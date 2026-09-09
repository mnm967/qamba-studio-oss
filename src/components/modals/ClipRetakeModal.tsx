// Retakes for a CLIP-BORN block — the takes system for extend/chain renders.
//
// A block made by the timeline's generate actions carries `params.clip_gen`
// (its re-runnable render recipe) and NO beats, so PromptRefsModal — whose
// whole retake path is "rewrite the beats, recompile, master_pass" — has
// nothing true to say about it: the brief would queue a revise_block over
// zero shots and the compiled-prompt card would render an empty envelope.
// This modal is the honest counterpart: edit the PROMPT (which IS the format
// on this path — invariant #6's documented exception), roll a seed, choose
// whether the take replaces the lane or lands beside the others.
//
// `BlockRetakeRouter` is the default export and the ONLY thing Workspace
// mounts for `kind: "prompt"`: it reads the block's params once and renders
// whichever modal is true for it. Routing here rather than at each opener
// (takes strip, storyboard rows, hover popovers) means no surface can forget.
import React, { useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Layers, Loader2, RefreshCw, Undo2, Wand2, X } from "lucide-react";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import { clipGenRecipe, type ClipGenRecipe } from "../../lib/blockFromClip";
import { blockKind, blockLabel, isClipBorn, type BlockKind } from "../../lib/blockKind";
import { queueBlockRender } from "../../lib/db/jobs";
import { loadCatalog } from "../../lib/catalog";
import {
  backendLabel, describeDirectorError, enhanceAlignment, enhanceGuide, enhancePrompt,
} from "../../lib/director";
import { modelKeyOf, styleTextFor, type ProjectSettings } from "../../lib/projectSettings";
import {
  COPY, danglingPictureRefs, defaultMode, editBlocker, editPayload, isUsableAnchor,
  readsAsRemoval, resolveAnchor, type RetakeCaps, type RetakeMode, type TakeRef,
} from "../../lib/retake";
import RefTiles from "../ui/RefTiles";
import AssetPickerModal from "./AssetPickerModal";
import type { Asset } from "../../lib/db/types";
import PromptRefsModal from "./PromptRefsModal";
import ModalShell, { Z_MODAL } from "./ModalShell";
import type { GenerationBlock } from "../../lib/db/types";

const KIND_BLURB: Record<BlockKind, string> = {
  chain: "A chain — the bridge between two shots. It renders from this prompt "
    + "and its two anchor frames, not from storyboard beats.",
  extend: "An extension — more of the shot before it. It renders from this "
    + "prompt and its opening frame, not from storyboard beats.",
  shot: "A generated shot. It renders from this prompt, not from storyboard beats.",
  trim: "", plan: "",
};

/** `.ws-ghost` at chip size. Deliberately not `.bam-mini`: that class belongs
 *  to the extend/chain modal and lives in timeline.css, which the routes that
 *  can open THIS modal do not all load — the same reason `.tas-` and `.pr-`
 *  keep to their own screens. */
const MINI: React.CSSProperties = {
  height: 24, padding: "0 9px", borderRadius: 8, gap: 5,
  fontSize: 11, fontFamily: "var(--font-mono, monospace)",
};

