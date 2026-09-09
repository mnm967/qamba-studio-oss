// The selected audio clip's — or audio LANE's — effect rack.
//
// One component for both, because they are one thing at two stages of the same
// signal path: a clip's chain is part of what that clip sounds like, a lane's
// is an insert everything on the lane passes through on its way to the mix.
// Same catalog, same parameters, same two engines. What differs is small and
// listed in `rack()` below — where the chain is read and written, what the
// meter taps, and whether there is a waveform to draw at all (a lane is not
// one piece of media, so there is not).
//
// Laid out the way a plugin is, because the shape carries information a list
// of sliders does not: the clip's waveform and a live output meter at the top,
// then one module per effect — power button, response graph, a row of rotary
// knobs. Order in the rack is order in the signal path.
//
// Everything drawn is computed from the effect's real coefficients
// (src/lib/fxCurves.ts), not sketched: the curve is the filter. Three
// behaviours are worth knowing:
//  - A knob or a graph handle writes with `undoable: false` while it moves and
//    commits ONE undo entry on release. Undoably per event, a single gesture
//    fills the 60-deep stack and ⌘Z can no longer reach past it.
//  - The meter only runs while the transport is playing AND a live chain
//    exists — no rAF otherwise, and the analyser tap is released on unmount.
//  - The panel says plainly when the preview cannot play the chain, because
//    Web Audio needs a CORS-readable media host (see audioGraph.ts). The
//    effects still reach the render either way.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Power, X } from "lucide-react";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import {
  FX_CATALOG, MAX_FX, defaultFx, fxDef, normalizeFx, type ClipFx, type EqBand, type FxParam,
} from "../../lib/audioFx";
import { needsCorsProxy } from "../../lib/corsMedia";
import {
  fxSupported, onCorsChange, probeCors, rackAnalyser, releaseRackAnalyser,
  type FxTap,
} from "../../lib/audioGraph";
import { mediaUrl } from "../../lib/supabase";
import { asNumberList } from "../../lib/jsonb";
import Dropdown from "../ui/Dropdown";
import Knob from "./Knob";
import FxGraph, { ClipWave } from "./FxGraph";
import type { Clip, Track } from "../../lib/db/types";

/** Knob readouts. A frequency knob that says "12000Hz" is a knob nobody reads. */
const fmtFor = (p: FxParam) => (v: number) => {
  // Pan is the one knob whose number is not the answer: -0.5 is "half left",
  // and every console in the world writes that L50.
  if (p.key === "pan") {
    const n = Math.round(Math.abs(v) * 100);
    return n === 0 ? "C" : `${v < 0 ? "L" : "R"}${n}`;
  }
  if (p.unit === "Hz") return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k` : `${Math.round(v)}`;
  if (p.unit === "dB") return `${v > 0 ? "+" : ""}${Math.round(v * 10) / 10}`;
  if (p.unit === ":1") return `${Math.round(v * 10) / 10}:1`;
  if (p.unit === "ms") return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v * 10) / 10}`;
  if (p.unit === "s") return `${Math.round(v * 10) / 10}s`;
  return `${Math.round(v * 100) / 100}`;
};

/** Output level, read from the tail of the live chain.
 *
 *  One rAF while playing, one reused byte array, one path element — and no
 *  React state per frame: the bar is written through a ref, the same trick the
 *  timeline playhead uses. */
