// Import a lore document — a world bible, a treatment, a script, research
// notes — into the project's retrieval corpus.
//
// The distinction this modal exists to hold: a bible ENTRY is a card the
// planner always sees one line of; a DOCUMENT is prose too long for any prompt,
// so it is split into passages and pulled back a passage at a time when it is
// relevant to the scene being written. A 60-page world bible is a document.
// Pasting it into an entry would put 60 pages in front of the model for every
// scene, or (more likely) get truncated somewhere nobody looks.
//
// Text only, read in the browser. The words are the asset here, and they belong
// in Postgres beside the chunks that will be searched — not in the media bucket,
// which is public (invariant #2) and would put an unpublished script on a URL.
import React, { useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FileText, Loader2, Upload } from "lucide-react";
import ModalShell from "./ModalShell";
import Dropdown from "../ui/Dropdown";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { LORE_DOC_KINDS, importLoreDoc, type LoreDocKind } from "../../lib/db/lore";
import { loadEpisodes } from "../../lib/db/projects";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { chunkText, titleFromText } from "../../lib/loreChunk";

const ACCEPT = ".md,.markdown,.txt,.text,text/plain,text/markdown";

/** Files a browser can read as text with no parsing library. A .pdf dropped
 *  here would "read" as its binary container and import as mojibake, so the
 *  extension is checked rather than trusting the drop. */
const READABLE = /\.(md|markdown|txt|text|rst|org|csv|json|ya?ml)$/i;

