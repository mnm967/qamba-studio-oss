// Redraw or edit one storyboard panel, with its prompt and its references in
// hand.
//
// TWO INTENTS IN ONE MODAL, the image twin of PromptRefsModal's split. A panel
// is the shot's intended framing — the render receives it as a `scene_ref`
// whose framing IS copied — so "this panel is wrong" is a thing you need to be
// able to fix directly, not by re-planning the scene. The zoomed panel is where
// you notice it, so that is where the button lives. What you do about it is one
// of two things, and until now only the first existed:
//
//   REDRAW — a new roll. The prompt is yours to edit and the seed rerolls.
//   EDIT   — the panel becomes the first reference and seeds the sampler
//     (`mode: "edit"`), so everything you don't name is held.
//
// `src/lib/panelRetake.ts` owns every decision that differs between them,
// because each of them fails SILENTLY when it is wrong — see the header there.
// In particular the seed: this modal used to send none, `handle_image_gen`
// reads `payload.seed or 0`, and 0 is the seed the panel already rendered at —
// so pressing Redraw without editing the prompt returned the identical file.
//
// Two details decide whether the edited prompt actually takes effect, and both
// are enforced in `panelJobs` rather than here:
//   * `prompt_spec` is NOT sent. `handle_image_gen` recomposes the prompt from
//     the spec whenever one is present, which would silently discard whatever
//     was typed here.
//   * references travel as `ref_asset_ids`, not `anchors` — anchors are the
//     late-bound form (entry + role, resolved at run time) and there is
//     nothing late about a redraw you are watching.
//
// The rolls control and the rail below it are the same mechanism the scene
// editor's alternates strip already uses: >1 roll targets `panel_alt`, which
// APPENDS to `beats.meta.panel_alts`, because N jobs aimed at the single
// `panel_asset_id` slot overwrite each other and leave whichever landed last.
//
// AND THE RAIL HOLDS THE ROLL HISTORY, not only a round of offers. A single
// roll REPLACES `panel_asset_id`, which is the point of it — but the picture
// it replaced used to leave the beat entirely, so this rail read "0
// alternates" however many times you redrew and going back to the take you
// preferred meant finding it in the library by eye. `beatMetaAfter` keeps the
// displaced id (worker, hosted runner and promote all go through it), so a
// redraw you regret is one click back and costs no render.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle, Check, ChevronDown, ImagePlus, Layers, Lock, RefreshCw,
  Sparkles, Trash2, Wand2,
} from "lucide-react";
import ModalShell from "./ModalShell";
import AssetPickerModal, { type Pick as RefPick } from "./AssetPickerModal";
import Dropdown from "../ui/Dropdown";
import TieredModelMenu, { qualityTiers, type Quality } from "../ui/TieredModelMenu";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import { assetUrl } from "../../lib/db/assets";
import { saveBeat } from "../../lib/db/director";
import { enqueueJob, USER_PRIORITY } from "../../lib/db/jobs";
import { loadCatalog } from "../../lib/catalog";
import { modelKeyOf, resolveDefaults, type ProjectSettings } from "../../lib/projectSettings";
import { PANEL_ALTS, panelChoiceMeta } from "../../lib/panelSpec";
import {
  COPY, defaultPanelMode, defaultSeedMode, editBlocker, editRefWarning, footerSummary,
  heldSeed, panelJobs, promotedNote, queueBlocker, queuedNote,
  refCapacity, seedForRound, type PanelMode, type SeedMode,
} from "../../lib/panelRetake";
import type { Asset, Beat, ModelCatalogRow } from "../../lib/db/types";

/** How many rolls one press queues. 1 replaces the panel; the rest are offers.
 *  Capped at the worker's own `PANEL_ALTS_KEPT`, so a single round can never
 *  overflow the list it writes into. */
const ROLLS = [1, 3, PANEL_ALTS];

/** The catalog row a model_map key came from.
 *
 *  The asset records what it RENDERED on (`meta.model` / `meta.requested_model`
 *  are model_map keys) and the picker works in catalog ids, which disagree —
 *  `modelKeyOf`'s exception table exists because of exactly that. Scanning for
 *  the row whose derived key matches is the inverse, and it is exact. A key
 *  with no row (a model dropped from the catalog since) resolves to null, and
 *  the raw key is kept and still sent — the panel keeps rendering on what drew
 *  it rather than silently moving to a default. */
