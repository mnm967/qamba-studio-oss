// The local storage plane, end to end, in a browser tab.
//
// WHY IT IS A HARNESS SCREEN. The plane's whole claim is that a project on
// this machine behaves like any other project — same tables, same queries,
// same media surfaces — and the honest way to check that is to make one, write
// to it through the ROUTED client every screen uses, read it back, and look at
// the picture. Unit tests already pin the store and the query shim
// (`localQuery.test.ts`, `localStore` in `localRest.test.ts`); what they cannot
// show is that `supabase.from(...)` actually lands on the local store inside a
// browser, that a project survives a reload, and that `mediaUrl` resolves a
// local key to something an `<img>` can load.
//
// Every button here drives the REAL modules — `createProject` with
// `storage: "local"`, `supabase.from`, `uploadMedia`. Nothing is stubbed except
// the far side of the Tauri bridge (`desktop.mock.ts`), which is the part a
// browser tab genuinely cannot have.
import React, { useCallback, useEffect, useState } from "react";
import {
  Database, HardDrive, ListChecks, Loader2, PanelRight, Pencil, Plus, RefreshCw,
  Settings2, Trash2,
} from "lucide-react";
import { Card } from "./ModalShell";
import ProjectSettingsModal from "./ProjectSettingsModal";
import ContextPanel from "../shell/ContextPanel";
import QueuePopover from "../shell/QueuePopover";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { supabase, mediaUrl } from "../../lib/supabase";
import { createProject, loadProjects, mainEpisode } from "../../lib/db/projects";
import {
  activeLocalProjectId, bootLocalPlane, deleteLocalProject, isLocalProject,
  localProjectBytes, localProjects, refreshMediaKeys, setActiveLocalProject,
} from "../../lib/localPlane";
import { uploadMedia } from "../../lib/upload.js";
import { registerAsset } from "../../lib/db/assets";

