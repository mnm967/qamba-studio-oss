// What the Render button opens: the delivery format, and the finishing passes
// that get applied on the way there.
//
// The button used to fire immediately with no options at all — `tl_render`
// carried nothing but a timeline id, and every output setting was a literal in
// worker/handlers/render.py (libx264 / crf 18 / aac 192k / always .mp4). This
// screen is those literals turned into a decision, plus the one thing that was
// already a decision and had no home on this screen: the post chain.
//
// TWO CARDS, TWO OWNERS, and keeping that visible is most of the design:
// OUTPUT is one setting for the whole render, while POST is per clip with a
// project-wide default. So the post card edits the DEFAULT and says how many
// clips have overridden it, rather than pretending it controls them.
//
// Everything here persists to projects.settings on Render. A studio delivers
// in one format for months, so remembering is right and a one-off is a
// change-and-change-back — stated in the footer instead of hidden behind a
// "save as default" checkbox nobody would find.
import React, { useMemo, useState } from "react";
import { Ban, Clapperboard, Cpu, Download, Loader2, Lock } from "lucide-react";
import ModalShell, { Card } from "./ModalShell";
import PostChainToggles from "../ui/PostChainToggles";
import PostRefPicker from "../ui/PostRefPicker";
import PostOptionsPanel from "../ui/PostOptionsPanel";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import {
  forgetInstalledNodes, renderBlock, renderFacts,
  type RenderBlock, type RenderFacts,
} from "../../lib/renderReadiness";
import {
  AUDIO_CODEC, describeOutput, encoderOf, isUpscale, normalizeOutput,
  outputSize, outputWarnings, PRORES_PROFILES, RESOLUTIONS, SAMPLE_RATES,
  VIDEO_FORMAT, VIDEO_FORMATS, type RenderOutput, type VideoFormatId,
} from "../../lib/renderOutput";
import {
  activeOps, chainNeedsGpu, describeChain, normalizePostOptions, resolvePost,
  tunableOps, type PostChain, type PostOptions,
} from "../../lib/postChain";

export interface RenderSettingsProps {
  /** The timeline being rendered — its own frame is the size everything is
   *  described against. */
  timeline: { width: number; height: number; fps: number; duration_ms?: number };
  /** Video clips only: audio clips are never offered a post chain, so counting
   *  them could only overstate how much of the cut is being processed. */
  clips: { id: string; post?: unknown }[];
  output: RenderOutput;
  projectChain: PostChain;
  /** projects.settings.post_ref_asset_id — what Color Match matches to. */
  postRefAssetId?: string | null;
  /** projects.settings.post_ref_mode — see PostRefPicker. */
  postRefMode?: "source" | "asset";
  /** projects.settings.post_ref_strength, 0..1 — how hard the grade applies. */
  postRefStrength?: number;
  /** projects.settings.post_refine_* / post_upscale_model — see PostOptionsPanel.
   *  Here as well as in the context panel for PostChainToggles' reason: a
   *  setting you can change in one surface and not the other is the same gap
   *  one level in, and this is the screen you are on when you decide to render. */
  postOptions?: PostOptions;
  projectId?: string | null;
  busy?: boolean;
  /** Test seam for /ui/render: the harness has no desktop bridge, so it
   *  states the machine instead of being one. Absent, the facts are read from
   *  the machine. */
  placeFacts?: RenderFacts;
  onRender: (o: RenderOutput, chain: PostChain, postRef: string | null,
             postRefMode: "source" | "asset", postOptions: PostOptions,
             postRefStrength: number) => void;
  onClose: () => void;
}

/**
 * WHY THIS RENDER CANNOT START, when it cannot.
 *
 * Its own card rather than a line in the footer, because these are errands —
 * install the engine's Python, download three weights — and an errand needs
 * room for what it is and a button that begins it. Nothing renders when
 * everything is in place: a card saying "yes" is noise on every render.
 */
