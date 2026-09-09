import React, { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Check, ImagePlus, Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";
import V2Shell from "../design/V2Shell";
import { useLiveQuery } from "../hooks/useLiveQuery";
import {
  attachRef, confirmRevision, createEntry, detachRef, dismissRevision,
  loadBible, loadBibleAssets, loadRevisions, saveEntry,
} from "../lib/db/director";
import { assetUrl, loadAssets, loadAssetsByIds } from "../lib/db/assets";
import { enqueueJob } from "../lib/db/jobs";
import { loadProject } from "../lib/db/projects";
import DeleteBibleEntryModal from "../components/modals/DeleteBibleEntryModal";
import type { Asset, BibleEntry, BibleKind } from "../lib/db/types";
import "../styles/director.css";

const KINDS: BibleKind[] = ["character", "environment", "prop", "style", "lore"];
const ROLES = ["master", "face", "full_body", "side", "outfit"];

function sheetPrompt(e: BibleEntry, style?: string | null) {
  const line = e.identity_line || e.summary || e.name;
  return e.kind === "character"
    ? `character reference sheet, ${style || "anime"} style: ${line}. Full body, neutral pose, front view, clean plain background, consistent design, high detail`
    : `environment reference, ${style || "anime"} style, establishing wide shot: ${line}. No characters, rich detail, coherent lighting`;
}

export default function BiblePage() {
  const { pid } = useParams<{ pid: string }>();
  const [kind, setKind] = useState<BibleKind>("character");
  const [selId, setSelId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [picking, setPicking] = useState(false);
  const [deletingEntry, setDeletingEntry] = useState<{ id: string; name: string; kind: string } | null>(null);

  const { data: project } = useLiveQuery(() => loadProject(pid!), ["projects"], [pid]);
  const { data, loading, reload } = useLiveQuery(
    async () => {
      // candidates depend on nothing here, so they ride the first round.
      const [entries, candidates] = await Promise.all([
        loadBible(pid!, { committedOnly: true }),
        // candidate images generated for entries but not yet attached
        loadAssets({ kind: "image", tags: ["candidate"], limit: 60 }),
      ]);
      const links = await loadBibleAssets(entries.map((e) => e.id));
      const assets = await loadAssetsByIds(links.map((l) => l.asset_id));
      return { entries, links, assets, candidates };
    },
    ["bible_entries", "bible_assets", "assets"],
    [pid]
  );
  const sel = useMemo(
    () => data?.entries.find((e) => e.id === selId) ?? null,
    [data?.entries, selId]
  );
  const { data: revisions, reload: reloadRevs } = useLiveQuery(
    () => (selId ? loadRevisions(selId) : Promise.resolve([])),
    ["bible_revisions"], [selId]
  );
  const { data: library } = useLiveQuery(
    () => (picking ? loadAssets({ kind: "image", limit: 40 }) : Promise.resolve([] as Asset[])),
    ["assets"], [picking]
  );

  const entries = (data?.entries ?? []).filter((e) => e.kind === kind);
  const linksFor = (id: string) => (data?.links ?? []).filter((l) => l.entry_id === id);
  const candidatesFor = (id: string) =>
    (data?.candidates ?? []).filter(
      (a) => (a.meta as { target?: { bible_entry_id?: string } })?.target?.bible_entry_id === id &&
        !(data?.links ?? []).some((l) => l.asset_id === a.id)
    );

  const genRef = async (e: BibleEntry, role: string) => {
    await enqueueJob({
      kind: "image_gen", lane: "gpu", priority: 20, project_id: pid,
      payload: {
        prompt: sheetPrompt(e, project?.style),
        width: 1024, height: 1024,
        target: { bible_entry_id: e.id, role, slot: linksFor(e.id).length },
        ref_asset_ids: linksFor(e.id).slice(0, 2).map((l) => l.asset_id),
      },
    });
    alert("Ref sheet queued — it appears in Candidates when done.");
  };

  const pendingRevs = (revisions ?? []).filter((r) => !r.confirmed_at);

  return (
    <V2Shell title="Bible" eyebrow={project?.title ?? ""} backTo={`/project/${pid}`} wide>
      <div className="dir-chiprow" style={{ marginBottom: 12 }}>
        {KINDS.map((k) => (
          <button key={k} className={"dir-chip" + (kind === k ? " on" : "")}
                  onClick={() => { setKind(k); setSelId(null); }}>
            {k}{k !== "lore" && k !== "style" ? "s" : ""}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <input
          className="dir-input sm" placeholder={`New ${kind} name…`} value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === "Enter" && newName.trim()) {
              const row = await createEntry({ project_id: pid!, kind, name: newName.trim() });
              setNewName(""); setSelId(row.id); reload();
            }
          }}
        />
        <Plus size={14} style={{ opacity: 0.5 }} />
      </div>

      <div className="biblewrap">
        <div className="biblegrid">
          {entries.map((e) => {
            const thumb = linksFor(e.id)[0];
            const a = thumb ? data?.assets.get(thumb.asset_id) : null;
            return (
              <div
                key={e.id}
                className={"dir-card entrycard" + (selId === e.id ? " on" : "")}
                role="button"
                tabIndex={0}
                onClick={() => setSelId(e.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    setSelId(e.id);
                  }
                }}
              >
                <div className="entrythumb">
                  {a ? <img src={assetUrl(a) ?? undefined} alt="" /> : <ImagePlus size={18} />}
                </div>
                <div className="entrymeta">
                  <div className="entryname">
                    {e.name}
                    <span className={"statuschip " + e.status}>{e.status}</span>
                  </div>
                  <div className="entryline">{e.identity_line ?? e.summary ?? "—"}</div>
                </div>
                <button
                  type="button"
                  className="entrycard-del"
                  title={`Delete ${e.name}`}
                  aria-label={`Delete ${e.name}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setDeletingEntry({ id: e.id, name: e.name, kind: e.kind });
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
          {/* `spin` (director.css), not `ns-spin` — workspace.css isn't loaded
              on this route unless the workspace was visited first. */}
          {!entries.length && (loading
            ? <div className="v2-empty" style={{ display: "flex", alignItems: "center",
                                                 justifyContent: "center", gap: 8 }}>
                <Loader2 size={14} className="spin" /> Loading…
              </div>
            : <div className="v2-empty">No {kind}s yet.</div>)}
        </div>

        {sel && (
          <aside className="dir-card entrydetail" key={sel.id}>
            <div className="entrydetail-head">
              <b>{sel.name}</b>
              <span className={"statuschip " + sel.status}>{sel.status}</span>
              {sel.status === "draft" && (
                <button className="dir-ghost" onClick={async () => {
                  await saveEntry(sel.id, { status: "confirmed" }); reload();
                }}>
                  <Check size={12} /> Confirm
                </button>
              )}
              <button className="dir-ghost" style={{ marginLeft: "auto" }} onClick={() => setSelId(null)}>
                <X size={13} />
              </button>
            </div>

            <label className="dir-label">Identity line (repeated verbatim in every shot)</label>
            <textarea
              className="dir-input" rows={3} defaultValue={sel.identity_line ?? ""}
              onBlur={async (e) => {
                if (e.target.value !== (sel.identity_line ?? "")) {
                  await saveEntry(sel.id, { identity_line: e.target.value }); reload();
                }
              }}
            />
            <label className="dir-label">Summary</label>
            <textarea
              className="dir-input" rows={2} defaultValue={sel.summary ?? ""}
              onBlur={async (e) => {
                if (e.target.value !== (sel.summary ?? "")) {
                  await saveEntry(sel.id, { summary: e.target.value }); reload();
                }
              }}
            />

            {(sel.kind === "character" || sel.kind === "environment") && (
              <>
                <div className="dir-cardlabel" style={{ marginTop: 10 }}>Reference slots</div>
                <div className="refrow">
                  {linksFor(sel.id).map((l) => {
                    const a = data?.assets.get(l.asset_id);
                    return (
                      <div key={l.asset_id} className="refslot" title={l.role}>
                        {a && <img src={assetUrl(a) ?? undefined} alt={l.role} />}
                        <span className="refrole">{l.role}</span>
                        <button className="refdel" onClick={async () => {
                          await detachRef(sel.id, l.asset_id); reload();
                        }}><X size={10} /></button>
                      </div>
                    );
                  })}
                  <div className="refactions">
                    {ROLES.slice(0, sel.kind === "character" ? 3 : 1).map((r) => (
                      <button key={r} className="dir-ghost" onClick={() => genRef(sel, r)}>
                        <Sparkles size={11} /> gen {r}
                      </button>
                    ))}
                    <button className="dir-ghost" onClick={() => setPicking((p) => !p)}>
                      <ImagePlus size={11} /> from library
                    </button>
                  </div>
                </div>
                {picking && (
                  <div className="candrow">
                    {(library ?? []).map((a) => (
                      <img key={a.id} src={assetUrl(a) ?? undefined} alt="" className="cand"
                           onClick={async () => {
                             await attachRef(sel.id, a.id, "master", linksFor(sel.id).length);
                             setPicking(false); reload();
                           }} />
                    ))}
                  </div>
                )}
                {candidatesFor(sel.id).length > 0 && (
                  <>
                    <div className="dir-cardlabel">Candidates</div>
                    <div className="candrow">
                      {candidatesFor(sel.id).map((a) => (
                        <div key={a.id} className="candwrap">
                          <img src={assetUrl(a) ?? undefined} alt="" className="cand" />
                          <button className="dir-ghost" onClick={async () => {
                            const role = (a.meta as { target?: { role?: string } })?.target?.role ?? "master";
                            await attachRef(sel.id, a.id, role, linksFor(sel.id).length);
                            reload();
                          }}>
                            <Check size={11} /> keep
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {pendingRevs.length > 0 && (
              <>
                <div className="dir-cardlabel" style={{ marginTop: 10 }}>
                  Proposed lore updates
                </div>
                {pendingRevs.map((r) => (
                  <div key={r.id} className="revcard">
                    <div className="revnote">v{r.version} — {r.change_note}</div>
                    {r.identity_line && r.identity_line !== sel.identity_line && (
                      <div className="revdiff">
                        <s>{sel.identity_line}</s>
                        <ins>{r.identity_line}</ins>
                      </div>
                    )}
                    <div className="dir-row">
                      <button className="dir-cta" onClick={async () => {
                        await confirmRevision(r); reloadRevs(); reload();
                      }}>
                        <Check size={12} /> Confirm
                      </button>
                      <button className="dir-ghost" onClick={async () => {
                        await dismissRevision(r.id); reloadRevs();
                      }}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </aside>
        )}
      </div>
      {deletingEntry && (
        <DeleteBibleEntryModal
          entryId={deletingEntry.id}
          name={deletingEntry.name}
          kindName={deletingEntry.kind}
          onClose={() => setDeletingEntry(null)}
          onDeleted={() => {
            if (selId === deletingEntry.id) setSelId(null);
            reload();
          }}
        />
      )}
    </V2Shell>
  );
}
