// "Change the audio" for a timeline block — MMAudio over a take's own picture,
// published as a NEW TAKE of that block.
//
// It is a take rather than an edit-in-place for the reason every derived take
// here is one: the old sound is not destroyed, the review path already applies,
// and activating it repoints the lane through machinery that already exists. It
// is a take rather than a LIBRARY ASSET because a soundtrack that lives beside
// the shot instead of on it is one more thing to line up by hand.
//
// The picture is COPIED, never re-encoded (`media.replace_audio`, `-c:v copy`).
// Two things follow, and both are stated on screen because neither is visible
// in the result: the frames are bit-identical, so nothing downstream in a chain
// goes stale; and the clip's LENGTH cannot change, because `apad` + `-shortest`
// end the mux at the picture.
import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AudioLines, Check, Loader2, Wand2, X } from "lucide-react";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { mediaUrl, supabase } from "../../lib/supabase";
import { enqueueJob, USER_PRIORITY } from "../../lib/db/jobs";
import { invalidateTables } from "../../hooks/useLiveQuery";
import { v2aModels } from "../../lib/catalog";
import { useLocalEngine } from "../../hooks/useLocalEngine";
import { plannerInstalled } from "../../lib/desktopPlanner";
import { isDesktopReady, markDesktopRows } from "../../lib/desktopRows";
import TieredModelMenu, { rowBlocked, TierIcon } from "../ui/TieredModelMenu";
import { tierOf } from "../../lib/localModels";
import Dropdown from "../ui/Dropdown";
import { modelKeyOf } from "../../lib/projectSettings";
import { describeDirectorError, enhancePrompt } from "../../lib/director";
import {
  DEFAULT_NEGATIVE, clampSeconds, durationNote, framesNeeded, v2aDefaults,
  v2aLabel, v2aPayload,
} from "../../lib/mmaudio";
import type { Asset, BlockTake, GenerationBlock, ModelCatalogRow } from "../../lib/db/types";

const STEPS = [10, 15, 25, 35, 50];
const CFGS = [3, 3.5, 4, 4.5, 5, 6, 7];

/** The offered values PLUS the row's own, sorted.
 *
 *  A `<select>` cannot display a value that is not one of its options — it
 *  silently falls back to the first — so a model whose recipe sits outside
 *  these lists showed "Steps 10" while `v2aPayload` sent its declared 4. The
 *  control disagreeing with the render, over a number nobody typed, is the
 *  silent-downgrade shape this codebase keeps naming; caught in
 *  `/ui/blockaudio` against a distilled fixture, not by a test. */
const withDefault = (list: number[], v: number) =>
  [...new Set([...list, v])].sort((a, b) => a - b);

interface TakeRow { take: BlockTake; asset: Asset | null }

export interface BlockAudioData {
  block: GenerationBlock;
  takes: TakeRow[];
  projectId: string | null;
  episodeId: string | null;
  models: ModelCatalogRow[];
}

/** Read the block, its takes and their assets. Hoisted out of the component so
 *  `/ui/blockaudio` can substitute fixtures: this screen is behind a sign-in,
 *  a project, an episode and a rendered block, and the two things most likely
 *  to be wrong about it are pictures — whether a 9:16 take's tile is the right
 *  SHAPE, and whether the negative field appears at all. */
export async function loadBlockAudio(blockId: string): Promise<BlockAudioData | null> {
  const { data: block } = await supabase.from("generation_blocks")
    .select("*").eq("id", blockId).maybeSingle();
  if (!block) return null;
  const b = block as GenerationBlock;
  const { data: takes } = await supabase.from("block_takes")
    .select("*").eq("block_id", blockId).order("created_at");
  const rows = (takes ?? []) as BlockTake[];
  const ids = rows.map((t) => t.asset_id).filter(Boolean) as string[];
  const { data: assets } = ids.length
    ? await supabase.from("assets").select("*").in("id", ids)
    : { data: [] as Asset[] };
  const byId = new Map((assets ?? []).map((a) => [(a as Asset).id, a as Asset]));
  const { data: story } = await supabase.from("storyboards")
    .select("episode_id").eq("id", b.storyboard_id).maybeSingle();
  const epId = (story as { episode_id?: string } | null)?.episode_id ?? null;
  const { data: ep } = epId
    ? await supabase.from("episodes").select("project_id").eq("id", epId).maybeSingle()
    : { data: null };
  return {
    block: b,
    // Newest first: the take you want to re-score is almost always the one
    // that just landed.
    takes: rows.map((t) => ({ take: t, asset: byId.get(t.asset_id ?? "") ?? null }))
      .filter((r): r is TakeRow => !!r.asset).reverse(),
    projectId: (ep as { project_id?: string } | null)?.project_id ?? null,
    episodeId: epId,
    models: await v2aModels().catch(() => [] as ModelCatalogRow[]),
  };
}

