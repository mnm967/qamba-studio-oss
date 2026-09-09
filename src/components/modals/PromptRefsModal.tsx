// Prompt & references — the retake cockpit for one generation block.
//
// TWO INTENTS IN ONE MODAL (handoff 1a). Everything you can do to a block that
// has already rendered is one of two things, and they were previously the same
// screen with no way to say which you meant:
//
//   REGENERATE — a new roll from the same references. The seed rerolls; the
//     note and any reference change are folded into a freshly composed prompt.
//   EDIT A TAKE — one take anchors the render (H3's `<Video 1>`, which is a
//     VIDEO reference slot and so a separate budget from the nine pictures),
//     and you name the one thing that changes. The seed is held, because the
//     promise is that nothing you didn't name moves.
//
// Position, size and order of every element are identical between them, so the
// switch reads as a change of intent rather than a change of screen. Five
// things move: the anchor card, the brief's label and border, the references
// heading, the seed control and the primary button. `src/lib/retake.ts` owns
// every one of those decisions, because each of them fails SILENTLY when it is
// wrong — see the header there.
//
// The note field is a BRIEF in both modes. The prompt itself stays
// compiler-owned (invariant #6) and is shown read-only below the references:
// it is an output of the brief now, not a sibling of it, which is why the
// "Ask the director" pill is gone. Composition happens on queue.
//
// Three things the old layout carried that moved rather than vanished: the
// i2v/t2v/flf/r2v strip is an advanced row inside the Render card (intent tabs
// and model-mode tabs cannot both live at the top), reference strength is a
// render parameter and sits with the other render parameters, and the dialogue
// card — the tallest thing in the modal, and about the block rather than about
// this decision — is a disclosure.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, FolderOpen, Image as ImageIcon,
  Layers, Lock, MessageSquare, Plus, RefreshCw, Settings2, Sparkles, Trash2, Undo2, Wand2,
} from "lucide-react";
import ModalShell from "./ModalShell";
import AssetPickerModal, { type Pick as RefPick } from "./AssetPickerModal";
import Dropdown from "../ui/Dropdown";
import TieredModelMenu, { type Quality } from "../ui/TieredModelMenu";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import { assetUrl, loadAssets } from "../../lib/db/assets";
import { loadBible, loadBibleAssets } from "../../lib/db/director";
import { backendLabel, describeDirectorError, enhancePrompt } from "../../lib/director";
import { queueBlockRender, queueRevisedRender } from "../../lib/db/jobs";
import { elVoiceName } from "../../lib/elVoices";
import { loadCatalog } from "../../lib/catalog";
import { takesRefine } from "../ui/ImageModelPicker";
import { modelKeyOf, resolveDefaults, type ProjectSettings } from "../../lib/projectSettings";
import { estimateSeconds, fmtEta, loadTimings } from "../../lib/eta";
import { ASPECTS, fitSize, megapixels, resOptions } from "../../lib/resolution";
import {
  COPY, defaultMode, defaultSeedMode, editBlocker, editPayload, footerSummary,
  queueBlocker, readsAsRemoval, resolveAnchor, rollSeed, splitRefs,
  type RetakeMode, type SeedMode,
} from "../../lib/retake";
import type {
  Asset, BibleEntry, BlockTake, GenerationBlock, ModelCatalogRow, RefSlot,
} from "../../lib/db/types";
import { asArray } from "../../lib/jsonb";
import { blockRef } from "../../../director/refs.js";


/** The roles the compiler understands. Wording matches what each one actually
 *  tells the model, because picking the wrong one silently rewrites the shot. */
const ROLES = [
  { id: "look", label: "look", hint: "Match its rendering — colour, light, materials. Framing ignored." },
  { id: "start_frame", label: "start frame", hint: "The block opens on this exact image. Only one slot can hold it." },
  { id: "end_frame", label: "end frame", hint: "The block arrives at this exact image. Used by first-last-frame." },
  { id: "scene_ref", label: "storyboard", hint: "A composed panel — its framing is followed." },
  { id: "character", label: "character", hint: "Identity anchor: face, hair, wardrobe held across every shot." },
  { id: "environment", label: "environment", hint: "The place: layout, materials, lighting logic." },
] as const;
const roleOf = (r: RefSlot) => (r.purpose ?? "look");
const roleLabel = (id: string) => ROLES.find((x) => x.id === id)?.label ?? id;

/** What each catalog mode takes as input. The strip used to be a hardcoded
 *  four — including a "video ref" no model declares — so it said the same
 *  thing whichever model you picked. It now comes from model_catalog.modes. */
const MODE_INPUT: Record<string, string> = {
  t2v: "text only — no images",
  i2v: "one opening image",
  flf: "a first and a last frame",
  r2v: "reference images, videos and audio",
  v2v: "an existing video to re-render",
};

/** Poster frame at 35% of the clip: the first frame of a take is the warmup
 *  the trim already removed, so a thumbnail of it shows the least useful
 *  moment of the shot. One rule, used by the rail and the anchor card. */
const poster = (e: React.SyntheticEvent<HTMLVideoElement>) => {
  const v = e.currentTarget;
  if (v.duration) v.currentTime = v.duration * 0.35;
};