function ReadyNotice({ blocked, onFix }: {
  blocked: RenderBlock;
  onFix: (tab: "engine" | "models") => void;
}) {
  return (
    <>
      {/* ONE flex item, not three. The reason routinely wraps to two lines,
          and as siblings the padlock took a line of its own above the text and
          the button took one below it. Inside the span they are a sentence
          with a hanging indent. */}
      <p className="rs-hint rs-blocked">
        <Lock size={11} />
        <span>
          {blocked.why}.
          {/* A fix the USER can perform is a button, never a sentence with
              nowhere to go. Every one of them is a tab of the engine window,
              and the sentence above named which. */}
          {blocked.fix && (
            <>
              {" "}
              <button type="button" className="rs-fix" onClick={() => onFix(blocked.fix!)}>
                {blocked.fix === "models" ? "Download them" : "Open the engine window"}
              </button>
            </>
          )}
          {/* WHICH models, itemised. "Some models are missing" sends somebody
              to a Models tab of forty rows to work out which — and the two
              kinds of line are not the same offer, so a line with no download
              behind it is marked rather than listed beside one that has. */}
          {!!blocked.needs?.length && (
            <span className="rs-needs">
              {blocked.needs.map((n, i) => (
                <span key={i} data-fix={n.fixable ? "1" : undefined}>
                  {n.fixable ? <Download size={10} /> : <Ban size={10} />}
                  <b>{n.label}</b>
                  <em>{n.detail}</em>
                </span>
              ))}
            </span>
          )}
        </span>
      </p>
    </>
  );
}

/** A labelled row of buttons. Used instead of a Dropdown wherever the whole
 *  option set is short enough to show — a format or a bitrate is a comparison,
 *  and a closed menu hides the thing being compared. */