function Meter({ tap }: { tap: FxTap }) {
  const barRef = useRef<HTMLElement>(null);
  const peakRef = useRef<HTMLElement>(null);
  const playing = usePlaybackStore((s) => s.playing);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let hold = 0;
    let holdAt = 0;
    let an: AnalyserNode | null = null;

    // The element and its chain are mounted by the PLAYER, and the order they
    // become ready in is not ours to control: a transport restart, a chain
    // rebuild or a re-mount can all land after this effect. So wait for the
    // tap rather than giving up on the first miss — which is what left the
    // meter dead at zero while the audio was plainly playing.
    let tries = 0;
    const find = () => {
      an = rackAnalyser(tap);
      return !!an || ++tries > 20;              // ~3s, then stop looking
    };

    const buf = new Uint8Array(32);
    const tick = () => {
      if (!an) {
        if (!find()) { raf = requestAnimationFrame(tick); return; }
        if (!an) return;                        // gave up: no chain here
      }
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
      // dBFS, floored where the meter's scale ends
      const db = peak > 0.0001 ? 20 * Math.log10(peak) : -60;
      const frac = Math.min(1, Math.max(0, (db + 60) / 60));
      if (barRef.current) barRef.current.style.width = `${frac * 100}%`;
      const now = performance.now();
      if (frac >= hold || now - holdAt > 900) { hold = frac; holdAt = now; }
      if (peakRef.current) peakRef.current.style.left = `${hold * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (barRef.current) barRef.current.style.width = "0%";
      if (an) releaseRackAnalyser(tap);
    };
  }, [tap, playing]);

  return (
    <span className="ws-fxmeter" title="Output level, after the chain">
      <i ref={barRef as React.RefObject<HTMLElement>} />
      <b ref={peakRef as React.RefObject<HTMLElement>} />
    </span>
  );
}

/** What the rack is attached to. A lane and a clip are different rows with
 *  the same column on them, so everything below reads and writes through this
 *  rather than branching per control. */
export type RackTarget =
  | { kind: "clip"; clip: Clip }
  | { kind: "track"; track: Track };

/** The waveform plus its live playhead cursor, isolated so the 10Hz tick
 *  re-renders only this leaf rather than the whole rack. Quantised to 100ms of
 *  clip time so its own set bails out between steps. */
function WaveWithHead({ peaks, clip, durationMs }: {
  peaks: number[]; clip: Clip; durationMs: number | null;
}) {
  const [head, setHead] = useState<number | null>(null);
  useEffect(() => usePlaybackStore.getState().onTick((ms) => {
    const rel = Math.round((ms - clip.t_start_ms) / 100) * 100;
    const f = rel / Math.max(1, clip.duration_ms);
    const q = f >= 0 && f <= 1 ? f : null;
    setHead((p) => (p === q ? p : q));
  }), [clip]);
  return (
    <ClipWave peaks={peaks} inMs={clip.in_ms} outMs={clip.out_ms}
              durationMs={durationMs} playhead={head} />
  );
}

export default function AudioFxPanel({ target }: { target: RackTarget }) {
  const clip = target.kind === "clip" ? target.clip : null;
  const track = target.kind === "track" ? target.track : null;
  const patchClip = useTimelineStore((s) => s.patchClip);
  const setTrackFx = useTimelineStore((s) => s.setTrackFx);
  const beginGesture = useTimelineStore((s) => s.beginGesture);
  const endGesture = useTimelineStore((s) => s.endGesture);
  // A lane has no media of its own, so its CORS answer is its clips' — the
  // rack is fed by their elements, and an element the browser may not read
  // cannot reach a bus any more than it can carry its own chain.
  const allClips = useTimelineStore((s) => s.clips);
  const laneClips = useMemo(
    () => (track ? allClips.filter((c) => c.track_id === track.id) : []),
    [allClips, track?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const laneClip = laneClips[0];
  const assetId = clip?.asset_id ?? laneClip?.asset_id ?? "";
  const asset = useTimelineStore((s) => s.assets.get(assetId));
  const stored = clip ? clip.audio_fx : track!.audio_fx;
  const chain = useMemo(() => normalizeFx(stored), [stored]);
  const [live, setLive] = useState<boolean | null>(null);
  const [open, setOpen] = useState<number | null>(0);
  const before = useRef<ClipFx[] | null>(null);
  // THE RACK IS PRO, the same shape as the post chain: a Free account can
  // neither add an effect nor turn a knob, and a chain already on the cut keeps
  // playing (the render applies what the rows say) — so "remove" stays open,
  // because taking an effect OFF is the way out, never the thing being sold.
  // Waits for `ready` for PostChainToggles' reason: a locked panel flashed at
  // somebody who has paid, on every launch, is worse than a moment of Free
  // controls.

  /** Whose analyser the meter and the EQ's spectrum read. Memoised because it
   *  is an effect dependency in both — a fresh object every render would
   *  re-tap the graph on every keystroke. */
  const tap = useMemo<FxTap>(
    () => ({ kind: target.kind, id: clip?.id ?? track!.id }), [target.kind, clip?.id, track?.id]);

  // The waveform's playhead cursor lives in <WaveWithHead> below now: even a
  // 100ms-quantised state HERE re-rendered the whole rack — EQ plots, knobs
  // and all — ten times a second whenever the playhead was inside the clip.
  // Only the waveform leaf subscribes and re-renders.

  // Can the preview play these at all? One HEAD against the media host, and
  // only once a chain exists — no effects, no request.
  useEffect(() => {
    if (!chain.length || !fxSupported()) return;
    const url = mediaUrl(asset?.b2_key ?? "");
    if (!url) return;
    // Desktop reads the bytes through Rust and plays a same-origin blob, so
    // there is no origin for the host to refuse — see lib/corsMedia.ts. The
    // probe is a web-only question.
    if (needsCorsProxy()) { setLive(true); return; }
    let alive = true;
    void probeCors(url).then((ok) => alive && setLive(ok));
    const off = onCorsChange(() => alive && setLive(false));
    return () => { alive = false; off(); };
  }, [chain.length, asset?.b2_key]);

  const write = (next: ClipFx[], opts: { undoable?: boolean } = {}) =>
    (clip
      ? patchClip(clip.id, { audio_fx: next }, { undoable: opts.undoable ?? true })
      : setTrackFx(track!.id, next, { undoable: opts.undoable ?? true }));

  /** Knob and handle moves: silent while dragging, one undo entry on release.
   *  The bracket is the store's, so the step covers whatever else the gesture
   *  touched rather than only this clip's `audio_fx`. */
  const edit = (idx: number, key: string, value: number | string | EqBand[]) => {
    if (!before.current) { before.current = chain; beginGesture("Adjust effect"); }
    write(chain.map((f, i) => (i === idx ? { ...f, params: { ...f.params, [key]: value } } : f)),
          { undoable: false });
  };
  const commit = () => {
    if (!before.current) return;
    endGesture();
    before.current = null;
  };

  const add = (id: string) => {
    const fx = defaultFx(id);
    if (!fx || chain.length >= MAX_FX) return;
    write([...chain, fx]);
    setOpen(chain.length);
  };
  const remove = (idx: number) => {
    write(chain.filter((_, i) => i !== idx));
    setOpen(null);
  };
  const power = (idx: number) => {
    write(chain.map((f, i) => (i === idx ? { ...f, enabled: f.enabled === false } : f)));
  };
  const move = (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= chain.length) return;
    const next = [...chain];
    [next[idx], next[to]] = [next[to], next[idx]];
    write(next);
    setOpen(to);
  };

  // Whose waveform the source strip draws. A clip rack draws its own; a LANE
  // rack draws its clip's ONLY when the lane holds exactly one (the master-
  // track case — one mp3 across the whole cut, which is what an A1 rack is
  // usually about). A lane with several clips has no single wave to draw, so
  // its meter stands alone there.
  const waveClip = clip ?? (laneClips.length === 1 ? laneClip : undefined) ?? null;
  const peaks = waveClip ? asNumberList(asset?.meta?.peaks) : [];
  const noun = clip ? "clip" : "lane";

  return (
    <div className="ws-rack" data-keys="own">
      <div className="ws-insp-sec">
        <span>{clip ? "Audio effects" : "Lane effects"}</span>
        <span style={{ flex: 1 }} />
        {chain.length < MAX_FX && (
          <Dropdown width={264} align="right" trigger={({ toggle }) => (
            <button className="ws-microbtn" style={{ padding: "0 8px" }} onClick={toggle}
                    title={`Add an effect to this ${noun}'s chain`}>
              <Plus size={11} /> Add
            </button>
          )}>
            {(close) => (
              <>
                {FX_CATALOG.map((def) => {
                  const had = chain.some((f) => f.id === def.id);
                  return (
                    <button key={def.id} className={"ws-menu-row" + (had ? " disabled" : "")}
                            disabled={had}
                            title={had ? `${def.label} is already on this ${noun}` : def.hint}
                            onClick={() => { add(def.id); close(); }}>
                      <span className="ws-lorapick">
                        <span className="nm">
                          <b>{def.label}</b>
                          {had && <i className="chip">on</i>}
                        </span>
                        <span className="hint">{def.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </Dropdown>
        )}
      </div>

      {/* the source: what is in it, and — when the chain is live — what is
          coming out of it. See waveClip for which rack gets a waveform: a
          multi-clip lane is not one piece of media, so only its meter shows. */}
      {(!!peaks.length || (!clip && live && !!chain.length)) && (
        <div className="ws-fxsrc">
          {!!peaks.length && waveClip && (
            <WaveWithHead peaks={peaks} clip={waveClip}
                          durationMs={asset?.duration_ms ?? null} />
          )}
          {live && !!chain.length && <Meter tap={tap} />}
        </div>
      )}

      {!chain.length && (
        <div className="ws-empty" style={{ margin: "2px 0 0" }}>
          {clip
            ? "No effects. EQ and a compressor are what most dialogue wants; the rack runs top to bottom."
            : "No lane effects. These run after every clip's own chain and before the "
              + "fader, so a compressor here hears the whole lane at once."}
        </div>
      )}

      <div className="ws-fxa-list">
        {chain.map((fx, i) => {
          const def = fxDef(fx.id);
          if (!def) return null;
          const isOpen = open === i;
          const off = fx.enabled === false;
          return (
            <div key={`${fx.id}:${i}`} className={"ws-fxa" + (isOpen ? " on" : "") + (off ? " off" : "")}>
              <div className="ws-fxa-head" onClick={() => setOpen(isOpen ? null : i)}>
                <button className={"pwr" + (off ? "" : " lit")} title={off ? "Switch on" : "Bypass"}
                        onClick={(e) => { e.stopPropagation(); power(i); }}>
                  <Power size={11} />
                </button>
                <b>{def.label}</b>
                <span className="idx mono">{i + 1}</span>
                <span style={{ flex: 1 }} />
                <button title="Earlier in the chain" disabled={i === 0}
                        onClick={(e) => { e.stopPropagation(); move(i, -1); }}>↑</button>
                <button title="Later in the chain" disabled={i === chain.length - 1}
                        onClick={(e) => { e.stopPropagation(); move(i, 1); }}>↓</button>
                <button title="Remove" onClick={(e) => { e.stopPropagation(); remove(i); }}>
                  <X size={12} />
                </button>
              </div>
              {isOpen && (
                <div className="ws-fxa-body">
                  <FxGraph fx={fx} tap={tap}
                           onInput={(k, v) => edit(i, k, v)} onCommit={commit} />
                  <div className="ws-knobs">
                    {def.params.map((p) => (
                      // `bands` has no knob: the EQ's editor drew its own.
                      p.kind === "bands" ? null : p.kind === "choice" ? (
                        <div key={p.key} className="ws-seg vert">
                          {p.choices?.map((c) => (
                            <button key={c.value} className={fx.params[p.key] === c.value ? "on" : ""}
                                    onClick={() => { edit(i, p.key, c.value); commit(); }}>
                              {c.label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <Knob key={p.key} label={p.label} value={Number(fx.params[p.key])}
                              min={p.min ?? 0} max={p.max ?? 1} step={p.step ?? 0.1}
                              unit={p.unit} defaultValue={Number(p.default)}
                              // Bipolar means the range STRADDLES zero, so the
                              // arc fills out from the centre: an EQ band, the
                              // overdrive's output trim, pan. A threshold that
                              // runs -60..0 does not — it fills from its floor,
                              // which is where its "off" is.
                              bipolar={(p.min ?? 0) < 0 && (p.max ?? 0) > 0}
                              format={fmtFor(p)}
                              onInput={(v) => edit(i, p.key, v)} onCommit={commit} />
                      )
                    ))}
                  </div>
                  <span className="ws-fxa-hint">{def.hint}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

    </div>
  );
}
