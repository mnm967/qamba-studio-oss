// Playing a clip's effect chain in the browser, through Tuna.
//
// This is the preview half of `audioFx.ts`; `worker/audio_fx.py` is the render
// half. It exists to be CHEAP when nothing is using it, because the timeline
// mounts one <audio> per audio clip and most of them will never carry an
// effect. So:
//
//   - Tuna is imported dynamically, the first time a chain is actually built.
//     A timeline with no effects never fetches the chunk.
//   - One AudioContext, created on that same first build. Not on load: an
//     AudioContext costs an audio thread, and Chrome warns about one created
//     before a user gesture.
//   - An element that has no effects is NEVER touched. `createMediaElementSource`
//     permanently reroutes an element's audio through the graph and cannot be
//     undone, so attaching "just in case" would put every clip's audio behind
//     a context that might be suspended.
//   - Turning a knob updates the live nodes in place. Only a change to the
//     chain's SHAPE (see fxSignature) relinks anything — rebuilding on every
//     drag frame clicks, and drops the effect's own state (an echo's tail, a
//     compressor's envelope).
//   - Teardown deactivates Tuna's LFOs. Chorus, Tremolo and Phaser drive
//     themselves from a 256-sample ScriptProcessor connected to the
//     destination; drop the references without calling `activate(false)` and
//     it keeps running its callback ~187 times a second for the life of the
//     page.
//   - The reverb's impulse response is cached by the parameters that produced
//     it, so a knob drag rebuilds a buffer only when a rounded value actually
//     moves, and two clips on the same setting share one.
//
// The hard constraint on all of it: a MediaElementAudioSourceNode built from a
// cross-origin element that is not CORS-approved outputs SILENCE. Not an error
// — silence. This build's media is a file in the project's own folder, served
// by `mediaserver.rs` on loopback with `Access-Control-Allow-Origin: *`, so it
// IS readable — provided the element asked in CORS mode, which is a separate
// thing from the header (see `corsMedia.ts`: an element that does not ask is
// opaque whatever the host said, and that was measured as video playing with
// no sound). Hence the probe: the graph is attached only where the media can
// actually be read, and everything here no-ops otherwise — the effects still
// reach the render, which is where they are the deliverable.
//
// One trap worth keeping written down, for anyone pointing this at media
// served from somewhere else: a host that sends `Vary: origin` on a response
// it answered WITH an Origin header and no `Vary` at all on one it answered
// without will POISON ITS OWN CACHE — a response stored from a non-CORS load
// carries no ACAO and nothing marking it origin-specific, and the browser then
// reports "No 'Access-Control-Allow-Origin' header is present" for a URL that
// is being served correctly. Check with curl before touching the host's rule;
// the fix is a cache-clearing reload, not a config change.
import { fxSignature, previewFx, tunaNodes, type ClipFx, type ReverbTap } from "./audioFx";

interface TunaEffect {
  input: AudioNode;
  output: AudioNode;
  [prop: string]: unknown;
}

interface Chain {
  src: MediaElementAudioSourceNode;
  /** Permanent tail, and the clip's own gain. The source always reaches its
   *  destination through this, so releasing the effects leaves a working
   *  element rather than a mute one.
   *
   *  It carries the clip's level only on the BUSSED path, where it is what
   *  makes the preview's order the render's: ffmpeg applies the clip's gain
   *  after the clip's inserts, and `<audio>.volume` is upstream of all of
   *  them. Off the bus the element keeps its volume and this stays at 1. */
  out: GainNode;
  /** The lane whose rack this element plays through, if any. */
  busId: string | null;
  nodes: TunaEffect[];
  sig: string;
  /** How many times this element's chain has been rebuilt. Kept because
   *  "turning a knob does not relink" is otherwise an unobservable claim —
   *  this is what `fxStateOf` reports and what a check can assert. */
  builds: number;
  /** The panel's meter tap, present only while a panel is watching. */
  analyser?: AnalyserNode;
}

/** One lane's insert rack: everything on the lane sums into `input`, passes
 *  through the rack, and leaves through `out` — which is the lane fader.
 *
 *  The order is the renderer's (`worker/mix.py::lane_bus`) and it is the whole
 *  point of the bus: inserts BEFORE the fader, so a lane compressor hears the
 *  lane rather than the fader, and a lane's clips are summed before the rack
 *  so it hears all of them at once. A per-clip chain structurally cannot do
 *  either. */
