// Bible entry detail — the character / place / prop sheet behind a row in the
// Bible, and the lore document behind a lore row.
//
// The sheet is three columns: references · spine · writing. The spine is what
// makes the other two readable — a fixed rail naming that kind's sections with
// a filled/empty dot each, so the state of a sheet is legible before you
// scroll it, and the one real decision on a character sheet (the speaking
// voice) is a click away instead of past sixteen equal-weight textareas.
//
// What it replaces, and why, is in src/lib/bibleSheet.ts: the sheet named
// fields nothing writes, did not name the fields the pipeline does, dropped
// every array-valued key on the floor, and rendered a provider id, an enum and
// a paragraph as the same 3-row box.
//
// The identity line keeps its own treatment because it is not prose: it is
// copied verbatim into every H3 prompt where this entry appears, so its length
// and concreteness decide whether the character survives a cut — and it is
// never clipped, because a line you can only half-read is a different line.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check, ChevronDown, ChevronRight, Copy, FileText, ImagePlus, Info, Layers, Loader2, Lock,
  MapPin, Package, Plus, Shirt, Sparkles, Trash2, Upload, Users, X, ZoomIn,
} from "lucide-react";
import ModalShell from "./ModalShell";
import AssetPickerModal from "./AssetPickerModal";
import Lightbox, { stepIndex } from "../ui/Lightbox";
import Dropdown from "../ui/Dropdown";
import ImageModelPicker, { validLoras } from "../ui/ImageModelPicker";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import { assetUrl } from "../../lib/db/assets";
import BibleVoiceClip from "./BibleVoiceClip";
import {
  attachRef, detachRef, loadRevisions, matchWorldField, saveEntry,
} from "../../lib/db/director";
import { enqueueJob } from "../../lib/db/jobs";
import { LORE_INDEX_MIN_CHARS, entryIndexState, indexEntryBody } from "../../lib/db/lore";
import { loadEpisodes } from "../../lib/db/projects";
import { chunkText } from "../../lib/loreChunk";
import LoreWhenPicker from "../ui/LoreWhenPicker";
import { isEvergreen, loreWhen, whenLabel, type LoreWhen } from "../../lib/loreTime";
import {
  modelKeyOf, resolveDefaults, styleTextFor, withStyle, type LoraPick, type ProjectSettings,
} from "../../lib/projectSettings";
import { loadCatalog } from "../../lib/catalog";
import {
  anchorLocked, anchorStanding, classifyDoc, fieldValue, hasValue, legalRole, listText, parseList,
  parsePalette, roleLabels, sectionState, sheetFor, visibleFields,
  type DotState, type SheetCtx, type SheetField, type SheetSection,
} from "../../lib/bibleSheet";
import type { Asset, BibleAsset, BibleEntry, ModelCatalogRow } from "../../lib/db/types";

/** Where a lore entry's prose lives, in the order it has been written over
 *  this app's life. `body` is the field now; the others are what earlier
 *  versions of this modal and the New-entry form wrote, and an entry saved
 *  under one of them still holds the only copy of that writing. */
const LORE_BODY_KEYS = ["body", "notes", "bio", "appearance"] as const;

const loreBodyKey = (doc: Record<string, unknown>): string => {
  for (const k of LORE_BODY_KEYS) {
    if (typeof doc[k] === "string" && (doc[k] as string).trim()) return k;
  }
  return "body";
};

/* ------------------------------------------------------------ typed fields */

/** No scrollbar inside a field: the box takes the height of its text. A
 *  clipped identity line reads as a shorter, vaguer identity line. */
const grow = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = "0px";
  el.style.height = `${el.scrollHeight + 2}px`;
};

function Prose({ value, placeholder, lead, autoFocus, onSave, onAbandon }: {
  value: string; placeholder?: string; lead?: boolean; autoFocus?: boolean;
  onSave: (next: string) => void;
  /** Blurring an add-chip's editor empty restores the chip — nothing is
   *  committed by curiosity. */
  onAbandon?: () => void;
}) {
  return (
    <textarea
      className={"ws-bs-prose" + (lead ? " lead" : "")} rows={1}
      ref={grow} defaultValue={value} placeholder={placeholder} autoFocus={autoFocus}
      onInput={(e) => grow(e.currentTarget)}
      onBlur={(e) => {
        const next = e.target.value;
        if (!next.trim() && !value.trim()) { onAbandon?.(); return; }
        if (next !== value) onSave(next);
      }} />
  );
}

function AddChip({ label, title, wide, onClick }: {
  label: string; title?: string; wide?: boolean; onClick: () => void;
}) {
  return (
    <button className={"ws-bs-add" + (wide ? " wide" : "")} onClick={onClick}
            title={title ?? label}>
      <Plus size={10} /><span>{label}</span>
    </button>
  );
}

/** `doc.palette` is a sentence the planner writes for every location — "humid
 *  emerald, cyan, violet, warm gold". It is what a colourist reads, and as
 *  prose in a 2-row box it was the least legible field on the sheet. */
function Swatches({ text, onEdit }: { text: string; onEdit: () => void }) {
  const swatches = parsePalette(text);
  return (
    <div className="ws-bs-swrow">
      {swatches.map((s, i) => (
        <button key={`${s.name}:${i}`} className="ws-bs-sw" onClick={onEdit}
                title={s.hex ? `${s.name} — ${s.hex}` : `${s.name} — no colour matched this name`}>
          <i className={s.hex ? "" : "unknown"} style={s.hex ? { background: s.hex } : undefined} />
          <span>{s.name}</span>
        </button>
      ))}
    </div>
  );
}

function ListChips({ items, readOnly, onChange }: {
  items: string[]; readOnly?: boolean; onChange?: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="ws-bs-chips">
      {items.map((it, i) => (
        <span key={`${it}:${i}`} className={"ws-bs-chip" + (readOnly ? " ro" : "")} title={it}>
          <span>{it}</span>
          {!readOnly && (
            <button title="Remove" onClick={() => onChange?.(items.filter((_, j) => j !== i))}>
              <X size={10} />
            </button>
          )}
        </span>
      ))}
      {!readOnly && (adding
        ? <input className="ws-input" autoFocus style={{ height: 27, width: 200, fontSize: 12 }}
                 placeholder="one more, or a comma-separated list"
                 onBlur={(e) => {
                   const add = parseList(e.target.value);
                   setAdding(false);
                   if (add.length) onChange?.([...items, ...add]);
                 }}
                 onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        : <AddChip label={items.length ? "add" : "add the first"} onClick={() => setAdding(true)} />)}
    </div>
  );
}

/* ------------------------------------------------------------------- spine */

function Spine({ sections, active, dotOf, onJump, written, total }: {
  sections: { id: string; label: string }[]; active: string;
  dotOf: (id: string) => DotState; onJump: (id: string) => void;
  written: number; total: number;
}) {
  const done = total > 0 && written >= total;
  return (
    <div className="ws-bs-spine">
      <span className="ws-flabel" style={{ color: "#5e6678", padding: "0 8px 8px" }}>
        On this sheet
      </span>
      {sections.map((s) => (
        <button key={s.id} className={"ws-bs-rail" + (s.id === active ? " on" : "")}
                onClick={() => onJump(s.id)}>
          <span className={`ws-bs-dot ${dotOf(s.id)}`} />
          <span>{s.label}</span>
        </button>
      ))}
      <div className={"ws-bs-prog" + (done ? " done" : written < total ? " low" : "")}>
        <span className="mono" style={{ fontSize: 9.5, color: "#5e6678", letterSpacing: ".05em" }}>
          SHEET
        </span>
        <b>{written}<i> / {total}</i></b>
        <em>fields written</em>
      </div>
    </div>
  );
}

