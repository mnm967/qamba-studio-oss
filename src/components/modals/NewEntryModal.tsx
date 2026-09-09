// New bible entry — kind switcher, then the form that kind actually needs.
//
// The four kinds used to share ONE form, and for lore that form was wrong in
// every field it offered. Lore was asked for an "identity line" ("6-8 concrete
// visual attributes … it IS the lore"), given a face / full body / side /
// outfit reference sheet and a "Generate sheet" button — a
// character sheet for a thing that has no face. Meanwhile the one field lore
// genuinely needs, the writing, was a three-row box at the bottom labelled
// "Biography".
//
// So lore branches to its own form (LoreForm below). What it is NOT is the
// interesting part: no identity line, no reference slots, no image cost, no
// voice. What it IS is a document, and documents are how it reaches the model:
//
//   summary  -> always in the planner's context. worker/llm.py flattens every
//               bible row into `existing_bible`, one line each.
//   body     -> too long for that, so it is chunked into `rag_chunks` and
//               retrieved top-k by `llm.rag_search` when relevant to the brief
//               (plus, for lore specifically, carried in full up to a budget —
//               see the `project_lore` block in plan_storyboard).
//
// Saved as a draft until confirmed; confirming bumps the version and marks
// dependent blocks stale (schema rules).
import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen, Check, FileText, Image as ImageIcon, Images, Layers, Loader2, Sparkles,
  Upload, Users,
} from "lucide-react";
import ModalShell, { Z_OVER_MODAL } from "./ModalShell";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { attachRef, createEntry } from "../../lib/db/director";
import { registerAsset } from "../../lib/db/assets";
import { enqueueJob } from "../../lib/db/jobs";
import { LORE_INDEX_MIN_CHARS, indexEntryBody } from "../../lib/db/lore";
import { chunkText } from "../../lib/loreChunk";
import { modelKeyOf, resolveDefaults, styleTextFor } from "../../lib/projectSettings";
import { uploadMedia } from "../../lib/upload";
import { supabase } from "../../lib/supabase";
import type { BibleEntry, BibleKind } from "../../lib/db/types";

const KINDS: { id: BibleKind; label: string; icon?: React.ReactNode }[] = [
  { id: "character", label: "Character", icon: <Users size={14} /> },
  { id: "environment", label: "Environment", icon: <ImageIcon size={14} /> },
  { id: "prop", label: "Prop", icon: <Layers size={14} /> },
  { id: "lore", label: "Lore", icon: <FileText size={14} /> },
];

/** Slot ids, NOT display labels — these are written straight to
 *  `bible_assets.role`, whose check constraint accepts exactly
 *  ref | face | full_body | side | outfit | turnaround | master | alt_angle |
 *  detail | atmosphere. This modal used to send "full body" and "alt light",
 *  so uploading to either slot failed the constraint and the reference was
 *  silently lost. They also have to be the ids `worker/image_prompt.py`'s
 *  FRAMING table knows, or a generated sheet is framed as something else. */
const SLOTS: Record<string, readonly string[]> = {
  character: ["face", "full_body", "side", "outfit"],
  environment: ["master", "alt_angle", "detail", "atmosphere"],
  prop: ["ref"],
  style: ["ref"],
  lore: [],
};
const slotLabel = (id: string) => id.replace(/_/g, " ");

/* ═══════════════════════════════════════════════════════════ lore form ══ */

/** Lore is writing. This form is a title, the line that always travels, and
 *  the document itself — plus a way to get a file into it, because nobody
 *  types a world bible into a textarea. */