interface Bus {
  input: GainNode;
  out: GainNode;
  nodes: TunaEffect[];
  sig: string;
  builds: number;
  analyser?: AnalyserNode;
}

/** Which rack a meter or a spectrum is watching. A clip's tap hangs off its
 *  `<audio>` element (the player stamps `data-clip`, and these elements are in
 *  no store); a lane's hangs off its bus, which has no element at all. */
export type FxTap = { kind: "clip" | "track"; id: string };

type TunaCtor = new (ctx: AudioContext) => Record<string, unknown>;

// ------------------------------------------------------------- reverb IR ----

/** The one effect Tuna does not play, and why.
 *
 *  Its Convolver takes an impulse-response URL and XHRs it; this impulse is
 *  GENERATED — the exact tap list `worker/audio_fx.py` hands to `aecho`, which
 *  is a pure feed-forward tap set. Convolving with those same taps is not an
 *  approximation of the render, it is the same filter, which is the whole
 *  reason the reverb could join a catalog whose rule is that both engines must
 *  be able to play an effect over the same range.
 *
 *  `normalize` MUST stay off. On (the default) the node rescales the response
 *  by its own RMS, so the tail would come out at a level nothing else knows
 *  about and the two engines would quietly stop matching. */
const irCache = new Map<string, AudioBuffer>();
const IR_CACHE_MAX = 6;

function irBuffer(key: string, taps: ReverbTap[]): AudioBuffer {
  const hit = irCache.get(key);
  if (hit) return hit;
  const c = context();
  const last = taps.length ? taps[taps.length - 1].ms : 0;
  // Mono: a one-channel response convolves each input channel with itself,
  // which is what `aecho` does per channel, and costs half the memory.
  const buf = c.createBuffer(1, Math.max(1, Math.floor((last / 1000) * c.sampleRate) + 2), c.sampleRate);
  const d = buf.getChannelData(0);
  d[0] = 1;                     // the dry path — `aecho`'s in_gain=1 tap
  for (const t of taps) {
    // FLOOR, not round: `aecho` truncates a delay to the sample below it
    // (measured — 58.2ms at 48kHz lands on sample 2793, not 2794). The
    // difference is 20 microseconds and inaudible, but matching it costs
    // nothing and makes the two impulse responses identical rather than
    // merely close.
    const i = Math.floor((t.ms / 1000) * c.sampleRate);
    if (i < d.length) d[i] += t.gain;
  }
  if (irCache.size >= IR_CACHE_MAX) irCache.delete(irCache.keys().next().value as string);
  irCache.set(key, buf);
  return buf;
}

/** A ConvolverNode dressed as a Tuna effect, so it links, disposes and takes
 *  its parameters through exactly the same code path as the other nine. */
class IRNode implements TunaEffect {
  [prop: string]: unknown;
  input: GainNode;
  output: GainNode;
  private conv: ConvolverNode;
  private key = "";
  constructor() {
    const c = context();
    this.input = c.createGain();
    this.output = c.createGain();
    this.conv = c.createConvolver();
    this.conv.normalize = false;
    this.input.connect(this.conv);
    this.conv.connect(this.output);
  }
  set ir(v: { key: string; taps: ReverbTap[] }) {
    if (!v || v.key === this.key) return;   // a knob that did not move
    this.key = v.key;
    this.conv.buffer = irBuffer(v.key, v.taps);
  }
}

let ctx: AudioContext | null = null;
let tuna: Record<string, unknown> | null = null;
let tunaLoading: Promise<Record<string, unknown>> | null = null;
const chains = new WeakMap<HTMLMediaElement, Chain>();
/** Elements with a build in flight — two rapid edits must not race into two
 *  source nodes for one element (the second throws InvalidStateError). */
const building = new WeakSet<HTMLMediaElement>();
/** Lane racks, by track id. A Map rather than a WeakMap: a lane is a row, not
 *  an object the DOM will collect for us, so these are released explicitly. */
const buses = new Map<string, Bus>();
const busBuilding = new Set<string>();