export default function PromptRefsModal({ blockId }: { blockId: string }) {
  const ws = useWorkspaceStore();
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [brief, setBrief] = useState("");
  const [seed, setSeed] = useState<number | null>(null);
  const [seedMode, setSeedMode] = useState<SeedMode>("roll");
  const [strength, setStrength] = useState(0.68);
  /** Second sampler pass for this block (`params.refine`). */
  const [refine, setRefine] = useState(false);
  const [modelId, setModelId] = useState<string | null>(null);
  const [resId, setResId] = useState<string | null>(null);
  const [refs, setRefs] = useState<RefSlot[] | null>(null);
  /** EDIT's references are its own, and they start EMPTY.
   *
   *  The block's `ref_plan` is what a regenerate composes from; an edit
   *  composes from the ANCHOR, and its references are only what is being
   *  ADDED — "put the glass orb in her hands" is one picture, not the block's
   *  whole staged set restated. Sharing one list would also mean adding a ref
   *  for a one-off edit silently rewrote the block's plan for every later
   *  render, so these are session-local and never persisted. */
  const [editRefs, setEditRefs] = useState<RefSlot[]>([]);
  const [busy, setBusy] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  /** What the brief said before the last rewrite, so it can be put back. Keyed
   *  by the mode it was taken in: the two tabs share one box and undoing a
   *  regenerate brief into an edit would restore words about the wrong job. */
  const [preEnhance, setPreEnhance] = useState<{ mode: RetakeMode; text: string } | null>(null);
  const [eta, setEta] = useState<string>("…");
  /** null = follow the block (a rendered block opens on Edit). Set once the
   *  user picks; coerced back to regenerate below if the model stops being
   *  able to hold an anchor. */
  const [modeSet, setModeSet] = useState<RetakeMode | null>(null);
  const [anchorTakeId, setAnchorTakeId] = useState<string | null>(null);
  /** References added in THIS session — what the composed prompt reads as the
   *  change. Ids, not indexes: the grid reorders on every save. */
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [showDialogue, setShowDialogue] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  /** The floating scrub preview a take thumbnail raises — the same affordance
   *  TakesStrip has, because a 130px tile cannot answer "which take is this".
   *  Portalled to <body>: `.ns-l3` carries a backdrop-filter, which makes the
   *  modal a containing block for fixed descendants, so a fixed popover inside
   *  it resolves against the modal's box and is clipped by its overflow. */
  const [hover, setHover] = useState<
    null | { rect: DOMRect; assetId: string; label: string }>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** which reference the picker is filling: the r2v set, or one named frame */
  const [picker, setPicker] = useState<
    null | { kind: "refs" } | { kind: "frame"; role: string; title: string }>(null);

  const { data, error: loadError, reload } = useLiveQuery(
    async () => {
      const [{ data: block }, { data: takes }] = await Promise.all([
        supabase.from("generation_blocks").select("*").eq("id", blockId).single(),
        supabase.from("block_takes").select("*").eq("block_id", blockId).order("created_at"),
      ]);
      const b = block as GenerationBlock;
      const audioIds = asArray<{ asset_id?: string }>(b.audio_refs)
        .map((r) => r.asset_id).filter(Boolean) as string[];
      const refIds = asArray<RefSlot>(b.ref_plan).map((r) => r.asset_id)
        .filter((x) => x && x !== "prev_last_frame") as string[];
      const ids = [...new Set([...refIds, ...audioIds, ...(takes ?? []).map((t) => t.asset_id)])];
      // One round for everything that only needs the block. The old shape was
      // an id-chase (block → storyboard → episode → project) of sequential
      // round trips; the episode rides the storyboard read as an embed.
      const [{ data: chainParent }, { data: story }, { data: beatRows }, { data: assets }, models] =
        await Promise.all([
          b.chain_from_block_id
            ? supabase.from("generation_blocks")
                .select("id,idx,status,active_take_id").eq("id", b.chain_from_block_id).maybeSingle()
            : Promise.resolve({ data: null }),
          supabase.from("storyboards")
            .select("id,episode_id,episodes(project_id)").eq("id", b.storyboard_id).maybeSingle(),
          b.beat_ids?.length
            ? supabase.from("beats").select("*").in("id", b.beat_ids)
            : Promise.resolve({ data: [] }),
          ids.length ? supabase.from("assets").select("*").in("id", ids) : Promise.resolve({ data: [] }),
          // Full catalog, not videoModels() — that filters to enabled, and a
          // model you cannot see is a model you cannot ask for. Disabled ones
          // render greyed with the provider key they are waiting on.
          loadCatalog().then((all) => all.filter((m) => m.kind === "video")),
        ]);
      const projectId = ((story as { episodes?: { project_id?: string } | null } | null)
        ?.episodes?.project_id) ?? null;

      // Beats carry the block's dialogue; audio_refs carries the staged
      // clips (per-line / exchange) — the panel shows both together.
      const beatOrder = new Map((b.beat_ids ?? []).map((id, i) => [id, i]));
      const beats = ((beatRows ?? []) as import("../../lib/db/types").Beat[])
        .sort((x, y) => (beatOrder.get(x.id) ?? 0) - (beatOrder.get(y.id) ?? 0));

      const [{ data: project }, bible, library] = await Promise.all([
        projectId
          ? supabase.from("projects").select("settings").eq("id", projectId).maybeSingle()
          : Promise.resolve({ data: null }),
        projectId ? loadBible(projectId) : Promise.resolve([] as BibleEntry[]),
        loadAssets({ projectId, kind: "image", limit: 60 }),
      ]);
      const settings = ((project as { settings?: ProjectSettings } | null)?.settings ?? {}) as ProjectSettings;
      const links = bible.length ? await loadBibleAssets(bible.map((e) => e.id)) : [];
      const bibleAssetIds = [...new Set(links.map((l) => l.asset_id))];
      const bibleAssets = bibleAssetIds.length
        ? ((await supabase.from("assets").select("*").in("id", bibleAssetIds)).data ?? []) as Asset[]
        : [];
      const all = new Map<string, Asset>(
        [...((assets ?? []) as Asset[]), ...library, ...bibleAssets].map((a) => [a.id, a]));
      return {
        block: b, projectId, settings, beats,
        chainParent: chainParent as
          { id: string; idx: number; status: string; active_take_id: string | null } | null,
        takes: (takes ?? []) as BlockTake[],
        assets: all, bible, links, library, models,
      };
    },
    ["generation_blocks", "block_takes"], [blockId]
  );

  const block = data?.block;
  useEffect(() => {
    if (!block) return;
    // `params.brief` is the new home. A block still carrying the old
    // `prompt_extra` note loads it as the brief, so queueing migrates it: the
    // words go into the beats and the key is cleared (see `persist`).
    setBrief((block.params?.brief as string) ?? (block.params?.prompt_extra as string) ?? "");
    setSeed(block.seed ?? 42);
    setStrength((block.params?.ref_strength as number) ?? 0.68);
    setRefine(!!block.params?.refine);
    setAnchorTakeId(block.active_take_id ?? null);
    // Fall back to the project's default rather than a hardcoded id.
    const mid = (block.params?.model_id as string) || resolveDefaults(data?.settings).video_model;
    setModelId(mid);
    // A block already has effective dims (the wizard launched it at a size) —
    // recover the nearest ladder entry rather than defaulting to something that
    // silently re-renders the retake smaller than the last take.
    const w = block.params?.width as number | undefined;
    const h = block.params?.height as number | undefined;
    const m = data?.models.find((x) => x.id === mid) ?? null;
    setResId(w && h ? (fitSize(m, w, h)?.resId ?? null) : null);
    // PICTURES only. `ref_plan` also carries `purpose: "voice"` entries, and
    // those are AUDIO — Ref2VA numbers pictures and audios independently
    // (official §2.5), so counting them against the 9-picture ceiling showed
    // "10 / 9" on a block staging 8 pictures and 2 voice refs, and the picker
    // refused to add a ninth picture there was room for. They round-trip
    // untouched via `voiceRefs` below; the Dialogue card is where they show.
    setRefs(splitRefs(asArray<RefSlot>(block.ref_plan)).pictures);
  }, [block?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The audio entries this modal deliberately doesn't manage as pictures.
   *  Every write below re-appends them, or editing refs would silently strip
   *  the block's voice references. */
  const voiceRefs = React.useMemo(
    () => splitRefs(asArray<RefSlot>(block?.ref_plan)).voices,
    [block?.ref_plan]);

  // Hidden on every row this modal actually lists (they are video models, and
  // qualityTiers() is image-only) — wired so a hosted image row appearing here
  // later is not a fifth surface to remember.
  const [quality, setQuality] = useState<Quality>("low");
  const model = data?.models.find((m) => m.id === modelId) ?? null;
  // A second, higher-resolution sampler pass for THIS block. Per-block is
  // where it matters most: measured on Rei EP03, the pass held the shot on a
  // 4.5s block (+44% detail, composition at the nondeterminism floor) and
  // drifted in the back half of a 9s one — so "refine the short shots, leave
  // the long ones" is a real editing decision, and the wizard's episode-wide
  // switch cannot express it. Gated on the model declaring a recipe, because
  // `resolve()` raises rather than quietly rendering one pass.
  const refineOk = takesRefine(model);
  // The reference ceiling is the model's, not a constant. Ref2VA's 9/3/3 is
  // H3's; a hosted model with a smaller budget silently drops the overflow.
  const caps = (model?.capabilities ?? {}) as {
    multiRef?: number; refVideos?: number; refAudios?: number; audio?: boolean;
  };
  const modes = model?.modes ?? [];
  const maxRefs = caps.multiRef ?? 9;
  const durMs = block ? block.t_end_ms - block.t_start_ms : 0;
  const isLocal = !model || model.provider === "local";
  const modelName = model?.display_name ?? modelId ?? "This model";

  // The block renders in the project's aspect; the resolution ladder is the
  // one the library dock offers for this model at that aspect.
  const aspectId = (() => {
    const a = resolveDefaults(data?.settings).aspect;
    return ASPECTS.some((x) => x.id === a) ? a : "16:9";
  })();
  const resList = useMemo(() => resOptions(model, aspectId), [model, aspectId]);
  // The ladder changes with the model, so a pinned id can stop existing —
  // fall back to the default rather than rendering an empty trigger.
  const size = resList.find((s) => s.id === resId)
    ?? resList.find((s) => s.id === "1024" || s.id === "720p")
    ?? resList[0];

  useEffect(() => {
    if (!block) return;
    if (!isLocal) { setEta("hosted"); return; }
    loadTimings().then((ts) => {
      const s = estimateSeconds(ts, {
        modelId: modelId ?? "h3-local",
        width: size.w,
        height: size.h,
        frames: block.frames || Math.round((durMs / 1000) * 24),
        steps: (block.params?.steps as number) ?? 20,
      });
      setEta(s ? fmtEta(s) : "~3m");
    }).catch(() => setEta("~3m"));
  }, [block?.id, durMs, modelId, isLocal, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // NO COST ESTIMATE — see GenComposer. The ETA below is the half of this
  // that answered a question.

  // The frame opens on the click — returning null here left the screen
  // unchanged for the whole of a many-round-trip loader.
  if (!data || !block || refs == null) {
    return (
      <ModalShell width={1040} maxH={720} tall z={92}
                  icon={<Wand2 size={16} />} title="Prompt & references"
                  loading loadingLabel="Loading block…" loadError={loadError} />
    );
  }
  const nextTake = data.takes.length + 1;
  const activeTake = data.takes.find((t) => t.id === block.active_take_id);
  const compiled = block.compiled_prompt as Record<string, unknown> | null;

  // ── intent ────────────────────────────────────────────────────────────────
  const editWhy = editBlocker(data.takes, caps, modelName, modes);
  // An explicit pick survives everything except becoming impossible: switching
  // to a model with no video-reference slot has to take Edit away, or the
  // anchor is dropped on queue and the render is a regenerate wearing an
  // edit's label. Coerced rather than left broken, and said out loud below.
  const coerced = modeSet === "edit" && !!editWhy;
  const mode: RetakeMode = coerced ? "regenerate"
    : modeSet ?? defaultMode(data.takes, caps, modelName, modes);
  const copy = COPY[mode];
  const anchor = resolveAnchor(data.takes, anchorTakeId, block.active_take_id);
  const pickMode = (m: RetakeMode) => {
    setModeSet(m);
    setNote(null);
    // The seed follows the intent unless the user has said otherwise since —
    // and they can only have said otherwise by opening the seed menu, which
    // sets it explicitly. Following on switch is what makes "new seed" and
    // "seed locked" true statements rather than defaults nobody re-checks.
    setSeedMode(defaultSeedMode(m));
    if (m === "edit" && seed !== block.seed) setSeed(block.seed ?? 42);
  };

  const isChain = (r: RefSlot) =>
    r.asset_id === "prev_last_frame" || roleOf(r) === "chain";
  /** What the grid shows and the render is handed. `refs` stays the BLOCK's
   *  plan throughout — the mode preconditions below (an opening frame, a
   *  closing frame, the chain) are properties of the block, not of this
   *  decision, and reading them off an edit's empty list would report a
   *  broken block. */
  const shownRefs = mode === "edit" ? editRefs : refs;
  const writeRefs = (next: RefSlot[]) =>
    (mode === "edit" ? setEditRefs(next) : saveRefs(next));
  const startCount = refs.filter((r) => roleOf(r) === "start_frame").length;
  const overRefs = Math.max(0, shownRefs.length - maxRefs);
  const hasOpening = refs.some((r) => isChain(r) || roleOf(r) === "start_frame");
  const hasEnd = refs.some((r) => roleOf(r) === "end_frame");
  // An edit ALWAYS renders r2v with the anchor as <Video 1> — `handle_video_edit`
  // resolves that mode itself and never reads `block.mode` — so the reference
  // grid is what an edit is handed whatever the block is planned as.
  const showGrid = mode === "edit" || block.mode === "r2v";

  /** Why a mode can't run on this block yet, or "" when it can. The worker
   *  raises the same conditions — better to read them here than to spend a
   *  claim on a job that dies on its preconditions. */
  const modeBlocker = (m: string): string => {
    if ((m === "i2v" || m === "flf") && !hasOpening) {
      return `${m} opens on a supplied frame — mark a reference as the start frame, or chain this block to the previous one.`;
    }
    if (m === "flf" && !hasEnd) return "flf needs a closing frame — mark a reference as the end frame.";
    if (m !== "r2v" && block.audio_mode === "locked") {
      return `Locked audio rides the r2v audio graph; ${m} has no audio input, so the track would be regenerated.`;
    }
    return "";
  };

  /** Frame roles hold exactly one image, so setting one demotes the previous
   *  holder rather than leaving two images claiming to open the segment. */
  const frameFor = (role: string) => refs.find((r) => roleOf(r) === role) ?? null;
  const chainSlot = refs.find(isChain) ?? null;
  const setFrame = (role: string, asset: Asset, label: string) => {
    const cleared = refs.map((r) => (roleOf(r) === role ? { ...r, purpose: "look" } : r));
    const at = cleared.findIndex((r) => r.asset_id === asset.id);
    saveRefs(at >= 0
      ? cleared.map((r, i) => (i === at ? { ...r, purpose: role, label } : r))
      : [...cleared, { slot: cleared.length + 1, label, purpose: role, asset_id: asset.id }]);
    if (at < 0) setFresh((s) => new Set(s).add(asset.id));
    setNote({ text: `${label} is now the ${roleLabel(role)}.` });
  };
  const clearFrame = (role: string) => {
    // Demote, don't delete: the image stays available for r2v.
    saveRefs(refs.map((r) => (roleOf(r) === role ? { ...r, purpose: "look" } : r)));
  };

  const setBlockMode = async (m: string) => {
    if (m === block.mode) return;
    setBusy(true);
    const { error } = await supabase.from("generation_blocks")
      .update({ mode: m }).eq("id", blockId);
    setBusy(false);
    if (error) { setNote({ text: `Could not switch mode: ${error.message}`, bad: true }); return; }
    const why = modeBlocker(m);
    setNote({ text: why ? `Switched to ${m}. ${why}` : `Switched to ${m} — ${MODE_INPUT[m] ?? "model-defined input"}.`,
              bad: !!why });
    reload();
  };
  // A chain to a block that never rendered has no frame to resolve, so the
  // job dies at execution. Say so here, where it can still be fixed.
  const brokenChain = !!block.chain_from_block_id && !data.chainParent?.active_take_id;

  const saveRefs = (next: RefSlot[]) => {
    setRefs(next);
    // PostgrestFilterBuilder is lazy — it only issues the request when it is
    // awaited or then'd. `void builder` type-checks, renders correctly, and
    // silently never reaches the database.
    supabase.from("generation_blocks")
      .update({ ref_plan: [...next.map((r, i) => ({ ...r, slot: i + 1 })), ...voiceRefs] })
      .eq("id", blockId)
      .then(({ error }) => {
        if (error) { setNote({ text: `Could not save refs: ${error.message}`, bad: true }); reload(); }
      });
  };
  const setRole = (idx: number, role: string) => {
    // Only one image can open a segment and only one can close it, so promoting
    // one demotes the other rather than shipping two contradictory declarations.
    const unique = role === "start_frame" || role === "end_frame";
    writeRefs(shownRefs.map((r, i) =>
      i === idx ? { ...r, purpose: role }
      : unique && roleOf(r) === role ? { ...r, purpose: "look" } : r));
  };
  /** Add a whole selection at once — the picker returns several. Anything past
   *  the model's ceiling is refused here rather than staged and dropped by the
   *  provider, where it would look like the reference simply didn't work. */
  const addRefs = (picks: RefPick[]) => {
    const room = maxRefs - shownRefs.length;
    if (room <= 0) {
      setNote({ text: `${modelName} takes at most ${maxRefs} images.`, bad: true }); return;
    }
    const incoming = picks.filter((p) => !shownRefs.some((r) => r.asset_id === p.asset.id));
    const take = incoming.slice(0, room);
    if (!take.length) {
      setNote({ text: mode === "edit" ? "Those images are already on this edit."
        : "Those images are already references on this block." });
      return;
    }
    writeRefs([
      ...shownRefs,
      ...take.map((p, i) => ({
        slot: shownRefs.length + i + 1, label: p.label, purpose: p.role, asset_id: p.asset.id,
      })),
    ]);
    setFresh((s) => { const n = new Set(s); take.forEach((p) => n.add(p.asset.id)); return n; });
    const dropped = incoming.length - take.length;
    setNote({ text: `Added ${take.length} reference${take.length === 1 ? "" : "s"}`
      + (dropped ? ` — ${dropped} didn't fit in ${modelName}'s ${maxRefs} slots.` : ".") });
  };

  /** What the render is handed. Persisted on both paths, because the Render
   *  card claims these are stored on the block and a control that says so and
   *  doesn't is the silent kind of wrong. */
  const persist = () => supabase.from("generation_blocks").update({
    params: {
      ...(block.params ?? {}),
      // The brief's new home — a RECORD of what was asked, read back when the
      // modal reopens.
      brief: brief.trim() || undefined,
      // …and `prompt_extra` is cleared, always. That key is the bug: the
      // worker appends it verbatim to the compiled description as "Director's
      // adjustment for this take:", and it lives on `block.params`, so it kept
      // appending to EVERY later render of the block. Now that the brief
      // rewrites the beats, leaving it would staple the instruction ("change
      // her line to X") onto a description that already says X — stray
      // imperative prose inside an H3 description, which the model may well
      // try to render. A block carrying an old note is migrated by this: the
      // effect loads it as the brief, and queueing puts it in the beats where
      // it belongs and clears it here.
      prompt_extra: undefined,
      ref_strength: strength,
      // Gated on the MODEL as well as the switch: the control hides itself
      // when the picked model declares no recipe, but the state survives a
      // model change and `resolve()` RAISES on one that cannot refine — so
      // this would fail the render rather than be a harmless unread key.
      // `undefined` drops it, so switching models clears a stale flag.
      refine: refineOk && refine ? true : undefined,
      // The CATALOG id — what this modal reads back to restore the picker
      // and what every surface names the model by.
      model_id: modelId ?? "h3-local",
      // …and what the WORKER actually reads: `_block_model` is
      // `params.model_key`, a model_map key. Writing only `model_id` made
      // the per-block model picker a silent no-op — every local retake
      // rendered on H3 whatever you picked. Hosted rows deliberately carry
      // no key (they have no model_map entry, and one the worker cannot
      // resolve fails the render — same rule as the wizard's `*-local`
      // gate); `undefined` drops the key, so switching to a hosted model
      // clears a stale one rather than leaving it to win.
      model_key: isLocal ? modelKeyOf(modelId ?? "h3-local") : undefined,
      // The worker reads these for master_pass (blocks.py); storing the
      // snapped pair means the retake really renders at the picked size.
      width: size.w,
      height: size.h,
    },
    ref_plan: [...refs.map((r, i) => ({ ...r, slot: i + 1 })), ...voiceRefs],
  }).eq("id", blockId);

  /**
   * SHARPEN THE EDIT BRIEF, on the Edit tab only.
   *
   * This box is the one place in the studio whose words reach a render
   * unmediated: `handle_video_edit` passes them VERBATIM into
   * `compile_video_edit`, which writes the vendor envelope around them and
   * changes not a character. So the difference between "she should not be
   * wearing glove, she should be only person in the room, change nothing
   * else" and a clause that works is entirely the writing — and this was the
   * only edit surface with no help writing it, while the clip retake beside
   * it has had one since the guides shipped.
   *
   * `shape: "edit"` swaps the system prompt for `prompt_guides.editSystem`,
   * which asks for the CLAUSE that completes "The one change: …" rather than
   * for a prompt. Everything that shapes a PROMPT is withheld deliberately:
   * the vendor doc (39KB of envelope specification is the surest way to be
   * handed an envelope), the style guide, the alignment line and the pass
   * duration each argue for one of the two things the envelope forbids —
   * restating the look, and emitting structure.
   *
   * REGENERATE IS NOT OFFERED ONE, and that is not an oversight. Its brief is
   * an instruction to the `revise_block` reviser, which rewrites the block's
   * BEATS; the compiler then builds the prompt from those. A rewrite shaped
   * like a prompt, or like an edit clause, is the wrong artefact for that
   * pipeline entirely.
   *
   * Explicit and undoable, the library composer's rule: the rewrite lands in
   * the box for review rather than going to the render, `preEnhance` puts
   * back what was there, and a backend hop is REPORTED rather than swallowed.
   */
  const enhance = async () => {
    const text = brief.trim();
    if (!text || enhancing || mode !== "edit") return;
    setEnhancing(true);
    setNote(null);
    try {
      const res = await enhancePrompt({
        prompt: text, kind: "video", shape: "edit",
        family: model?.family ?? null,
        model_label: modelName,
        // The EDIT's own strip, which is what `compile_video_edit` numbers
        // <Picture 1..N> — never the block's staged set, which an edit does
        // not compose from. Sending the block's count would invite the
        // rewrite to name a picture this render does not stage.
        refs: editRefs.length,
        project_id: data.projectId,
        backend: data.settings.director_backend ?? undefined,
      });
      setPreEnhance({ mode, text });
      setBrief(res.prompt);
      const how = "Sharpened into the one clause this edit carries";
      const hops = res.fell_back ?? [];
      setNote({ text: hops.length
        ? `${backendLabel(hops[0].from)} ${hops[0].reason} — ${backendLabel(res.backend)} `
          + `wrote this instead. ${how}.`
        : `${how}.` });
    } catch (err) {
      setNote({ text: `Couldn't sharpen it: `
        + describeDirectorError(String((err as Error).message || err)), bad: true });
    } finally {
      setEnhancing(false);
    }
  };

  const queue = async () => {
    const why = queueBlocker({ mode, brief, anchor: anchor.take, editWhy,
                              refs: editRefs.length })
      || (mode === "regenerate" ? modeBlocker(block.mode) : "");
    if (why) { setNote({ text: why, bad: true }); return; }
    setBusy(true);
    try {
      await persist();
      if (mode === "edit" && anchor.take) {
        // `video_edit` already does exactly what Edit promises: the source
        // becomes H3's `<Video 1>` under "preserve its framing, timing and
        // subjects except where the instruction changes them", plus the image
        // refs. Reusing it beats inventing an `intent: "edit"` flag that no
        // handler reads — which is what a queued job that renders a plain
        // regenerate would have been.
        await queueBlockRender(blockId, {
          kind: "video_edit", lane: "gpu",
          blockIdx: block.idx,
          project_id: data.projectId ?? undefined,
          model_id: modelId ?? "h3-local",
          payload: editPayload({
            anchor: anchor.take, anchorNo: anchor.index, blockIdx: block.idx, brief,
            // The EDIT's own list — an edit composes from the anchor, so
            // restating the block's whole staged set would spend its picture
            // slots on things the anchor already holds.
            refAssetIds: editRefs.map((r) => r.asset_id).filter((id) => id !== "prev_last_frame"),
            seed: seed ?? block.seed ?? 42,
            modelKey: isLocal ? modelKeyOf(modelId ?? "h3-local") : null,
            width: size.w, height: size.h,
          }),
        });
        setNote({ text: `Editing take ${anchor.index} — lands as take ${nextTake}, side by side.` });
      } else {
        const render = {
          // A hosted provider is a different lane and handler entirely; the
          // catalog's provider decides, so adding a model never needs UI edits.
          kind: isLocal ? "master_pass" : "api_generate",
          lane: (isLocal ? "gpu" : "api") as "gpu" | "api",
          blockIdx: block.idx,
          model_id: modelId ?? "h3-local",
          payload: {
            take_of: true,
            ...(modelId ? { model_id: modelId } : {}),
            // A regenerate that reuses the seed returns near-identical footage,
            // which reads as the button not having worked — so `roll` writes a
            // fresh one and `hold` deliberately writes nothing.
            ...(seedMode === "roll" ? { seed: rollSeed() }
              : seed != null && seed !== block.seed ? { seed } : {}),
            // Deliberately NO `prompt_extra`: by the time this job runs the
            // revision has already put the brief into the beats, and the
            // compiled description says the new thing. Sending it too would
            // append the REQUEST to the answer.
            ...(brief.trim() ? { brief: brief.trim() } : {}),
          },
        };
        if (brief.trim()) {
          // THE BRIEF REWRITES THE SHOT. Anything else is the bug this
          // replaces: `prompt_extra` alone is appended to an otherwise
          // unchanged compile, so the take comes back identical — and the
          // dialogue provably so, since the lines are recorded at plan time
          // and staged as reference audio.
          await queueRevisedRender(blockId, {
            brief, projectId: data.projectId,
            backend: data.settings.director_backend ?? null,
            render,
          });
          setNote({ text: `Rewriting the shot, then rendering take ${nextTake}.` });
        } else {
          await queueBlockRender(blockId, render);
          setNote({ text: `Queued as take ${nextTake} — watch it in the queue.` });
        }
      }
      reload();
    } catch (e) {
      setNote({ text: `Could not queue: ${String(e).slice(0, 120)}`, bad: true });
    } finally { setBusy(false); }
  };

  /** One named frame the FL2VA modes render from. The opening frame falls back
   *  to the chain when this block continues the previous one — that IS the
   *  supplied first frame, and showing it as empty would be a lie. */
  const frameSlot = (role: string, title: string, hint: string) => {
    const held = frameFor(role);
    const chained = role === "start_frame" && !held && !!chainSlot;
    const asset = held && held.asset_id !== "prev_last_frame"
      ? data.assets.get(held.asset_id) : null;
    const filled = !!asset || chained;
    const tone = role === "start_frame" ? "#6fd08c" : "#c97aff";
    return (
      <div key={role} style={{ width: 224, display: "flex", flexDirection: "column", gap: 7 }}>
        <div style={{ position: "relative", aspectRatio: "16/9", borderRadius: 16, overflow: "hidden",
                      background: "#0b0e14",
                      border: chained ? "1px solid rgba(90,162,255,.4)"
                        : filled ? `1px solid ${tone}66` : "1px dashed rgba(255,255,255,.13)" }}>
          {asset
            ? <img src={assetUrl(asset) ?? undefined} alt=""
                   style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center",
                             gap: 6, alignContent: "center", justifyItems: "center",
                             color: chained ? "#8fc2ff" : "#3d4658" }}>
                <ImageIcon size={20} />
                <span className="mono" style={{ fontSize: 10 }}>
                  {chained ? "block " + (data.chainParent?.idx ?? "?") + "'s final frame" : "not set"}
                </span>
              </span>}
          <span className="mono" style={{ position: "absolute", left: 7, top: 7, padding: "3px 7px",
                                          borderRadius: 8, fontSize: 9, fontWeight: 700, color: "#07090e",
                                          background: chained ? "rgba(90,162,255,.9)" : `${tone}e6` }}>
            {chained ? "CHAIN" : role === "start_frame" ? "FIRST" : "LAST"}
          </span>
          {held && (
            <button className="ws-microbtn sq danger" title="Clear this frame"
                    onClick={() => clearFrame(role)}
                    style={{ position: "absolute", right: 6, top: 6 }}>
              <Trash2 size={11} />
            </button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600,
                         overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </span>
          <button className="ws-microbtn" style={{ padding: "0 10px" }}
                  onClick={() => setPicker({ kind: "frame", role, title })}>
            {filled ? "change" : "choose"}
          </button>
        </div>
        <span className="mono" style={{ fontSize: 10, lineHeight: 1.5, color: "#5e6678" }}>
          {chained ? "Continues the previous block. Choose an image to override it." : hint}
        </span>
      </div>
    );
  };

  const openHover = (h: { assetId: string; label: string }, el: HTMLElement) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const rect = el.getBoundingClientRect();
    hoverTimer.current = setTimeout(() => setHover({ ...h, rect }), 120);
  };
  const closeHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHover(null), 140);
  };
  const holdHover = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); };

  /** One take thumbnail, in the rail and in the anchor card. Takes the minimal
   *  shape so the rail's `BlockTake` and the anchor's resolved `TakeRef` share
   *  one renderer — the poster rule has to be the same in both places. */
  const takeMedia = (t: { asset_id: string }, idx: number) => {
    const a = data.assets.get(t.asset_id);
    const isVid = a && (a.kind === "video" || a.kind === "render"
      || (a.content_type && a.content_type.startsWith("video/")));
    if (!a) {
      return <span style={{ display: "grid", placeItems: "center", width: "100%", height: "100%",
                            color: "#5e6678", fontSize: 11 }}>Take {idx + 1}</span>;
    }
    return isVid
      ? <video src={assetUrl(a) ?? undefined} muted preload="metadata" playsInline
               onLoadedMetadata={poster} />
      : <img src={assetUrl(a) ?? undefined} alt="" />;
  };

  const dialogueRows = (() => {
    const rows: { n: number; shot: number; speaker: string; line: string; delivery?: string }[] = [];
    let n = 0;
    (data.beats ?? []).forEach((bt, bi) => (bt.dialogue ?? []).forEach((d) => {
      n += 1;
      rows.push({ n, shot: bi + 1, speaker: (d.speaker ?? "").split(" — ")[0].trim() || "—",
                  line: d.line, delivery: d.delivery });
    }));
    return rows;
  })();

  return (
    <ModalShell
      width={1040} maxH={720} tall z={92}
      icon={<Wand2 size={16} />}
      title="Prompt & references"
      context={`${blockRef(block.idx)} · ${(durMs / 1000).toFixed(1)}s · ${modelName} · ${mode === "edit" ? "r2v edit" : block.mode}`}
      footer={<>
        <span className="sum">
          {footerSummary({ mode, anchorNo: anchor.index, refCount: shownRefs.length,
                           seedMode, seed, width: size.w, height: size.h })}
        </span>
        {note && (
          <span className="mono" style={{ fontSize: 12, color: note.bad ? "#ff8080" : "#6fd08c",
                                          maxWidth: 340, textAlign: "right", lineHeight: 1.4 }}>
            {note.text}
          </span>
        )}
        <button className="ws-ghost" onClick={ws.closeModal}>Cancel</button>
        <button
          className="ws-ghost"
          onClick={() =>
            ws.openModal({
              kind: "pickTake",
              blockId,
              fromScene: ws.modal && "fromScene" in ws.modal ? ws.modal.fromScene : undefined,
            })
          }
          style={{ display: "flex", alignItems: "center", gap: 6 }}
          title="Pick an existing take or asset from library instead of running AI render"
        >
          <FolderOpen size={14} /> From Library
        </button>
        <button className="ws-primary glow" disabled={busy} onClick={queue}>
          {mode === "edit" ? <Layers size={15} /> : <RefreshCw size={15} />}
          {copy.primary(nextTake)}
        </button>
      </>}
    >
      {/* ── mode tabs ──────────────────────────────────────────────────────
          Radio semantics, not a segmented control: each carries a second line,
          and that line is live state (which take is held). */}
      <div className="pr-tabs" role="radiogroup" aria-label="What this render does">
        {(["regenerate", "edit"] as const).map((m) => {
          const on = mode === m;
          const why = m === "edit" ? editWhy : "";
          return (
            <button key={m} role="radio" aria-checked={on} disabled={!!why}
                    className={"pr-tab" + (on ? " on" : "")}
                    title={why || (m === "regenerate"
                      ? "A new roll from the same references — the seed rerolls."
                      : "Hold one take and change only what you name. The seed stays put.")}
                    onClick={() => pickMode(m)}>
              <i>{m === "regenerate" ? <RefreshCw size={15} /> : <Layers size={15} />}</i>
              <span>
                <b>{COPY[m].tab}</b>
                <em>{why && m === "edit" ? "nothing to hold yet" : COPY[m].tabSub(anchor.index, on)}</em>
              </span>
            </button>
          );
        })}
      </div>

      <div className="pr-body">
        <div className="pr-col ns-scroll">
          {coerced && (
            <div className="pr-note info">
              <AlertTriangle size={14} />
              <span>{editWhy} Switched to a regenerate so the render matches what the button says.</span>
            </div>
          )}

          {/* ── anchor (edit only) ─────────────────────────────────────────
              Above the brief because it is the subject of the edit. Amber
              because it is take-state, matching the ACTIVE badge. */}
          {mode === "edit" && anchor.take && (
            <div className="pr-anchor">
              <span className="thumb"
                    onPointerEnter={(e) => anchor.take && openHover(
                      { assetId: anchor.take.asset_id, label: `Take ${anchor.index}` },
                      e.currentTarget)}
                    onPointerLeave={closeHover}>
                {takeMedia(anchor.take, anchor.index - 1)}
              </span>
              <span className="txt">
                <b>Editing take {anchor.index}</b>
                <em>anchor · identity, framing, timing and audio are held</em>
              </span>
              <Dropdown width={260} align="right"
                trigger={({ toggle }) => (
                  <button className="ws-microbtn" onClick={toggle}
                          title="Hold a different take">change take</button>
                )}>
                {(close) => (
                  <>
                    <div className="ws-menu-label">anchor this edit on</div>
                    {data.takes.map((t, i) => (
                      <button key={t.id} className={"ws-menu-row" + (t.id === anchor.take?.id ? " on" : "")}
                              disabled={t.state === "rejected" || !t.asset_id}
                              style={t.state === "rejected" ? { opacity: 0.45, cursor: "default" } : undefined}
                              onClick={() => { close(); setAnchorTakeId(t.id); }}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "block", fontSize: 12.5 }}>Take {i + 1}</span>
                          <span className="mono" style={{ display: "block", fontSize: 10, color: "#5e6678" }}>
                            {t.id === block.active_take_id ? "active" : t.state ?? "pending"}
                            {t.kind ? ` · ${t.kind}` : ""}
                          </span>
                        </span>
                        {t.id === anchor.take?.id && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                      </button>
                    ))}
                  </>
                )}
              </Dropdown>
            </div>
          )}
          {mode === "edit" && anchor.fellBack && (
            <div className="pr-note warn">
              <AlertTriangle size={14} />
              <span>
                The take this edit was anchored on is gone or was rejected — it now holds
                take {anchor.index}. Pick another with <b>change take</b> if that's wrong.
              </span>
            </div>
          )}
          {mode === "edit" && block.mode !== "r2v" && (
            <div className="pr-note info">
              <AlertTriangle size={14} />
              <span>
                This block is planned as <span className="mono">{block.mode}</span>. The edit renders
                as <span className="mono">r2v</span> with take {anchor.index} as the video reference —
                the block's own mode is left alone.
              </span>
            </div>
          )}

          {/* ── brief ──────────────────────────────────────────────────── */}
          <div className="pr-brief">
            <div className="pr-row">
              <span className="pr-st">{copy.briefLabel}</span>
              <span className="pr-grow" />
              {/* SHARPEN, on the Edit tab only. The regenerate brief goes to
                  the reviser, which rewrites beats — a clause written for the
                  edit envelope is the wrong artefact there, and the guide that
                  would write a PROMPT is the wrong one too, so the control is
                  simply absent rather than present and meaning something
                  different. `undo` restores the words that were typed. */}
              {mode === "edit" && preEnhance && preEnhance.mode === mode
                && preEnhance.text !== brief && !enhancing && (
                <button type="button" className="ws-ghost pr-mini"
                        title="Put the brief back the way you wrote it"
                        onClick={() => {
                          setBrief(preEnhance.text);
                          setPreEnhance(null); setNote(null);
                        }}>
                  <Undo2 size={12} /> undo
                </button>
              )}
              {mode === "edit" && (
                <button type="button" className="ws-ghost pr-mini"
                        disabled={!brief.trim() || enhancing}
                        title={"Tighten this into the one clause the edit carries — the change "
                             + "and the pictures it means, and nothing about the shot that "
                             + "stays. The studio writes the model's format around it."}
                        onClick={enhance}>
                  <Wand2 size={12} /> {enhancing ? "sharpening…" : "sharpen"}
                </button>
              )}
              <span className="pr-aibadge"
                    title="The prompt is composed on queue from this brief plus the reference set. You never write the model's format by hand.">
                <Sparkles size={11} />director writes the prompt
              </span>
            </div>
            <textarea rows={4} className={"pr-ta ns-scroll" + (mode === "edit" ? " live" : "")}
                      value={brief} placeholder={copy.placeholder}
                      onChange={(e) => setBrief(e.target.value)} />
            <div className="pr-chips">
              {copy.chips.map((c) => (
                // Chips APPEND to the brief; they never replace what's there.
                <button key={c} className="pr-chip"
                        onClick={() => setBrief((p) => (p ? p.replace(/\s+$/, "") + ". " : "") + c)}>
                  {c}
                </button>
              ))}
            </div>
            {/* What the brief will actually DO, said plainly, because the two
                intents do genuinely different things with it — and because a
                regenerate's brief edits the storyboard, which is not something
                to discover afterwards. */}
            {brief.trim() && (
              <span className="pr-meta" style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
                <Sparkles size={11} style={{ flex: "none", marginTop: 2, color: "#c97aff" }} />
                <span>
                  {mode === "regenerate"
                    ? "The director rewrites this block's shots — action, camera, who's in "
                      + "frame, the lines — reading the references below, and merges shots "
                      + "away when you ask for fewer cuts. The prompt is recompiled from the "
                      + "result. Changed lines re-record themselves. The edit sticks on the "
                      + "storyboard."
                    : "Sent with the anchor take as the model's video reference. The storyboard "
                      + "is not changed — only this take is."}
                </span>
              </span>
            )}
            {/* A SUBTRACTION IS THE ONE BRIEF THAT RENDERS ITS OPPOSITE, and it
                is the natural way to ask, so it is worth a line rather than a
                silent wrong take. Sharpen rewrites it (`editSystem` carries the
                rule); this says so instead of leaving the button looking
                decorative. A hint, never a blocker — the phrasing may be fine
                and the check is deliberately eager. */}
            {mode === "edit" && readsAsRemoval(brief) && (
              <span className="pr-meta" style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
                <AlertTriangle size={11} style={{ flex: "none", marginTop: 2, color: "#ffb84d" }} />
                <span>
                  This asks for something to be taken away. The model adds what it is
                  told and cannot remove, so a bare "remove the …" usually comes back
                  with the thing still there. Say what is in its place instead — the
                  bare floor, her empty hands — or press <b>sharpen</b>, which rewrites
                  it that way.
                </span>
              </span>
            )}
          </div>

          {/* ── dialogue: the block's, not this decision's ──────────────── */}
          {dialogueRows.length > 0 && (
            <>
              <button className={"pr-disc" + (showDialogue ? " open" : "")}
                      onClick={() => setShowDialogue((v) => !v)}>
                <ChevronRight size={12} />
                <MessageSquare size={13} style={{ flex: "none", color: "#c97aff" }} />
                Dialogue in this block
                <span className="pr-grow" />
                <span className="pr-meta" style={{ fontSize: 10.5 }}>
                  {dialogueRows.length} line{dialogueRows.length === 1 ? "" : "s"} · voices cast in the bible
                </span>
              </button>
              {showDialogue && (() => {
                const slots = asArray<import("../../lib/db/types").AudioRefSlot>(block.audio_refs);
                const lineSlot = new Map<number, { asset_id?: string; at_ms?: number }>();
                let exchange: { asset_id?: string; slot: number } | null = null;
                const timbreOnly = slots.length > 0 && slots.every((s) => s.kind === "voice");
                for (const s of slots) {
                  if (s.kind === "line" && s.order) lineSlot.set(s.order, s);
                  if (s.kind === "exchange") {
                    exchange = { asset_id: s.asset_id, slot: s.slot };
                    for (const l of s.lines ?? []) if (l.order) lineSlot.set(l.order, l);
                  }
                }
                const voiceOf = (speaker: string) => {
                  const e = data.bible.find((x) =>
                    x.kind === "character" && x.name.split(" — ")[0].trim().toLowerCase() === speaker.toLowerCase());
                  const doc = (e?.doc ?? {}) as { el_voice_id?: string };
                  return elVoiceName(doc.el_voice_id);
                };
                const xchgAsset = exchange?.asset_id ? data.assets.get(exchange.asset_id) : null;
                const askDialogue = () => ws.askDirector(
                  `Block ${blockRef(block.idx)}'s dialogue needs changes. Current lines:\n` +
                  dialogueRows.map((r) => `[Shot ${r.shot}] ${r.speaker}: "${r.line}"`).join("\n") +
                  `\n\nApply my edits to the beats (update_beat) — changed lines re-synthesize ` +
                  `automatically on the next retake and the shots re-time to the recording. ` +
                  `Ask me what should change.`);
                return (
                  <div className="ws-card" style={{ padding: 14 }}>
                    <div className="pr-row" style={{ marginBottom: 4 }}>
                      <span className="pr-meta">
                        {slots.length
                          ? exchange ? "one recorded conversation, placed verbatim"
                            : timbreOnly ? "voice-timbre refs only (no exact clips staged)"
                            : "recorded lines, placed verbatim"
                          : "clips stage on the next render"}
                      </span>
                      <span className="pr-grow" />
                      <button className="ws-microbtn" style={{ padding: "0 10px" }}
                              title="Opens the director with these lines — edits land on the beats"
                              onClick={askDialogue}>
                        <Sparkles size={11} />change the lines
                      </button>
                    </div>
                    {exchange && (
                      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "7px 0 2px" }}>
                        <span className="mono" style={{ fontSize: 10.5, color: "#8fc2ff", flex: "none" }}>
                          conversation clip
                        </span>
                        {xchgAsset
                          ? <audio controls preload="none" src={assetUrl(xchgAsset) ?? undefined}
                                   style={{ height: 30, flex: 1, minWidth: 0 }} />
                          : <span className="pr-meta">not on this device yet</span>}
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 8 }}>
                      {dialogueRows.map((r) => {
                        const s = lineSlot.get(r.n);
                        const clip = !exchange && s?.asset_id ? data.assets.get(s.asset_id) : null;
                        const vname = voiceOf(r.speaker);
                        return (
                          <div key={r.n} style={{ display: "flex", alignItems: "center", gap: 9,
                                                  padding: "7px 10px", borderRadius: 12,
                                                  background: "rgba(7,9,14,.45)",
                                                  border: "1px solid rgba(255,255,255,.06)" }}>
                            <span className="mono" style={{ fontSize: 9.5, color: "#5e6678", flex: "none" }}>
                              S{r.shot}
                            </span>
                            <span style={{ flex: "none", fontSize: 12, fontWeight: 600, maxWidth: 110,
                                           overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {r.speaker}
                            </span>
                            {vname && (
                              <span className="mono" style={{ flex: "none", fontSize: 9, padding: "2px 6px",
                                                              borderRadius: 7, background: "rgba(201,122,255,.12)",
                                                              color: "#c97aff" }}>
                                {vname}
                              </span>
                            )}
                            <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "#c8cfdb",
                                           overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                  title={r.line + (r.delivery ? ` — ${r.delivery}` : "")}>
                              “{r.line}”
                            </span>
                            {s?.at_ms != null && (
                              <span className="mono" style={{ flex: "none", fontSize: 9.5, color: "#6fd08c" }}
                                    title="Measured placement: where this line begins inside its shot">
                                @{(s.at_ms / 1000).toFixed(1)}s
                              </span>
                            )}
                            {clip && (
                              <audio controls preload="none" src={assetUrl(clip) ?? undefined}
                                     style={{ height: 26, width: 150, flex: "none" }} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 11, lineHeight: 1.55, color: "#5e6678", marginTop: 9 }}>
                      Line edits and voice recasts re-synthesize automatically on the next take
                      (clips are content-addressed). Shot lengths follow the recorded audio; a
                      cut-off line's shot is auto-extended inside the block by QA. Character
                      voices are cast in the bible — open a character to change theirs.
                    </div>
                  </div>
                );
              })()}
            </>
          )}

          {/* ── references ─────────────────────────────────────────────── */}
          <div className="ws-card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="pr-row" style={{ flexWrap: "wrap" }}>
              <span className="pr-st">
                {showGrid ? copy.refsLabel
                  : block.mode === "flf" ? "First and last frame"
                  : block.mode === "i2v" ? "Opening frame" : "Inputs"}
              </span>
              {showGrid && (
                <span className="pr-meta" style={{ color: overRefs ? "#ff8080" : undefined }}>
                  {shownRefs.length}/{maxRefs}
                </span>
              )}
              <span className="pr-grow" />
              <span className="pr-meta">changing these rewrites the prompt</span>
            </div>

            {/* The reference section IS the input form, so it has to look like
                whatever the render actually takes. An edit and r2v get the
                numbered set with roles; the FL2VA modes get one or two named
                frame slots; t2v gets nothing to fill in. A 0/9 grid under
                "flf" was asking for the wrong thing entirely. */}
            {showGrid ? (
              <div className="pr-refs">
                {shownRefs.map((r, i) => {
                  const chained = isChain(r);
                  const a = r.asset_id !== "prev_last_frame" ? data.assets.get(r.asset_id) : null;
                  const role = chained ? "chain" : roleOf(r);
                  // Only meaningful against a pre-existing set: in EDIT the
                  // whole list is the change, so a badge on every tile says
                  // nothing.
                  const isNew = mode === "regenerate" && fresh.has(r.asset_id);
                  return (
                    <div key={`${r.asset_id}-${i}`} className="pr-ref">
                      <div className={"sq" + (chained ? " chain" : isNew ? " new"
                        : role === "start_frame" ? " start" : "")}>
                        {a ? <img src={assetUrl(a) ?? undefined} alt="" />
                           : <span style={{ position: "absolute", inset: 0, display: "grid",
                                            placeItems: "center", color: "#3d4658" }}>
                               <ImageIcon size={18} /></span>}
                        {chained && <span className="pr-chainbadge">CHAIN</span>}
                        {!chained && isNew && <span className="pr-newbadge">NEW</span>}
                        {!chained && (
                          <button className="ws-microbtn sq danger del" title="Remove this reference"
                                  onClick={() => writeRefs(shownRefs.filter((_, j) => j !== i))}>
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                      {chained ? (
                        <span className="pr-role chain" style={{ cursor: "default", justifyContent: "center" }}
                              title="The previous block's final frame — what keeps the scene continuous.">
                          <span>{i + 1} · previous frame</span>
                        </span>
                      ) : (
                        <Dropdown width={250}
                          trigger={({ toggle }) => (
                            <button className={"pr-role" + (isNew ? " new" : "")} onClick={toggle}
                                    title={r.label ?? undefined}>
                              <span>{i + 1} · {roleLabel(role)}</span>
                              <ChevronDown size={10} style={{ flex: "none" }} />
                            </button>
                          )}>
                          {(close) => (
                            <>
                              <div className="ws-menu-label">{r.label ?? "reference"} — used as</div>
                              {ROLES.map((opt) => (
                                <button key={opt.id} className={"ws-menu-row" + (opt.id === role ? " on" : "")}
                                        onClick={() => { close(); setRole(i, opt.id); }}>
                                  <span style={{ flex: 1, minWidth: 0 }}>
                                    <span style={{ display: "block", fontSize: 12.5 }}>{opt.label}</span>
                                    <span style={{ display: "block", fontSize: 10.5, color: "#5e6678",
                                                   lineHeight: 1.45, whiteSpace: "normal" }}>{opt.hint}</span>
                                  </span>
                                  {opt.id === role && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                                </button>
                              ))}
                            </>
                          )}
                        </Dropdown>
                      )}
                    </div>
                  );
                })}

                {shownRefs.length < maxRefs && (
                  <button className="ws-dashbtn pr-add" onClick={() => setPicker({ kind: "refs" })}>
                    <Plus size={16} />
                    <span>add reference</span>
                  </button>
                )}
              </div>
            ) : block.mode === "t2v" ? (
              <div className="ws-empty" style={{ lineHeight: 1.6 }}>
                t2v builds the shot from the prompt alone — there is nothing to attach.
                {refs.length > 0 && ` The ${refs.length} reference${refs.length === 1 ? "" : "s"} on this block `
                  + `stay stored for when you switch back to r2v.`}
              </div>
            ) : (
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                {frameSlot("start_frame", "Opening frame",
                  "The segment opens on this exact image.")}
                {block.mode === "flf" && frameSlot("end_frame", "Closing frame",
                  "The segment arrives at this exact image.")}
                {(() => {
                  const spare = refs.filter((r) => !isChain(r)
                    && roleOf(r) !== "start_frame" && roleOf(r) !== "end_frame");
                  if (!spare.length) return null;
                  return (
                    <div style={{ flex: 1, minWidth: 170, alignSelf: "stretch", display: "flex",
                                  flexDirection: "column", gap: 7, padding: "11px 13px", borderRadius: 16,
                                  border: "1px dashed rgba(255,255,255,.1)" }}>
                      <span className="mono" style={{ fontSize: 10, letterSpacing: ".1em",
                                                      textTransform: "uppercase", color: "#5e6678" }}>
                        not used in {block.mode}
                      </span>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {spare.slice(0, 8).map((r) => {
                          const a = data.assets.get(r.asset_id);
                          return (
                            <span key={r.asset_id} title={`${r.label ?? "reference"} · ${roleLabel(roleOf(r))}`}
                                  style={{ width: 34, height: 34, borderRadius: 9, overflow: "hidden",
                                           background: "#0b0e14", border: "1px solid rgba(255,255,255,.08)",
                                           opacity: 0.5 }}>
                              {a && <img src={assetUrl(a) ?? undefined} alt=""
                                         style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                            </span>
                          );
                        })}
                      </div>
                      <span style={{ fontSize: 11, lineHeight: 1.5, color: "#5e6678" }}>
                        {spare.length} reference{spare.length === 1 ? "" : "s"} kept on the block —
                        r2v uses them, {block.mode} doesn't.
                      </span>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* What the picked model can actually be handed. Reference slots
                that exceed it are staged and then dropped by the provider, so
                the ceiling belongs next to the grid, not in a doc. */}
            <div className="pr-meta">
              {modelName} takes{" "}
              {caps.multiRef ? `up to ${caps.multiRef} images` : "no reference images"}
              {caps.refVideos ? `, ${caps.refVideos} videos` : ""}
              {caps.refAudios ? `, ${caps.refAudios} audio` : ""}
              {mode === "edit"
                ? ` in r2v — the anchor take is one of the ${caps.refVideos ?? 0} video slots, `
                  + `not one of the pictures. The block's own ${refs.length} reference`
                  + `${refs.length === 1 ? "" : "s"} stay on it, untouched.`
                : block.mode && MODE_INPUT[block.mode] ? ` in ${block.mode}` : ""}
              {caps.audio && mode !== "edit" ? " · carries its own audio" : ""}
            </div>

            {/* Everything that will fail, or fail quietly, before it is spent. */}
            {mode === "regenerate" && modeBlocker(block.mode) && (
              <div className="pr-note bad">
                <AlertTriangle size={14} />
                <span>{modeBlocker(block.mode)} The render will fail until that's fixed.</span>
              </div>
            )}
            {mode === "regenerate" && modes.length > 0 && !modes.includes(block.mode) && (
              <div className="pr-note warn">
                <AlertTriangle size={14} />
                <span>
                  This block is planned as <span className="mono">{block.mode}</span>, which{" "}
                  {modelName} doesn't list — it only does <span className="mono">{modes.join(", ")}</span>.
                  Its references may be ignored.
                </span>
              </div>
            )}
            {overRefs > 0 && showGrid && (
              <div className="pr-note warn">
                <AlertTriangle size={14} />
                <span>
                  {shownRefs.length} references but {modelName} takes {caps.multiRef} — the last{" "}
                  {overRefs} won't reach it.
                </span>
              </div>
            )}
            {startCount > 1 && mode === "regenerate" && (
              <div className="pr-note bad">
                <AlertTriangle size={14} />
                <span>Two slots are marked "start frame" — only one image can open a segment.</span>
              </div>
            )}
            {brokenChain && mode === "regenerate" && (
              <div className="pr-note bad">
                <AlertTriangle size={14} />
                <span style={{ flex: 1 }}>
                  This block opens on block {data.chainParent?.idx}'s final frame, but that block
                  hasn't rendered yet ({data.chainParent?.status}) — so there is no frame to open
                  on and the render will fail. Render block {data.chainParent?.idx} first, or start
                  this one fresh.
                </span>
                <button className="ws-microbtn" style={{ flex: "none" }}
                        onClick={async () => {
                          const { error } = await supabase.from("generation_blocks")
                            .update({ chain_from_block_id: null }).eq("id", blockId);
                          setNote(error ? { text: `Could not unlink: ${error.message}`, bad: true }
                            : { text: "Unchained — this block now starts fresh." });
                          reload();
                        }}>
                  Start fresh
                </button>
              </div>
            )}
            {refs.some(isChain) && showGrid && mode === "regenerate" && (
              <div className="pr-note warn">
                <AlertTriangle size={14} />
                <span>
                  The chain slot is the previous block's final frame — that's what keeps the scene
                  continuous, so it can't be removed here. Marking another image "start frame"
                  overrides it for this block.
                </span>
              </div>
            )}
            {showGrid && !shownRefs.length && (
              <div className="ws-empty" style={{ lineHeight: 1.6 }}>
                {mode === "edit"
                  ? "Nothing added — the anchor take carries the identity, the place and the "
                    + "framing already. Add a reference only for something the edit brings IN: "
                    + "a prop, a new costume, a look to match."
                  : "No references — the model invents identity and place on every roll."}
              </div>
            )}
          </div>

          {/* ── what the LAST render was actually sent ───────────────────
              A record, not a preview. The next prompt does not exist yet — it
              is composed on queue from the beats the brief is about to rewrite
              — so showing this as "the prompt the director will send" claimed
              to predict something nobody can predict, and on a block whose
              brief changes the dialogue it would have been actively wrong.

              Shown fully expanded, not behind a disclosure: this is the last
              thing in the column, so collapsing it saved no space and only
              cost a click. A static label, not a `.pr-disc` button — there is
              nothing here to toggle. */}
          {compiled && (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <div className="pr-row">
                <span className="pr-st" style={{ fontSize: 13 }}>Compiled prompt · last render</span>
                <span className="pr-grow" />
                <span className="pr-meta" style={{ fontSize: 10.5 }}>
                  fmt v{(compiled.fmt_version as number) ?? "?"} · read-only
                </span>
              </div>
              <div className="pr-draft">
                {Object.entries(compiled)
                  .filter(([k, v]) => k !== "fmt_version" && typeof v === "string" && v)
                  .map(([k, v]) => (
                    <div key={k}>
                      <h6>{k.replace(/_/g, " ")}</h6>
                      <p>{v as string}</p>
                    </div>
                  ))}
              </div>
            </div>
          )}

        </div>

        {/* ── rail ────────────────────────────────────────────────────────── */}
        <div className="pr-rail ns-scroll">
          <div className="ws-card">
            <span className="pr-st">Render</span>
            <Dropdown width={296}
              trigger={({ toggle }) => (
                <button className="pr-sel" onClick={toggle}>
                  <span>{modelName}</span>
                  <ChevronDown size={13} style={{ flex: "none" }} />
                </button>
              )}>
              {(close) => (
                // The shared grouped menu — same list, same grouping, as the
                // library and every other model picker in the app.
                <TieredModelMenu
                  models={data.models} value={modelId} close={close}
                  onPick={setModelId} quality={quality} onQuality={setQuality}
                  noteFor={(m) => (
                    (m.capabilities as { refVideos?: number } | null)?.refVideos
                    && (m.modes ?? []).includes("r2v") ? "can edit a take" : null)} />
              )}
            </Dropdown>

            <div style={{ display: "flex", gap: 9 }}>
              <Dropdown width={296}
                trigger={({ toggle }) => (
                  <button className="pr-sel" onClick={toggle} style={{ flex: 1 }}>
                    <span>{size.label}</span>
                    <ChevronDown size={13} style={{ flex: "none" }} />
                  </button>
                )}>
                {(close) => (
                  <>
                    <div className="ws-menu-label">
                      resolution{model?.sizes?.length ? ` · ${model.display_name}` : ""}
                    </div>
                    {resList.map((s) => (
                      <button key={s.id} className={"ws-menu-row" + (size.id === s.id ? " on" : "")}
                              onClick={() => { close(); setResId(s.id); }}>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "block", fontSize: 12.5 }}>{s.label}</span>
                          <span className="mono" style={{ display: "block", fontSize: 10, color: "#5e6678" }}>
                            {megapixels(s)} MP{s.maxFrames ? ` · max ${s.maxFrames}f` : ""}
                          </span>
                        </span>
                        {size.id === s.id && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                      </button>
                    ))}
                  </>
                )}
              </Dropdown>

              {/* A button, not a number field: the choice is roll / hold / type
                  one, and the default is what the intent implies. */}
              <Dropdown width={250} align="right"
                trigger={({ toggle }) => (
                  <button className={"pr-seed" + (seedMode === "roll" ? " on" : "")} onClick={toggle}
                          title={seedMode === "roll"
                            ? "A fresh seed is written on queue — a genuinely different roll."
                            : "The block's seed is held, so changes stay comparable."}>
                    {seedMode === "roll" ? <RefreshCw size={12} /> : <Lock size={12} />}
                    {seedMode === "roll" ? "new seed" : `seed ${seed ?? "—"}`}
                  </button>
                )}>
                {(close) => (
                  <>
                    <div className="ws-menu-label">seed</div>
                    <button className={"ws-menu-row" + (seedMode === "roll" ? " on" : "")}
                            onClick={() => { close(); setSeedMode("roll"); setSeed(rollSeed()); }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 12.5 }}>Roll a new one</span>
                        <span style={{ display: "block", fontSize: 10.5, color: "#5e6678", lineHeight: 1.45 }}>
                          A genuinely different take. Written on queue.
                        </span>
                      </span>
                      {seedMode === "roll" && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                    </button>
                    <button className={"ws-menu-row" + (seedMode === "hold" ? " on" : "")}
                            onClick={() => { close(); setSeedMode("hold"); setSeed(block.seed ?? 42); }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 12.5 }}>
                          Hold the block's ({block.seed ?? 42})
                        </span>
                        <span style={{ display: "block", fontSize: 10.5, color: "#5e6678", lineHeight: 1.45 }}>
                          Same roll — only your changes move.
                        </span>
                      </span>
                      {seedMode === "hold" && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                    </button>
                    <div className="ws-menu-label">or type one</div>
                    <div style={{ padding: "0 8px 8px" }}>
                      <input className="ws-input mono" type="number" value={seed ?? ""}
                             onChange={(e) => {
                               const v = e.target.value === "" ? null : Math.abs(Math.trunc(+e.target.value));
                               setSeed(v);
                               setSeedMode("hold");
                             }}
                             style={{ height: 32, padding: "0 10px", fontSize: 12.5 }} />
                    </div>
                  </>
                )}
              </Dropdown>
            </div>

            <div className="pr-meta" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
              {size.w}×{size.h}
              {model?.dim_step ? ` · snapped to the model's ${model.dim_step}px step` : ""} ·
              stored on the block.
            </div>

            {/* Reference strength is a RENDER parameter, not a reference one —
                it belongs with the other render parameters rather than under
                the grid it does not describe. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 7, paddingTop: 10,
                          borderTop: "1px solid rgba(255,255,255,.07)" }}>
              <div className="pr-row" style={{ gap: 8 }}>
                <span className="pr-meta" style={{ flex: 1 }}>reference strength</span>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{strength.toFixed(2)}</span>
              </div>
              <input type="range" min={0.2} max={1} step={0.01} value={strength}
                     title="Higher holds identity; lower lets the prompt move the camera."
                     onChange={(e) => setStrength(+e.target.value)} style={{ width: "100%" }} />
            </div>

            {/* Refinement — a render parameter like the one above it, and shown
                only where the model declares a recipe. */}
            {refineOk && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 10,
                            borderTop: "1px solid rgba(255,255,255,.07)" }}>
                <label className="pr-row" style={{ gap: 8, cursor: "pointer" }}>
                  <input type="checkbox" checked={refine}
                         onChange={(e) => setRefine(e.target.checked)} />
                  <span className="pr-meta" style={{ flex: 1 }}>refinement pass</span>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 600,
                                                  color: refine ? "#ffb454" : "#6b7385" }}>
                    {refine ? "2-pass" : "1-pass"}
                  </span>
                </label>
                <div style={{ fontSize: 11, lineHeight: 1.5, color: "#8b93a5" }}>
                  Renders as usual, then upscales 1.25x and samples again for 4
                  steps at low denoise. Measured +36-44% detail; the soundtrack is
                  carried across untouched. Roughly doubles the render, and on
                  blocks past ~9s it can drift in the back half.
                </div>
              </div>
            )}

            {model && model.provider !== "local" && (
              <div style={{ fontSize: 11.5, lineHeight: 1.55, color: "#e8c268" }}>
                Hosted — runs on {model.provider}&rsquo;s API as an{" "}
                <span className="mono">api_generate</span> job rather than on a GPU.
              </div>
            )}

            {/* ── advanced: the block's own mode ─────────────────────────
                Intent tabs and model-mode tabs cannot both live at the top,
                and nothing else in the product sets `block.mode` by hand — so
                it stays reachable and stops competing for the same attention. */}
            <button className={"pr-disc" + (showAdvanced ? " open" : "")}
                    style={{ padding: "9px 11px", fontSize: 11.5 }}
                    onClick={() => setShowAdvanced((v) => !v)}>
              <ChevronRight size={11} />
              <Settings2 size={12} style={{ flex: "none" }} />
              Block mode
              <span className="pr-grow" />
              <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>{block.mode}</span>
            </button>
            {showAdvanced && (
              <>
                <div className="ws-seg" style={{ width: "100%" }}>
                  {modes.map((m) => {
                    const why = modeBlocker(m);
                    return (
                      <button key={m} className={"mono" + (block.mode === m ? " on" : "")}
                              disabled={busy}
                              title={`${m} — takes ${MODE_INPUT[m] ?? "model-defined input"}` +
                                     (block.mode === m ? ". This block renders in this mode."
                                       : why ? `. ${why}` : ". Click to switch this block to it.")}
                              onClick={() => void setBlockMode(m)}
                              style={{ fontSize: 11, padding: "0 8px",
                                       opacity: block.mode === m ? 1 : why ? 0.4 : 0.72,
                                       color: block.mode !== m && why ? "#c9b48b" : undefined }}>
                        {m}
                      </button>
                    );
                  })}
                  {!modes.length && (
                    <button className="mono" disabled
                            style={{ fontSize: 11, padding: "0 8px", opacity: 0.5, cursor: "default" }}>
                      no modes listed
                    </button>
                  )}
                </div>
                <div className="pr-meta" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
                  {block.mode} takes {MODE_INPUT[block.mode] ?? "model-defined input"}. An edit
                  ignores this and renders r2v.
                </div>
              </>
            )}
          </div>

          <div className="ws-card" style={{ flex: "0 0 auto" }}>
            <div className="pr-row" style={{ gap: 8 }}>
              <span className="pr-st">Takes</span>
              <span className="pr-grow" />
              <button className="mono" onClick={() => ws.openModal({ kind: "takes", blockId })}
                      style={{ fontSize: 11, color: "#5aa2ff", background: "none", border: 0,
                               cursor: "pointer", padding: "2px 4px" }}>
                manage ({data.takes.length})
              </button>
            </div>
            <div className="pr-takes">
              {data.takes.slice(0, 6).map((t, idx) => {
                const isActive = t.id === block.active_take_id;
                const isAnchor = mode === "edit" && t.id === anchor.take?.id;
                const rejected = t.state === "rejected";
                return (
                  <button key={t.id}
                          className={(isActive ? "active " : "") + (isAnchor ? "anchor " : "")
                            + (rejected ? "rejected" : "")}
                          title={mode === "edit" && !rejected && t.asset_id
                            ? `Anchor this edit on take ${idx + 1}`
                            : `Take ${idx + 1}${isActive ? " (active)" : ""}${rejected ? " · rejected" : ""}`}
                          onPointerEnter={(e) => t.asset_id && openHover(
                            { assetId: t.asset_id, label: `Take ${idx + 1}` }, e.currentTarget)}
                          onPointerLeave={closeHover}
                          onClick={() => {
                            if (mode === "edit" && !rejected && t.asset_id) setAnchorTakeId(t.id);
                            else ws.openModal({ kind: "takes", blockId });
                          }}>
                    {takeMedia(t, idx)}
                    {isAnchor ? <span className="pr-tlbl anchor">ANCHOR</span>
                      : isActive ? <span className="pr-tlbl">ACTIVE</span> : null}
                  </button>
                );
              })}
              {!data.takes.length && (
                <div className="ws-empty" style={{ gridColumn: "1/-1", padding: 14, fontSize: 12 }}>
                  Nothing rendered yet.
                </div>
              )}
            </div>
            <div className="pr-kv">
              <div>
                <span>{model?.family ?? "H3"}</span>
                <span>{(durMs / 1000).toFixed(1)}s</span>
              </div>
              <div>
                <span>{isLocal ? "render ETA" : "runs on a hosted API"}</span>
                <span>{eta}</span>
              </div>
              {activeTake && mode === "regenerate" && (
                <div>
                  <span>active</span>
                  <span>take {data.takes.indexOf(activeTake) + 1}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {hover && createPortal(
        (() => {
          const W = 300;
          const a = data.assets.get(hover.assetId);
          const left = Math.max(8, Math.min(window.innerWidth - W - 8,
            hover.rect.left + hover.rect.width / 2 - W / 2));
          // Flip above only when there is genuinely room, same rule as
          // TakesStrip's — a popover clipped by the viewport is worse than one
          // covering the tile it came from.
          const above = hover.rect.top > 250;
          return (
            <div className="ws-hover ns-l2 ns-pop"
                 onPointerEnter={holdHover} onPointerLeave={closeHover}
                 style={{
                   position: "fixed", zIndex: 340, width: W, left,
                   ...(above ? { bottom: window.innerHeight - hover.rect.top + 10 }
                             : { top: hover.rect.bottom + 10 }),
                 }}>
              <div style={{ position: "relative", aspectRatio: "16/9", background: "#000" }}
                   onPointerMove={(e) => {
                     // Scrub rather than play: the question a take thumbnail
                     // cannot answer is "what happens in it", and dragging
                     // across the whole clip answers it in one gesture.
                     const v = e.currentTarget.querySelector("video");
                     const bar = e.currentTarget.querySelector<HTMLElement>("[data-bar]");
                     if (!v?.duration) return;
                     const r = e.currentTarget.getBoundingClientRect();
                     const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
                     v.currentTime = f * v.duration;
                     if (bar) bar.style.width = `${f * 100}%`;
                   }}>
                <video src={assetUrl(a) ?? undefined} muted preload="metadata" playsInline
                       onLoadedMetadata={poster}
                       style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 3,
                              background: "rgba(255,255,255,.16)" }}>
                  <span data-bar style={{ display: "block", height: "100%", width: "35%",
                                          background: "#eaeef6" }} />
                </div>
                <span className="mono" style={{ position: "absolute", left: 9, top: 9,
                                                padding: "4px 8px", borderRadius: 10,
                                                background: "rgba(7,9,14,.72)", backdropFilter: "blur(12px)",
                                                fontSize: 10.5, fontWeight: 600, color: "#eaeef6" }}>
                  {hover.label} · scrub to preview
                </span>
              </div>
            </div>
          );
        })(),
        document.body,
      )}

      {picker && (
        <AssetPickerModal
          projectId={data.projectId}
          title={picker.kind === "refs" ? "Add references" : picker.title}
          context={picker.kind === "refs"
            ? `${blockRef(block.idx)} · ${shownRefs.length}/${maxRefs} used · ${modelName}`
            : `${blockRef(block.idx)} · ${roleLabel(picker.role)} — one image only`}
          multi={picker.kind === "refs"}
          capacity={picker.kind === "refs" ? maxRefs - shownRefs.length : 1}
          // A frame slot may reuse an image already attached to the block; the
          // r2v set may not, since the same asset twice is a wasted slot.
          used={picker.kind === "refs" ? new Set(shownRefs.map((r) => r.asset_id)) : undefined}
          roles={picker.kind === "refs" ? ROLES : undefined}
          defaultRole={picker.kind === "refs" ? "look" : picker.role}
          onClose={() => setPicker(null)}
          onPick={(picks) => {
            if (picker.kind === "refs") addRefs(picks);
            else if (picks[0]) setFrame(picker.role, picks[0].asset, picks[0].label);
          }}
        />
      )}
    </ModalShell>
  );
}