export default function LoreImportModal({ projectId }: { projectId: string }) {
  const ws = useWorkspaceStore();
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<LoreDocKind>("lore");
  const [filename, setFilename] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { data: episodes } = useLiveQuery(
    () => loadEpisodes(projectId), ["episodes"], [projectId]);

  const chunks = useMemo(() => (text.trim() ? chunkText(text) : []), [text]);
  const words = useMemo(() => text.trim().split(/\s+/).filter(Boolean).length, [text]);
  const kindDef = LORE_DOC_KINDS.find((k) => k.id === kind)!;
  const eps = episodes ?? [];

  const take = async (f: File) => {
    setErr(null);
    if (!READABLE.test(f.name)) {
      setErr(`${f.name} isn't a text file. Markdown or plain text — for a PDF or a `
             + `.docx, copy the text and paste it below.`);
      return;
    }
    try {
      const body = await f.text();
      if (!body.trim()) { setErr(`${f.name} is empty.`); return; }
      setText(body);
      setFilename(f.name);
      // Only fill a title the user hasn't written — re-dropping a file must
      // not silently rename a document they just named.
      setTitle((t) => t.trim() || titleFromText(body, f.name));
    } catch (e) {
      setErr(`Could not read ${f.name}: ${String((e as Error).message || e).slice(0, 90)}`);
    }
  };

  const run = async () => {
    if (!text.trim()) { setErr("Nothing to import yet — choose a file or paste the text."); return; }
    setBusy(true); setErr(null);
    try {
      const res = await importLoreDoc({
        projectId, kind, text, episodeId,
        title: title.trim() || titleFromText(text, filename ?? undefined),
        source: filename ? `file:${filename}` : "paste",
      });
      setDone(res.job
        ? `Imported "${res.doc.title}" — ${res.chunks} passage${res.chunks === 1 ? "" : "s"}, `
          + `queued for indexing.`
        : `Imported "${res.doc.title}" — ${res.chunks} passage${res.chunks === 1 ? "" : "s"} stored, `
          + `but the indexing job could not be queued. Re-index it from the shelf.`);
      // Leave the result on screen rather than closing: the number of passages
      // is the only feedback that the split did something sensible, and a modal
      // that vanishes takes it with it.
      setText(""); setTitle(""); setFilename(null);
    } catch (e) {
      setErr(String((e as Error).message || e).slice(0, 200));
    } finally { setBusy(false); }
  };

  return (
    <ModalShell
      width={720} z={95}
      icon={<FileText size={16} />}
      title="Import lore document"
      context="chunked and indexed for retrieval — never rendered"
      footer={<>
        <span className="sum" style={{ color: "#5e6678" }}>
          {err ? <span style={{ color: "#ff8080" }}>{err}</span>
               : done ? <span style={{ color: "#6fd08c" }}>{done}</span>
               : chunks.length
                 ? `${words.toLocaleString()} words · ${chunks.length} passage${chunks.length === 1 ? "" : "s"}`
                 : "Markdown or plain text — or paste anything"}
        </span>
        <button className="ws-ghost" disabled={busy} onClick={ws.closeModal}>
          {done ? "Done" : "Cancel"}
        </button>
        <button className="ws-primary" disabled={busy || !text.trim()}
                style={{ borderColor: "rgba(111,208,140,.5)", background: "rgba(111,208,140,.12)", color: "#6fd08c" }}
                onClick={() => void run()}>
          {busy ? <Loader2 size={15} className="ns-spin" /> : <Check size={15} />}
          {busy ? "Importing…" : "Import"}
        </button>
      </>}
    >
      <div className="ns-scroll ws-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div
          className="ws-dashbtn"
          style={{ minHeight: 92, flexDirection: "column", gap: 6, cursor: "pointer", padding: 16,
                   ...(over ? { borderColor: "rgba(143,194,255,.6)", background: "rgba(143,194,255,.07)" } : {}) }}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault(); setOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void take(f);
          }}
        >
          <Upload size={18} style={{ color: "#8fc2ff" }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {filename ?? "Drop a .md or .txt file, or click to choose"}
          </span>
          <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
            {filename ? `${words.toLocaleString()} words read` : "for a PDF or Word file, paste the text below"}
          </span>
          <input ref={fileRef} type="file" accept={ACCEPT} hidden
                 onChange={(e) => e.target.files?.[0] && void take(e.target.files[0])} />
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }}>
            <span className="ws-mlabel">Title</span>
            <input className="ws-input" style={{ height: 38, fontSize: 13.5 }}
                   placeholder={text ? titleFromText(text, filename ?? undefined) : "Named from the file's first heading"}
                   value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          {/* Asked at import because it is nearly free HERE and expensive
              later: every entry extracted from this document inherits it, so
              answering once tags a dozen facts. Defaulting to an episode would
              be wrong — a series bible belongs to none of them, and guessing
              would make its rules vanish from episode 1. */}
          {eps.length > 0 && (
            <div style={{ flex: "0 0 auto", width: 168, display: "flex", flexDirection: "column", gap: 7 }}>
              <span className="ws-mlabel">About</span>
              <Dropdown width={250}
                trigger={({ toggle }) => (
                  <button className="ws-ghost" onClick={toggle}
                          style={{ height: 38, width: "100%", justifyContent: "space-between", padding: "0 12px" }}>
                    <span style={{ fontSize: 13 }}>
                      {eps.find((e) => e.id === episodeId)?.code ?? "the series"}
                    </span>
                    <ChevronDown size={13} />
                  </button>
                )}>
                {(close) => (
                  <>
                    <div className="ws-menu-label">what this document covers</div>
                    <button className={"ws-menu-row" + (episodeId ? "" : " on")}
                            style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "7px 11px" }}
                            onClick={() => { close(); setEpisodeId(null); }}>
                      <span>The series</span>
                      <span style={{ fontSize: 10.5, lineHeight: 1.4, color: "#5e6678",
                                     whiteSpace: "normal", textAlign: "left" }}>
                        Rules that hold in every episode. Facts from it are always in context.
                      </span>
                    </button>
                    {eps.map((e) => (
                      <button key={e.id} className={"ws-menu-row" + (e.id === episodeId ? " on" : "")}
                              style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "7px 11px" }}
                              onClick={() => { close(); setEpisodeId(e.id); }}>
                        <span>{e.code || `Ep${e.idx + 1}`}</span>
                        <span style={{ fontSize: 10.5, lineHeight: 1.4, color: "#5e6678",
                                       whiteSpace: "normal", textAlign: "left" }}>
                          {e.title || "facts start here unless you mark them otherwise"}
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </Dropdown>
            </div>
          )}
          <div style={{ flex: "0 0 auto", width: 190, display: "flex", flexDirection: "column", gap: 7 }}>
            <span className="ws-mlabel">Kind</span>
            <Dropdown width={290}
              trigger={({ toggle }) => (
                <button className="ws-ghost" onClick={toggle}
                        style={{ height: 38, width: "100%", justifyContent: "space-between", padding: "0 12px" }}>
                  <span style={{ fontSize: 13 }}>{kindDef.label}</span>
                  <ChevronDown size={13} />
                </button>
              )}>
              {(close) => (
                <>
                  <div className="ws-menu-label">what this document is</div>
                  {LORE_DOC_KINDS.map((k) => (
                    <button key={k.id} className={"ws-menu-row" + (k.id === kind ? " on" : "")}
                            style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "7px 11px" }}
                            onClick={() => { close(); setKind(k.id); }}>
                      <span>{k.label}</span>
                      <span style={{ fontSize: 10.5, lineHeight: 1.4, color: "#5e6678",
                                     whiteSpace: "normal", textAlign: "left" }}>
                        {k.hint}
                      </span>
                    </button>
                  ))}
                </>
              )}
            </Dropdown>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
            <span className="ws-mlabel">Text</span>
            <span style={{ flex: 1 }} />
            {chunks.length > 0 && (
              <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
                splits into {chunks.length} passage{chunks.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <textarea className="ws-input ns-scroll" rows={10} value={text}
                    style={{ fontSize: 12.5, lineHeight: 1.7, resize: "vertical" }}
                    placeholder="Paste here if the source isn't a text file."
                    onChange={(e) => { setText(e.target.value); setDone(null); }} />
        </div>

        {chunks.length > 0 && (
          <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>First passage, as it will be retrieved</span>
            <div className="mono ns-scroll" style={{ fontSize: 11, lineHeight: 1.65, color: "#9aa4b6",
                                                     maxHeight: 120, overflowY: "auto", whiteSpace: "pre-wrap" }}>
              {chunks[0].slice(0, 700)}{chunks[0].length > 700 ? "…" : ""}
            </div>
            <span style={{ fontSize: 11, lineHeight: 1.55, color: "#5e6678" }}>
              Passages are packed to about 1,100 characters on paragraph boundaries, and a
              heading always travels with the text beneath it — so a hit arrives knowing
              which section it came from.
            </span>
          </div>
        )}
      </div>
    </ModalShell>
  );
}