function Choice<T extends string | number>({ value, options, onChange, disabled }: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="rs-choice" data-disabled={disabled ? "1" : undefined}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" title={o.title}
                className={"rs-chip" + (o.value === value ? " on" : "")}
                disabled={disabled}
                onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function RenderSettingsModal({
  timeline, clips, output, projectChain, postRefAssetId, postRefMode, postRefStrength,
  postOptions,
  projectId, busy, placeFacts, onRender, onClose,
}: RenderSettingsProps) {
  const [o, setO] = useState<RenderOutput>(() => normalizeOutput(output));
  const [chain, setChain] = useState<PostChain>(() => projectChain);
  const [postRef, setPostRef] = useState<string | null>(() => postRefAssetId ?? null);
  const [refMode, setRefMode] = useState<"source" | "asset">(() => postRefMode ?? "source");
  const [refStrength, setRefStrength] = useState<number>(
    () => Math.max(0, Math.min(1, Number(postRefStrength ?? 1) || 0)));
  const [opts, setOpts] = useState<PostOptions>(() => normalizePostOptions(postOptions));

  // Every edit goes through normalizeOutput, so an illegal combination can
  // never be held in state and shown back as if it were fine. Changing the
  // format is the case that matters: it can invalidate the audio codec (webm
  // will not carry AAC), and that correction has to be VISIBLE here rather
  // than applied silently by the worker half an hour later.
  const set = (patch: Partial<RenderOutput>) => setO((cur) => normalizeOutput({ ...cur, ...patch }));

  // QUALITY RESETS WHEN THE FORMAT DOES, and clamping instead was measurably
  // worse. The scales are not comparable — ProRes 3 is a profile, h264 18 and
  // vp9 31 are CRFs on different curves — so carrying the number across lands
  // you at whatever the new format's clamp allows: going ProRes -> VP9 gave
  // CRF 24, VP9's maximum-quality end, which is several times slower and much
  // larger than the VP9 anyone picking VP9 wanted. Each format's default IS
  // its recommended setting, and the number changes in front of you.
  //
  // normalizeOutput still CLAMPS rather than resets, and that difference is
  // deliberate: it also reads stored settings, where the smallest repair that
  // keeps a saved value usable is the right one.
  const setFormat = (format: VideoFormatId) =>
    setO((cur) => normalizeOutput({ ...cur, format, quality: VIDEO_FORMAT[format].qualityDefault }));

  const def = VIDEO_FORMAT[o.format];
  const size = outputSize(o, timeline.width, timeline.height);
  const up = isUpscale(o, timeline.width, timeline.height);
  const warnings = outputWarnings(o, timeline.width, timeline.height);

  // What the render will actually do, per clip — the same resolution the
  // worker performs, so this cannot disagree with it.
  const resolved = useMemo(
    () => clips.map((c) => resolvePost(c.post, chain)),
    [clips, chain]);
  const overridden = resolved.filter((r) => r.mode === "custom").length;
  const withPasses = resolved.filter((r) => activeOps(r.chain).length).length;
  const gpu = resolved.some((r) => chainNeedsGpu(r.chain));

  // Color Match RAISES without a reference, so a render queued in this state
  // cannot succeed — and it would fail at the END, after every clip and every
  // other pass had spent its GPU time. Blocking here costs a click; letting it
  // through costs the render.
  // Only in "asset" mode: source mode extracts its reference from each
  // clip's own take, so there is nothing to be missing.
  const needsRef = refMode === "asset"
    && resolved.some((r) => r.chain.color_match) && !postRef;

  /* ── can this machine run it ─────────────────────────────────────────── */

  // ASKED FROM THE MACHINE, and re-asked whenever the answer could change —
  // which is on every edit to the post card, because the CHAIN is what decides
  // both whether the engine matters and which weights this machine needs. The
  // harness states the facts instead (`placeFacts`), because it has no bridge.
  const ws = useWorkspaceStore();
  const [facts, setFacts] = useState<RenderFacts | null>(placeFacts ?? null);
  // The resolved chains as a STRING, so the effect re-runs when the passes
  // change and not when `resolved` is merely rebuilt — which it is on every
  // render, since `clips` is a fresh array from the caller.
  const chainSig = useMemo(
    () => JSON.stringify(resolved.map((r) => activeOps(r.chain))), [resolved]);
  React.useEffect(() => {
    if (placeFacts) { setFacts(placeFacts); return; }
    let live = true;
    void renderFacts({ chains: resolved.map((r) => r.chain), opts })
      .then((f) => { if (live) setFacts(f); });
    return () => { live = false; };
    // `chainSig` stands in for `resolved`; `opts` is a fresh object per render
    // too, so the fields the requirements actually read are named instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeFacts, chainSig, opts.post_upscale_model, opts.post_grade_method]);

  // A render with nowhere to go is refused HERE rather than queued and failed
  // by the worker minutes later — `needsRef`'s rule, and the same trade: a
  // click against a render. NOT until the facts have landed: "not asked yet"
  // must not read as "your machine cannot", which would flash a disabled
  // Render button on every open.
  const blocked = facts ? renderBlock(facts) : null;
  const nowhere = !!blocked;

  const qualityLabel = def.quality === "profile"
    ? `ProRes ${PRORES_PROFILES[o.quality] ?? o.quality}`
    : `CRF ${o.quality}`;

  return (
    <ModalShell
      icon={<Clapperboard size={17} />}
      title="Render settings"
      context={describeOutput(o)}
      width={720}
      maxH={760}
      onClose={onClose}
      footer={
        <>
          <div className="ws-mono" style={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}>
            {size.w}x{size.h} · {o.fps ?? timeline.fps}fps · {encoderOf(o)}
            {" · "}
            <span style={{ color: gpu ? "var(--amber)" : undefined }}>
              {gpu ? "this machine · engine" : "this machine"}
            </span>
            <br />
            <span style={{ opacity: 0.6,
                           color: needsRef || nowhere ? "var(--amber)" : undefined }}>
              {/* One line, so the FIRST thing standing between this click and
                  a render is what it says. */}
              {nowhere
                ? "This machine cannot run this render yet."
                : needsRef
                ? "Color Match needs a grade reference before this can render."
                : "Saved as this project's default."}
            </span>
          </div>
          <button className="ws-ghost" onClick={onClose}>Cancel</button>
          <button className="ws-render" disabled={busy || needsRef || nowhere}
                  title={nowhere ? blocked?.why
                         : needsRef ? "Color Match needs a grade reference" : undefined}
                  onClick={() => onRender(o, chain, postRef, refMode, opts, refStrength)}>
            {busy ? <Loader2 size={14} className="ws-spin" /> : <Clapperboard size={14} />}
            <span>Render</span>
          </button>
        </>
      }>
      <div className="ws-modal-body rs-body">

        <Card label="Format">
          <Choice value={o.format}
                  options={VIDEO_FORMATS.map((f) => ({
                    value: f.id as VideoFormatId, label: f.label, title: f.hint,
                  }))}
                  onChange={setFormat} />
          <p className="rs-hint">{def.hint}</p>

          <div className="rs-row">
            <label className="ws-mlabel" style={{ minWidth: 92 }}>Quality</label>
            {def.quality === "profile" ? (
              <Choice value={o.quality}
                      options={Object.entries(PRORES_PROFILES).map(([v, label]) => ({
                        value: Number(v), label,
                      }))}
                      onChange={(quality) => set({ quality })} />
            ) : (
              <>
                {/* Lower CRF = higher quality, which is the opposite of every
                    other slider in this app — so the ends are labelled rather
                    than left to the number. */}
                <span className="rs-end">smaller</span>
                <input type="range" className="rs-range"
                       min={def.qualityMin} max={def.qualityMax} step={1}
                       value={o.quality}
                       onChange={(e) => set({ quality: Number(e.target.value) })} />
                <span className="rs-end">better</span>
              </>
            )}
            <span className="ws-mono rs-val">{qualityLabel}</span>
          </div>

          {def.hwEncoder && (
            <label className="rs-check">
              <input type="checkbox" checked={o.hardware}
                     onChange={(e) => set({ hardware: e.target.checked })} />
              <Cpu size={13} />
              <span>Hardware encode <span className="ws-mono">({def.hwEncoder})</span></span>
            </label>
          )}

          <div className="rs-row">
            <label className="ws-mlabel" style={{ minWidth: 92 }}>Resolution</label>
            {/* Named targets rather than multipliers: "0.75x" makes you do the
                arithmetic to find out what you are delivering. Each is the
                SHORT EDGE, so one label reads correctly on a landscape cut and
                a vertical one — and the computed size sits beside it, which is
                what makes a non-16:9 timeline visible instead of surprising. */}
            <Choice value={o.resolution ?? 0}
                    options={[
                      { value: 0, label: "Timeline",
                        title: `This cut's own frame — ${timeline.width}x${timeline.height}` },
                      ...RESOLUTIONS.map((r) => ({
                        value: r.value, label: r.label, title: r.title,
                      })),
                    ]}
                    onChange={(v) => set({ resolution: v === 0 ? null : Number(v) })} />
            <span className="ws-mono rs-val" data-up={up ? "1" : undefined}>
              {size.w}x{size.h}
            </span>
          </div>

          <div className="rs-row">
            <label className="ws-mlabel" style={{ minWidth: 92 }}>Frame rate</label>
            <Choice value={o.fps ?? 0}
                    options={[
                      { value: 0, label: `Timeline (${timeline.fps})` },
                      { value: 24, label: "24" }, { value: 25, label: "25" },
                      { value: 30, label: "30" }, { value: 60, label: "60" },
                    ]}
                    onChange={(fps) => set({ fps: fps === 0 ? null : Number(fps) })} />
          </div>
        </Card>

        <Card label="Audio">
          <div className="rs-row">
            <label className="ws-mlabel" style={{ minWidth: 92 }}>Codec</label>
            {/* Only the codecs this container will mux. The list changes with
                the format above rather than showing greyed rows, because an
                unavailable option here is not a limitation of the app — it is
                the container's, and there is nothing to enable. */}
            <Choice value={o.audio}
                    options={def.audio.map((id) => ({
                      value: id, label: AUDIO_CODEC[id].label,
                      title: AUDIO_CODEC[id].hint,
                    }))}
                    onChange={(audio) => set({ audio })} />
          </div>
          <p className="rs-hint">{AUDIO_CODEC[o.audio].hint}</p>

          {AUDIO_CODEC[o.audio].bitrates && (
            <div className="rs-row">
              <label className="ws-mlabel" style={{ minWidth: 92 }}>Bitrate</label>
              <Choice value={o.audioBitrate}
                      options={AUDIO_CODEC[o.audio].bitrates!.map((b) => ({
                        value: b, label: `${b}k`,
                      }))}
                      onChange={(audioBitrate) => set({ audioBitrate })} />
            </div>
          )}

          {o.audio !== "none" && o.audio !== "opus" && (
            <div className="rs-row">
              <label className="ws-mlabel" style={{ minWidth: 92 }}>Sample rate</label>
              <Choice value={o.sampleRate}
                      options={SAMPLE_RATES.map((r) => ({ value: r, label: `${r / 1000} kHz` }))}
                      onChange={(sampleRate) => set({ sampleRate })} />
            </div>
          )}
          {o.audio === "opus" && (
            <p className="rs-hint">Opus encodes at 48 kHz; anything else would be
              resampled on the way in, so the control is not offered.</p>
          )}
        </Card>

        <Card label="Post processing">
          <p className="rs-hint" style={{ marginTop: -2 }}>
            The project default. Every clip that has not been given its own
            chain in the inspector follows this one — these run per clip during
            the render, not now.
          </p>
          <PostChainToggles chain={chain} onChange={setChain} disabled={busy} />
          {tunableOps(chain).size > 0 && (
            <>
              <div className="ws-hdiv" />
              <PostOptionsPanel chain={chain} value={opts} disabled={busy}
                                onChange={(patch) => setOpts((c) => ({ ...c, ...patch }))} />
            </>
          )}
          {chain.color_match && (
            // Only when the pass is on: it is the one setting here that is
            // REQUIRED rather than optional, and showing it otherwise is a
            // slot with no consequence.
            <>
              <div className="ws-hdiv" />
              <span className="ws-mlabel">Grade reference</span>
              <PostRefPicker projectId={projectId ?? null} value={postRef}
                             onChange={setPostRef} disabled={busy}
                             mode={refMode} onMode={setRefMode}
                             strength={refStrength} onStrength={setRefStrength} />
            </>
          )}
          <div className="rs-summary">
            <span className="ws-mono">{describeChain(chain)}</span>
            <span className="rs-sep">·</span>
            <span>
              {withPasses} of {clips.length} clip{clips.length === 1 ? "" : "s"} will be processed
              {overridden > 0 && ` · ${overridden} override${overridden === 1 ? "s" : ""} this default`}
            </span>
          </div>
          {gpu && (
            <p className="rs-hint">
              This render drives ComfyUI, so it needs the local engine running
              and takes one clip at a time.
            </p>
          )}
        </Card>

        {/* LAST, because it is the only card that is about neither the file
            nor the picture — and because the two above are what decide it: the
            post chain is what makes the local engine a precondition. Absent
            when nothing is in the way, which is the common case. */}
        {blocked && (
          <Card label="Before this can render">
            {/* CLOSES FIRST, which costs whatever was tuned here and is still
                the right trade: the two modals are in different subtrees at
                the same depth, so leaving this one up puts a second scrim
                behind the engine window with no clear way back — and
                installing an engine is a multi-gigabyte errand, not something
                anyone returns from mid-sentence. */}
            <ReadyNotice blocked={blocked}
                         onFix={(tab) => {
                           // The engine is about to change, so the cached class
                           // list stops being an answer about it. Dropped here
                           // rather than waited out, or a pack installed in the
                           // next minute reads as still absent.
                           forgetInstalledNodes();
                           onClose();
                           ws.openModal({ kind: "engine", tab });
                         }} />
          </Card>
        )}

        {warnings.length > 0 && (
          <div className="rs-warn">
            {warnings.map((w, i) => <p key={i}>{w}</p>)}
          </div>
        )}
      </div>
    </ModalShell>
  );
}