/** A 1x1 PNG, so the media path is exercised with real bytes rather than a
 *  string that only looks like a file. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export default function LocalPlaneDemo() {
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [assets, setAssets] = useState<any[]>([]);
  /** Project settings reads `projects` through the ROUTED client, so on a local
   *  project it needs no session at all — which is what makes it reviewable
   *  here at all. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The "Project settings" RAIL — the same panel the workspace shows, which
   *  is where the storage row has to read correctly at 350px. */
  const store = useWorkspaceStore();
  const [railOpen, setRailOpen] = useState(false);
  /** The queue popover, which on this plane reads the open project's own job
   *  rows out of the file rather than a database. */
  const [queueOpen, setQueueOpen] = useState(false);
  const [episode, setEpisode] = useState<any>(null);

  const say = (line: string) => setLog((l) => [...l.slice(-14), line]);

  const refresh = useCallback(async () => {
    const list = await loadProjects().catch(() => localProjects() as any[]);
    setProjects(list);
    const active = activeLocalProjectId();
    if (!active) { setRows([]); setAssets([]); return; }
    // THE ROUTED CLIENT, deliberately: this is the same call the storyboard
    // makes, and it must land on the local store without knowing that it did.
    const beats = await supabase.from("beats").select("id,idx,action").order("idx");
    if (beats.error) say(`beats: ${beats.error.message}`);
    setRows((beats.data as any[]) ?? []);
    const media = await supabase.from("assets").select("*").is("deleted_at", null);
    if (media.error) say(`assets: ${media.error.message}`);
    setAssets((media.data as any[]) ?? []);
    const eps = await supabase.from("episodes").select("*").eq("project_id", active).limit(1);
    setEpisode((eps.data as any[])?.[0] ?? null);
    say(`refresh: plane=${active.slice(0, 8)} beats=${beats.data?.length ?? "err"}`);
  }, []);

  useEffect(() => { void bootLocalPlane().then(refresh); }, [refresh]);

  const make = async () => {
    setBusy("create");
    try {
      const p = await createProject({
        medium: "film", title: `Local demo ${new Date().toISOString().slice(11, 19)}`,
        style: "anime", aspect: "16:9", storage: "local",
        logline: "A project whose rows never leave this machine.",
      });
      say(`created ${p.id.slice(0, 8)} — ${isLocalProject(p.id) ? "local" : "NOT LOCAL (wrong)"}`);
      // The harness has no router, so the plane is pointed by hand — the app
      // reads it off `/project/:pid` instead (localScope.ts).
      setActiveLocalProject(p.id);
      const ep = await mainEpisode(p.id);
      say(`episode ${ep?.code ?? "—"} ${ep ? "✓" : "MISSING"}`);

      const sb = await supabase.from("storyboards").insert({ episode_id: ep!.id }).select().single();
      const sc = await supabase.from("scenes")
        .insert({ storyboard_id: sb.data.id, idx: 0, slug: "OPEN", purpose: "establish" })
        .select().single();
      const beats = await supabase.from("beats").insert(
        [0, 1, 2].map((idx) => ({
          scene_id: sc.data.id, idx, duration_ms: 3000,
          action: `beat ${idx} — written through supabase.from()`,
        }))).select();
      // `project_id` is DERIVED, never passed — the store's own trigger walks
      // the parent chain the way Postgres used to, and half the app's queries
      // filter on it.
      say(`wrote ${beats.data?.length ?? 0} beats, project_id derived: ${beats.data?.[0]?.project_id === p.id}`);

      const key = `images/${p.id}.png`;
      await uploadMedia(new File([Uint8Array.from(atob(PIXEL), (c) => c.charCodeAt(0))],
        "pixel.png", { type: "image/png" }), key);
      await registerAsset({ b2_key: key, kind: "image", project_id: p.id, content_type: "image/png" });
      say(`media ${key} → ${String(mediaUrl(key)).slice(0, 42)}…`);
      // A ROW WITH NO FILE. It is a real state — a job cancelled between
      // registering an asset and writing it — and there is no bucket to fall
      // through to here, so `mediaUrl` answers NULL and the surface renders
      // nothing rather than a broken image pointing at a host that does not
      // exist. The pipeline's own `media.b2_get` names the key and the path it
      // looked at, which is the other half of the same honesty.
      const ghost = `images/ghost-${p.id}.png`;
      await registerAsset({ b2_key: ghost, kind: "image", project_id: p.id, content_type: "image/png" });
      await refreshMediaKeys(p.id);
      say(`missing ${ghost} → ${mediaUrl(ghost) === null ? "null (correct)" : "A URL (wrong)"}`);
      await refresh();
    } catch (e) {
      say(`FAILED: ${(e as Error).message}`);
    } finally { setBusy(null); }
  };

  const open = async (id: string) => { setActiveLocalProject(id); await refresh(); };

  const drop = async (id: string) => {
    setBusy("delete");
    try {
      await deleteLocalProject(id);
      if (activeLocalProjectId() === id) setActiveLocalProject(null);
      say(`deleted ${id.slice(0, 8)}`);
      await refresh();
    } finally { setBusy(null); }
  };

  const active = activeLocalProjectId();

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14,
                  maxWidth: 900, margin: "0 auto", color: "#c8cfdb" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <HardDrive size={18} />
        <h2 style={{ margin: 0, fontSize: 16, color: "#fff" }}>Local storage plane</h2>
        <span data-testid="active-plane" style={{ fontSize: 11.5, opacity: 0.6 }}>
          {active ? `plane: local · ${active.slice(0, 8)}` : "plane: none open"}
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="ws-primary" onClick={make} disabled={!!busy} data-testid="make-local">
          {busy === "create" ? <Loader2 size={14} className="ns-spin" /> : <Plus size={14} />}
          {" New local project"}
        </button>
        <button className="ws-ghost" onClick={refresh} disabled={!!busy}>
          <RefreshCw size={13} /> Refresh
        </button>
        {active && (
          <button className="ws-ghost" data-testid="edit-beat"
                  onClick={() => void (async () => {
                    // An ordinary edit through the routed client, which is what
                    // the throttled save watches for.
                    const { data } = await supabase.from("beats").select("id").limit(1);
                    const id = (data as any[])?.[0]?.id;
                    if (!id) return;
                    await supabase.from("beats")
                      .update({ action: `edited at ${new Date().toISOString().slice(11, 19)}` })
                      .eq("id", id);
                    say("edited a beat");
                    await refresh();
                  })()}>
            <Pencil size={13} /> Edit a beat
          </button>
        )}
        <button className="ws-ghost" data-testid="open-queue"
                onClick={() => setQueueOpen((v) => !v)}>
          <ListChecks size={13} /> {queueOpen ? "Hide" : "Show"} queue
        </button>
        {active && (
          <button className="ws-ghost" data-testid="open-rail"
                  onClick={() => {
                    useWorkspaceStore.getState().set("panel", "models");
                    setRailOpen((v) => !v);
                  }}>
            <PanelRight size={13} /> {railOpen ? "Hide" : "Show"} settings rail
          </button>
        )}
        {active && (
          <button className="ws-ghost" data-testid="open-settings"
                  onClick={() => setSettingsOpen(true)}>
            <Settings2 size={13} /> Project settings…
          </button>
        )}
      </div>

      <Card label={`Projects (${projects.length})`}>
        <div data-testid="project-list" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {projects.map((p) => (
            <div key={p.id} data-testid="project-row"
                 style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 12.5 }}>
              <span style={{ flex: 1, color: p.id === active ? "#fff" : undefined }}>{p.title}</span>
              <span className="dir-tag dim" data-testid="tag-local">on this computer</span>
              <button className="ws-ghost" onClick={() => open(p.id)}>Open</button>
              <button className="ws-ghost" onClick={() => drop(p.id)}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {!projects.length && <span style={{ opacity: 0.6, fontSize: 12 }}>none yet</span>}
        </div>
      </Card>

      <Card label={`Beats read back through supabase.from() (${rows.length})`}>
        <div data-testid="beat-list" style={{ fontSize: 12, fontFamily: "ui-monospace, monospace",
             opacity: 0.85, display: "flex", flexDirection: "column", gap: 3 }}>
          {rows.map((r) => <span key={r.id}>{r.idx}. {r.action}</span>)}
          {!rows.length && <span style={{ opacity: 0.6 }}>no rows — open a local project</span>}
        </div>
      </Card>

      <Card label={`Media resolved by mediaUrl() (${assets.length})`}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {assets.map((a) => (
            <img key={a.id}
                 data-testid={a.b2_key.includes("ghost-") ? "local-media-missing" : "local-media"}
                 src={mediaUrl(a.b2_key) ?? ""} alt={a.b2_key}
                 style={{ width: 42, height: 42, borderRadius: 8, objectFit: "cover",
                          background: "#1b2030", border: "1px solid rgba(255,255,255,.1)" }} />
          ))}
          {!assets.length && <span style={{ opacity: 0.6, fontSize: 12 }}>no media</span>}
        </div>
      </Card>

      {active && (
        <Card label="On disk">
          <div data-testid="local-bytes" style={{ fontSize: 12, fontFamily: "ui-monospace, monospace",
               opacity: 0.85, display: "flex", alignItems: "center", gap: 8 }}>
            <Database size={13} />
            {localProjectBytes(active)} bytes of media in this project's folder
          </div>
        </Card>
      )}

      <Card label="Log">
        <div data-testid="demo-log" style={{ fontSize: 11.5, fontFamily: "ui-monospace, monospace",
             opacity: 0.75, display: "flex", flexDirection: "column", gap: 2 }}>
          {log.map((l, i) => <span key={i}>{l}</span>)}
          {!log.length && <span style={{ opacity: 0.6 }}>—</span>}
        </div>
      </Card>

      {queueOpen && <div data-testid="queue-host"><QueuePopover /></div>}
      {railOpen && active && (
        <div data-testid="settings-rail"
             style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 360,
                      display: "flex", borderLeft: "1px solid rgba(255,255,255,.08)",
                      background: "#0b0d12", zIndex: 40 }}>
          <ContextPanel episode={episode} projectId={active} />
        </div>
      )}
      {settingsOpen && active && (
        <div onClick={(e) => {
          // The real modal closes through the workspace store, which the
          // harness does not drive — so the scrim closes it here instead.
          if ((e.target as HTMLElement).classList.contains("ws-scrim")) setSettingsOpen(false);
        }}>
          <ProjectSettingsModal projectId={active} />
        </div>
      )}
      {/* `store` is read so the rail's own store writes re-render this screen;
          without it the panel would open and the harness would not know. */}
      <span hidden>{store.panel ?? ""}</span>
    </div>
  );
}
