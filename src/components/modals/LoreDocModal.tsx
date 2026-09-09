// One lore document: what it says, whether the director can actually reach it,
// and the two things you can do to it afterwards — re-index, or extract bible
// entries from it.
//
// The passages are shown as passages rather than as one reflowed page on
// purpose. A passage is the unit of retrieval: the director never sees this
// document, it sees one of these blocks, so how the split landed is the thing
// worth looking at. A document whose passages each end mid-clause retrieves
// badly, and there is nowhere else to notice that.
import React, { useState } from "react";
import {
  AlertTriangle, Check, ChevronDown, FileText, Loader2, RefreshCw, Sparkles, Trash2, X,
} from "lucide-react";
import ModalShell from "./ModalShell";
import Dropdown from "../ui/Dropdown";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { deleteDraftEntry, saveEntry } from "../../lib/db/director";
import {
  LORE_DOC_KINDS, deleteLoreDoc, loadDocChunks, loadExtractJobs, loadLoreDocs,
  loadProposedEntries, queueLoreExtract, reindexLoreDoc, setLoreDocEpisode,
} from "../../lib/db/lore";
import { loadEpisodes } from "../../lib/db/projects";

export default function LoreDocModal({ docId, projectId }: { docId: string; projectId: string }) {
  const ws = useWorkspaceStore();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // `rag_documents` is NOT in the realtime publication, so it cannot be
  // subscribed (binding an unpublished table takes the whole shared channel
  // down — see hooks/realtimeTables.ts). `jobs` IS published, and the embed
  // job's progress is the only thing here that changes on its own, so watching
  // it refreshes exactly when there is something new to show.
  const { data, reload } = useLiveQuery(
    async () => {
      const [docs, chunks, jobs, proposed, episodes] = await Promise.all([
        loadLoreDocs(projectId),
        loadDocChunks(docId),
        loadExtractJobs(projectId),
        loadProposedEntries(projectId, docId),
        loadEpisodes(projectId).catch(() => []),
      ]);
      return {
        doc: docs.find((d) => d.id === docId) ?? null,
        chunks,
        jobs: jobs.filter((j) => j.document_id === docId),
        proposed, episodes,
      };
    },
    // `bible_entries` is published, so proposals appear here the moment the
    // extract job writes them — the review list materialises in place rather
    // than the user having to know to come back and look.
    ["jobs", "bible_entries"], [docId, projectId]
  );

  const doc = data?.doc;
  if (!data || !doc) return null;

  const pending = doc.chunks - doc.embedded;
  const kindLabel = LORE_DOC_KINDS.find((k) => k.id === doc.kind)?.label ?? doc.kind;
  const live = data.jobs.filter((j) => j.status === "queued" || j.status === "running");
  const proposed = data.proposed;
  // The extract pass specifically — `live` above also covers embed jobs, and a
  // document being indexed must not read as "the director is reading it".
  // `data.jobs` is newest-first, so `find` is "the latest of this kind".
  const extracting = data.jobs.find(
    (j) => j.task === "extract_lore" && (j.status === "queued" || j.status === "running"));
  const lastExtract = data.jobs.find((j) => j.task === "extract_lore");
  const lastEmbed = data.jobs.find((j) => j.kind === "embed");
  // Only the LATEST attempt's failure is worth showing. Surfacing any failure
  // ever recorded means a run that failed on an old build keeps accusing a
  // document that has since been read successfully — measured: the pod's
  // pre-deploy `unknown llm task 'extract_lore'` sat beside six good proposals
  // and read as though the extraction had just broken.
  const failed = [lastExtract, lastEmbed].filter(
    (j) => j && (j.status === "error" || j.status === "failed")) as typeof data.jobs;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setNote(null);
    try { await fn(); } catch (e) {
      setNote(`Failed: ${String((e as Error).message || e).slice(0, 140)}`);
    } finally { setBusy(false); }
  };

  return (
    <ModalShell
      width={860} maxH={720} z={95}
      icon={<FileText size={16} />}
      title={doc.title}
      context={`${kindLabel} · ${doc.chunks} passage${doc.chunks === 1 ? "" : "s"}`
               + (doc.source ? ` · ${doc.source}` : "")}
      footer={<>
        <span className="sum" style={{ color: note ? "#e8c268" : "#5e6678" }}>
          {note ?? "Retrieved a passage at a time, when it is relevant to the scene being written."}
        </span>
        {confirmDelete ? (
          <>
            <button className="ws-ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep</button>
            <button className="ws-ghost" disabled={busy}
                    style={{ borderColor: "rgba(228,110,110,.5)", color: "#e46e6e" }}
                    onClick={() => void act(async () => {
                      await deleteLoreDoc(doc.id);
                      ws.closeModal();
                    })}>
              <Trash2 size={13} /> Delete document
            </button>
          </>
        ) : (
          <>
            <button className="ws-ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 size={13} /> Delete
            </button>
            <button className="ws-ghost" onClick={ws.closeModal}>Done</button>
          </>
        )}
      </>}
    >
      <div className="ns-scroll ws-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* ---- reachability: the one thing that is invisible everywhere else -- */}
        <div className="ws-card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {pending === 0 && doc.chunks > 0 ? (
            <>
              <Check size={15} style={{ color: "#6fd08c" }} />
              <span style={{ fontSize: 13 }}>
                Indexed — all {doc.chunks} passage{doc.chunks === 1 ? "" : "s"} are searchable by the director.
              </span>
            </>
          ) : live.length ? (
            <>
              <Loader2 size={15} className="ns-spin" style={{ color: "#8fc2ff" }} />
              <span style={{ fontSize: 13 }}>
                Indexing in the studio cloud — {doc.embedded} of {doc.chunks} done
                {live[0].progress_note ? ` · ${live[0].progress_note}` : ""}
              </span>
            </>
          ) : (
            <>
              <AlertTriangle size={15} style={{ color: "#e8c268" }} />
              <span style={{ flex: 1, minWidth: 220, fontSize: 13, lineHeight: 1.55 }}>
                {doc.embedded} of {doc.chunks} passages indexed.
                <span style={{ color: "#9aa4b6" }}>
                  {" "}Until the rest are, this document is stored but the director cannot
                  retrieve it — indexing runs in the studio cloud, so it waits for that to be awake.
                </span>
              </span>
            </>
          )}
          <span style={{ flex: 1 }} />
          {pending > 0 && !live.length && (
            <button className="ws-ghost" disabled={busy}
                    onClick={() => void act(async () => {
                      await reindexLoreDoc(doc);
                      setNote(`Queued indexing for ${pending} passage${pending === 1 ? "" : "s"}.`);
                      reload();
                    })}>
              <RefreshCw size={13} /> Index now
            </button>
          )}
        </div>

        {failed.length > 0 && (
          <div className="ws-card" style={{ borderColor: "rgba(228,110,110,.35)" }}>
            <span style={{ fontSize: 12.5, color: "#ff9a9a", lineHeight: 1.6 }}>
              A job for this document failed: {failed[0].error_msg ?? "no reason recorded"}.
              {" "}Embedding needs <span className="mono">OPENAI_API_KEY</span> with quota on the
              worker — the entry summaries still reach the planner without it.
            </span>
          </div>
        )}

        {/* ---- what this document is about -------------------------------- */}
        {data.episodes.length > 0 && (
          <div className="ws-card" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>This document covers</span>
            <Dropdown width={250}
              trigger={({ toggle }) => (
                <button className="ws-ghost" onClick={toggle}
                        style={{ height: 32, minWidth: 130, justifyContent: "space-between", padding: "0 11px" }}>
                  <span style={{ fontSize: 12.5 }}>
                    {data.episodes.find((e) => e.id === doc.episode_id)?.code ?? "the series"}
                  </span>
                  <ChevronDown size={12} />
                </button>
              )}>
              {(close) => (
                <>
                  <div className="ws-menu-label">what this document covers</div>
                  <button className={"ws-menu-row" + (doc.episode_id ? "" : " on")}
                          onClick={() => { close(); void act(async () => {
                            await setLoreDocEpisode(doc.id, null);
                            setNote("Series-wide — facts extracted from it will be always true."); reload();
                          }); }}>
                    The series
                  </button>
                  {data.episodes.map((e) => (
                    <button key={e.id} className={"ws-menu-row" + (e.id === doc.episode_id ? " on" : "")}
                            onClick={() => { close(); void act(async () => {
                              await setLoreDocEpisode(doc.id, e.id);
                              setNote(`Now scoped to ${e.code || `Ep${e.idx + 1}`}.`); reload();
                            }); }}>
                      {e.code || `Ep${e.idx + 1}`}
                    </button>
                  ))}
                </>
              )}
            </Dropdown>
            <span style={{ flex: 1, minWidth: 200, fontSize: 11.5, lineHeight: 1.55, color: "#5e6678" }}>
              Entries extracted from here start out with this timing. Changing it does not
              re-time entries already proposed — those may have been corrected by hand.
            </span>
          </div>
        )}

        {/* ---- extract entries ------------------------------------------- */}
        {/* The proposals land HERE, in the panel whose button made them.
            Before, the pass queued a job and said so, and the drafts appeared
            in the Lore tab indistinguishable from hand-written entries — you
            had to know they existed, know where to look, and know which of the
            cards were new. A review list you can act on is the whole point of
            proposing rather than writing. */}
        <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Extract bible entries</span>
            {extracting && (
              <span className="mono" style={{ fontSize: 10.5, color: "#8fc2ff",
                                              display: "flex", alignItems: "center", gap: 6 }}>
                <Loader2 size={11} className="ns-spin" />
                {extracting.progress_note ?? "reading the document"}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button className="ws-primary" disabled={busy || !!extracting}
                    onClick={() => void act(async () => {
                      await queueLoreExtract({ doc, projectId });
                      setNote("Reading the document — proposals appear below as they land.");
                      reload();
                    })}>
              {busy || extracting ? <Loader2 size={13} className="ns-spin" /> : <Sparkles size={13} />}
              {extracting ? "Reading…" : proposed.length ? "Read it again" : "Read it and propose entries"}
            </button>
          </div>
          <div style={{ fontSize: 11.5, lineHeight: 1.65, color: "#9aa4b6" }}>
            The document stays as it is — this reads it and proposes named lore entries
            (a faction, a rule, a piece of history) so the things the story leans on hardest are
            in the planner's context for <i>every</i> scene, not only when retrieval surfaces them.
            Nothing becomes canon until you confirm it below.
          </div>

          {proposed.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4,
                            paddingTop: 10, borderTop: "1px solid rgba(255,255,255,.07)" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {proposed.length} proposed
                  <span className="mono" style={{ fontSize: 10.5, color: "#e8c268", marginLeft: 8 }}>
                    awaiting your decision
                  </span>
                </span>
                <span style={{ flex: 1 }} />
                <button className="ws-microbtn" disabled={busy}
                        onClick={() => void act(async () => {
                          for (const p of proposed) await saveEntry(p.id, { status: "confirmed" });
                          setNote(`Confirmed ${proposed.length} entr${proposed.length === 1 ? "y" : "ies"}.`);
                          reload();
                        })}>
                  <Check size={11} /> confirm all
                </button>
                <button className="ws-microbtn danger" disabled={busy}
                        onClick={() => void act(async () => {
                          for (const p of proposed) await deleteDraftEntry(p.id);
                          setNote("Discarded every proposal. The document is unchanged.");
                          reload();
                        })}>
                  <X size={11} /> discard all
                </button>
              </div>

              {proposed.map((p) => (
                <div key={p.id} className="ws-card"
                     style={{ display: "flex", flexDirection: "column", gap: 7,
                              background: "rgba(255,255,255,.02)" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 600 }}>{p.name}</span>
                      {/* The summary is the load-bearing field — it is what the
                          planner sees for this entry in EVERY scene — so it is
                          what a reviewer should be reading, not the body. */}
                      <span style={{ fontSize: 12, lineHeight: 1.6, color: "#9aa4b6" }}>
                        {p.summary || <i style={{ color: "#e8c268" }}>no summary — it would reach the planner blank</i>}
                      </span>
                    </span>
                    <button className="ws-microbtn" disabled={busy} title="Make this canon"
                            onClick={() => void act(async () => {
                              await saveEntry(p.id, { status: "confirmed" });
                              setNote(`"${p.name}" confirmed.`); reload();
                            })}>
                      <Check size={11} /> keep
                    </button>
                    <button className="ws-microbtn danger" disabled={busy} title="Discard this proposal"
                            onClick={() => void act(async () => {
                              await deleteDraftEntry(p.id);
                              setNote(`"${p.name}" discarded.`); reload();
                            })}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                  {p.body && (
                    <span className="ns-scroll" style={{ fontSize: 11.5, lineHeight: 1.65, color: "#5e6678",
                                                         maxHeight: 88, overflowY: "auto", whiteSpace: "pre-wrap" }}>
                      {p.body}
                    </span>
                  )}
                  <button className="ws-microbtn" style={{ alignSelf: "flex-start" }}
                          onClick={() => ws.openModal({ kind: "entry", entryId: p.id })}>
                    open &amp; edit
                  </button>
                </div>
              ))}
            </>
          )}

          {!proposed.length && lastExtract?.status === "done" && (
            <div style={{ fontSize: 11.5, lineHeight: 1.6, color: "#5e6678" }}>
              The last pass proposed nothing new — either this document's concepts are already
              in the bible, or it is narrative rather than canon. Nothing was changed.
            </div>
          )}
        </div>

        {/* ---- the passages ---------------------------------------------- */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
            <span className="ws-mlabel">Passages</span>
            <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
              each one is what a retrieval hit returns
            </span>
          </div>
          {data.chunks.map((c) => (
            <div key={c.id} className="ws-card" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span className="mono" style={{ fontSize: 10, color: "#5e6678", flex: "0 0 auto", marginTop: 2 }}>
                {String(c.idx + 1).padStart(2, "0")}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.7, color: "#9aa4b6",
                             whiteSpace: "pre-wrap" }}>
                {c.content}
              </span>
            </div>
          ))}
          {data.chunks.length >= 200 && (
            <span className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>
              showing the first 200 passages
            </span>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