function ClipRetakeModal({ block, recipe }: { block: GenerationBlock; recipe: ClipGenRecipe }) {
  const ws = useWorkspaceStore();
  const [prompt, setPrompt] = useState(recipe.prompt);
  /** "review" lands the take PENDING beside the others — the takes-system
   *  default, since picking between takes is what this block class is FOR.
   *  "replace" activates it and repoints the lane, the master_pass norm. */
  const [activate, setActivate] = useState<"review" | "replace">("review");
  const [busy, setBusy] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  /** What the box held before the rewrite, so one click puts it back. An
   *  enhance REPLACES what is in there — on the regenerate tab routinely a
   *  compiled envelope somebody already edited — so it has to be undoable.
   *  KEYED BY INTENT, because the two tabs hold different things and an undo
   *  offered over the wrong box would put a prompt into the brief. */
  const [preEnhance, setPreEnhance] =
    useState<{ mode: RetakeMode; text: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /**
   * THE SECOND INTENT, which this modal did not have.
   *
   * A clip-born block has takes like any other, and `handle_video_edit` has
   * never needed beats — it anchors on an ASSET and takes `block_id` only to
   * inherit the checkpoint and to publish the result as a take. So "hold this
   * take and change one thing" was available on the beats path and missing
   * here for no reason but the tabs never being drawn: to swap a character or
   * a background you had to re-roll the whole shot and lose everything else
   * in it. The decisions are `lib/retake.ts`'s, shared rather than restated.
   */
  const [intent, setIntent] = useState<RetakeMode | null>(null);
  /** The edit's own instruction. NOT the prompt: an edit's words go into the
   *  vendor's edit envelope verbatim (`compile_video_edit`), where the
   *  regenerate path's box holds the whole compiled prompt. */
  const [brief, setBrief] = useState("");
  /** The edit's own pictures — what it brings IN. Deliberately not the
   *  block's staged set: an edit composes from the anchor, which already
   *  holds the identity, the place and the framing. */
  const [editRefs, setEditRefs] = useState<Asset[]>([]);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);

  const { data, error } = useLiveQuery(
    async () => {
      const [{ data: takes }, { data: story }, models] = await Promise.all([
        // `asset_id` and `state` are what an anchor is judged on, and
        // `created_at` is the order the takes strip shows them in — selecting
        // the id alone was enough to COUNT them and not to hold one.
        supabase.from("block_takes")
          .select("id,asset_id,state,created_at")
          .eq("block_id", block.id).order("created_at", { ascending: true }),
        // ONE LEVEL OF EMBED, and the ceiling is the LOCAL PLANE's rather than
        // PostgREST's. `localQuery.parseSelect` refuses a nested embed outright
        // — handing back the outer row with the inner half missing is exactly
        // the silent wrong answer that module exists to prevent — and
        // `.select()` throws SYNCHRONOUSLY, inside this very Promise.all,
        // before the takes query is so much as awaited.
        //
        // This chase used to ask for
        // `episodes(project_id,projects(settings,style))` in one round, to save
        // two sequential awaits. On a local project that rejected the WHOLE
        // loader: `data` stayed null, and because a failed load and a slow one
        // rendered identically, the modal read as though it were still loading
        // — the meta row on "…", the primary button offering "take 1" over a
        // block that already had one, and the Edit tab disabled as "nothing to
        // hold yet" with a perfectly good anchor sitting underneath it. The
        // project row is a second round now, and `loadErr` below is the other
        // half of that fix.
        supabase.from("storyboards")
          .select("episode_id,episodes(project_id)")
          .eq("id", block.storyboard_id).maybeSingle(),
        // The WHOLE catalog, not videoModels(): that filters `enabled`, which
        // records whether the STUDIO holds a key rather than whether the model
        // works, so a block rendered on a hosted or BYOK row resolved to
        // nothing and was named by its bare model_map key.
        loadCatalog().then((all) => all.filter((m) => m.kind === "video")).catch(() => []),
      ]);
      const ep = (story as {
        episode_id?: string;
        episodes?: { project_id?: string } | null;
      } | null) ?? null;
      const projectId = ep?.episodes?.project_id ?? null;
      // The second round, asked only when there is an id to ask with. What it
      // carries — the style guide and the director backend — grounds a REWRITE
      // and nothing else: the takes, the anchor and the Edit gate are all
      // decided without it, so a project row that cannot be read costs the
      // enhance button its style and leaves the rest of this modal working.
      const { data: projRow } = projectId
        ? await supabase.from("projects")
            .select("settings,style").eq("id", projectId).maybeSingle()
        : { data: null };
      const proj = (projRow as
        { settings?: ProjectSettings | null; style?: string | null } | null) ?? null;
      const settings = proj?.settings ?? null;
      // The recipe stores a model_map KEY; the catalog speaks ids. Inverted
      // via modelKeyOf (the PanelRegenModal precedent) so the header can name
      // the model rather than print its key.
      const row = (models ?? []).find((m) => modelKeyOf(m.id) === recipe.model_key);
      const rows = (takes ?? []) as TakeRef[];
      return {
        takes: rows,
        takeCount: rows.length,
        // What Edit needs to know about the model, straight off the catalog
        // row: `refVideos` is the budget for the anchor (it rides in as H3's
        // `<Video 1>`, a separate count from the pictures) and `modes` is what
        // the worker will let it render — `handle_video_edit` is hardcoded to
        // r2v, so a row with the budget and no r2v queues clean and dies.
        caps: (row?.capabilities ?? {}) as RetakeCaps,
        modes: row?.modes ?? [],
        episodeId: ep?.episode_id ?? null,
        projectId,
        modelName: row?.display_name ?? recipe.model_key ?? "the project default",
        // WHICH GUIDE a rewrite follows, and it comes off the RECIPE's own
        // model rather than the project default: the recipe is what a retake
        // replays, and `handle_clip_gen` falls back to plain H3 when it names
        // no model, not to whatever the project happens to prefer. A family
        // that does not resolve is REPORTED as general craft, never guessed —
        // `enhanceGuide` returns `exact: false` and the button says so.
        family: row?.family ?? null,
        style: styleTextFor(settings, proj?.style ?? null).text || null,
        // Same routing rule as the director dock and the library composer:
        // the local backend is queued by the
        // browser rather than served by the gated endpoint.
        backend: settings?.director_backend || "auto",
      };
    },
    ["block_takes"], [block.id]
  );

  const durMs = Number(recipe.duration_ms) || 0;

  // ── the two intents ──────────────────────────────────────────────────────
  // Every rule here is `lib/retake.ts`'s, so the beats path and this one
  // cannot drift about when an edit is possible, which take it holds, or what
  // the copy says. `editWhy` is a REASON rather than a boolean: "you cannot"
  // and "nothing has rendered yet" are different amounts of help.
  const takes = data?.takes ?? [];
  /**
   * A LOADER THAT THREW MUST NOT READ AS ONE THAT IS STILL RUNNING.
   *
   * Every "loading" state in this modal is `data == null`, and until this was
   * read the two were the same screen: a rejected loader leaves `data` null
   * forever, so the meta row sat on "…", the primary button offered a take
   * number computed from zero takes, and the Edit tab was disabled as "nothing
   * to hold yet" — over a block whose take was perfectly good. Telling that
   * apart from a slow network took a screenshot, which is the whole argument
   * for showing it. A REASON rather than a boolean, for `editWhy`'s reason:
   * the sentence is what somebody wondering why the tab is grey actually needs.
   */
  const loadErr = error ? String((error as Error).message || error) : null;
  const editWhy = data
    ? editBlocker(takes, data.caps, data.modelName, data.modes)
    : loadErr
      ? "This block's takes and model didn't load, so there is nothing to anchor an edit on."
      : "Loading…";
  /**
   * WHY THE PRIMARY BUTTON REFUSES, or "" when it will queue — and the state
   * it exists for is `data == null`, on BOTH intents.
   *
   * An edit already stopped there, because `editWhy` folds the load in. A
   * REGENERATE did not: it looked perfectly queueable, and `project_id` /
   * `episode_id` are both `data?.…`. `queueBlockRender` passes those straight
   * through to `enqueueJob` and derives neither, so the job row went out with
   * both null and nothing downstream repaired it — a render that is queued and
   * mis-scoped is worse than one that is refused, because it still runs, still
   * costs the GPU, and lands filed under nothing.
   *
   * Deliberately NOT extended to the empty prompt or the empty brief: those
   * are the caller's own preconditions, `queue()` already reports them, and
   * turning them into a disabled button here is a different change.
   */
  const queueWhy = data ? ""
    : loadErr
      ? "This block's details didn't load, so a render queued from here would go out with "
        + "no project or episode. Reopen this to try again."
      : "Still reading this block's takes and model.";
  const anchor = resolveAnchor(takes, anchorId, block.active_take_id ?? null);
  // Opened on the intent that is TRUE for this block: a block with a usable
  // take is usually opened to change what is in it. Held in state as null
  // until the takes land, or the modal would open on regenerate every time
  // and flip under the pointer.
  const mode: RetakeMode = intent
    ?? (data ? defaultMode(takes, data.caps, data.modelName, data.modes) : "regenerate");
  const copy = COPY[mode];
  const editing = mode === "edit";
  /** Eight is `handle_video_edit`'s own slice, and the anchor does not count
   *  against it — it rides the VIDEO budget (official §2.5). */
  const EDIT_REF_CAP = 8;

  /**
   * Rewrite the prompt against the guide of the model this block renders on.
   *
   * The extend/chain modal has had this button since the guides shipped and
   * the RETAKE of the same render did not — which is the wrong way round: a
   * retake is where you argue with a prompt that came back not quite right,
   * and on this path the prompt IS the format. `handle_clip_gen` sends
   * `payload.prompt` to ComfyUI verbatim (invariant #6's one documented
   * exception), so a chain whose envelope has drifted out of shape — a lost
   * alignment line, a description edited into prose — has nothing else to put
   * it back.
   *
   * IT SERVES BOTH TABS, and it asks each one for a different thing. The
   * regenerate box holds the whole compiled prompt, so its rewrite is the
   * vendor envelope. The edit brief is the exact opposite case:
   * `h3_prompt.compile_video_edit` writes that envelope AROUND those words —
   * they land inside "The one change: …" — so a rewrite shaped like a prompt
   * would nest one envelope in another, and a rewrite that described the shot
   * would re-specify what the envelope has just declared held. `shape: "edit"`
   * swaps the system prompt for `editSystem`, which asks for the clause.
   *
   * Explicit and undoable, the library composer's own rule: the rewrite lands
   * in the box for review rather than going straight to the render, and
   * `preEnhance` puts back what was there. A backend hop is REPORTED.
   */
  const guide = enhanceGuide({ family: data?.family, kind: "video", mode: recipe.mode });
  const enhance = async () => {
    const text = (editing ? brief : prompt).trim();
    if (!text || enhancing || !data) return;
    setEnhancing(true);
    setNote(null);
    try {
      const res = await enhancePrompt({
        prompt: text, kind: "video",
        family: data.family, mode: recipe.mode ?? null,
        model_label: data.modelName,
        project_id: data.projectId,
        backend: data.backend,
        // EVERYTHING WITHHELD FROM AN EDIT IS WITHHELD ON PURPOSE. The style
        // guide, the pass duration and the H3 alignment line all describe a
        // PROMPT, and on a brief each argues for one of the two things the
        // envelope forbids — restating the look, and emitting envelope
        // structure. `refs` is the EDIT's own strip, which is what
        // `compile_video_edit` numbers <Picture 1..N>, and not the block's
        // staged set: an edit composes from the anchor.
        ...(editing ? { shape: "edit" as const, refs: editRefs.length } : {
          style: data.style,
          // What the render actually stages, so the rewrite knows how many
          // pictures it may refer to and whether the opening frame is fixed.
          refs: Array.isArray(recipe.ref_asset_ids) ? recipe.ref_asset_ids.length : 0,
          has_start: !!recipe.start_asset_id,
          // Arithmetic, not writing: H3's keyframe modes open on a fixed vendor
          // instruction line carrying the real render duration to two decimals.
          // Computed here from the recipe's own length and sent verbatim, so a
          // rewritten chain still aligns Picture 2 with the end of the pass.
          ...(durMs ? { duration_ms: durMs, alignment: enhanceAlignment(recipe.mode, durMs) } : {}),
        }),
      });
      setPreEnhance({ mode, text });
      if (editing) setBrief(res.prompt); else setPrompt(res.prompt);
      const how = editing
        ? "Sharpened into the one clause this edit carries"
        : res.guide.exact
          ? `Rewritten with the ${res.guide.label} prompt guide`
          : `${data.modelName} has no stored guide — rewritten with general video craft`;
      const hops = res.fell_back ?? [];
      setNote(hops.length
        ? `${backendLabel(hops[0].from)} ${hops[0].reason} — ${backendLabel(res.backend)} wrote this instead. ${how}.`
        : `${how}.`);
    } catch (err) {
      setNote(`Couldn't enhance: ${describeDirectorError(String((err as Error).message || err))}`);
    } finally {
      setEnhancing(false);
    }
  };

  const queue = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      // Checked here as well as on the button, for `editWhy`'s reason one line
      // down: a refetch can fail between the render that enabled this and the
      // click that used it.
      if (queueWhy) throw new Error(queueWhy);
      if (editing) {
        // `video_edit` already IS what Edit promises — the anchor becomes H3's
        // `<Video 1>` under "preserve its framing, timing and subjects except
        // where the instruction changes them" — so this reuses it rather than
        // inventing a flag no handler reads. `editPayload` is the beats path's
        // own builder; only `activate` is ours, because this modal HAS the
        // review/replace choice and a control that changes nothing is worse
        // than no control.
        if (editWhy) throw new Error(editWhy);
        if (!anchor.take) throw new Error("No take to anchor this edit on.");
        if (!brief.trim()) throw new Error("Name the one thing that changes.");
        // A `Picture N` nothing stages is an instruction pointing at nothing:
        // `compile_video_edit` defines a subject per STAGED picture, so the
        // label binds to no reference and the take comes back unchanged. The
        // worker refuses it too; refusing here saves the claim and the wait.
        const dangling = danglingPictureRefs(brief, editRefs.length);
        if (dangling.length) {
          throw new Error(
            `The brief names ${dangling.map((n) => `Picture ${n}`).join(", ")}, and this `
            + `edit stages ${editRefs.length}. Add the picture below, or drop the label.`);
        }
        await queueBlockRender(block.id, {
          kind: "video_edit", lane: "gpu",
          blockIdx: block.idx,
          model_id: "h3-local",
          project_id: data?.projectId ?? undefined,
          episode_id: data?.episodeId ?? undefined,
          payload: editPayload({
            anchor: anchor.take, anchorNo: anchor.index, blockIdx: block.idx,
            brief,
            refAssetIds: editRefs.map((r) => r.id),
            // HELD, not rolled. The whole promise is that only the named thing
            // moves, and a fresh seed re-decides everything the anchor was
            // holding — see `defaultSeedMode`.
            seed: Number(recipe.seed) || 42,
            modelKey: recipe.model_key ?? null,
            loras: recipe.loras,
            ...(recipe.width && recipe.height
              ? { width: Number(recipe.width), height: Number(recipe.height) } : {}),
            activate,
          }),
        });
        setNote(activate === "review"
          ? `Queued — the edit of take ${anchor.index} will land beside the others.`
          : `Queued — the edit of take ${anchor.index} will replace this block on the lane.`);
        return;
      }
      // The edited prompt is the BLOCK's recipe now, not this retake's alone —
      // `master_pass` reads params.clip_gen at claim time, so persisting first
      // is what makes the edit reach the render (and every later one).
      const text = prompt.trim();
      if (!text) throw new Error("The prompt is empty — a clip-born block renders from it.");
      if (text !== recipe.prompt) {
        const { error } = await supabase.from("generation_blocks")
          .update({ params: { ...(block.params ?? {}), clip_gen: { ...recipe, prompt: text } } })
          .eq("id", block.id);
        if (error) throw error;
      }
      await queueBlockRender(block.id, {
        blockIdx: block.idx,
        model_id: "h3-local",
        project_id: data?.projectId ?? undefined,
        episode_id: data?.episodeId ?? undefined,
        payload: {
          // handle_master_pass delegates to the clip recipe; the seed is a
          // fresh roll or the retake is the identical picture.
          seed: Math.floor(Math.random() * 1e9) + 1,
          activate,
        },
      });
      setNote(activate === "review"
        ? "Queued — the take will land beside the others in the strip; click it there to use it."
        : "Queued — the take will replace this block on the lane when it lands.");
    } catch (err) {
      setNote(`Couldn't queue the retake: ${(err as Error)?.message ?? err}`);
    } finally {
      setBusy(false);
    }
  };

  const secs = durMs ? ` · ${(durMs / 1000).toFixed(1)}s` : "";
  // The tier is DECLARED even though it matches the stylesheet's default: this
  // modal opens the reference picker, so which of the two layers it sits on is
  // a fact about it rather than something inherited.
  return createPortal(
    <>
      {/* A PORTAL BUBBLES THROUGH THE REACT TREE, NOT THE DOM, so the picker
          is a SIBLING of the scrim rather than a child of it. Rendered inside,
          its every click — choosing a reference included — bubbled up to the
          scrim's own onClick and closed this modal out from under it: pick a
          picture, and the panel you picked it for is simply gone. The scrim's
          guard below is the other half; either alone leaves the trap for the
          next portalled child (`Dropdown` is one, and is safe only because it
          sits inside `.ws-modal`, whose stopPropagation catches it first). */}
      <div className="ws-scrim" style={{ zIndex: Z_MODAL }}
           onClick={(e) => e.target === e.currentTarget && ws.closeModal()}>
        <div className="ws-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
          <div className="ws-modal-head">
            <div className="ws-modal-ico"><RefreshCw size={16} /></div>
            <div style={{ flex: 1 }}>
              <div className="ws-modal-t">Retake · {blockLabel(blockKind(block), block.idx)}</div>
              <div className="ws-modal-c">{KIND_BLURB[blockKind(block)]}</div>
            </div>
            <button className="ws-ghost" style={{ width: 34, height: 34, padding: 0, justifyContent: "center" }}
                    onClick={() => ws.closeModal()} aria-label="Close">
              <X size={16} />
            </button>
          </div>
          <div className="ws-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* FIRST, because everything below it is describing a block this
                modal could not read. Without it the failure wore the loading
                state's clothes and the tabs looked like a verdict. */}
            {loadErr && (
              <div className="mono" style={{ fontSize: 11.5, lineHeight: 1.5,
                                             color: "#ff8a8a", display: "flex", gap: 6 }}>
                <AlertTriangle size={12} style={{ flex: "none", marginTop: 2 }} />
                <span>
                  Couldn't load this block's takes and model, so the tabs below are
                  showing what a block with nothing rendered looks like — not what
                  this one holds. Reopen this to try again. {loadErr}
                </span>
              </div>
            )}
            {/* TWO INTENTS, the same pair the beats path offers. Both tabs are
                always drawn — a tab that disappears cannot explain itself, and
                "nothing rendered yet" is exactly what someone opening this
                wants told. */}
            <div style={{ display: "flex", gap: 8 }}>
              {(["regenerate", "edit"] as const).map((m) => {
                const on = mode === m;
                const off = m === "edit" && !!editWhy;
                return (
                  <button key={m} type="button" className="ws-ghost"
                          disabled={off} title={off ? editWhy : undefined}
                          onClick={() => setIntent(m)}
                          style={{ flex: 1, height: "auto", padding: "9px 12px",
                                   flexDirection: "column", alignItems: "flex-start", gap: 2,
                                   ...(on ? { borderColor: "rgba(90,162,255,.55)", color: "#8fc2ff",
                                              background: "rgba(90,162,255,.10)" } : {}) }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                      {m === "edit" ? <Layers size={13} /> : <RefreshCw size={13} />}
                      {COPY[m].tab}
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: "#6f7889", fontWeight: 500 }}>
                      {m === "edit"
                        // "nothing to hold yet" is a claim about the BLOCK, and
                        // it is only true once the takes have been read. With
                        // no answer yet — or none coming — say which.
                        ? (!data ? (loadErr ? "couldn't load" : "loading…")
                           : editWhy ? "nothing to hold yet"
                           : COPY.edit.tabSub(anchor.index, on))
                        : COPY.regenerate.tabSub(0, on)}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mono" style={{ fontSize: 12, color: "#8b93a5" }}>
              {data ? `${data.modelName} · ${editing ? "r2v · edit" : recipe.mode ?? "t2v"}${secs} · `
                      + `${data.takeCount} take${data.takeCount === 1 ? "" : "s"} so far · `
                      // The seed FOLLOWS the intent, so the line has to say which
                      // one is in force: an edit that rolled would re-decide
                      // everything the anchor is holding.
                      + (editing ? "seed held" : "seed rolls fresh")
                    : loadErr ? "couldn't load this block's details" : "…"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="mono" style={{ fontSize: 10.5, letterSpacing: ".08em",
                                                textTransform: "uppercase", color: "#5e6678" }}>
                  {editing ? copy.briefLabel : "Prompt"}
                </span>
                <span style={{ flex: 1 }} />
                {/* ONE BUTTON, TWO REQUESTS. The regenerate box holds the whole
                    compiled prompt — on this path the prompt IS the format
                    (invariant #6's documented exception) — so its rewrite is the
                    vendor envelope, written against the model's own guide. The
                    edit brief is the opposite: `compile_video_edit` writes
                    `[video editing + audio reuse]`, declares the anchor as
                    `<Video 1>` and states that everything unnamed is held, all
                    around these words — so an envelope back from here would sit
                    inside another envelope. `shape: "edit"` asks for the clause
                    that completes "The one change: …" instead. */}
                {preEnhance && preEnhance.mode === mode
                  && preEnhance.text !== (editing ? brief : prompt) && !enhancing && (
                  <button type="button" className="ws-ghost" style={MINI}
                          title={`Put the ${editing ? "brief" : "prompt"} back the way it was`}
                          onClick={() => {
                            if (editing) setBrief(preEnhance.text);
                            else setPrompt(preEnhance.text);
                            setPreEnhance(null); setNote(null);
                          }}>
                    <Undo2 size={12} /> undo
                  </button>
                )}
                <button type="button" className="ws-ghost" style={MINI}
                        disabled={!data || !(editing ? brief : prompt).trim() || enhancing}
                        title={editing
                          ? "Tighten this into the one clause the edit carries — the change "
                            + "and the pictures it means, and nothing about the shot that "
                            + "stays. The studio writes the format around it."
                          : guide.exact
                            ? `Rewrite this against the ${guide.label} prompt guide — this block `
                              + "renders from the prompt verbatim, so its shape is the format."
                            : `${data?.modelName ?? "This model"} has no stored guide; general `
                              + "video craft is applied instead."}
                        onClick={() => void enhance()}>
                  {enhancing ? <Loader2 size={12} className="ns-spin" /> : <Wand2 size={12} />}
                  {enhancing ? "rewriting…" : "enhance"}
                </button>
              </div>
              {editing ? (
                <textarea className="ws-input" rows={4} value={brief} autoFocus
                          placeholder={copy.placeholder}
                          onChange={(e) => setBrief(e.target.value)}
                          style={{ resize: "vertical", lineHeight: 1.45 }} />
              ) : (
                <textarea className="ws-input" rows={7} value={prompt}
                          onChange={(e) => setPrompt(e.target.value)}
                          style={{ resize: "vertical", lineHeight: 1.45 }} />
              )}
              {/* The same warning the block edit carries, for the same reason:
                  this brief reaches the render verbatim, and a subtraction is
                  the one phrasing that renders its opposite. */}
              {editing && readsAsRemoval(brief) && (
                <div className="mono" style={{ fontSize: 11.5, lineHeight: 1.5,
                                               color: "#ffb84d", display: "flex", gap: 6 }}>
                  <AlertTriangle size={12} style={{ flex: "none", marginTop: 2 }} />
                  <span>
                    This asks for something to be taken away, and the model can only
                    add — say what is in its place instead, or press sharpen.
                  </span>
                </div>
              )}
              {editing && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {copy.chips.map((c) => (
                    <button key={c} type="button" className="ws-ghost" style={MINI}
                            onClick={() => setBrief((b) => (b.trim() ? `${b.trim()}, ${c}` : c))}>
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* THE EDIT'S OWN PICTURES — what it brings IN. "Replace the
                character" and "change the background" are reference edits, so
                the strip is the whole point of the tab; `handle_video_edit`
                stages these alongside the anchor and takes eight.
                Deliberately NOT the block's own staged set: an edit composes
                from the anchor, which already holds the identity, the place and
                the framing, and restating them would spend the slots twice. */}
            {editing && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="mono" style={{ fontSize: 10.5, letterSpacing: ".08em",
                                                textTransform: "uppercase", color: "#5e6678" }}>
                  {copy.refsLabel}
                </span>
                <RefTiles refs={editRefs} cap={EDIT_REF_CAP} addLabel="add"
                          onAdd={() => setPicker(true)}
                          onRemove={(a) => setEditRefs((c) => c.filter((x) => x.id !== a.id))} />
                <span className="mono" style={{ fontSize: 11, color: "#5e6678", lineHeight: 1.5 }}>
                  {editRefs.length
                    ? `${editRefs.length}/${EDIT_REF_CAP} · name them in the brief — “put the coat `
                      + `from Picture 1 on her” — or they are staged and never referred to.`
                    : `A new character sheet, a different location plate, a prop. Everything you `
                      + `do not name is held from take ${anchor.index}.`}
                </span>
                {/* Which take is being held, and the way to hold another. Only
                    offered when there IS another: a one-take block has nothing
                    to choose between and a picker there is furniture. */}
                {takes.filter(isUsableAnchor).length > 1 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    <span className="mono" style={{ fontSize: 11, color: "#5e6678" }}>anchor</span>
                    {takes.map((t, i) => isUsableAnchor(t) && (
                      <button key={t.id} type="button" className="ws-ghost" style={{
                        ...MINI,
                        ...(anchor.take?.id === t.id
                          ? { borderColor: "rgba(90,162,255,.55)", color: "#8fc2ff",
                              background: "rgba(90,162,255,.10)" } : {}),
                      }} onClick={() => setAnchorId(t.id)}>
                        take {i + 1}
                      </button>
                    ))}
                  </div>
                )}
                {anchor.fellBack && (
                  <span className="mono" style={{ fontSize: 11, color: "#e8c268" }}>
                    The take you had anchored is gone — holding take {anchor.index} instead.
                  </span>
                )}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              {([["review", "Land beside the other takes", "It arrives pending — pick it in the takes strip."],
                 ["replace", "Replace on the lane", "It becomes the active take and the clip repoints."]] as const)
                .map(([v, label, hint]) => (
                  <button key={v} type="button" className="ws-ghost"
                          onClick={() => setActivate(v)} title={hint}
                          style={{ flex: 1, justifyContent: "center",
                                   ...(activate === v ? { borderColor: "rgba(90,162,255,.55)", color: "#8fc2ff",
                                                          background: "rgba(90,162,255,.10)" } : {}) }}>
                    {label}
                  </button>
                ))}
            </div>
            {note && <div className="mono" style={{ fontSize: 12,
                          color: note.startsWith("Couldn't") ? "#ff8a8a" : "#8fc2ff" }}>{note}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="ws-ghost" onClick={() => ws.closeModal()}>Close</button>
              <button className="ws-primary"
                      disabled={busy || !!queueWhy || (editing && (!!editWhy || !brief.trim()))}
                      title={queueWhy || undefined}
                      onClick={() => void queue()}>
                {busy ? <Loader2 size={14} className="ns-spin" />
                      // NO NUMBER while the count is unknown. `?? 0` made this
                      // read "Regenerate as take 1" over a block that already
                      // had one — a confident wrong answer on the one control
                      // that spends GPU time.
                      : !data ? COPY[mode].tab
                      : copy.primary(data.takeCount + 1)}
              </button>
            </div>
          </div>
        </div>
      </div>
      {picker && (
        <AssetPickerModal
          projectId={data?.projectId ?? null}
          title="Add a reference for this edit"
          kindFilter="image" defaultRole="look" multi
          used={new Set(editRefs.map((r) => r.id))}
          capacity={EDIT_REF_CAP - editRefs.length}
          onPick={(picks) => {
            setEditRefs((cur) => [...cur, ...picks.map((p) => p.asset)
              .filter((a) => !cur.some((c) => c.id === a.id))].slice(0, EDIT_REF_CAP));
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </>,
    document.body
  );
}

/**
 * A clip-born block that has no recipe anywhere.
 *
 * Two ways to get here: media somebody imported and promoted (there was
 * never a render), or a chain/extension whose source job has since been
 * pruned. It IS a block — takes, assembly and library picks all work — it
 * just cannot re-render itself, and saying so is the whole job of this
 * screen. The alternative was the beats-path modal, which offers a brief, a
 * reference grid and a compiled-prompt card, every one of them describing a
 * storyboard shot this block is not.
 */
function NoRecipe({ block }: { block: GenerationBlock }) {
  const ws = useWorkspaceStore();
  const kind = blockKind(block);
  return createPortal(
    <div className="ws-scrim"
         onClick={(e) => e.target === e.currentTarget && ws.closeModal()}>
      <div className="ws-modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="ws-modal-head">
          <div className="ws-modal-ico"><RefreshCw size={16} /></div>
          <div style={{ flex: 1 }}>
            <div className="ws-modal-t">{blockLabel(kind, block.idx)}</div>
            <div className="ws-modal-c">No render recipe on this block.</div>
          </div>
          <button className="ws-ghost" style={{ width: 34, height: 34, padding: 0, justifyContent: "center" }}
                  onClick={() => ws.closeModal()} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="ws-modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "#a9b4c6" }}>
            This block was made from a clip that carries no generation recipe — imported
            media, or a render whose job has been pruned. Everything else about it works:
            it has takes, you can add more from your library, compare and assemble them.
          </p>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "#a9b4c6" }}>
            To get a new render of this moment, use <b>Extend</b> or <b>Chain</b> on the
            lane — those write a recipe, so everything they make is retakeable from here.
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="ws-ghost" onClick={() => ws.closeModal()}>Close</button>
            <button className="ws-primary"
                    onClick={() => ws.openModal({ kind: "takes", blockId: block.id })}>
              Open takes
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * One row read, then the modal that is TRUE for this block.
 *
 * The test is CLIP-BORN, not "has a recipe": a promoted chain with no
 * recoverable recipe still has no beats, so PromptRefsModal's brief would
 * queue a revise_block over zero shots and its compiled-prompt card would
 * render an empty envelope. Trims and planner blocks keep the beats path,
 * which is the one that is true for them.
 */
export default function BlockRetakeRouter({ blockId }: { blockId: string }) {
  const { data } = useLiveQuery(
    async () => {
      const { data } = await supabase.from("generation_blocks")
        .select("*").eq("id", blockId).maybeSingle();
      return (data ?? null) as GenerationBlock | null;
    },
    ["generation_blocks"], [blockId]
  );
  if (!data) {
    // The click has to show SOMETHING now: this router's own read plus the
    // child modal's loader is several round trips, and a null here meant the
    // screen sat unchanged for all of them.
    return (
      <ModalShell width={1040} maxH={720} tall z={92}
                  icon={<Wand2 size={16} />} title="Prompt & references"
                  loading loadingLabel="Loading block…" />
    );
  }
  const recipe = clipGenRecipe(data.params);
  if (recipe) return <ClipRetakeModal block={data} recipe={recipe} />;
  if (isClipBorn(data)) return <NoRecipe block={data} />;
  return <PromptRefsModal blockId={blockId} />;
}