const rowForKey = (rows: ModelCatalogRow[], key: string | null) =>
  (key ? rows.find((m) => modelKeyOf(m.id) === key) ?? null : null);

/** A reference and what to call it. The picker knows the bible entry a sheet
 *  belongs to ("Rei · face"), which is the only useful caption here — an
 *  `assets` row carries no name of its own, so anything opened from a caller
 *  falls back to the object's filename. */
interface Ref { asset: Asset; label: string }
const refName = (a: Asset) => a.b2_key.split("/").pop() ?? "reference";
const asRef = (a: Asset): Ref => ({ asset: a, label: refName(a) });

export default function PanelRegenModal({
  asset, prompt: initialPrompt, refs: initialRefs, beatId, projectId, label, onClose,
}: {
  asset: Asset;
  prompt: string;
  refs: Asset[];
  beatId: string;
  projectId?: string | null;
  label?: string | null;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<PanelMode>(defaultPanelMode());
  /** Two fields, not one. Redraw's box IS the prompt and is sent verbatim;
   *  edit's is an instruction about the picture. Sharing one would mean
   *  switching tabs handed a 300-word panel prompt to an edit as its
   *  instruction, which reads as "change everything". */
  const [prompt, setPrompt] = useState(initialPrompt);
  const [instruction, setInstruction] = useState("");
  const [refs, setRefs] = useState<Ref[]>(() => initialRefs.map(asRef));
  /** An EDIT's references start EMPTY and are session-local, the same rule
   *  PromptRefsModal follows: an edit composes from the panel, which already
   *  carries the identity, the place and the framing, so its references are
   *  only what the edit brings IN. */
  const [editRefs, setEditRefs] = useState<Ref[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  // Hosted render quality. Panels default to low — measured, the shot is
  // right at every tier and only background detail scales, at 6x the price.
  const [quality, setQuality] = useState<Quality>("low");
  const [seedMode, setSeedMode] = useState<SeedMode>(defaultSeedMode("redraw"));
  /** Whether this picture recorded the roll it came from. Absent on an
   *  upload, and on anything rendered before `meta.seed` existed. */
  const canHold = heldSeed(asset.meta) != null;
  const [seed, setSeed] = useState<number | null>(null);
  const [denoise, setDenoise] = useState(0.55);
  const [rolls, setRolls] = useState(1);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Focused without `autoFocus`: that prop focuses via the DOM attribute,
   *  which makes the browser scroll the focused element into view — and with
   *  references now ABOVE the prompt on Redraw, that scroll carries the whole
   *  column past the hero image, opening the modal already scrolled past what
   *  it's showing you. `preventScroll` keeps the cursor in the box without
   *  moving the page under it. */
  const textRef = useRef<HTMLTextAreaElement>(null);

  /** The beat is loaded here rather than passed in, so every caller gets the
   *  alternates rail — AssetDetailModal opens this from a library picture and
   *  has no scene in hand at all. */
  const { data, reload } = useLiveQuery(
    async () => {
      const { data: beat } = await supabase.from("beats").select("*").eq("id", beatId).maybeSingle();
      const b = (beat ?? null) as Beat | null;
      const altIds = ((b?.meta?.panel_alts as string[] | undefined) ?? []);
      const panelId = b?.meta?.panel_asset_id as string | undefined;
      const stillId = b?.meta?.still_asset_id as string | undefined;
      const ids = [...new Set([...altIds, panelId, stillId].filter(Boolean) as string[])];
      const [{ data: rows }, { data: project }, models] = await Promise.all([
        ids.length ? supabase.from("assets").select("*").in("id", ids)
          : Promise.resolve({ data: [] as Asset[] }),
        projectId
          ? supabase.from("projects").select("settings").eq("id", projectId).maybeSingle()
          : Promise.resolve({ data: null }),
        // The full catalog, not imageModels() — a model you cannot see is a
        // model you cannot ask for, so a disabled row renders greyed with the
        // provider key it is waiting on.
        loadCatalog().then((all) => all.filter((m) => m.kind === "image")),
      ]);
      const byId = new Map(((rows ?? []) as Asset[]).map((a) => [a.id, a]));
      return {
        beat: b,
        alts: altIds.map((id) => byId.get(id)).filter(Boolean) as Asset[],
        panelId: panelId ?? null,
        hasUserStill: !!stillId,
        settings: ((project as { settings?: ProjectSettings } | null)?.settings ?? {}) as ProjectSettings,
        models,
      };
    },
    ["beats", "assets"], [beatId],
  );

  /** The model this panel was actually drawn with — NOT a constant. A panel has
   *  to match the sheets it is anchored to, and those are drawn with the
   *  project's own image model, which is not always Krea 2: hard-coding it
   *  redrew a Klein project's panel on Krea 2 and returned a picture that no
   *  longer matched its own bible.
   *
   *  `requested_model` is preferred over `model` because the latter records
   *  what RAN — so on a job that fell back (Krea 2 -> Klein when the rebalance
   *  node is absent) reusing it would pin the downgrade forever, instead of
   *  retrying what was asked for. */
  const renderedKey = (asset.meta?.requested_model as string)
    ?? (asset.meta?.model as string) ?? null;

  useEffect(() => {
    if (!data) return;
    // The row it rendered on, else the project's own image model, else leave
    // the picker empty and keep sending the raw key below.
    const own = rowForKey(data.models, renderedKey);
    setModelId(own?.id ?? (renderedKey ? null : resolveDefaults(data.settings).image_model));
  }, [data?.models.length, renderedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const model = useMemo(
    () => data?.models.find((m) => m.id === modelId) ?? null, [data?.models, modelId]);
  const modelName = model?.display_name ?? renderedKey ?? "the project's image model";
  /** A row we could not resolve keeps rendering on the key the panel used;
   *  once a row IS picked its own key wins. */
  const modelKey = model ? modelKeyOf(model.id) ?? null : renderedKey;

  const editWhy = editBlocker({ hasSource: true, model, modelName });
  /** A model switch can take Edit away underneath a chosen intent. Coerce
   *  rather than queue something the button doesn't say. */
  const coerced = mode === "edit" && !!editWhy;
  const liveMode: PanelMode = coerced ? "redraw" : mode;
  const copy = COPY[liveMode];
  const editing = liveMode === "edit";
  useEffect(() => { textRef.current?.focus({ preventScroll: true }); }, [liveMode]);

  const shownRefs = editing ? editRefs : refs;
  const maxRefs = refCapacity(model) || 9;
  // The source occupies one slot on an edit, so the room for ADDED pictures is
  // one less than the model's ceiling.
  const roomFor = Math.max(0, maxRefs - (editing ? 1 : 0));
  const overRefs = shownRefs.length > roomFor;
  const refWarning = editing ? editRefWarning(model, editRefs.length) : "";

  const text = editing ? instruction : prompt;
  const setText = editing ? setInstruction : setPrompt;

  const width = asset.width ?? 1280;
  const height = asset.height ?? 704;

  const nextSeed = () =>
    seedForRound({ seedMode, typed: seed, held: heldSeed(asset.meta) });

  const pickMode = (m: PanelMode) => {
    setMode(m);
    setSeedMode(defaultSeedMode(m, canHold));
    // Typed seeds are per-intent: a number entered to reproduce a roll means
    // nothing once the intent changes.
    setSeed(null);
  };

  const addRefs = (picked: RefPick[]) => {
    const room = roomFor - shownRefs.length;
    if (room <= 0) {
      setNote({ text: `${modelName} takes at most ${maxRefs} images`
        + (editing ? ", and the panel itself is one of them." : ".") , bad: true });
      return;
    }
    const incoming = picked.filter((p) => !shownRefs.some((r) => r.asset.id === p.asset.id)
      && !(editing && p.asset.id === asset.id));
    const take = incoming.slice(0, room);
    if (!take.length) { setNote({ text: "Those images are already staged." }); return; }
    (editing ? setEditRefs : setRefs)([
      ...shownRefs,
      ...take.map((p) => ({ asset: p.asset, label: p.label || refName(p.asset) })),
    ]);
    const dropped = incoming.length - take.length;
    setNote({ text: `Added ${take.length} reference${take.length === 1 ? "" : "s"}`
      + (dropped ? ` — ${dropped} didn't fit in ${modelName}'s ${maxRefs} slots.` : ".") });
  };

  const removeRef = (i: number) =>
    (editing ? setEditRefs : setRefs)(shownRefs.filter((_, j) => j !== i));

  const queue = async () => {
    const why = queueBlocker({ mode: liveMode, text, editWhy });
    if (why) { setNote({ text: why, bad: true }); return; }
    setBusy(true);
    try {
      const jobs = panelJobs({
        mode: liveMode, sourceAssetId: asset.id, beatId, text,
        refAssetIds: shownRefs.map((r) => r.asset.id),
        seed: nextSeed(), width, height, rolls,
        modelKey, denoise, label: label ?? "panel",
        // Gated on the MODEL, not just on the state: the tier survives a
        // model switch and the picker does not.
        quality: qualityTiers(model).length ? quality : null,
      });
      // Serially, so the seeds land in the order the labels claim.
      for (const payload of jobs) {
        await enqueueJob({
          kind: "image_gen", lane: "gpu", priority: USER_PRIORITY,
          project_id: projectId ?? undefined,
          ...(model ? { model_id: model.id } : {}),
          payload,
        });
      }
      setNote({ text: queuedNote(rolls, liveMode) });
      if (rolls > 1) reload();
      else setTimeout(onClose, 1100);
    } catch (e) {
      setNote({ text: `Could not queue: ${String(e).slice(0, 120)}`, bad: true });
    } finally { setBusy(false); }
  };

  /** Make one of the rolls the shot's panel. Deliberately NOT a render: the
   *  alternates are already on file, so a second opinion costs nothing. */
  const promote = async (assetId: string) => {
    if (!data?.beat) return;
    try {
      await saveBeat(beatId, { meta: panelChoiceMeta(data.beat, assetId) });
      setNote({ text: promotedNote(data.hasUserStill) });
      reload();
    } catch (e) {
      setNote({ text: `Could not promote: ${String(e).slice(0, 120)}`, bad: true });
    }
  };

  const blocked = queueBlocker({ mode: liveMode, text, editWhy });

  const refTile = (a: Asset | null, name: string, i: number, opts?: { locked?: string }) => (
    <div key={`${a?.id ?? "src"}-${i}`} className="pr-ref">
      <div className={"sq" + (opts?.locked ? " chain" : "")}>
        {a ? <img src={assetUrl(a) ?? undefined} alt="" />
           : <span style={{ position: "absolute", inset: 0, display: "grid",
                            placeItems: "center", color: "#3d4658" }}>
               <ImagePlus size={18} /></span>}
        {opts?.locked && <span className="pr-chainbadge">SOURCE</span>}
        {!opts?.locked && (
          <button className="ws-microbtn sq danger del" title="Remove this reference"
                  onClick={() => removeRef(i)}>
            <Trash2 size={11} />
          </button>
        )}
      </div>
      <span className={"pr-role" + (opts?.locked ? " chain" : "")}
            style={{ cursor: "default", justifyContent: "center" }}
            title={opts?.locked ?? name}>
        <span>{i + 1} · {name}</span>
      </span>
    </div>
  );

  /** Redraw shows what's staged before what to type — you're usually
   *  choosing references first and writing the prompt around them. Edit
   *  reverses it: the source is fixed (not a picker), so "what changes" is
   *  the primary action and the reference-additions are secondary. */
  const promptBlock = (
    // ── the box ─────────────────────────────────────────────────────────
    // Deliberately NOT a brief in the PromptRefsModal sense. That modal's
    // prompt is compiler-owned and its note goes through `revise_block`,
    // which rewrites the BEATS — and a beat is what the video block compiles
    // from too, so rewriting one to fix a picture would silently change the
    // shot. This text is sent verbatim.
    <div className="pr-brief" key="prompt">
      <div className="pr-row">
        <span className="pr-st">{copy.fieldLabel}</span>
        <span className="pr-grow" />
        <span className="pr-aibadge"
              title="This text is sent to the model as written. Nothing recomposes it — which is why the edit takes effect.">
          <Sparkles size={11} />sent verbatim
        </span>
      </div>
      <textarea ref={textRef} rows={editing ? 4 : 9}
                className={"pr-ta ns-scroll" + (editing ? " live" : "")}
                value={text} placeholder={copy.placeholder}
                onChange={(e) => setText(e.target.value)}
                style={editing ? undefined
                  : { fontSize: 12.5, lineHeight: 1.65, fontFamily: "var(--font-mono)" }} />
      <div className="pr-chips">
        {copy.chips.map((c) => (
          // Chips APPEND; they never replace what is there.
          <button key={c} className="pr-chip"
                  onClick={() => setText((p) => (p ? p.replace(/\s+$/, "") + ". " : "") + c)}>
            {c}
          </button>
        ))}
      </div>
      <span className="pr-meta">{copy.fieldHint}</span>
    </div>
  );

  const refsBlock = (
    // ── references ────────────────────────────────────────────────────
    <div className="ws-card" key="refs" style={{ padding: 14, display: "flex",
                                      flexDirection: "column", gap: 12 }}>
      <div className="pr-row" style={{ flexWrap: "wrap" }}>
        <span className="pr-st">{copy.refsLabel}</span>
        <span className="pr-meta" style={{ color: overRefs ? "#ff8080" : undefined }}>
          {shownRefs.length + (editing ? 1 : 0)}/{maxRefs}
        </span>
        <span className="pr-grow" />
        <span className="pr-meta">{copy.refsHint}</span>
      </div>
      {/* Fixed 88px tiles rather than the shared `.pr-refs` 4-up 1fr grid: a
          picture-editing modal's own references are supporting material, not
          the main event the block modal's grid is sized for, and at this
          modal's width 1fr tiles ran noticeably larger than anywhere else
          they're used. `.pr-add` already carries `aspect-ratio: 1`, so it
          matches the smaller column without its own override. */}
      <div className="pr-refs" style={{ gridTemplateColumns: "repeat(auto-fill, 88px)" }}>
        {/* On an edit the source is reference 1 and cannot be removed — the
            worker reworks `ref_names[0]`, so the numbering here has to be the
            numbering the render gets. */}
        {editing && refTile(asset, "this panel", 0,
                            { locked: "The picture being edited." })}
        {shownRefs.map((r, i) => refTile(r.asset, r.label, editing ? i + 1 : i))}
        <button className="pr-add" onClick={() => setPicking(true)}>
          <ImagePlus size={16} /> add
        </button>
      </div>
      {!editing && !refs.length && (
        <span className="pr-meta">
          none — the panel will be drawn from the prompt alone, which is how faces drift
        </span>
      )}
    </div>
  );

  return createPortal(
    <ModalShell
      icon={editing ? <Layers size={15} /> : <Wand2 size={15} />}
      title={copy.title} width={1020} maxH={720} tall z={97}
      context={`${label ?? "panel"} · ${modelName} · ${width}×${height}`}
      onClose={onClose}
      footer={<>
        <span className="sum">
          {footerSummary({ mode: liveMode, refCount: shownRefs.length, rolls, seedMode,
                           seed: seedMode === "hold" ? (seed ?? heldSeed(asset.meta)) : seed,
                           width, height, denoise: editing ? denoise : undefined })}
        </span>
        {note && (
          <span className="mono" style={{ fontSize: 12, color: note.bad ? "#ff8080" : "#6fd08c",
                                          maxWidth: 340, textAlign: "right", lineHeight: 1.4 }}>
            {note.text}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="ws-ghost" onClick={onClose}>Cancel</button>
        <button className="ws-primary glow" disabled={busy || !!blocked}
                title={blocked || undefined} onClick={() => void queue()}>
          {editing ? <Layers size={14} /> : <Wand2 size={14} />} {copy.primary(rolls)}
        </button>
      </>}
    >
      {/* ── mode tabs ────────────────────────────────────────────────────
          Radio semantics rather than a segmented control: each carries a
          second line saying what the intent does to the picture. */}
      <div className="pr-tabs" role="radiogroup" aria-label="What this render does">
        {(["redraw", "edit"] as const).map((m) => {
          const on = liveMode === m;
          const why = m === "edit" ? editWhy : "";
          return (
            <button key={m} role="radio" aria-checked={on} disabled={!!why}
                    className={"pr-tab" + (on ? " on" : "")}
                    title={why || (m === "redraw"
                      ? "A new roll of this shot — your prompt, a fresh seed."
                      : "Hold this picture and change only what you name. The seed stays put.")}
                    onClick={() => pickMode(m)}>
              <i>{m === "redraw" ? <RefreshCw size={15} /> : <Layers size={15} />}</i>
              <span>
                <b>{COPY[m].tab}</b>
                <em>{why && m === "edit" ? "this model can't rework a picture" : COPY[m].tabSub}</em>
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
              <span>{editWhy} Switched to a redraw so the render matches what the button says.</span>
            </div>
          )}

          {/* Sized to the panel's OWN aspect ratio, not a fixed box — a
              fixed height forced a shape mismatch against object-fit:contain,
              which is what letterboxing IS. 400 clears every widescreen ratio
              this app renders (H3/LTX land between 1.7 and 1.85 at this
              column's ~656px width); the cap only bites a genuinely portrait
              or square asset, which is exactly the case object-fit:contain
              is still there to protect. */}
          <div style={{ width: "100%", aspectRatio: `${width} / ${height}`, maxHeight: 400,
                        borderRadius: 14, overflow: "hidden",
                        border: "1px solid rgba(255,255,255,.08)", background: "#000",
                        display: "grid", placeItems: "center", flex: "none" }}>
            <img src={assetUrl(asset) ?? undefined} alt=""
                 style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          </div>

          {editing && (
            <div className="pr-note info">
              <Sparkles size={14} />
              <span>
                This picture is the edit's first reference and seeds the sampler — its framing,
                cast and light are held. Name only what changes.
              </span>
            </div>
          )}
          {refWarning && (
            <div className="pr-note warn">
              <AlertTriangle size={14} /><span>{refWarning}</span>
            </div>
          )}

          {/* Redraw: you're usually picking references before writing the
              prompt they inform, so the grid comes first. Edit: the source
              is fixed rather than picked, so "what changes" is the primary
              field and stays on top. */}
          {editing ? [promptBlock, refsBlock] : [refsBlock, promptBlock]}
        </div>

        {/* ── rail ────────────────────────────────────────────────────── */}
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
                // The shared grouped menu. Was a flat available/needs-a-key
                // split, which could not say a row runs at a provider.
                <TieredModelMenu
                  models={data?.models ?? []} value={modelId} close={close}
                  onPick={setModelId} quality={quality} onQuality={setQuality}
                  noteFor={(m) => [
                    (m.modes ?? []).includes("edit") ? "can edit a picture" : null,
                    modelKeyOf(m.id) === renderedKey ? "drew this one" : null,
                  ].filter(Boolean).join(" · ") || null} />
              )}
            </Dropdown>

            <div style={{ display: "flex", gap: 9 }}>
              {/* A button, not a number field: the choice is roll / hold / type
                  one, and the default is what the intent implies. */}
              <Dropdown width={250} align="right"
                trigger={({ toggle }) => (
                  <button className={"pr-seed" + (seedMode === "roll" ? " on" : "")}
                          style={{ flex: 1 }} onClick={toggle}
                          title={seedMode === "roll"
                            ? "A fresh seed is written on queue — a genuinely different roll."
                            : "The panel's own seed is held, so only your changes move."}>
                    {seedMode === "roll" ? <RefreshCw size={12} /> : <Lock size={12} />}
                    {seedMode === "roll" ? "new seed"
                      : `seed ${seed ?? heldSeed(asset.meta) ?? "—"}`}
                  </button>
                )}>
                {(close) => (
                  <>
                    <div className="ws-menu-label">seed</div>
                    <button className={"ws-menu-row" + (seedMode === "roll" ? " on" : "")}
                            onClick={() => { close(); setSeedMode("roll"); setSeed(null); }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 12.5 }}>Roll a new one</span>
                        <span style={{ display: "block", fontSize: 10.5, color: "#5e6678", lineHeight: 1.45 }}>
                          A genuinely different picture. Written on queue.
                        </span>
                      </span>
                      {seedMode === "roll" && <Check size={12} style={{ color: "#5aa2ff", flex: "none" }} />}
                    </button>
                    <button className={"ws-menu-row" + (seedMode === "hold" ? " on" : "")}
                            disabled={!canHold}
                            style={canHold ? undefined : { opacity: 0.45, cursor: "default" }}
                            title={canHold ? undefined
                              : "This picture didn't record a seed, so there is no roll to resume."}
                            onClick={() => { close(); setSeedMode("hold"); setSeed(null); }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 12.5 }}>
                          Hold this panel's{canHold ? ` (${heldSeed(asset.meta)})` : ""}
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
                               const v = e.target.value === "" ? null
                                 : Math.abs(Math.trunc(+e.target.value));
                               setSeed(v);
                               setSeedMode("hold");
                             }}
                             style={{ height: 32, padding: "0 10px", fontSize: 12.5 }} />
                    </div>
                  </>
                )}
              </Dropdown>
            </div>

            {/* ── rolls ───────────────────────────────────────────────────
                The one control that decides where the pictures LAND, so it
                says so rather than being labelled with a bare number. */}
            <div className="pr-row" style={{ gap: 8 }}>
              <span className="pr-meta" style={{ flex: 1 }}>rolls</span>
              <div className="ws-seg">
                {ROLLS.map((n) => (
                  <button key={n} className={"mono" + (rolls === n ? " on" : "")}
                          style={{ fontSize: 11, padding: "0 10px" }}
                          title={n === 1
                            ? "One picture, and it replaces this shot's panel."
                            : `${n} pictures, side by side under the panel to choose from.`}
                          onClick={() => setRolls(n)}>{n}</button>
                ))}
              </div>
            </div>
            <div className="pr-meta" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
              {rolls > 1
                ? `${rolls} rolls land as alternates — nothing is replaced until you promote one.`
                : "One roll replaces this shot's panel when it lands. The one it"
                  + " replaces is kept below, one click from coming back."}
            </div>

            {editing && (
              <>
                <div className="pr-row" style={{ gap: 8 }}>
                  <span className="pr-meta" style={{ flex: 1 }}>how much may change</span>
                  <span className="mono" style={{ fontSize: 11, color: "#8fc2ff" }}>
                    {Math.round(denoise * 100)}%
                  </span>
                </div>
                <input type="range" min={0.15} max={0.9} step={0.05} value={denoise}
                       onChange={(e) => setDenoise(+e.target.value)} />
                <div className="pr-meta" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
                  How far the sampler is allowed from this picture. Low keeps the
                  frame and reworks detail; high starts inventing composition.
                </div>
              </>
            )}

            <div className="pr-meta" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
              {width}×{height} · the panel's own size
              {(model?.family ?? "") === "minimax-h3"
                ? " · H3 snaps to its nearest native frame" : ""}
            </div>
          </div>

          {/* ── the roll so far ─────────────────────────────────────────── */}
          <div className="ws-card" style={{ flex: "0 0 auto" }}>
            <div className="pr-row" style={{ gap: 8 }}>
              <span className="pr-st">Rolls</span>
              <span className="pr-grow" />
              <span className="pr-meta">{data?.alts.length ?? 0} other
                {(data?.alts.length ?? 0) === 1 ? "" : "s"} on file</span>
            </div>
            <div className="pr-takes">
              {[...(data?.alts ?? [])].reverse().map((a) => {
                const isPanel = a.id === data?.panelId;
                return (
                  <button key={a.id} className={isPanel ? "active" : undefined}
                          title={isPanel ? "This is the shot's panel."
                            : "Make this the shot's panel — no render, it already exists."}
                          onClick={() => !isPanel && void promote(a.id)}>
                    <img src={assetUrl(a) ?? undefined} alt="" />
                    {isPanel && <span className="pr-tlbl">PANEL</span>}
                  </button>
                );
              })}
              {!data?.alts.length && (
                <span className="pr-meta" style={{ gridColumn: "1 / -1" }}>
                  Nothing else on file yet — every roll this shot has had collects
                  here, whether it replaced the panel or was rolled beside it.
                </span>
              )}
            </div>
            {data?.hasUserStill && (
              <span className="pr-meta" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
                This beat has a still you designated, which outranks every panel.
                Promoting changes what RENDERS, not what the strip shows.
              </span>
            )}
          </div>
        </div>
      </div>

      {picking && (
        <AssetPickerModal
          projectId={projectId ?? null}
          title={editing ? "Add a reference for this edit" : "Add a reference"}
          context={`${modelName} · ${roomFor - shownRefs.length} slot`
            + `${roomFor - shownRefs.length === 1 ? "" : "s"} left`}
          multi capacity={Math.max(0, roomFor - shownRefs.length)}
          used={new Set([...shownRefs.map((r) => r.asset.id), ...(editing ? [asset.id] : [])])}
          onPick={(picks) => { addRefs(picks); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      )}
    </ModalShell>,
    document.body,
  );
}