/**
 * `onClose` exists so this can be opened from INSIDE another modal — the
 * wizard's cast & world step opens it on a card. Without it the Done button
 * and the scrim call `ws.closeModal`, which clears the store's ONE modal slot:
 * that slot is holding the wizard, so tidying up an entry would close the whole
 * wizard and lose the user's place in it.
 */
export default function BibleEntryModal({ entryId, onClose }: {
  entryId: string; onClose?: () => void;
}) {
  const ws = useWorkspaceStore();
  const close = onClose ?? ws.closeModal;
  const [note, setNote] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [tweak, setTweak] = useState("");
  // Null until picked: the default slot depends on the kind, which arrives with
  // the query.
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [modelId, setModelId] = useState<string | null>(null);
  const [loras, setLoras] = useState<LoraPick[]>([]);
  const [outfitOpen, setOutfitOpen] = useState(false);
  const [outfitName, setOutfitName] = useState("");
  const [outfitLook, setOutfitLook] = useState("");
  const [outfitBusy, setOutfitBusy] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  // Sheet chrome
  const [active, setActive] = useState("identity");
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [allRefs, setAllRefs] = useState(false);
  const writeRef = useRef<HTMLDivElement | null>(null);
  const secRefs = useRef(new Map<string, HTMLDivElement>());

  const { data, error: loadError, reload } = useLiveQuery(
    async () => {
      const { data: entry } = await supabase.from("bible_entries")
        .select("*").eq("id", entryId).single();
      const e = entry as BibleEntry;
      const { data: links } = await supabase.from("bible_assets")
        .select("*").eq("entry_id", entryId).order("slot");
      const vr = (e as { voice_ref_asset_id?: string | null }).voice_ref_asset_id;
      const ids = [...(links ?? []).map((l) => l.asset_id), ...(vr ? [vr] : [])];
      const { data: assets } = ids.length
        ? await supabase.from("assets").select("*").in("id", ids) : { data: [] };
      const [revisions, { data: project }, { data: jobs }, catalog, indexed,
             episodes, { data: siblings }] = await Promise.all([
        loadRevisions(entryId).catch(() => []),
        e.project_id
          ? supabase.from("projects").select("settings,style").eq("id", e.project_id).maybeSingle()
          : Promise.resolve({ data: null }),
        // References generated for this entry that haven't landed yet — without
        // these the sheet looks empty while the GPU is busy making the thing
        // you just asked for.
        // Claim order, so a sheet queued early in a big batch is in the window
        // while it renders rather than after — see loadRecentJobs in db/jobs.ts.
        supabase.from("jobs").select("id,kind,status,progress,progress_note,payload,error_msg")
          .in("kind", ["image_gen", "tts"]).in("status", ["queued", "running", "error"])
          .order("priority", { ascending: true })
          .order("created_at", { ascending: true }).limit(30),
        loadCatalog().then((all) => all.filter((m) => m.kind === "image")),
        // Whether this entry's body is mirrored into retrieval, and how far the
        // indexing got. Only lore mirrors, so this is null for every other kind.
        e.kind === "lore" && e.project_id
          ? entryIndexState(entryId, e.project_id).catch(() => null)
          : Promise.resolve(null),
        // The episode list, for lore's timing controls. Lore only: nothing
        // else on a bible entry is anchored in story time.
        e.kind === "lore" && e.project_id
          ? loadEpisodes(e.project_id).catch(() => [])
          : Promise.resolve([]),
        // The rest of the bible, so a world value can say how many entries
        // share it. `era` is the project's, not this entry's, and without the
        // count the World section is an ordinary paragraph you would edit
        // without knowing it belongs to thirty other sheets.
        e.project_id && e.kind !== "lore"
          ? supabase.from("bible_entries").select("id,name,kind,doc")
              .eq("project_id", e.project_id).neq("id", entryId)
          : Promise.resolve({ data: [] }),
      ]);
      type RawJob = {
        id: string; kind: string; status: string; progress: number | null;
        progress_note: string | null; error_msg: string | null;
        payload: { target?: { bible_entry_id?: string }; bible_entry_id?: string; speaker_entry_id?: string } | null;
      };
      const allJobs = ((jobs ?? []) as unknown as RawJob[]);
      const pending = allJobs.filter((j) => j.kind === "image_gen" && j.payload?.target?.bible_entry_id === entryId);
      const voiceJobs = allJobs.filter((j) => j.kind === "tts" && (j.payload?.bible_entry_id === entryId || j.payload?.speaker_entry_id === entryId));
      const voiceJob = voiceJobs.find((j) => j.status === "running")
        ?? voiceJobs.find((j) => j.status === "queued")
        ?? voiceJobs.find((j) => j.status === "error")
        ?? voiceJobs[0]
        ?? null;
      return {
        entry: e,
        links: (links ?? []) as BibleAsset[],
        assets: new Map(((assets ?? []) as Asset[]).map((a) => [a.id, a])),
        revisions, pending, voiceJob, catalog, indexed, episodes,
        siblings: (siblings ?? []) as { id: string; name: string; kind: string;
                                        doc: Record<string, unknown> | null }[],
        settings: ((project as { settings?: ProjectSettings } | null)?.settings ?? {}) as ProjectSettings,
        projectStyle: (project as { style?: string } | null)?.style ?? null,
      };
    },
    ["bible_entries", "bible_assets", "jobs"], [entryId]
  );

  const entry = data?.entry;
  useEffect(() => {
    if (!data || modelId != null) return;
    const eff = resolveDefaults(data.settings);
    setModelId(eff.image_model);
    setLoras(eff.image_loras);
  }, [data, modelId]);
  const refs = useMemo(
    () => (data?.links ?? []).map((l) => ({ link: l, asset: data?.assets.get(l.asset_id) }))
      .filter((r) => r.asset) as { link: BibleAsset; asset: Asset }[],
    [data]);

  // The rail is a position indicator as well as a jump target, so the active
  // item follows the writing column's scroll. rAF-coalesced: this fires on
  // every wheel tick and does a handful of rect reads.
  const syncActive = useCallback(() => {
    const c = writeRef.current;
    if (!c) return;
    const line = c.getBoundingClientRect().top + 24;
    let cur = "";
    for (const [id, el] of secRefs.current) {
      if (el.getBoundingClientRect().top <= line) cur = id;
    }
    if (cur) setActive(cur);
  }, []);
  const onScroll = useCallback(() => {
    requestAnimationFrame(syncActive);
  }, [syncActive]);

  if (!data || !entry) {
    return (
      <ModalShell width={1080} maxH={760} tall z={93} onClose={close}
                  icon={<Users size={16} />} title="Bible entry"
                  loading loadingLabel="Loading entry…" loadError={loadError} />
    );
  }
  const doc = (entry.doc ?? {}) as Record<string, unknown>;
  const isVisual = entry.kind === "character" || entry.kind === "environment";
  const isLore = entry.kind === "lore";
  const sheet = sheetFor(entry.kind);
  const bodyKey = loreBodyKey(doc);
  const ctx: SheetCtx = {
    entry, doc, voiceClip: Boolean(entry.voice_ref_asset_id), refCount: refs.length,
  };
  const classed = classifyDoc(sheet, ctx);
  // WHAT THIS SCREEN CAN DRAW, which is not the same set as what a location
  // HAS. `sheet.roles` is the vocabulary — it supplies the captions and the
  // labels for every plate on file — and a `takeOnly` slot (a location's
  // `coverage` grid) is produced by an `orbit_sheet` take and by nothing else.
  // Offering it here would be a Generate button whose only possible output is
  // one flat image filed as a contact sheet.
  const drawable = sheet.roles.filter((r) => !r.takeOnly);
  const role = picked && drawable.some((r) => r.id === picked) ? picked : sheet.anchor;
  const roleLabel = (id: string) =>
    sheet.roles.find((r) => r.id === id)?.label ?? id.replace("_", " ");
  const capOf = roleLabels(refs.map((r) => r.link), sheet.roles);
  // Slot order, as loaded — `anchorStanding` and `anchorLocked` both read it,
  // and the first entry carrying the anchor role is the one the worker
  // resolves.
  const refLinks = refs.map((r) => r.link);

  // Identity lives in the anchor slot — the face for a person, the master for a
  // place. Put it first so it is never the ref that gets dropped when a model
  // caps how many it accepts.
  const anchorFirst = [...refs].sort((a, b) =>
    Number(b.link.role === sheet.anchor) - Number(a.link.role === sheet.anchor));
  const hasAnchor = refs.some((r) => r.link.role === sheet.anchor);
  const model = data.catalog.find((m: ModelCatalogRow) => m.id === (modelId ?? "")) ?? null;
  const modelRefCap = Number((model?.capabilities as { refs?: number } | undefined)?.refs ?? 0);
  // The worker swaps a ref-incapable model for one that can take them rather
  // than dropping the anchors. Correct, but it must not be a surprise.
  //
  // Gated on having FOUND the row: `modelId` is a catalog id and the `refs ?? 0`
  // fallback cannot tell "this model takes none" from "I could not look this
  // one up", so a miss announced a limit the model does not have. Measured on
  // SenseNova U1.5 (ten references) whose settings row held the model_map key
  // `sensenova-u1` where the catalog id is `sensenova-u1-local` — the sheets
  // rendered on it correctly the whole time and only the warning was wrong.
  // A confidently wrong capability claim is worse than none.
  const willSubstitute = !!model && modelRefCap === 0
    && (hasAnchor || entry.kind === "character");
  const anchorNote = hasAnchor ? `, anchored on the ${sheet.anchorLabel} ref` : "";
  // `master` is the character sheet's catch-all, so its absence is never
  // worth reporting; a `takeOnly` slot is skipped for a different reason —
  // nothing on this screen can fill it, and a nag pointing at no button is
  // the control-that-cannot-reach-the-render one step removed.
  const missingRoles = drawable.filter(
    (r) => r.id !== "master" && !refs.some((x) => x.link.role === r.id));

  const saveDoc = async (key: string, value: unknown) => {
    const next = { ...doc };
    if (value === "" || (Array.isArray(value) && !value.length)) delete next[key];
    else next[key] = value;
    await saveEntry(entry.id, { doc: next } as Partial<BibleEntry>);
    reload();
  };

  const saveField = async (f: { key: string; scope?: "entry" | "doc" }, value: unknown) => {
    if (f.scope === "entry") {
      await saveEntry(entry.id, { [f.key]: value } as Partial<BibleEntry>);
      if (f.key === "identity_line") setNote("Identity line saved — applies to the next compile.");
      reload();
      return;
    }
    await saveDoc(f.key, value);
  };

  /** Write a lore entry's place in story time. Stored evergreen means "no
   *  `when` key at all" rather than a row of nulls: `lore_status` reads a
   *  missing key as evergreen, so the two are equivalent to the planner. */
  const saveWhen = async (next: LoreWhen) => {
    const rest = { ...doc };
    delete (rest as Record<string, unknown>).when;
    const nextDoc = isEvergreen(next) ? rest : { ...rest, when: next };
    await saveEntry(entry.id, { doc: nextDoc } as Partial<BibleEntry>);
    setNote(isEvergreen(next)
      ? "Always true — every episode is planned with this."
      : `Timing saved — ${whenLabel(next, data.episodes)}.`);
    reload();
  };

  /** Save a lore entry's prose and re-mirror it into retrieval. The write
   *  MIGRATES a legacy key to `body`, and the retrieval copy is replaced
   *  wholesale — merging would leave chunks of deleted paragraphs retrievable
   *  forever, which reads as the director quoting canon that was edited out. */
  const saveLoreBody = async (value: string) => {
    const next: Record<string, unknown> = { ...doc, body: value };
    if (bodyKey !== "body") delete next[bodyKey];
    await saveEntry(entry.id, { doc: next } as Partial<BibleEntry>);
    if (entry.project_id) {
      try {
        const res = await indexEntryBody({
          entryId: entry.id, projectId: entry.project_id, title: entry.name, body: value,
        });
        setNote(res
          ? `Saved — re-indexing ${res.chunks} passage${res.chunks === 1 ? "" : "s"}.`
          : "Saved. Short enough that the planner reads it in full — nothing to index.");
      } catch (e) {
        setNote(`Saved, but not re-indexed: ${String((e as Error).message || e).slice(0, 90)}`);
      }
    }
    reload();
  };

  /** Regenerate anchored on this entry's own anchor slot, so a tweak reads as
   *  "same character / same place, but…" rather than a fresh roll of the dice.
   *
   *  A body or outfit sheet generated without the face is a different person
   *  wearing the description — which is exactly how a redhead comes back
   *  blonde; a detail plate made without the master is a different room. So the
   *  anchor leads the reference list, and if there isn't one yet we make it
   *  first and chain this job behind it. */
  const generate = async (forRole?: string) => {
    const r = forRole ?? role;
    setBusy(true);
    try {
      const base = entry.identity_line || entry.summary || entry.name;
      const eff = resolveDefaults(data.settings);
      const style = styleTextFor(data.settings, data.projectStyle).text || undefined;
      const chosen = modelId ?? eff.image_model;
      const project_id = entry.project_id ?? undefined;
      // Only send a LoRA the chosen model actually declares — switching models
      // with one selected would otherwise ask the worker for a missing file.
      const ok = validLoras(data.catalog.find((m: ModelCatalogRow) => m.id === chosen), loras);
      // NOTE: anchored regenerations deliberately do NOT auto-add the
      // Identity Edit LoRA. On a fresh composition it normalizes wardrobe —
      // armor and prosthetics get erased (measured on NEONFALL tier 1) —
      // while the face-ref conditioning alone holds identity.
      const loraPayload = ok.length ? { loras: ok } : {};
      // The worker writes the prompt for the family that ends up running it
      // (worker/image_prompt.py). `prompt` stays as the fallback for a pod on
      // an older build.
      const specFor = (rr: string, n?: string) => ({
        kind: entry.kind, role: rr, name: entry.name, identity: base, style,
        ...(n ? { note: n } : {}),
      });

      let deps: string[] | undefined;
      let anchors = anchorFirst.map((x) => x.asset.id).slice(0, 3);

      // No anchor yet and this isn't it: make the anchor first, and depend on
      // it. The worker resolves the ref at execution, so it exists by the time
      // this one runs.
      if (isVisual && !hasAnchor && r !== sheet.anchor) {
        const anchorJob = await enqueueJob({
          kind: "image_gen", lane: "gpu", priority: 20, project_id,
          model_id: chosen,
          payload: {
            prompt_spec: specFor(sheet.anchor),
            prompt: withStyle(style, sheet.subject(sheet.anchor), base),
            model_key: modelKeyOf(chosen), width: 1024, height: 1024,
            ...loraPayload,
            auto_accept: true,
            label: `${entry.name} · ${sheet.anchorLabel} ${sheet.refWord}`,
            target: { bible_entry_id: entry.id, role: sheet.anchor, slot: refs.length },
          },
        });
        deps = anchorJob?.id ? [anchorJob.id] : undefined;
        anchors = [];
      }

      await enqueueJob({
        kind: "image_gen", lane: "gpu", priority: 20, project_id,
        model_id: chosen,
        ...(deps ? { depends_on: deps } : {}),
        payload: {
          // The style guide leads: it is what stops a project drifting between
          // cel shading, rendered 3D and photography between one ref and the next.
          //
          // The prompt is composed by the pipeline's own Python
          // (worker/image_prompt.py), which is where the family that finally
          // runs the job is known — the reference fallback can still swap one
          // model for another after this row is written. `prompt` is the
          // fallback for a build whose worker predates `prompt_spec`.
          prompt_spec: specFor(r, tweak.trim() || undefined),
          prompt: withStyle(style, sheet.subject(r), base, tweak.trim()),
          model_key: modelKeyOf(chosen),
          width: 1024, height: 1024,
          ...loraPayload,
          // You asked for a reference for THIS entry, so it attaches to this
          // entry. Without this the worker leaves it loose in the library and
          // you have to link it back by hand.
          auto_accept: true,
          label: `${entry.name} · ${roleLabel(r)} ${sheet.refWord}`,
          target: { bible_entry_id: entry.id, role: r, slot: refs.length + (deps ? 1 : 0) },
          ref_asset_ids: anchors,
          // Resolve the anchor at execution time when we just queued it.
          ...(deps ? { anchor_role: sheet.anchor, anchor_entry_id: entry.id } : {}),
        },
      });
      setNote(hasAnchor || r === sheet.anchor
        ? `Queued a ${roleLabel(r)} ${sheet.refWord}${anchorNote}.`
        : `No ${sheet.anchorLabel} ${sheet.refWord} yet — queued the ${sheet.anchorLabel} first, `
          + `then the ${roleLabel(r)} anchored on it.`);
      setTweak("");
      reload();   // show the pending tile now, not on the next realtime tick
    } catch (e) {
      setNote(`Could not queue: ${String((e as Error).message || e).slice(0, 110)}`);
    } finally { setBusy(false); }
  };

  /** The plates a coverage take can build on. `refs` carries ARCHIVED rows too
   *  (the loader does not filter, so the grid can show history), and
   *  `handlers/orbit._sheet_refs` reads live rows only — counting archived ones
   *  here would offer the button on an entry whose every plate is withdrawn,
   *  and the job would raise "has no reference plates" on an entry that
   *  visibly shows five. */
  const liveRefs = refs.filter((r) => (r.link.slot ?? 0) < 90);

  /** Redraw every view as ONE H3 take.
   *
   *  The per-role Generate above is N independent renders, which is why a
   *  location's four plates come back as four crops of one frontal view and a
   *  six-view turnaround is a composition the image models refuse. One take
   *  cannot drift between its own views.
   *
   *  It CONDITIONS on what is already here, so it is a second pass — hence the
   *  guard on `liveRefs`. Nothing is archived here: the handler retires what it
   *  replaces once the render lands, and archiving first would withdraw the
   *  pictures the take is built from. */
  const redrawAsOneTake = async () => {
    setCoverBusy(true);
    try {
      await enqueueJob({
        kind: "orbit_sheet", lane: "gpu", priority: 5,
        project_id: entry.project_id ?? undefined,
        payload: {
          entry_id: entry.id, sheet_mode: "coverage",
          label: `${entry.name.split(" — ")[0].slice(0, 44)} · coverage sheet`,
        },
      });
      setNote(`Queued one take covering every view, built from the `
              + `${liveRefs.length} plate${liveRefs.length === 1 ? "" : "s"} on file. `
              + `It replaces them when it lands.`);
      reload();   // show the pending tile now, not on the next realtime tick
    } catch (e) {
      // A LOCAL project is served now rather than refused: `orbit_sheet` is in
      // `plan_cli.KINDS` (and so in `LOCAL_PROJECT_KINDS`), so `enqueueJob`
      // CORRECTS the lane and this machine's own Python claims it — resolving
      // against `model_map.desktop.json` like every other render kind. What
      // still lands here is a build whose Python cannot, and a project on a
      // machine with no H3 reference checkpoint; both messages name the fix,
      // so show them rather than a generic failure.
      setNote(`Could not queue: ${String((e as Error).message || e).slice(0, 160)}`);
    } finally {
      setCoverBusy(false);
    }
  };

  /** Outfit variant: a new castable character entry sharing this one's face.
   *  The sheet renders as an identity-preserving EDIT of this entry's full
   *  body (Krea 2 Identity Edit LoRA when installed — an undeclared key is
   *  dropped by the worker, never fatal), anchored late so it works even while
   *  the parent's sheets are still rendering. */
  const makeOutfit = async () => {
    setOutfitBusy(true);
    try {
      const look = outfitLook.trim();
      const vname = `${entry.name} — ${outfitName.trim()}`.slice(0, 80);
      const base = (entry.identity_line || entry.name).replace(/\.$/, "");
      const { data: v, error } = await supabase.from("bible_entries").insert({
        project_id: entry.project_id, kind: "character", name: vname,
        summary: `${entry.name} in ${outfitName.trim()}`,
        identity_line: `${base}; now wearing ${look}`,
        doc: { variant_of: entry.id, outfit: look,
               ...(typeof doc.voice === "string" && doc.voice ? { voice: doc.voice } : {}) },
        status: entry.status === "confirmed" ? "confirmed" : "draft",
      }).select("id").single();
      if (error) throw new Error(error.message);
      const eff = resolveDefaults(data.settings);
      const style = styleTextFor(data.settings, data.projectStyle).text || undefined;
      const chosen = modelId ?? eff.image_model;
      await enqueueJob({
        kind: "image_gen", lane: "gpu", priority: 20,
        project_id: entry.project_id ?? undefined, model_id: chosen,
        payload: {
          prompt: `Change only the clothing: now wearing ${look}. Keep the face, hair, build and pose identical.`,
          prompt_spec: { kind: "character", role: "full_body", name: vname,
                         identity: `${base}; now wearing ${look}`, style },
          mode: "edit", denoise: 0.75,
          anchor_entry_id: entry.id, anchor_roles: ["full_body", "face"],
          loras: [{ key: "identity", strength: 1.0 }],
          model_key: modelKeyOf(chosen),
          width: 1024, height: 1024,
          auto_accept: true,
          label: `${vname} · full body`,
          target: { bible_entry_id: (v as { id: string }).id, role: "full_body", slot: 0 },
        },
      });
      setNote(`Created "${vname}" — its face stays anchored to ${entry.name}'s face sheet.`);
      setOutfitOpen(false); setOutfitName(""); setOutfitLook("");
      reload();
    } catch (e) {
      setNote(`Could not create the variant: ${String((e as Error).message || e).slice(0, 110)}`);
    } finally { setOutfitBusy(false); }
  };

  const loreBody = typeof doc[bodyKey] === "string" ? (doc[bodyKey] as string) : "";
  const loreChunks = loreBody.trim() ? chunkText(loreBody).length : 0;

  /* -------------------------------------------------------- writing column */

  const railItems = [
    ...sheet.sections.map((s) => ({ id: s.id, label: s.label })),
    ...(classed.extras.length ? [{ id: "extra", label: "Also written" }] : []),
    ...(classed.records.length ? [{ id: "records", label: "Records" }] : []),
  ];

  const dotOf = (id: string): DotState => {
    if (id === "records") return "records";
    if (id === "extra") return "written";
    const s = sheet.sections.find((x) => x.id === id);
    return s ? sectionState(s, ctx) : "unwritten";
  };

  const jump = (id: string) => {
    setActive(id);
    secRefs.current.get(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const secRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) secRefs.current.set(id, el); else secRefs.current.delete(id);
  };

  /** One field, rendered as its type. An unwritten one is an add-chip that
   *  becomes a focused editor in place, never a blank box. */
  const renderField = (f: SheetField) => {
    const raw = fieldValue(f, ctx);
    const filled = hasValue(raw);
    const key = `${f.scope ?? "doc"}:${f.key}`;
    const open = opened.has(key);
    const openIt = () => setOpened((s) => new Set(s).add(key));
    const closeIt = () => setOpened((s) => { const n = new Set(s); n.delete(key); return n; });

    // A `full` field runs the whole writing width with no label column — the
    // section header is already its label, and the 84px column is what pushed
    // a four-colour palette onto two rows.
    const wrap = (ctl: React.ReactNode, mid = true) =>
      f.full
        ? <div key={key}>{ctl}</div>
        : (
          <div className={"ws-bs-row" + (mid ? " mid" : "")} key={key}>
            <span className="ws-flabel">{f.label}</span>
            <div className="ws-bs-ctl">{ctl}</div>
          </div>
        );

    if (f.type === "enum") {
      return wrap(
        <div className="ws-bs-enum">
          {(f.options ?? []).map((o) => (
            <button key={o} className={o === raw ? "on" : ""}
                    onClick={() => void saveField(f, o)}>{o}</button>
          ))}
        </div>);
    }

    if (f.type === "colors" && filled && !open) {
      return wrap(<Swatches text={String(raw)} onEdit={openIt} />);
    }

    if (f.type === "list") {
      const items = Array.isArray(raw) ? raw.map(String) : parseList(listText(raw));
      return wrap(filled || open
        ? <ListChips items={items} readOnly={f.readOnly}
                     onChange={(next) => void saveField(f, next)} />
        : <AddChip label={f.hint} title={f.guide} onClick={openIt} />);
    }

    if (!filled && !open) {
      return wrap(<AddChip label={f.hint} title={f.guide} onClick={openIt} />);
    }

    const text = typeof raw === "string" ? raw : listText(raw);
    return wrap(
      <Prose key={`${key}:${text.length}`} value={text} placeholder={f.guide ?? f.hint}
             lead={f.key === "identity_line"}
             autoFocus={open && !filled}
             onSave={(next) => { closeIt(); void saveField(f, f.type === "list" ? parseList(next) : next); }}
             onAbandon={closeIt} />,
      false);
  };

  /* --------------------------------------------------------------- world */

  const worldPeers = (key: string) => {
    const mine = typeof doc[key] === "string" ? (doc[key] as string).trim() : "";
    const withValue = data.siblings.filter(
      (s) => typeof s.doc?.[key] === "string" && (s.doc[key] as string).trim());
    return {
      mine,
      same: withValue.filter((s) => (s.doc![key] as string).trim() === mine),
      other: withValue.filter((s) => (s.doc![key] as string).trim() !== mine),
    };
  };

  const worldNotice = (s: SheetSection) => {
    const f = s.fields.find((x) => x.inherited);
    if (!f) return null;
    const { mine, same, other } = worldPeers(f.key);
    if (!mine && !same.length && !other.length) return null;
    if (!mine) {
      const common = other[0];
      return (
        <div className="ws-bs-note purple">
          <Info size={12} style={{ flex: "none" }} />
          <span>
            {other.length} other {other.length === 1 ? "entry has" : "entries have"} an era and
            this one does not — it will be planned without the world's period.
          </span>
          <button className="ws-microbtn" style={{ flex: "none", borderColor: "rgba(201,122,255,.35)", color: "#c97aff" }}
                  onClick={async () => {
                    await saveDoc(f.key, String(common.doc![f.key]));
                    setNote(`Inherited the era from ${common.name}.`);
                  }}>
            inherit
          </button>
        </div>
      );
    }
    if (other.length) {
      return (
        <div className="ws-bs-note amber">
          <Info size={12} style={{ flex: "none" }} />
          <span>
            {other.length} other {other.length === 1 ? "entry says" : "entries say"} something
            else. A world with two eras plans as two worlds.
          </span>
          <button className="ws-microbtn" style={{ flex: "none", borderColor: "rgba(232,194,104,.4)", color: "#e8c268" }}
                  onClick={async () => {
                    const n = await matchWorldField(other.map((o) => o.id), f.key, mine);
                    setNote(`Updated ${n} ${n === 1 ? "entry" : "entries"} to this era.`);
                    reload();
                  }}>
            match {other.length}
          </button>
        </div>
      );
    }
    return (
      <div className="ws-bs-note purple">
        <Info size={12} style={{ flex: "none" }} />
        <span>
          Shared by {same.length} other {same.length === 1 ? "entry" : "entries"}. Editing it here
          changes the world, not this {entry.kind}.
        </span>
      </div>
    );
  };

  /* ----------------------------------------------------------------- render */

  return (
    <ModalShell
      width={isLore ? 860 : 1080} maxH={760} tall z={93}
      onClose={close}
      icon={entry.kind === "character" ? <Users size={16} />
            : isLore ? <FileText size={16} />
              : entry.kind === "environment" ? <MapPin size={16} /> : <Package size={16} />}
      title={entry.name}
      context={isLore
        ? `lore · bible v${entry.version} · ${entry.status}`
          + (loreChunks ? ` · ${loreChunks} passage${loreChunks === 1 ? "" : "s"}` : "")
        : `${entry.kind} · bible v${entry.version} · ${entry.status} · ${refs.length} ref${refs.length === 1 ? "" : "s"}`}
      headActions={
        <button className="ws-icobtn" title={`Delete ${entry.name}`}
                style={{ color: "#7e8b9e" }}
                onClick={() => ws.openModal({ kind: "deleteEntry", entryId: entry.id, name: entry.name, kindName: entry.kind })}>
          <Trash2 size={15} />
        </button>
      }
      footer={<>
        <span className="sum">
          {isLore
            ? "The summary travels with every plan; the body is retrieved when it is relevant."
            : "The identity line is copied verbatim into every prompt this entry appears in."}
        </span>
        {note && <span className="mono" style={{ fontSize: 12, color: "#6fd08c" }}>{note}</span>}
        {/* A draft is a proposal — from the wizard, from a director revision,
            from extract_lore — and this modal is where a user reading one
            lands. "Done" alone closes it with nothing decided. */}
        {entry.status === "draft" && (
          <button className="ws-primary"
                  style={{ borderColor: "rgba(111,208,140,.5)", background: "rgba(111,208,140,.12)", color: "#6fd08c" }}
                  onClick={async () => {
                    await saveEntry(entry.id, { status: "confirmed" });
                    setNote("Confirmed — this is canon now.");
                    reload();
                  }}>
            <Check size={13} /> Keep
          </button>
        )}
        <button className="ws-ghost" onClick={close}>Done</button>
      </>}
    >
      {isLore ? (
        /* ---- lore: a document, not a sheet ------------------------------
           No reference column at all. A lore entry has no face, no angles and
           nothing to anchor a render on, and no sheet to put a spine on. */
        <div className="ns-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 22px 14px",
                                            display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Timing first: it decides which episodes see any of what follows,
              so reading the body without it is reading canon out of context. */}
          {data.episodes.length > 0 && (
            <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>When is this true?</span>
                <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
                  decides which episodes are planned with it
                </span>
              </div>
              <LoreWhenPicker
                value={loreWhen(doc)} episodes={data.episodes}
                onChange={(next) => void saveWhen(next)} />
            </div>
          )}

          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 6 }}>
              <span className="ws-flabel">In one line</span>
              <span className="mono" style={{ fontSize: 10.5, color: "#6fd08c" }}>
                always in the director's context
              </span>
            </div>
            <textarea className="ws-input" rows={2} defaultValue={entry.summary ?? ""}
                      placeholder="What this is and what it changes — the one line every plan sees."
                      style={{ fontSize: 13.5, lineHeight: 1.65, padding: "13px 15px", borderRadius: 16 }}
                      onBlur={async (e) => {
                        if (e.target.value !== (entry.summary ?? "")) {
                          await saveEntry(entry.id, { summary: e.target.value });
                          setNote("Summary saved — it applies to the next plan."); reload();
                        }
                      }} />
            <div style={{ fontSize: 11.5, color: "#5e6678", marginTop: 6, lineHeight: 1.55 }}>
              Every bible entry is flattened to one line for the planner, and for lore this is
              that line. Carry the <i>consequence</i>: "nobody speaks the old names aloud" is
              usable; "a treaty from the war" is not.
            </div>
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 9, marginBottom: 6 }}>
              <span className="ws-flabel">The lore itself</span>
              <span className="mono" style={{ fontSize: 10.5, color: "#8fc2ff" }}>
                retrieved when relevant
              </span>
              <span style={{ flex: 1 }} />
              <label className="ws-microbtn" style={{ cursor: "pointer", padding: "0 8px" }}>
                <Upload size={11} /> append a file
                <input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" hidden
                       onChange={async (e) => {
                         const f = e.target.files?.[0];
                         if (!f) return;
                         try {
                           const text = await f.text();
                           if (!text.trim()) { setNote(`${f.name} is empty.`); return; }
                           await saveLoreBody(loreBody.trim() ? `${loreBody.trim()}\n\n${text}` : text);
                         } catch (err) {
                           setNote(`Could not read ${f.name}: ${String((err as Error).message).slice(0, 80)}`);
                         }
                       }} />
              </label>
            </div>
            {/* key: uncontrolled, so it must remount when the text is replaced
                from underneath it (an appended file, a migrated legacy key) —
                otherwise the box keeps showing the pre-append value and the
                next blur writes that back over the append. */}
            <textarea key={`${bodyKey}:${loreBody.length}`} className="ws-input ns-scroll" rows={16}
                      defaultValue={loreBody}
                      placeholder="History, rules, factions, terminology — as long as it needs to be."
                      style={{ fontSize: 13, lineHeight: 1.7, padding: "13px 15px", borderRadius: 16,
                               resize: "vertical" }}
                      onBlur={(e) => { if (e.target.value !== loreBody) void saveLoreBody(e.target.value); }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 7, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
                {loreBody.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words
                {loreChunks ? ` · ${loreChunks} passage${loreChunks === 1 ? "" : "s"}` : ""}
              </span>
              {data.indexed && (
                <span className="mono" style={{ fontSize: 10.5,
                       color: data.indexed.embedded >= data.indexed.chunks ? "#6fd08c" : "#e8c268" }}>
                  {data.indexed.embedded >= data.indexed.chunks
                    ? "indexed — searchable by the director"
                    : `${data.indexed.embedded}/${data.indexed.chunks} indexed — the rest wait for the studio cloud`}
                </span>
              )}
              {!data.indexed && loreBody.trim().length > 0
                && loreBody.trim().length < LORE_INDEX_MIN_CHARS && (
                <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
                  short enough to be read in full — not indexed separately
                </span>
              )}
              {/* Long enough to index and no index row: the save that would
                  have created one hasn't happened (or failed). */}
              {!data.indexed && loreBody.trim().length >= LORE_INDEX_MIN_CHARS && (
                <span className="mono" style={{ fontSize: 10.5, color: "#e8c268" }}>
                  not indexed — edit and blur to index it
                </span>
              )}
            </div>
            {bodyKey !== "body" && (
              <div style={{ fontSize: 11, color: "#5e6678", marginTop: 6, lineHeight: 1.55 }}>
                This entry's text is stored under <span className="mono">{bodyKey}</span> from an
                earlier version. Saving moves it to the current field — nothing is lost.
              </div>
            )}
          </div>

          {data.revisions.length > 0 && (
            <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                Pending director revisions
                <span className="mono" style={{ fontSize: 11, color: "#e8c268", marginLeft: 8 }}>
                  {data.revisions.length}
                </span>
              </span>
              <div style={{ fontSize: 12, lineHeight: 1.6, color: "#9aa4b6" }}>
                The director proposed changes to this entry. They stay drafts until you
                confirm them on the Bible page.
              </div>
            </div>
          )}
        </div>
      ) : (
      <div className="ws-bs-body">
        {/* ---- references ------------------------------------------------- */}
        <div className="ws-bs-refs ns-scroll" style={{ width: sheet.refsWidth }}>
          <div className="ws-card">
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{sheet.refsTitle}</span>
              {refs.length > 0 && (
                <span className="mono" style={{ fontSize: 10, color: "#5e6678" }}>
                  {refs.length}
                  {isVisual && (() => {
                    const n = new Set(refs.map((r) => r.link.role)).size;
                    const word = entry.kind === "environment" ? "angle" : "slot";
                    return ` · ${n} ${word}${n === 1 ? "" : "s"}`;
                  })()}
                </span>
              )}
              <span style={{ flex: 1 }} />
              <button className="ws-microbtn" style={{ padding: "0 8px" }}
                      onClick={() => setPicking((p) => !p)}>
                <ImagePlus size={11} />library
              </button>
            </div>
            {(refs.length || data.pending.length) ? (
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${sheet.refCols},1fr)`,
                            gap: sheet.refCols === 3 ? 8 : 9 }}>
                {data.pending.map((j) => (
                  <div key={j.id} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <span className={"ws-refbig pending" + (j.status === "error" ? " failed" : "")}
                          title={j.error_msg ?? j.progress_note ?? j.status}>
                      {j.status === "error"
                        ? <X size={16} style={{ color: "#ff8080" }} />
                        : <Loader2 size={16} className="ns-spin" style={{ color: "#8fc2ff" }} />}
                      {j.status === "running" && j.progress != null && (
                        <i className="bar" style={{ width: `${Math.round(j.progress * 100)}%` }} />
                      )}
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: j.status === "error" ? "#ff8080" : "#5e6678",
                                                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {j.status === "error" ? "failed" : j.status === "running" ? (j.progress_note ?? "rendering") : "queued"}
                    </span>
                  </div>
                ))}
                {/* Six then "+n more": a location genuinely holds seven plates,
                    and a column that scrolls past the Generate card hides the
                    control you opened it for. */}
                {refs.slice(0, allRefs ? refs.length : 6).map((r, i) => {
                  // The badge means "everything else here was generated against
                  // this one". A prop generates nothing — it has no Generate
                  // card at all — so on a prop it would label a fact that has
                  // no consequence.
                  //
                  // `live` vs `spare` matters as much as the badge itself: two
                  // sheets in the anchor slot are not two anchors, they are the
                  // one the worker resolves plus one nothing reads. Both said
                  // ANCHOR until 2026-08-24, so "which face is this character"
                  // had no answer on screen and removing the wrong tile would
                  // have swapped her identity silently.
                  const standing = isVisual ? anchorStanding(r.link, sheet, refLinks) : null;
                  const locked = anchorLocked(r.link, sheet, refLinks);
                  return (
                    <div key={r.link.asset_id}
                         className={"ws-bs-tile" + (standing === "live" ? " anchor" : "")}
                         style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <button className="ws-refbig" title="Click to view full size"
                              onClick={() => setLightbox(i)}>
                        <img src={assetUrl(r.asset) ?? undefined} alt="" />
                        <span className="zoom"><ZoomIn size={15} /></span>
                      </button>
                      {/* The anchor ring and badge are load-bearing: a plate
                          generated without this tile is a different person or
                          a different room, and nothing said which one it was. */}
                      {standing === "live" && <span className="ws-bs-anchorbadge">ANCHOR</span>}
                      {standing === "spare" && (
                        <span className="ws-bs-anchorbadge spare"
                              title={`A second ${sheet.anchorLabel} ${sheet.refWord}. Every render `
                                + `resolves the first one, so this is on file and unused — remove it, `
                                + `or remove the ${sheet.anchorLabel} above to make this the identity.`}>
                          SPARE
                        </span>
                      )}
                      <div className="ws-bs-cap">
                        <span title={capOf[i]}>{capOf[i]}</span>
                        <button className={"ws-microbtn sq" + (locked ? "" : " danger")}
                                style={{ width: 22, height: 22 }}
                                title={locked
                                  ? `The ${sheet.anchorLabel} is what every other ${sheet.refWord} `
                                    + `here was generated against — removing it does not un-generate them.`
                                  : standing === "live"
                                    ? `Remove — the spare ${sheet.anchorLabel} becomes this `
                                      + `${entry.kind}'s identity.`
                                    : "Remove from the sheet"}
                                onClick={async () => {
                                  if (locked) {
                                    setNote(`The ${sheet.anchorLabel} holds this ${entry.kind}'s identity — `
                                      + `the other ${refs.length - 1} were made against it. Replace it `
                                      + `rather than removing it.`);
                                    return;
                                  }
                                  await detachRef(entry.id, r.asset.id);
                                  // Promoting the spare changes what every
                                  // future render is anchored on, and the tile
                                  // that vanishes cannot say so — the note is
                                  // where the consequence lands.
                                  setNote(standing === "live"
                                    ? `Removed — the spare is this ${entry.kind}'s ${sheet.anchorLabel} now. `
                                      + `The ${sheet.refWord}s made against the old one are unchanged.`
                                    : standing === "spare"
                                      ? `Removed the spare ${sheet.anchorLabel} — the identity `
                                        + `${sheet.refWord} is untouched.`
                                      : `Removed from the sheet — the picture is still in the library.`);
                                  reload();
                                }}>
                          {locked ? <Lock size={10} /> : <Trash2 size={10} />}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="ws-empty" style={{ padding: 18, fontSize: 12.5 }}>
                No {sheet.refWord}s yet — without them this {entry.kind} is re-invented on every block.
              </div>
            )}
            {/* The slots this kind has and this entry hasn't. One click queues
                the missing sheet the Generate button would draw. */}
            {(refs.length > 6 || (isVisual && missingRoles.length > 0)) && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 9, flexWrap: "wrap" }}>
                {refs.length > 6 && (
                  <button className="ws-microbtn ghost" onClick={() => setAllRefs((a) => !a)}>
                    {allRefs ? "show fewer" : `+${refs.length - 6} more`}
                  </button>
                )}
                <span style={{ flex: 1 }} />
                {isVisual && missingRoles.slice(0, 2).map((r) => (
                  <AddChip key={r.id} label={r.label}
                           onClick={() => { setPicked(r.id); void generate(r.id); }} />
                ))}
              </div>
            )}
            {!isVisual && (
              <div style={{ fontSize: 10.5, lineHeight: 1.55, color: "#5e6678", marginTop: 8 }}>
                Props take references from the library — they are not rendered from an identity line.
              </div>
            )}
          </div>

          {isVisual && (
            <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>Generate another</span>
              <div style={{ fontSize: 11.5, lineHeight: 1.55, color: "#7d879b" }}>
                {hasAnchor
                  ? <>Anchored on the <span style={{ color: "#5aa2ff" }}>{sheet.anchorLabel}</span>{" "}
                      {sheet.refWord} — so it stays the same {entry.kind}.</>
                  : <>No {sheet.anchorLabel} {sheet.refWord} yet — one is queued first, and the rest
                      anchor on it.</>}
              </div>
              <ImageModelPicker models={data.catalog} value={modelId} onPick={setModelId}
                                withRefs={hasAnchor || entry.kind === "character"}
                                loras={loras} onLoras={setLoras} />
              {willSubstitute && (
                <span className="mono" style={{ fontSize: 10, color: "#e8c268", lineHeight: 1.5 }}>
                  this model takes no references — the worker will swap in one that does
                </span>
              )}
              <div style={{ display: "flex", gap: 7 }}>
                <Dropdown width={250}
                  trigger={({ toggle }) => (
                    <button className="ws-ghost" onClick={toggle}
                            style={{ height: 33, minWidth: 92, justifyContent: "space-between", padding: "0 10px" }}>
                      <span className="mono" style={{ fontSize: 11 }}>{roleLabel(role)}</span>
                      <ChevronRight size={12} style={{ transform: "rotate(90deg)" }} />
                    </button>
                  )}>
                  {(closeMenu) => (
                    <>
                      <div className="ws-menu-label">{sheet.slotWord}</div>
                      {drawable.map((r) => (
                        <button key={r.id} className={"ws-menu-row" + (r.id === role ? " on" : "")}
                                style={{ flexDirection: "column", alignItems: "flex-start", gap: 2,
                                         padding: "7px 11px" }}
                                onClick={() => { closeMenu(); setPicked(r.id); }}>
                          <span>{r.label}</span>
                          <span style={{ fontSize: 10.5, lineHeight: 1.4, color: "#5e6678",
                                         whiteSpace: "normal", textAlign: "left" }}>
                            {r.hint}
                          </span>
                        </button>
                      ))}
                    </>
                  )}
                </Dropdown>
                <input className="ws-input" style={{ flex: 1, height: 33, fontSize: 12 }}
                       placeholder={sheet.tweakHint}
                       value={tweak} onChange={(e) => setTweak(e.target.value)}
                       onKeyDown={(e) => { if (e.key === "Enter" && !busy) void generate(); }} />
              </div>
              <button className="ws-primary" style={{ justifyContent: "center" }}
                      disabled={busy} onClick={() => void generate()}>
                {busy ? <Loader2 size={13} className="ns-spin" /> : <Sparkles size={13} />}
                {busy ? "Queueing…" : "Generate"}
              </button>

              {/* One take, every view. Offered on the two kinds that have a
                  coverage shape; a prop is one flat product shot, which is not
                  a thing to take eight views of. Disabled rather than hidden
                  when there is nothing to build from — the reason is the whole
                  point, and a button that vanishes reads as a missing feature
                  rather than as a precondition. */}
              {isVisual && (
                <button className="ws-ghost"
                        style={{ justifyContent: "center", height: 30, fontSize: 12 }}
                        disabled={coverBusy || !liveRefs.length}
                        title={liveRefs.length
                          ? `Rebuilds every view as one H3 take from the ${liveRefs.length} `
                            + `plate${liveRefs.length === 1 ? "" : "s"} on file, so the views `
                            + `cannot disagree. It also writes ${sheet.takeSheet}. `
                            + `Replaces them when it lands.`
                          : `Draw its ${sheet.anchorLabel} ${sheet.refWord} first — a coverage `
                            + `take is built FROM the plates already on file. It then writes `
                            + `every view plus ${sheet.takeSheet}.`}
                        onClick={() => void redrawAsOneTake()}>
                  {coverBusy ? <Loader2 size={12} className="ns-spin" /> : <Layers size={12} />}
                  {coverBusy ? "Queueing…" : "Redraw all views as one take"}
                </button>
              )}

              {/* Outfit variants: same face and body, new wardrobe. A variant is
                  its own castable entry whose identity anchor stays the PARENT's
                  face sheet (the worker follows doc.variant_of). */}
              {entry.kind === "character" && !doc.variant_of && (
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <button className="ws-ghost" style={{ justifyContent: "center", height: 30, fontSize: 12 }}
                          onClick={() => setOutfitOpen((o) => !o)}>
                    <Shirt size={12} /> {outfitOpen ? "Cancel outfit" : "New outfit variant"}
                  </button>
                  {outfitOpen && (
                    <>
                      <input className="ws-input" style={{ height: 32, fontSize: 12 }}
                             placeholder='Outfit name — e.g. "Gala Dress"'
                             value={outfitName} onChange={(e) => setOutfitName(e.target.value)} />
                      <input className="ws-input" style={{ height: 32, fontSize: 12 }}
                             placeholder="Exact pieces with colors and materials"
                             value={outfitLook} onChange={(e) => setOutfitLook(e.target.value)} />
                      <button className="ws-primary" style={{ justifyContent: "center" }}
                              disabled={outfitBusy || !outfitName.trim() || !outfitLook.trim()}
                              onClick={() => void makeOutfit()}>
                        {outfitBusy ? <Loader2 size={13} className="ns-spin" /> : <Shirt size={13} />}
                        {outfitBusy ? "Queueing…" : "Create variant"}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ---- the spine --------------------------------------------------- */}
        <Spine sections={railItems} active={active} dotOf={dotOf} onJump={jump}
               written={classed.written} total={classed.total} />

        {/* ---- the writing ------------------------------------------------- */}
        <div className="ws-bs-write ns-scroll" ref={writeRef} onScroll={onScroll}>
          {sheet.sections.map((s) => {
            const fields = visibleFields(s, ctx);
            if (!fields.length) return null;
            const state = sectionState(s, ctx);
            const attention = s.attention?.(ctx) ?? null;
            const unwritten = fields.filter((f) => !hasValue(fieldValue(f, ctx))
                                                   && !opened.has(`${f.scope ?? "doc"}:${f.key}`));
            const allUnwritten = unwritten.length === fields.length;
            return (
              <div key={s.id} className="ws-bs-sec" ref={secRef(s.id)}>
                <div className="ws-bs-sechead">
                  <b className={allUnwritten ? "dim" : ""}>{s.label}</b>
                  {(attention || s.note) && (
                    <span className="mono" style={{ fontSize: 10.5,
                           color: attention ? "#e8c268"
                             : state === "unwritten" ? "#e8c268"
                               : state === "inherited" ? "#c97aff"
                                 : s.id === "identity" ? "#6fd08c" : "#8fc2ff" }}>
                      {attention ?? s.note}
                    </span>
                  )}
                  {s.id === "identity" && (
                    <>
                      <span style={{ flex: 1 }} />
                      <span className="mono" style={{ fontSize: 10.5,
                             color: (entry.identity_line ?? "").length > 220 ? "#e8c268" : "#5e6678" }}>
                        {(entry.identity_line ?? "").length} chars
                      </span>
                    </>
                  )}
                </div>

                {/* A whole section nobody has written is a row of add-chips,
                    not four empty boxes stacked down the column. */}
                {allUnwritten ? (
                  <div className="ws-bs-chips">
                    {fields.map((f) => (
                      <AddChip key={f.key} label={f.hint} title={f.guide}
                               onClick={() => setOpened((x) => new Set(x).add(`${f.scope ?? "doc"}:${f.key}`))} />
                    ))}
                  </div>
                ) : fields.map(renderField)}

                {/* The identity line's rivals. `sheet_identity` is what the VLM
                    read off the reference sheet and equals the line in every
                    live row; `identity_line_written` is what a human wrote
                    before the sheet was read and differs in 6 of 7 — it holds
                    story detail a picture cannot show, so it is a decision,
                    not a duplicate to hide. */}
                {s.id === "identity" && classed.rivals.map((r) => (
                  <div key={r.key} className="ws-bs-note amber"
                       style={{ alignItems: "flex-start", flexDirection: "column", gap: 7 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                      <Info size={12} style={{ flex: "none" }} />
                      <span style={{ flex: 1 }}>
                        A second version of this {r.of === "summary" ? "summary" : "identity line"} is
                        stored as <span className="mono">{r.key}</span>. Only one of them reaches a render.
                      </span>
                      <button className="ws-microbtn" style={{ flex: "none", padding: "0 8px" }}
                              onClick={async () => {
                                await saveEntry(entry.id, { [r.of]: r.value } as Partial<BibleEntry>);
                                await saveDoc(r.key, "");
                                setNote(`Adopted ${r.key} — it is the ${r.of.replace("_", " ")} now.`);
                              }}>
                        use this
                      </button>
                      <button className="ws-microbtn ghost" style={{ flex: "none", padding: "0 8px" }}
                              onClick={async () => {
                                await saveDoc(r.key, "");
                                setNote(`Discarded ${r.key}.`);
                              }}>
                        discard
                      </button>
                    </div>
                    <div style={{ fontSize: 12, lineHeight: 1.55, color: "#b3bccd" }}>{r.value}</div>
                  </div>
                ))}

                {s.id === "world" && worldNotice(s)}


                {s.id === "voice" && entry.kind === "character" && (
                  <BibleVoiceClip
                    entry={entry}
                    asset={(entry.voice_ref_asset_id
                      ? data.assets.get(entry.voice_ref_asset_id) : null) ?? null}
                    voiceJob={data.voiceJob}
                    onSaveDoc={saveDoc}
                    onChanged={reload} />
                )}
              </div>
            );
          })}

          {/* Whatever the director wrote that this sheet does not name is still
              the entry's writing — leaving it out is what buried `palette` on
              every location for a year. */}
          {classed.extras.length > 0 && (
            <div className="ws-bs-sec" ref={secRef("extra")}>
              <div className="ws-bs-sechead">
                <b>Also written</b>
                <span className="mono" style={{ fontSize: 10.5, color: "#8fc2ff" }}>
                  written by the director, not on this sheet
                </span>
              </div>
              {classed.extras.map((x) => renderField({
                key: x.key, label: x.label, type: x.type, hint: `${x.label.toLowerCase()}…`,
              }))}
            </div>
          )}

          {/* Records: what leaves the form entirely. Nothing here is sent to
              any model as writing, and the section says so. */}
          {classed.records.length > 0 && (
            <div className="ws-bs-sec" ref={secRef("records")}>
              <button className="ws-bs-sechead" style={{ background: "none", border: 0, padding: 0,
                                                         cursor: "pointer", width: "100%" }}
                      onClick={() => setRecordsOpen((o) => !o)}>
                <b className="dim">Records</b>
                <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
                  {classed.records.length} · nothing here is sent to a model
                </span>
                <span style={{ flex: 1 }} />
                <ChevronRight size={12} style={{ color: "#5e6678",
                               transform: recordsOpen ? "rotate(90deg)" : "none" }} />
              </button>
              {recordsOpen && (
                <div className="ws-bs-chips">
                  {classed.records.map((r) => (
                    <span key={r.key} className="ws-bs-rec" title={r.value}>
                      <b>{r.key}</b><span>{r.value}</span>
                      <button title="Copy" onClick={() => void navigator.clipboard?.writeText(r.value)}>
                        <Copy size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {data.revisions.length > 0 && (
            <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                Pending director revisions
                <span className="mono" style={{ fontSize: 11, color: "#e8c268", marginLeft: 8 }}>
                  {data.revisions.length}
                </span>
              </span>
              <div style={{ fontSize: 12, lineHeight: 1.6, color: "#9aa4b6" }}>
                The director proposed changes to this entry. They stay drafts until you
                confirm them on the Bible page.
              </div>
            </div>
          )}
        </div>
      </div>
      )}

      {lightbox != null && (
        <Lightbox assets={refs.map((r) => r.asset)} index={lightbox}
                  onClose={() => setLightbox(null)}
                  onStep={(d) => setLightbox((i) => stepIndex(i, d, refs.length))} />
      )}

      {/* You pick a reference by LOOKING at it, and this column is 326px wide —
          a four-across grid of the first 48 library rows crammed under the
          plates was the one presentation that carries no information about the
          image. It is also the surface that can search the whole library,
          upload a new file, and attach several plates in one visit, which a
          location with seven of them needs. Same picker as the block's ref
          panel and the composer; it portals to <body>, so the modal's own
          backdrop-filter cannot clip it. */}
      {picking && (
        <AssetPickerModal
          projectId={entry.project_id}
          title={`Add ${sheet.refWord}s`}
          context={`${entry.name} · ${refs.length} attached · a role decides how each one is used`}
          multi
          used={new Set(refs.map((r) => r.asset.id))}
          roles={sheet.roles}
          defaultRole={role}
          onClose={() => setPicking(false)}
          onPick={async (picks) => {
            setPicking(false);
            try {
              // Slots continue from what is already here, in the order picked,
              // so the anchor keeps slot 0 and nothing overwrites a link.
              await Promise.all(picks.map((p, i) =>
                attachRef(entry.id, p.asset.id, legalRole(sheet, p.role, role),
                          refs.length + i)));
              setNote(picks.length === 1
                ? `Attached as ${roleLabel(legalRole(sheet, picks[0].role, role))}.`
                : `Attached ${picks.length} ${sheet.refWord}s.`);
            } catch (e) {
              setNote(`Could not attach: ${String((e as Error).message || e).slice(0, 110)}`);
            }
            reload();
          }} />
      )}
    </ModalShell>
  );
}