export default function BlockAudioModal({
  blockId, clipId, load = loadBlockAudio, enqueue = enqueueJob,
}: {
  blockId: string;
  clipId?: string;
  /** Harness seam — see `loadBlockAudio`. */
  load?: (id: string) => Promise<BlockAudioData | null>;
  /** Harness seam, and the important half: `/ui/blockaudio` renders against
   *  fixtures, so a review screen must not be able to spend GPU time by being
   *  opened. Same rule StaleBlocksModal states for its own `queue`. */
  enqueue?: typeof enqueueJob;
}) {
  const ws = useWorkspaceStore();
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState(DEFAULT_NEGATIVE);
  const [takeId, setTakeId] = useState<string | null>(null);
  const [modelId, setModelId] = useState("");
  const [steps, setSteps] = useState(0);
  const [cfg, setCfg] = useState(0);
  const [mask, setMask] = useState(false);
  /** "replace" is the default here, unlike the clip retake modal. Changing a
   *  block's audio is a CONTENT edit — the user asked for the shot to sound
   *  different, so the different one should play — and history keeps the old
   *  takes either way. */
  const [activate, setActivate] = useState<"replace" | "review">("replace");
  const [busy, setBusy] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const { data } = useLiveQuery(
    async () => load(blockId),
    ["block_takes", "generation_blocks"], [blockId]
  );

  const takes = data?.takes ?? [];
  /** The block's ACTIVE take unless the user picked another — which is the
   *  point of offering the list: re-scoring take 1 while take 3 is on the lane
   *  publishes a take built from a picture nobody is watching. */
  const chosen = useMemo(
    () => takes.find((r) => r.take.id === takeId)
      ?? takes.find((r) => r.take.id === data?.block.active_take_id)
      ?? takes[0] ?? null,
    [takes, takeId, data?.block.active_take_id]);

  // THE CATALOGUE READ IS SUPABASE-ONLY, so a model this machine can render
  // arrives here looking exactly like one it cannot. `markDesktopRows` is what
  // adds that — the same mark the Audio & Voice studio applies, so the two
  // surfaces cannot disagree about where one render goes.
  const engine = useLocalEngine();
  const [plannerOk, setPlannerOk] = useState(false);
  React.useEffect(() => { void plannerInstalled().then(setPlannerOk); }, []);
  const models = useMemo(
    () => markDesktopRows(data?.models ?? [],
      { status: engine.status, planner: plannerOk, engineUp: engine.running }),
    [data?.models, engine.status, engine.running, plannerOk]);
  // A pick can be REFUSED (not downloaded, engine asleep, a studio row a
  // member cannot spend), and a refused row must not become the default just
  // because it is first — the submit would queue onto a lane nothing claims.
  //
  // ASKED WITH THE SAME `admin` THE MENU USES. Hardcoding `true` here made the
  // two disagree: the menu greyed a studio row for a member while this picked
  // it as the default, so the modal opened on a model its own list refused.
  const usable = models.filter((m) => !rowBlocked(m));
  const model = models.find((m) => m.id === modelId) ?? usable[0] ?? models[0] ?? null;
  const blocked = model ? rowBlocked(model) : null;
  const def = useMemo(() => v2aDefaults(model), [model]);
  const seconds = chosen
    ? clampSeconds(chosen.asset?.duration_ms ?? def.trainedSeconds * 1000, def.maxSeconds)
    : 0;
  const lenNote = chosen ? durationNote(seconds, def.trainedSeconds) : null;

  const enhance = async () => {
    const text = prompt.trim();
    if (!text || enhancing) return;
    setEnhancing(true);
    try {
      const res = await enhancePrompt({
        prompt: text, kind: "v2a", family: model?.family ?? null, mode: "v2a",
        model_label: model?.display_name ?? null,
        project_id: data?.projectId ?? undefined,
      });
      setPrompt(res.prompt);
      const hops = res.fell_back ?? [];
      setNote((res.guide.exact
        ? `Rewritten with the ${res.guide.label} guide.`
        : "No stored guide for this model — rewritten with general sound-design craft.")
        + (hops.length ? ` (${hops[0].from} ${hops[0].reason} — ${res.backend} wrote it.)` : ""));
    } catch (e) {
      setNote(`Couldn't enhance: ${describeDirectorError(String((e as Error).message || e))}`);
    } finally {
      setEnhancing(false);
    }
  };

  const queue = async () => {
    if (busy || !chosen || !model) return;
    setBusy(true);
    setNote(null);
    try {
      const payload = v2aPayload({
        sourceAssetId: chosen.asset!.id,
        model,
        modelKey: modelKeyOf(model.id),
        prompt,
        negative,
        durationMs: chosen.asset?.duration_ms ?? def.trainedSeconds * 1000,
        steps: steps || undefined,
        cfg: cfg || undefined,
        maskAwayClip: mask,
        projectId: data?.projectId ?? undefined,
        blockId,
        takeId: chosen.take.id,
        activate,
      });
      await enqueue({
        // WHERE IT RUNS FOLLOWS THE ROW, not a literal. Hardcoding `gpu` was
        // right while nothing local could score a clip; with the weights and
        // both node packs on this machine the pod is a box that need not even
        // be awake. `local` is the lane only this machine claims.
        kind: "v2a_gen",
        lane: isDesktopReady(model) ? "local" : "gpu",
        priority: USER_PRIORITY,
        project_id: data?.projectId ?? undefined,
        episode_id: data?.episodeId ?? undefined,
        model_id: model.id,
        payload: {
          ...payload,
          label: v2aLabel({
            blockLabel: `Block ${(data?.block.idx ?? 0) + 1}`, prompt,
          }),
        },
      });
      // The grid and the queue popover both read `jobs`; invalidating here is
      // what makes the row appear on this tick instead of after the realtime
      // round trip, which is the window that reads as a dead button.
      invalidateTables(["jobs"]);
      setNote(activate === "replace"
        ? "Queued — the new take will replace this block on the lane when it lands."
        : "Queued — it will arrive pending beside the other takes; pick it in the strip.");
    } catch (err) {
      setNote(`Couldn't queue it: ${(err as Error)?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  };

  const label = data ? `Block ${data.block.idx + 1}` : "Block";
  return createPortal(
    <div className="ws-scrim" onClick={() => ws.closeModal()}>
      <div className="ws-modal ba" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="ws-modal-head">
          <div className="ws-modal-ico"><AudioLines size={16} /></div>
          <div style={{ flex: 1 }}>
            <div className="ws-modal-t">Change the audio · {label}</div>
            <div className="ws-modal-c">
              A model watches this take and writes a new soundtrack for it. The
              picture is copied untouched — same frames, same length.
            </div>
          </div>
          <button className="ws-ghost" style={{ width: 34, height: 34, padding: 0, justifyContent: "center" }}
                  onClick={() => ws.closeModal()} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="ws-modal-body ba-body ns-scroll">
          {!data && <div className="mono ba-dim">Loading the block…</div>}

          {data && !takes.length && (
            <div className="mono ba-dim">
              This block has no rendered take yet, so there is no picture to
              score. Render it first.
            </div>
          )}

          {data && !!takes.length && (
            <>
              {/* WHICH TAKE. Not decoration: the source picture is what the
                  model watches AND what the new take is built from, so
                  re-scoring a superseded take publishes a shot nobody is
                  watching. Defaults to the active one. */}
              <section className="ba-sec">
                <h4>Score which take</h4>
                <div className="ba-takes ns-scroll">
                  {takes.map(({ take, asset }, i) => {
                    const on = chosen?.take.id === take.id;
                    const active = take.id === data.block.active_take_id;
                    return (
                      <button key={take.id} className={`ba-take${on ? " on" : ""}`}
                              onClick={() => setTakeId(take.id)}
                              title={`${take.kind ?? "take"} · ${
                                asset?.duration_ms ? (asset.duration_ms / 1000).toFixed(1) + "s" : "unknown length"}`}>
                        <video src={mediaUrl(asset!.b2_key) ?? undefined} muted preload="metadata" />
                        <span className="cap">
                          <b>Take {takes.length - i}</b>
                          {active && <em>on the lane</em>}
                          {take.kind === "audio" && <em>re-scored</em>}
                        </span>
                        {on && <span className="tick"><Check size={11} /></span>}
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* WHAT TO HEAR. The model can already see the shot — the prompt
                  says which of the sounds it could plausibly make are the ones
                  wanted, which is why the guide is its own kind. */}
              <section className="ba-sec">
                <h4>What should it sound like</h4>
                <div className="ba-field">
                  <textarea className="ws-input ns-scroll" rows={3} value={prompt}
                            placeholder="The sound sources you want, most important first — 'boots on wet gravel, a chain-link gate rattling, distant traffic'. Leave it empty to let the picture decide."
                            onChange={(e) => setPrompt(e.target.value)} />
                  <button className="ba-wand" disabled={!prompt.trim() || enhancing}
                          title="Rewrite against this model's prompt guide"
                          onClick={() => void enhance()}>
                    {enhancing ? <Loader2 size={12} className="ns-spin" /> : <Wand2 size={12} />}
                  </button>
                </div>
                {/* A LABEL, not just a placeholder. This field ships with a
                    value in it ("music, speech, voices" is the vendor's own
                    clean-bed default), so its placeholder is never once
                    visible — leaving an unexplained box of words directly
                    under the prompt, which reads as a second prompt. */}
                {def.takesNegative && (
                  <div className="ba-neg">
                    <label htmlFor="ba-neg-in">
                      Negative prompt <em>sounds to keep out</em>
                    </label>
                    <input id="ba-neg-in" className="ws-input" value={negative}
                           placeholder="e.g. music, speech, voices"
                           onChange={(e) => setNegative(e.target.value)} />
                  </div>
                )}
              </section>

              <section className="ba-sec">
                <h4>Render</h4>
                <div className="ba-row">
                  <label>Model</label>
                  {/* THE TIER IS THE FIRST THING TO KNOW HERE — whether this
                      render wakes a $3.36/hr box or runs on the laptop — and a
                      plain <select> could say neither that nor why a row was
                      unpickable. Same menu as every other picker in the app. */}
                  <Dropdown width={300} className="ba-modelpick" trigger={({ toggle }) => (
                    <button className="ws-input ba-modelbtn" onClick={toggle}>
                      <TierIcon tier={model ? tierOf(model) : null} />
                      <span style={{ flex: 1, minWidth: 0, textAlign: "left",
                                     overflow: "hidden", textOverflow: "ellipsis" }}>
                        {model?.display_name ?? "No video-to-audio model in the catalog"}
                      </span>
                    </button>
                  )}>
                    {(close) => (
                      <TieredModelMenu models={models} value={model?.id ?? null}
                                       close={close} onPick={setModelId} />
                    )}
                  </Dropdown>
                </div>
                {blocked && (
                  <p className="ba-hint" style={{ color: "#ffb454" }}>
                    {blocked.why}.
                  </p>
                )}
                <div className="ba-row">
                  <label>Steps</label>
                  <select className="ws-input" value={steps || def.steps}
                          onChange={(e) => setSteps(Number(e.target.value))}>
                    {withDefault(STEPS, def.steps).map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                  <label>Guidance</label>
                  <select className="ws-input" value={cfg || def.cfg}
                          onChange={(e) => setCfg(Number(e.target.value))}>
                    {withDefault(CFGS, def.cfg).map((v) => <option key={v} value={v}>{v.toFixed(1)}</option>)}
                  </select>
                </div>
                <label className="ba-check" title={
                  "Drops the visual semantics and keeps only the timing, so the sound "
                  + "still lands on the motion but is described entirely by your prompt. "
                  + "Worth trying when the shot is stylised, very dark, or misleading "
                  + "about what is making the noise."}>
                  <input type="checkbox" checked={mask}
                         onChange={(e) => setMask(e.target.checked)} />
                  <span>Ignore what it looks like, keep the timing</span>
                </label>
                {/* THE LENGTH IS THE TAKE'S and cannot change — the mux ends at
                    the picture. Stated because a model that quantises its own
                    output to a latent grid would otherwise look like it had
                    retimed the shot. */}
                {chosen && (
                  <div className="ba-note">
                    <b>{seconds.toFixed(1)}s</b> — the take's own length, unchanged.
                    {" "}{framesNeeded(seconds, def.syncFps)} frames at {def.syncFps}fps.
                    {lenNote && <span className="warn"> {lenNote}</span>}
                  </div>
                )}
              </section>

              <div className="ba-modes">
                {([["replace", "Play it on the lane",
                    "It becomes the active take and the clip repoints. The old takes stay."],
                   ["review", "Land beside the other takes",
                    "It arrives pending — pick it in the takes strip when you have listened."]] as const)
                  .map(([v, t, hint]) => (
                    <button key={v} type="button" className="ws-ghost" title={hint}
                            onClick={() => setActivate(v)}
                            style={{ flex: 1, justifyContent: "center",
                              ...(activate === v ? {
                                borderColor: "rgba(90,162,255,.55)", color: "#8fc2ff",
                                background: "rgba(90,162,255,.10)" } : {}) }}>
                      {t}
                    </button>
                  ))}
              </div>
            </>
          )}

          {note && (
            <div className="mono" style={{ fontSize: 12,
              color: note.startsWith("Couldn't") ? "#ff8a8a" : "#8fc2ff" }}>{note}</div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="ws-ghost" onClick={() => ws.closeModal()}>Close</button>
            <button className="ws-primary" disabled={busy || !chosen || !model}
                    onClick={() => void queue()}>
              {busy ? <Loader2 size={14} className="ns-spin" /> : "Generate the audio"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