export const fxSupported = () =>
  typeof window !== "undefined" &&
  !!(window.AudioContext || (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);

function context(): AudioContext {
  if (!ctx) {
    const Ctor = window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor();
  }
  return ctx;
}

/** Resume after the autoplay policy suspended us. Safe to call on every play:
 *  it is a no-op once running, and there is no context at all until something
 *  has effects. */
export function resumeAudio(): void {
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

async function loadTuna(): Promise<Record<string, unknown>> {
  if (tuna) return tuna;
  if (!tunaLoading) {
    tunaLoading = import("tunajs").then((m) => {
      const Ctor = ((m as unknown as { default?: TunaCtor }).default ?? m) as unknown as TunaCtor;
      tuna = new Ctor(context());
      return tuna;
    });
  }
  return tunaLoading;
}

// ------------------------------------------------------------------ CORS ----

let corsProbe: Promise<boolean> | null = null;
const corsListeners = new Set<() => void>();

/** Can scripts read this media host's bytes? One HEAD per session, cached.
 *
 *  HEAD is a CORS-safelisted method, so this costs a request with no body and
 *  no preflight. A false answer is the safe one: it only disables the live
 *  preview. Claiming true when it is false would be worse than either —
 *  `crossOrigin="anonymous"` on an element the host will not CORS-approve
 *  fails the LOAD, so the clip would not play at all. */
export function probeCors(url: string): Promise<boolean> {
  if (!corsProbe) {
    // Resolving AT ALL is the answer, whatever the status. A cross-origin
    // response with no ACAO rejects the promise outright, so a 404 we can read
    // the status of has already passed the check — testing `r.ok` instead
    // would disable effects for a whole studio because one probe URL was
    // missing. Same-origin media resolves too, and needs no header to reach
    // Web Audio.
    //
    // `no-store` is load-bearing: the media element usually loads the file
    // BEFORE this runs, B2 answers a non-CORS request with no ACAO and no
    // `Vary`, and that response then sits in the cache answering for every
    // origin. Measured on a real project — the same URL was `BLOCKED` on a
    // default fetch and `200 cors` with the cache bypassed, at the same
    // moment. Reading the cache here reports the bucket as refusing an origin
    // it is plainly serving.
    corsProbe = fetch(url, { method: "HEAD", mode: "cors", cache: "no-store" })
      .then(() => true)
      .catch(() => false);
  }
  return corsProbe;
}

export const corsKnown = () => corsProbe !== null;

/** An element loaded with `crossOrigin` set has failed — ask again whether the
 *  host allows a CORS read, and report which it was.
 *
 *  It matters that this RE-PROBES instead of concluding. A media element's
 *  error tells you nothing about the cause: `MEDIA_ERR_SRC_NOT_SUPPORTED`
 *  covers a CORS refusal, a 404 and a codec the browser will not decode alike.
 *  Blaming CORS for a missing file disabled live effects for the whole session
 *  and put a confident, wrong explanation on screen — which is exactly what
 *  happened the first time, on a clip whose media had been deleted.
 *
 *  Returns true when CORS is fine (so the caller should report an ordinary
 *  media error); false when it is not, having told every listener so the
 *  surfaces can re-mount without `crossOrigin` and at least play the clip. */
export async function recheckCors(url: string): Promise<boolean> {
  corsProbe = fetch(url, { method: "HEAD", mode: "cors", cache: "no-store" })
    .then(() => true).catch(() => false);
  const ok = await corsProbe;
  if (!ok) for (const fn of corsListeners) fn();
  return ok;
}

export function onCorsChange(fn: () => void): () => void {
  corsListeners.add(fn);
  return () => { corsListeners.delete(fn); };
}

// ----------------------------------------------------------------- chains ---

/** Every Tuna node for a chain, flattened — EQ is three filters, so node
 *  index and effect index are not the same thing. */
const flatten = (fx: ClipFx[]) => fx.flatMap((f) => tunaNodes(f));

function assign(node: TunaEffect, props: Record<string, unknown>) {
  for (const [k, v] of Object.entries(props)) {
    try {
      (node as Record<string, unknown>)[k] = v;
    } catch {
      /* a property this Tuna version doesn't expose: leave it at its default
         rather than failing the whole chain */
    }
  }
}

function dispose(nodes: TunaEffect[]) {
  for (const n of nodes) {
    // Chorus/Tremolo/Phaser run a ScriptProcessor LFO wired to the
    // destination. Disconnecting the effect does not stop it.
    for (const key of ["lfoL", "lfoR", "lfo"]) {
      const lfo = n[key] as { activate?: (on: boolean) => void } | undefined;
      try { lfo?.activate?.(false); } catch { /* not an LFO-backed effect */ }
    }
    try { n.input.disconnect(); } catch { /* already gone */ }
    try { n.output.disconnect(); } catch { /* already gone */ }
  }
}

/** Wire `src -> nodes -> [tap] -> tail`, from scratch.
 *
 *  EVERY output is disconnected first, and that is not tidiness. An
 *  AnalyserNode is a pass-through that sits IN the signal path, so adding one
 *  to a chain that was already linked — which is exactly what opening the
 *  panel on a clip that has effects does — leaves the last node connected both
 *  straight to the tail and through the tap. The tail then hears it twice.
 *  Rebuilding from a clean slate is the only version of this that is correct
 *  whichever way the chain is being changed. */
function link(src: AudioNode, nodes: TunaEffect[], tap: AnalyserNode | undefined, tail: AudioNode) {
  try { src.disconnect(); } catch { /* never connected */ }
  for (const n of nodes) {
    try { n.output.disconnect(); } catch { /* already gone */ }
  }
  if (tap) {
    try { tap.disconnect(); } catch { /* already gone */ }
  }
  let head: AudioNode = src;
  for (const n of nodes) {
    head.connect(n.input);
    head = n.output;
  }
  // The meter taps the END of the rack, so it shows what the effects are
  // actually putting out — the point of watching one while turning a makeup
  // knob. On a lane that is BEFORE the fader, for the same reason: it answers
  // "what is this rack doing", not "how loud did I leave the lane".
  if (tap) {
    head.connect(tap);
    head = tap;
  }
  head.connect(tail);
}

function relink(chain: Chain) {
  link(chain.src, chain.nodes, chain.analyser, chain.out);
}

/** Where a clip's tail goes: into its lane's rack, or straight out. Separate
 *  from `relink` because the lane can change without the chain changing. */
function routeOut(chain: Chain) {
  try { chain.out.disconnect(); } catch { /* never connected */ }
  chain.out.connect(chain.busId ? busInput(chain.busId) : context().destination);
}

// -------------------------------------------------------------------- buses -

/** This lane's bus, created on demand. Synchronous by design: an element may
 *  need somewhere to connect before Tuna has finished loading the rack's
 *  nodes, and a bus with an empty rack is just a gain stage. */
function busInput(id: string): GainNode {
  let bus = buses.get(id);
  if (!bus) {
    const c = context();
    bus = { input: c.createGain(), out: c.createGain(), nodes: [], sig: "", builds: 0 };
    bus.out.connect(c.destination);
    buses.set(id, bus);
    link(bus.input, bus.nodes, bus.analyser, bus.out);
  }
  return bus.input;
}

/** The lane fader, in LINEAR gain rather than `elementVolume`'s 0..1.
 *
 *  `<audio>.volume` is capped at 1, so a lane pushed to +6dB has always been
 *  clamped in the preview while the render applied all of it. A GainNode has
 *  no such cap, so on the bussed path the two finally agree. */
export function setBusGain(id: string, gain: number): void {
  const bus = buses.get(id);
  // Guarded: the player calls this per lane per rAF tick, and an AudioParam
  // write is a cross-thread message even when the value is unchanged.
  if (bus && bus.out.gain.value !== gain) bus.out.gain.value = gain;
}

/** Which lane's rack this element is actually routed through, or null.
 *
 *  Read from the real graph rather than inferred from the rows, because the
 *  two disagree for a moment on every change and the player has to know which
 *  gain stage owns the level RIGHT NOW: guessing "bussed" one tick early sets
 *  the element to unity while nothing else is holding the fader, and the lane
 *  jumps. */
export const busOf = (el: HTMLMediaElement) => chains.get(el)?.busId ?? null;

/** The clip's own level, after its own inserts — see `Chain.out`. */
export function setClipGain(el: HTMLMediaElement, gain: number): void {
  const chain = chains.get(el);
  // Guarded for the same reason as setBusGain: per-clip per-tick caller.
  if (chain && chain.out.gain.value !== gain) chain.out.gain.value = gain;
}

/** Build or update one lane's rack. Same contract as `applyFx`: fire and
 *  forget, idempotent, and a knob turn assigns in place rather than relinking. */
export function applyBusFx(id: string, fx: ClipFx[]): void {
  if (!fxSupported()) return;
  const active = previewFx(fx);
  const sig = fxSignature(fx);
  const cur = buses.get(id);
  if (!active.length) {
    // No rack any more. The BUS stays if it exists — elements are still routed
    // into it, and tearing it down under them would mute the lane until the
    // player's next pass. It is a plain gain stage now.
    if (cur && cur.nodes.length) {
      dispose(cur.nodes);
      cur.nodes = [];
      cur.sig = "";
      link(cur.input, cur.nodes, cur.analyser, cur.out);
    }
    return;
  }
  busInput(id);                       // exists from here on
  const bus = buses.get(id) as Bus;
  if (bus.sig === sig && bus.nodes.length) {
    const props = flatten(active);
    bus.nodes.forEach((n, i) => props[i] && assign(n, props[i].props));
    return;
  }
  if (busBuilding.has(id)) return;
  busBuilding.add(id);
  void loadTuna()
    .then((t) => {
      busBuilding.delete(id);
      const live = buses.get(id);
      if (!live) return;              // released while Tuna was loading
      const want = previewFx(fx);
      const built: TunaEffect[] = [];
      for (const spec of flatten(want)) {
        if (spec.effect === "IR") {
          const node = new IRNode();
          assign(node, spec.props);
          built.push(node);
          continue;
        }
        const Effect = t[spec.effect] as (new (p: Record<string, unknown>) => TunaEffect) | undefined;
        if (!Effect) continue;
        built.push(new Effect(spec.props));
      }
      dispose(live.nodes);
      live.nodes = built;
      live.sig = fxSignature(fx);
      live.builds += 1;
      link(live.input, live.nodes, live.analyser, live.out);
      resumeAudio();
    })
    .catch((err) => {
      busBuilding.delete(id);
      console.error("lane fx unavailable", err);
    });
}

/** Drop a lane's bus entirely. Only safe once nothing is routed into it — the
 *  player re-runs `applyFx` for the lane's clips in the same pass. */
export function releaseBus(id: string): void {
  const bus = buses.get(id);
  if (!bus) return;
  dispose(bus.nodes);
  buses.delete(id);
  try { bus.analyser?.disconnect(); } catch { /* already gone */ }
  try { bus.input.disconnect(); } catch { /* already gone */ }
  try { bus.out.disconnect(); } catch { /* already gone */ }
}

export const busIds = () => [...buses.keys()];

/** How wide the analyser's window is. The meter only ever wanted a peak and
 *  ran at the minimum 32, but the EQ draws a SPECTRUM off the same tap, and
 *  the bins are linearly spaced while the display is logarithmic — so the
 *  bottom of the plot is where resolution runs out first. 4096 puts the bins
 *  ~5.9Hz apart at 48kHz, which is about one per column down at 20Hz; 2048
 *  would smear the two lowest octaves into steps. The meter is unaffected: it
 *  reads TIME-domain data, where a longer window is more samples to scan and
 *  nothing else. */
const FFT_SIZE = 4096;

/** A tap on the tail of the chain, created on demand and only where a chain
 *  already exists — shared by the level meter and the EQ's spectrum, because
 *  both want the same thing (what this clip is putting out, after its
 *  effects) and a second AnalyserNode would be a second FFT of it. */
export function analyserFor(el: HTMLMediaElement): AnalyserNode | null {
  const chain = chains.get(el);
  if (!chain) return null;
  if (!chain.analyser) {
    // The floor of the spectrum display. -90 is below anything audible in a
    // mix and keeps a quiet passage off the bottom edge instead of pinned to
    // it; the default -100/-30 window clips loud material flat at the top.
    chain.analyser = makeAnalyser();
    relink(chain);
  }
  return chain.analyser;
}

/** The sample rate the analyser's bins are spaced against. The EQ needs it to
 *  put a bin on a frequency, and there is no context at all until something
 *  has effects — so this answers null rather than creating one. */
export const audioSampleRate = () => ctx?.sampleRate ?? null;

export function releaseAnalyser(el: HTMLMediaElement): void {
  const chain = chains.get(el);
  if (!chain?.analyser) return;
  const a = chain.analyser;
  chain.analyser = undefined;
  relink(chain);
  try { a.disconnect(); } catch { /* already gone */ }
}

function makeAnalyser(): AnalyserNode {
  const a = context().createAnalyser();
  a.fftSize = FFT_SIZE;
  a.minDecibels = -90;
  a.maxDecibels = -10;
  return a;
}

/** The same tap on a LANE's rack. Before the fader — see `link`. */
export function busAnalyser(id: string): AnalyserNode | null {
  const bus = buses.get(id);
  if (!bus) return null;
  if (!bus.analyser) {
    bus.analyser = makeAnalyser();
    link(bus.input, bus.nodes, bus.analyser, bus.out);
  }
  return bus.analyser;
}

export function releaseBusAnalyser(id: string): void {
  const bus = buses.get(id);
  if (!bus?.analyser) return;
  const a = bus.analyser;
  bus.analyser = undefined;
  link(bus.input, bus.nodes, bus.analyser, bus.out);
  try { a.disconnect(); } catch { /* already gone */ }
}

/** The meter/spectrum tap for whichever kind of rack the panel is showing.
 *
 *  The clip half owns the DOM lookup so its two consumers (the level meter and
 *  the EQ's spectrum) cannot drift on the selector — they each had their own
 *  copy of it, which is one place too many for a string that has to match what
 *  the player stamps on the element. */
export function rackAnalyser(tap: FxTap): AnalyserNode | null {
  if (tap.kind === "track") return busAnalyser(tap.id);
  const el = document.querySelector<HTMLMediaElement>(`audio[data-clip="${tap.id}"]`);
  return el ? analyserFor(el) : null;
}

export function releaseRackAnalyser(tap: FxTap): void {
  if (tap.kind === "track") { releaseBusAnalyser(tap.id); return; }
  const el = document.querySelector<HTMLMediaElement>(`audio[data-clip="${tap.id}"]`);
  if (el) releaseAnalyser(el);
}

/** The element's own chain, created on demand.
 *
 *  `createMediaElementSource` permanently reroutes an element and cannot be
 *  undone, so this is only ever reached for an element that genuinely needs
 *  the graph — its own effects, or a lane rack it has to be summed into. */
function ensureChain(el: HTMLMediaElement, busId: string | null): Chain {
  let chain = chains.get(el);
  if (!chain) {
    const src = context().createMediaElementSource(el);
    const out = context().createGain();
    chain = { src, out, busId, nodes: [], sig: "", builds: 0 };
    chains.set(el, chain);
    // BOTH halves, and the first is the one that got forgotten: the interior
    // (src -> out; relink, since there are no nodes yet) and the exit (out ->
    // bus or destination). `createMediaElementSource` has already rerouted the
    // element, so a chain whose src dangles is not "no effects yet", it is
    // silence — and the no-own-effects fast path in applyFx never builds
    // nodes, so nothing after this would ever wire it.
    relink(chain);
    routeOut(chain);
  } else if (chain.busId !== busId) {
    chain.busId = busId;
    // Off the bus, the element's own volume is the level again and this gain
    // stage goes back to being a plain tail — left at the clip's gain it would
    // apply it twice.
    if (!busId) chain.out.gain.value = 1;
    routeOut(chain);
  }
  return chain;
}

/** Apply `fx` to this element's audio, and route it into `busId`'s lane rack
 *  if it has one. Fire and forget; never throws.
 *
 *  Called from a render pass, so it must be idempotent and cheap: the common
 *  case (no effects, no lane rack, nothing attached) returns before touching
 *  anything. */
export function applyFx(el: HTMLMediaElement, fx: ClipFx[], busId: string | null = null): void {
  if (!fxSupported()) return;
  // previewFx, not activeFx: the EQ needs a chain even when it is flat,
  // because its display is a spectrum read off that chain's own analyser.
  const active = previewFx(fx);
  const sig = fxSignature(fx);
  const cur = chains.get(el);
  if (!active.length && !busId) {
    if (cur) releaseFx(el);
    return;                     // an untouched element stays untouched
  }
  if (!active.length) {
    // No inserts of its own, but its lane has a rack — so the element still
    // has to reach the bus, through a chain of zero effects. No Tuna needed
    // for that, and waiting for it would leave the clip playing dry past the
    // lane's rack in the meantime.
    const chain = ensureChain(el, busId);
    if (chain.nodes.length) {
      dispose(chain.nodes);
      chain.nodes = [];
      chain.sig = "";
      chain.builds += 1;
      relink(chain);
    }
    return;
  }
  if (cur && cur.sig === sig) {
    ensureChain(el, busId);     // the lane can change without the chain changing
    const props = flatten(active);
    cur.nodes.forEach((n, i) => props[i] && assign(n, props[i].props));
    return;                     // a knob turn: no relinking, no allocation
  }
  if (building.has(el)) return;
  building.add(el);
  void loadTuna()
    .then((t) => {
      building.delete(el);
      // The chain may have changed again while Tuna was loading.
      const want = previewFx(fx);
      const wantSig = fxSignature(fx);
      const chain = ensureChain(el, busId);
      const built: TunaEffect[] = [];
      for (const spec of flatten(want)) {
        if (spec.effect === "IR") {
          const node = new IRNode();
          assign(node, spec.props);
          built.push(node);
          continue;
        }
        const Effect = t[spec.effect] as (new (p: Record<string, unknown>) => TunaEffect) | undefined;
        if (!Effect) continue;
        built.push(new Effect(spec.props));
      }
      dispose(chain.nodes);
      chain.nodes = built;
      chain.sig = wantSig;
      chain.builds += 1;
      relink(chain);
      resumeAudio();
    })
    .catch((err) => {
      building.delete(el);
      console.error("audio fx unavailable", err);
    });
}

/** Drop the effects AND the lane, keep the element audible. The source node
 *  cannot be un-created, so the bypass is source -> out -> destination. */
export function releaseFx(el: HTMLMediaElement): void {
  const chain = chains.get(el);
  if (!chain) return;
  dispose(chain.nodes);
  chain.nodes = [];
  chain.sig = "";
  chain.busId = null;
  // The element's own volume is the level again — see `Chain.out`.
  chain.out.gain.value = 1;
  routeOut(chain);
  chain.src.disconnect();
  chain.src.connect(chain.out);
}

/** The element is going away. Same as release, plus the tail — otherwise its
 *  LFOs and its gain node outlive it. */
export function disposeFx(el: HTMLMediaElement): void {
  const chain = chains.get(el);
  if (!chain) return;
  dispose(chain.nodes);
  try { chain.src.disconnect(); } catch { /* already gone */ }
  try { chain.out.disconnect(); } catch { /* already gone */ }
  chains.delete(el);
}

/** Every lane rack goes away — the player is unmounting. Buses are keyed by a
 *  row id rather than by an object, so nothing collects them for us. */
export function disposeAllBuses(): void {
  for (const id of [...buses.keys()]) releaseBus(id);
}

/** Dev/test handle: is this element routed through the graph, and with what? */
export const fxStateOf = (el: HTMLMediaElement) => {
  const c = chains.get(el);
  return c ? { sig: c.sig, nodes: c.nodes.length, builds: c.builds, bus: c.busId } : null;
};

/** The same, for a lane. `gain` is the fader the bus is holding — the one
 *  number that says whether the preview and the render agree about a lane
 *  pushed past 0dB. */
export const busStateOf = (id: string) => {
  const b = buses.get(id);
  return b ? { sig: b.sig, nodes: b.nodes.length, builds: b.builds, gain: b.out.gain.value } : null;
};

// Dev-only handle, same rationale as __tl / __ws: a check can read the real
// graph instead of inferring it from the DOM. It has to come from the module
// the APP imported — a second `import()` of this path is a second instance,
// with its own WeakMap and its own idea of whether CORS was probed. Stripped
// from production builds.
if (import.meta.env.DEV) {
  (window as unknown as { __fx?: unknown }).__fx = {
    fxStateOf, busStateOf, busIds, corsKnown, probeCors, resumeAudio,
    analyserFor, releaseAnalyser, rackAnalyser, releaseRackAnalyser,
    context: () => ctx,
    tunaLoaded: () => !!tuna,
  };
}