function LoreForm({
  name, setName, summary, setSummary, body, setBody, onFile,
}: {
  name: string; setName: (v: string) => void;
  summary: string; setSummary: (v: string) => void;
  body: string; setBody: (v: string) => void;
  onFile: (f: File) => void;
}) {
  const words = useMemo(() => body.trim().split(/\s+/).filter(Boolean).length, [body]);
  // The real number, from the real chunker — an estimate here would disagree
  // with what the import actually produces.
  const chunks = useMemo(() => (body.trim() ? chunkText(body).length : 0), [body]);

  return (
    <div style={{ display: "flex", gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Name</span>
          <input className="ws-input" value={name} autoFocus style={{ height: 42, fontSize: 14.5 }}
                 placeholder="The Ashfall Concordat"
                 onChange={(e) => setName(e.target.value)} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            In one line
            <span className="mono" style={{ fontSize: 10.5, color: "#5e6678", marginLeft: 8 }}>
              always in the director's context
            </span>
          </span>
          <input className="ws-input" value={summary} style={{ height: 42, fontSize: 14 }}
                 placeholder="Treaty that ended the ash wars — and the reason nobody speaks the old names aloud."
                 onChange={(e) => setSummary(e.target.value)} />
          <span style={{ fontSize: 11.5, lineHeight: 1.55, color: "#5e6678" }}>
            Every plan sees this line for every lore entry, so it has to carry the
            <i> consequence</i>, not the label. The full text below is read when it is
            relevant to the scene being written.
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>The lore itself</span>
            <span style={{ flex: 1 }} />
            <label className="ws-pill" style={{ height: 28, cursor: "pointer" }}>
              <Upload size={12} /> Import a file
              <input type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" hidden
                     onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            </label>
          </div>
          <textarea rows={14} className="ws-input ns-scroll" value={body}
                    style={{ fontSize: 13.5, lineHeight: 1.7, borderRadius: 18, padding: "14px 16px",
                             resize: "vertical" }}
                    placeholder={"History, rules, factions, terminology — as long as it needs to be.\n\n"
                      + "Markdown headings are respected when this is indexed: a retrieved passage "
                      + "arrives carrying the section it came from."}
                    onChange={(e) => setBody(e.target.value)} />
          <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
            {words.toLocaleString()} word{words === 1 ? "" : "s"}
            {chunks > 0 && ` · ${chunks} retrievable passage${chunks === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>

      <div style={{ flex: "0 0 auto", width: 268, display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>How lore reaches the render</span>
          <div style={{ fontSize: 11.5, lineHeight: 1.65, color: "#9aa4b6" }}>
            Lore never becomes a picture. It reaches the work by being <i>read</i> —
            by the planner when it writes your scenes, and by the director in chat.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 2 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <span className="mono" style={{ fontSize: 10, color: "#6fd08c", flex: "0 0 auto", marginTop: 2 }}>
                ALWAYS
              </span>
              <span style={{ fontSize: 11.5, lineHeight: 1.55, color: "#9aa4b6" }}>
                the one-line summary, in every plan
              </span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <span className="mono" style={{ fontSize: 10, color: "#8fc2ff", flex: "0 0 auto", marginTop: 2 }}>
                WHEN&nbsp;RELEVANT
              </span>
              <span style={{ fontSize: 11.5, lineHeight: 1.55, color: "#9aa4b6" }}>
                the body, retrieved a passage at a time
              </span>
            </div>
          </div>
        </div>

        {body.trim().length >= LORE_INDEX_MIN_CHARS ? (
          <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Indexing</span>
            <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "#9aa4b6" }}>
              Saving splits this into {chunks} passage{chunks === 1 ? "" : "s"} and queues them for
              indexing in the studio cloud. Until that job runs they are stored but not yet
              searchable — the summary line still travels either way.
            </div>
          </div>
        ) : body.trim() ? (
          <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Read in full</span>
            <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "#9aa4b6" }}>
              Short enough that the planner reads all of it in every plan, so it is not
              indexed separately — nothing to wait for.
            </div>
          </div>
        ) : null}

        <div style={{ fontSize: 11, lineHeight: 1.6, color: "#5e6678" }}>
          Importing a longer document — a whole world bible, a script — is better done from
          the Lore tab's document shelf, which keeps it as one searchable document instead
          of one entry.
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════ modal ══ */

/**
 * NESTED USE — the wizard opens this one, and every prop below exists because
 * routing it through `ws.openModal` cannot work: the store holds exactly ONE
 * modal (`set({ modal: m })`), and the wizard IS that modal, so opening this
 * the ordinary way would CLOSE the wizard mid-draft rather than stack over it.
 * Same rule SceneEditorModal's reference picker already follows.
 *
 * `onClose` is the load-bearing one: unset, this modal ends by calling
 * `ws.closeModal()`, which from inside the wizard is the identical failure one
 * step later — you save a character and the wizard you were filling in
 * disappears.
 */
export default function NewEntryModal({
  projectId, initialKind, kinds, modelId, nested = false, onClose, onCreated, onAskDirector,
}: {
  projectId: string;
  initialKind?: string;
  /** The image model "Generate sheet" renders on, when the opener has a live
   *  one of its own. The wizard does: its picker is SESSION state seeded from
   *  `projects.settings` and never written back, so reading the row here would
   *  draw a sheet on a different model from the sheets bar directly above the
   *  tile that opened this. Unset, the project row decides — which is right
   *  for the Bible page, where the row IS the setting. */
  modelId?: string;
  /** Restrict the kind switcher. A caller that can only SHOW three kinds must
   *  only offer three: a lore entry saved from the wizard's cast & world step
   *  lands in a column that step does not render, so the save succeeds and
   *  nothing appears — the control-whose-result-you-cannot-see failure. */
  kinds?: BibleKind[];
  /** Portal to <body> and sit above the modal that opened this.
   *
   *  MEASURED, because the reason is easy to overstate: a `position: fixed`
   *  child resolves against the nearest backdrop-filtered ancestor's PADDING
   *  BOX, and padding is inside that box — so nesting under a full-viewport
   *  `.ws-scrim` (34px of padding and all) still lands on the viewport, which
   *  is why the wizard's other nested modals render in place and look right.
   *  Where it genuinely breaks is a `.ns-l3` PANEL: probed live, a fixed
   *  `inset: 0` child of one came back [201, 74, 878, 751] against a
   *  1280x900 viewport, then clipped by that panel's `overflow: hidden` —
   *  the modal opening inside the panel that summoned it.
   *
   *  So this is here to make the modal safe for ANY opener rather than to fix
   *  the wizard, and it settles the z-order outright instead of relying on a
   *  descendant of a higher stacking context happening to paint above it. */
  nested?: boolean;
  onClose?: () => void;
  /** The row landed. The opener reloads on this rather than on close, so a
   *  cancel costs no refetch and a save is on screen without one. */
  onCreated?: (entry: BibleEntry) => void;
  /** Where "Draft it" puts its prompt. Defaults to the workspace dock, which
   *  is the wrong composer when this is nested in a modal that has one of its
   *  own — the draft would land behind it, on a surface about another
   *  conversation. */
  onAskDirector?: (draft: string) => void;
}) {
  const ws = useWorkspaceStore();
  const close = onClose ?? ws.closeModal;
  const ask = onAskDirector ?? ws.askDirector;
  const offered = kinds?.length ? KINDS.filter((k) => kinds.includes(k.id)) : KINDS;
  const [kind, setKind] = useState<BibleKind>(
    (initialKind as BibleKind) ?? offered[0]?.id ?? "character");
  const [name, setName] = useState("");
  const [line, setLine] = useState("");
  const [bio, setBio] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [slots, setSlots] = useState<(string | null)[]>([null, null, null, null]);
  const [slotUrls, setSlotUrls] = useState<(string | null)[]>([null, null, null, null]);
  const [voiceName, setVoiceName] = useState<string | null>(null);
  const [voiceAsset, setVoiceAsset] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isLore = kind === "lore";
  const slotNames = SLOTS[kind] ?? SLOTS.character;

  const uploadSlot = async (i: number, file: File) => {
    const key = `refs/uploads/${projectId}/${Date.now()}_${file.name.replace(/[^\w.-]+/g, "_")}`;
    await uploadMedia(file, key, () => {});
    const asset = await registerAsset({
      b2_key: key, kind: "image", project_id: projectId,
      content_type: file.type, bytes: file.size, tags: ["ref"],
    });
    setSlots((s) => s.map((x, j) => (j === i ? asset.id : x)));
    setSlotUrls((s) => s.map((x, j) => (j === i ? URL.createObjectURL(file) : x)));
  };

  /** Read a text file into the body. Text only and read in the browser — no
   *  upload, because the words are the asset here and they belong in Postgres
   *  next to the chunks that will be searched, not in the media bucket. */
  const readLoreFile = async (f: File) => {
    setErr(null);
    try {
      const text = await f.text();
      if (!text.trim()) { setErr(`${f.name} is empty.`); return; }
      setBody((b) => (b.trim() ? `${b.trim()}\n\n${text}` : text));
      if (!name.trim()) {
        const h1 = /^#\s+(.+)$/m.exec(text);
        setName((h1?.[1] ?? f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")).trim().slice(0, 80));
      }
    } catch (e) {
      setErr(`Could not read ${f.name}: ${String((e as Error).message || e).slice(0, 80)}`);
    }
  };

  const save = async (confirm: boolean) => {
    if (!name.trim()) { setErr("Name it first."); return; }
    setBusy(true); setErr(null);
    try {
      const entry = await createEntry({
        project_id: projectId, kind, name: name.trim(),
        summary: (isLore ? summary : bio).trim() || undefined,
        identity_line: isLore ? undefined : line.trim() || undefined,
      });
      if (isLore) {
        if (body.trim()) {
          await supabase.from("bible_entries").update({ doc: { body: body.trim() } }).eq("id", entry.id);
          // Best effort: the entry is saved and its summary already reaches
          // every plan. A failure here costs retrieval of the long text, not
          // the entry, so it must not fail the save — but it must be said.
          try {
            await indexEntryBody({
              entryId: entry.id, projectId, title: name.trim(), body: body.trim(),
            });
          } catch (e) {
            console.warn("lore entry not indexed", (e as Error).message);
          }
        }
      } else {
        if (bio.trim()) {
          await supabase.from("bible_entries").update({ doc: { bio: bio.trim() } }).eq("id", entry.id);
        }
        for (let i = 0; i < slotNames.length; i++) {
          if (slots[i]) await attachRef(entry.id, slots[i]!, slotNames[i], i);
        }
        if (voiceAsset) {
          await supabase.from("bible_entries").update({ voice_ref_asset_id: voiceAsset }).eq("id", entry.id);
        }
      }
      if (confirm) await supabase.from("bible_entries").update({ status: "confirmed" }).eq("id", entry.id);
      onCreated?.(entry);
      close();
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  };

  const generateSheet = async () => {
    if (!name.trim() || !line.trim()) { setErr("Name + identity line first — the sheet is generated from them."); return; }
    setBusy(true); setErr(null);
    try {
      // THE PROJECT'S OWN MODEL AND STYLE, fetched here rather than on mount:
      // only this button needs them, and every other way out of this modal
      // (save draft, confirm) would be paying for a round trip it never reads.
      //
      // Both were missing and both fail SILENTLY. The payload carried
      // `model_id: "krea2"` — a jobs-row column, where `handle_image_gen`
      // reads `payload.model_key` and falls back to krea2 on its own — so a
      // project set to any other image model had its sheets drawn by a model
      // nobody chose. And a `prompt_spec` with no `style` composes with no
      // style clause: `image_prompt` appends that clause last and a FACE plate
      // is the one text-to-image sheet in the set, so it is the sheet that
      // loses the style, and every sheet derived from it inherits the loss.
      const { data: proj } = await supabase.from("projects")
        .select("settings,style").eq("id", projectId).maybeSingle();
      const settings = (proj?.settings ?? null) as Parameters<typeof resolveDefaults>[0];
      const chosen = modelId ?? resolveDefaults(settings).image_model;
      const style = styleTextFor(settings, proj?.style as string | null).text || undefined;

      const entry = await createEntry({
        project_id: projectId, kind, name: name.trim(),
        summary: bio.trim() || undefined, identity_line: line.trim() || undefined,
      });
      for (let i = 0; i < slotNames.length; i++) {
        const spec = { kind, role: slotNames[i], name: name.trim(), identity: line.trim(), style };
        await enqueueJob({
          kind: "image_gen", lane: "gpu", priority: 20, project_id: projectId,
          model_id: chosen,
          payload: {
            // prompt_spec is what composes the prompt; `prompt` stays as the
            // fallback for a pod on an older build. `sheetJobPayload` composes
            // in the BROWSER for a hosted family, which is what lets a hosted
            // sheet skip the pod entirely — it returns the pod-side pair
            // unchanged for every local one.
            prompt_spec: spec,
            prompt: `${kind} reference, ${slotLabel(slotNames[i])} view: ${line.trim()}`,
            model_key: modelKeyOf(chosen),
            width: 1024, height: 1024,
            label: `${name.trim().slice(0, 28)} · ${slotLabel(slotNames[i])} sheet`,
            target: { bible_entry_id: entry.id, role: slotNames[i], slot: i },
            auto_accept: true,
          },
        });
      }
      onCreated?.(entry);
      close();
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally { setBusy(false); }
  };

  // Portalled and lifted only when NESTED, and the two travel together: the
  // portal is what puts the scrim on the viewport rather than inside the
  // opener's backdrop-filtered box, and Z_OVER_MODAL is what stops it
  // rendering behind the modal it was opened from. Standalone this stays
  // exactly where it was — same tree, same z — so the Bible page and the
  // refs CTA are byte-identical.
  const shell = (
    <ModalShell
      width={880} z={nested ? Z_OVER_MODAL : 93}
      onClose={close}
      icon={<BookOpen size={16} />}
      title="New bible entry"
      context="saved as draft until you confirm"
      footer={<>
        <span className="sum" style={{ color: "#5e6678" }}>
          {err ? <span style={{ color: "#ff8080" }}>{err}</span>
               : isLore ? "Lore is read by the director and the planner — it is never rendered"
               : "Confirming bumps the bible version and marks affected blocks stale"}
        </span>
        <button className="ws-ghost" disabled={busy} onClick={() => void save(false)}>Save draft</button>
        <button className="ws-primary" disabled={busy}
                style={{ borderColor: "rgba(111,208,140,.5)", background: "rgba(111,208,140,.12)", color: "#6fd08c" }}
                onClick={() => void save(true)}>
          {busy ? <Loader2 size={15} className="ns-spin" /> : <Check size={15} />}Confirm entry
        </button>
      </>}
    >
      <div className="ns-scroll ws-modal-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="ws-seg" style={{ padding: 4, borderRadius: 18 }}>
          {offered.map((k) => (
            <button key={k.id} className={kind === k.id ? "on" : ""} style={{ height: 36, gap: 7 }}
                    onClick={() => setKind(k.id)}>
              {k.icon}{k.label}
            </button>
          ))}
        </div>

        {isLore ? (
          <LoreForm name={name} setName={setName} summary={summary} setSummary={setSummary}
                    body={body} setBody={setBody} onFile={(f) => void readLoreFile(f)} />
        ) : (
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Name</span>
              <input className="ws-input" value={name} autoFocus style={{ height: 42, fontSize: 14.5 }}
                     onChange={(e) => setName(e.target.value)} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Identity line</span>
                <span style={{ flex: 1 }} />
                <button className="ws-pill" style={{ height: 28, borderColor: "rgba(201,122,255,.4)",
                                                     background: "rgba(201,122,255,.1)", color: "#c97aff" }}
                        onClick={() => ask(
                          `Draft an identity line for a new ${kind} named "${name || "(unnamed)"}": one sentence, 6–8 concrete visual attributes, repeatable verbatim. ${bio ? `Context: ${bio}` : ""}`)}>
                  <Sparkles size={12} />Draft it
                </button>
              </div>
              <textarea rows={4} className="ws-input ns-scroll" value={line}
                        style={{ fontSize: 14, lineHeight: 1.65, borderRadius: 18, padding: "14px 16px" }}
                        placeholder={kind === "character"
                          ? "Ward archivist, late twenties, shaved temples with a long black fringe, grey eyes, wire earpiece always in the right ear, ink-stained fingers, oversized cardigan over a uniform shirt."
                          : "One sentence of concrete, repeatable visual attributes."}
                        onChange={(e) => setLine(e.target.value)} />
              <span style={{ fontSize: 11.5, lineHeight: 1.55, color: "#5e6678" }}>
                Six to eight concrete visual attributes. This exact sentence is repeated verbatim in
                every compiled prompt — it <i>is</i> the {kind}.
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Biography · fed to the director via RAG</span>
              <textarea rows={3} className="ws-input ns-scroll" value={bio}
                        style={{ fontSize: 14, lineHeight: 1.65, borderRadius: 18, padding: "14px 16px" }}
                        onChange={(e) => setBio(e.target.value)} />
            </div>
          </div>

          <div style={{ flex: "0 0 auto", width: 268, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Reference sheet</span>
              <div style={{ display: "grid",
                            gridTemplateColumns: slotNames.length > 1 ? "1fr 1fr" : "1fr", gap: 9 }}>
                {slotNames.map((s, i) => (
                  <div key={s} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <label style={{ aspectRatio: "1", borderRadius: 16, overflow: "hidden", cursor: "pointer",
                                    ...(slotUrls[i]
                                      ? { background: "#0b0e14", border: "1px solid rgba(255,255,255,.08)" }
                                      : { border: "1px dashed rgba(255,255,255,.15)", background: "rgba(255,255,255,.02)",
                                          display: "grid", placeItems: "center", color: "#5e6678" }) }}>
                      {slotUrls[i]
                        ? <img src={slotUrls[i]!} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        : <Upload size={16} />}
                      <input type="file" accept="image/*" hidden
                             onChange={(e) => e.target.files?.[0] && void uploadSlot(i, e.target.files[0])} />
                    </label>
                    <span className="mono" style={{ fontSize: 11, fontWeight: 500, color: "#5e6678", textAlign: "center" }}>
                      {slotLabel(s)}
                    </span>
                  </div>
                ))}
              </div>
              <button className="ws-primary" style={{ height: 38, justifyContent: "center" }}
                      disabled={busy} onClick={() => void generateSheet()}>
                <Images size={14} />Generate sheet{slotNames.length > 1 ? ` · ${slotNames.length}` : ""}
              </button>
            </div>
            {kind === "character" && (
              <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Voice</span>
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                  <span className="ws-pill" title="Voice timbre ref rides H3's audio ref slots"
                        style={{ borderColor: "rgba(90,162,255,.4)", background: "rgba(90,162,255,.1)", color: "#8fc2ff" }}>
                    H3 · timbre ref
                  </span>
                  <span className="ws-pill" title="TTS wiring point — deferred" style={{ opacity: 0.55 }}>TTS · soon</span>
                </div>
                <label className="ws-dashbtn" style={{ height: 36, fontSize: 12, cursor: "pointer" }}>
                  <Upload size={13} />{voiceName ?? "Drop a 10s sample"}
                  <input type="file" accept="audio/*" hidden
                         onChange={async (e) => {
                           const f = e.target.files?.[0];
                           if (!f) return;
                           const key = `voices/${projectId}/${Date.now()}_${f.name.replace(/[^\w.-]+/g, "_")}`;
                           await uploadMedia(f, key, () => {});
                           const a = await registerAsset({
                             b2_key: key, kind: "audio", project_id: projectId,
                             content_type: f.type, bytes: f.size, tags: ["voice-ref"],
                           });
                           setVoiceAsset(a.id); setVoiceName(f.name);
                         }} />
                </label>
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </ModalShell>
  );
  return nested ? createPortal(shell, document.body) : shell;
}
