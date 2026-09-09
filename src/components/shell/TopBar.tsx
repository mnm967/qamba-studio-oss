import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  BookOpen, Check, ChevronDown, Clapperboard, Cpu, Eye, Globe, Images, LayoutList,
  ListVideo, Music, PanelRight, Pencil, Plus, Share2, Sparkles, Tv, Wallet, Workflow,
} from "lucide-react";
import { useIsAdmin } from "../../lib/auth";
import { isDesktop } from "../../lib/desktop";
import { pingComfy } from "../../lib/comfyLocal";
import { useProjectRole } from "../../hooks/useProjectRole";
import { useActiveDownloads } from "../../hooks/useActiveDownloads";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import { createEpisode, loadEpisodes, loadProjects, mainEpisode } from "../../lib/db/projects";
import type { Episode, Project } from "../../lib/db/types";

export type WsView =
  | "timeline" | "storyboard" | "bible" | "library" | "workflows" | "projects";

const TABS: {
  id: WsView; label: string; icon: React.ReactNode;
  /** reachable without a project, at /<id> — the tabs that describe the studio
   *  rather than the open episode */
  studioWide?: boolean;
}[] = [
  { id: "timeline", label: "Timeline", icon: <ListVideo size={16} /> },
  { id: "storyboard", label: "Storyboard", icon: <LayoutList size={16} /> },
  { id: "bible", label: "Bible", icon: <BookOpen size={16} /> },
  { id: "library", label: "Library", icon: <Images size={16} /> },
  // Which ComfyUI graph each model renders on, and which of them this machine
  // can resolve. It names checkpoint and LoRA filenames — all of them files
  // the user downloaded themselves, onto the engine they run.
  { id: "workflows", label: "Workflows", icon: <Workflow size={16} />, studioWide: true },
];

const MEDIUM_CHIP: Record<string, string> = { series: "SERIES", film: "FILM", music_video: "MV" };

/** Anchored dropdown that closes on outside click or Escape. */
function Menu({ open, onClose, children, width = 260 }: {
  open: boolean; onClose: () => void; children: React.ReactNode; width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // defer: the click that opened the menu is still propagating
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return <div className="ws-menu ns-l2 ns-pop" style={{ width }} ref={ref}>{children}</div>;
}

export default function TopBar({
  project, episode, view, hasProject,
}: {
  project: Project | null;
  episode: Episode | null;
  view: WsView;
  hasProject?: boolean;
}) {
  const nav = useNavigate();
  const ws = useWorkspaceStore();
  const isAdmin = useIsAdmin();
  const downloads = useActiveDownloads();
  const role = useProjectRole(project?.id ?? null);
  const [menu, setMenu] = useState<"project" | "episode" | null>(null);

  const isProjectSelected = hasProject ?? Boolean(project);

  const { data } = useLiveQuery(
    async () => {
      const [{ count }, { count: queued }] = await Promise.all([
        supabase.from("jobs").select("id", { count: "exact", head: true })
          .in("status", ["queued", "running"]),
        supabase.from("jobs").select("id", { count: "exact", head: true }).eq("status", "queued"),
      ]);
      return { active: count ?? 0, queued: queued ?? 0 };
    },
    ["jobs"], []
  );
  const { data: projects } = useLiveQuery(
    () => (menu === "project" ? loadProjects() : Promise.resolve(null)), ["projects"], [menu]);
  const { data: episodes } = useLiveQuery(
    () => (project ? loadEpisodes(project.id) : Promise.resolve([] as Episode[])),
    ["episodes"], [project?.id]);

  // The local engine, on the desktop build only. Polled rather than watched:
  // a user starts ComfyUI in another window and expects the chip to notice,
  // and there is no event to subscribe to. 15s is slow enough to be free and
  // fast enough that "I just started it" resolves while they are still looking.
  const [local, setLocal] = useState<{ up: boolean; label: string } | null>(null);
  useEffect(() => {
    if (!isDesktop()) return;
    let live = true;
    const tick = async () => {
      const s = await pingComfy();
      if (!live) return;
      setLocal({
        up: s.reachable,
        label: s.reachable
          ? s.vram_total_mb ? `${(s.vram_total_mb / 1024).toFixed(0)}GB` : "ready"
          : "offline",
      });
    };
    void tick();
    const h = setInterval(tick, 15_000);
    return () => { live = false; clearInterval(h); };
  }, []);

  const base = project && episode ? `/project/${project.id}/ep/${episode.id}` : null;
  // Film and music videos have exactly one auto-created MAIN episode — it's an
  // implementation detail, not something to switch between. Only a series (or
  // anything that really grew a second episode) gets the episode switcher.
  const showEpisodes = !!project && (project.medium === "series" || (episodes?.length ?? 0) > 1);

  const goEpisode = async (ep: Episode) => {
    setMenu(null);
    nav(`/project/${project!.id}/ep/${ep.id}/${view === "projects" ? "timeline" : view}`);
  };

  return (
    <header className="ws-top">
      {/* The identity cluster is the only part that carries user-supplied text,
          so it is the only part allowed to shrink. Everything to its right is
          fixed-size chrome that used to get squeezed by a long episode title. */}
      <div className="ws-top-left">
      <div style={{ display: "flex", alignItems: "center", gap: 9, flex: "0 0 auto" }}>
        <Link to="/" className="ws-mark" title="Qamba Studio"><img src="/logo/mark.png" alt="Qamba Studio" /></Link>
        <span className="ws-brand">QAMBA</span>
      </div>
      <span className="ws-vdiv" />

      <div style={{ position: "relative", minWidth: 0 }}>
        <button className="ws-switch" title={project?.title ?? "Switch project"}
                onClick={() => setMenu((m) => (m === "project" ? null : "project"))}>
          {project?.medium === "music_video" ? <Music size={13} style={{ color: "#9aa4b6" }} />
            : project?.medium === "film" ? <Clapperboard size={13} style={{ color: "#9aa4b6" }} />
            : <Tv size={13} style={{ color: "#9aa4b6" }} />}
          <span className="t">{project?.title ?? "Projects"}</span>
          {project && <span className="chip">{MEDIUM_CHIP[project.medium] ?? project.medium}</span>}
          <ChevronDown size={13} style={{ color: "#5e6678" }} />
        </button>
        <Menu open={menu === "project"} onClose={() => setMenu(null)} width={300}>
          <div className="ws-menu-label">Projects</div>
          {(projects ?? []).map((p) => (
            <button key={p.id} className={"ws-menu-row" + (p.id === project?.id ? " on" : "")}
                    onClick={async () => {
                      setMenu(null);
                      const ep = await mainEpisode(p.id);
                      nav(ep ? `/project/${p.id}/ep/${ep.id}/timeline` : `/project/${p.id}`);
                    }}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.title}
              </span>
              <span className="chip mono">{MEDIUM_CHIP[p.medium] ?? p.medium}</span>
              {p.id === project?.id && <Check size={13} style={{ color: "#5aa2ff" }} />}
            </button>
          ))}
          {projects && !projects.length && <div className="ws-menu-empty">No projects yet.</div>}
          <div className="ws-menu-sep" />
          <button className="ws-menu-row" onClick={() => { setMenu(null); nav("/"); }}>
            <LayoutList size={13} style={{ color: "#5e6678" }} />All projects
          </button>
          <button className="ws-menu-row" onClick={() => { setMenu(null); ws.openModal({ kind: "newProject" }); }}>
            <Plus size={13} style={{ color: "#5e6678" }} />New project…
          </button>
        </Menu>
      </div>

      {showEpisodes && episode && (
        <div style={{ position: "relative", minWidth: 0, flex: "0 0 auto" }}>
          <button className="ws-switch ep-switch"
                  title={`Switch episode — ${episode.code}${episode.title ? ` · ${episode.title}` : ""}`}
                  onClick={() => setMenu((m) => (m === "episode" ? null : "episode"))}>
            <span className="ep-badge">{episode.code}</span>
            <ChevronDown size={13} style={{ color: "#5e6678", flex: "none" }} />
          </button>
          <Menu open={menu === "episode"} onClose={() => setMenu(null)} width={280}>
            <div className="ws-menu-label">Episodes</div>
            {(episodes ?? []).map((ep) => (
              <button key={ep.id} className={"ws-menu-row" + (ep.id === episode.id ? " on" : "")}
                      onClick={() => goEpisode(ep)}>
                <span className="ep-badge mono">{ep.code}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {ep.title || `Episode ${ep.code}`}
                </span>
                {ep.id === episode.id && <Check size={13} style={{ color: "#5aa2ff", flex: "none" }} />}
              </button>
            ))}
            {project?.medium === "series" && role.canEdit && (
              <>
                <div className="ws-menu-sep" />
                <button
                  className="ws-menu-row"
                  onClick={async () => {
                    setMenu(null);
                    const nextNum = (episodes?.length ?? 0) + 1;
                    const code = `EP${String(nextNum).padStart(2, "0")}`;
                    const newEp = await createEpisode(project.id, code, `Episode ${nextNum}`);
                    nav(`/project/${project.id}/ep/${newEp.id}/${view === "projects" ? "timeline" : view}`);
                  }}
                >
                  <Plus size={13} style={{ color: "#5e6678" }} />New episode…
                </button>
              </>
            )}
          </Menu>
        </div>
      )}
      </div>

      {/* A shared project says so, permanently. Read-only that is only
          discovered by pressing a button is the failure this replaces. */}
      {role.isShared && (
        <span className={"ws-rolechip" + (role.canEdit ? " editor" : "")}
              title={role.canEdit
                ? "Shared with you as an editor — you can change the storyboard and queue renders"
                : "Shared with you as a viewer — read-only"}>
          {role.canEdit ? <Pencil size={11} /> : <Eye size={11} />}
          {role.canEdit ? "Editor" : "Viewer"}
        </span>
      )}

      {isProjectSelected && (
        <nav className="ws-nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={view === t.id ? "on" : ""}
              aria-label={t.label}
              onClick={() => nav(base ? `${base}/${t.id}` : t.studioWide ? `/${t.id}` : "/")}
            >
              {t.icon}<span className="lbl">{t.label}</span>
            </button>
          ))}
        </nav>
      )}

      <div className="ws-top-right">
        {/* Which GPU is about to be spent. On the desktop build there are two
            answers and the difference is money, so the local engine gets its
            own chip beside the pod's rather than replacing it — "Local GPU:
            active" next to "pod: stopped" is the whole point. The chip is
            absent in the browser, where there is only ever the pod. */}
        {isDesktop() && (
          <button className={"ws-pod" + (local?.up ? "" : " off")}
                  title={local?.up
                    ? "A ComfyUI on this machine is answering — renders run here, on your GPU"
                    : "No local engine is running — click to install or start one"}
                  onClick={() => ws.openModal({ kind: "engine" })}>
            <span className="ns-dot" style={{
              width: 6, height: 6, borderRadius: "50%", background: "currentColor",
              boxShadow: "0 0 8px currentColor",
            }} />
            <Cpu size={12} />
            <span>local · {local?.label ?? "…"}</span>
          </button>
        )}

        {/* The hub is admin-only for the same reason the Workflows tab is: an
            imported graph names checkpoint and LoRA filenames, which is what
            `local_files` is withheld from members to avoid handing over. */}
        {isAdmin && (
          <button className="ws-icobtn" title="Civitai hub — import workflows and LoRAs"
                  onClick={() => ws.openModal({ kind: "civitai", projectId: project?.id ?? null })}>
            <Globe size={14} />
          </button>
        )}

        {/* Weight downloads count here too. They are not jobs — no row, no
            pod — but the badge is the only thing that tells you to open the
            popover at all, and a 12GB download that shows nowhere in the
            chrome is one you close the engine window and forget about. */}
        <button className="ws-btn-blue" onClick={() => ws.toggle("queueOpen")}>
          <Clapperboard size={13} />
          Queue
          {!!((data?.active ?? 0) + downloads.length) && (
            <span className="n">{(data?.active ?? 0) + downloads.length}</span>
          )}
        </button>

        {/* One-shot plans an episode AND queues its renders — the single most
            expensive button in the app. A viewer's insert would be refused by
            RLS several screens in, after the interview. */}
        <button
          className="ws-btn-purple"
          onClick={() => ws.openModal({ kind: "wizard" })}
          disabled={!project || (role.isShared && !role.canEdit)}
          title={role.isShared && !role.canEdit
            ? "Read-only — ask the project owner for editor access"
            : "Plan an episode end to end"}
          style={!project || (role.isShared && !role.canEdit)
            ? { opacity: 0.45, pointerEvents: "none" } : undefined}
        >
          <Sparkles size={13} /> One-shot
        </button>

        <button
          className={"ws-icobtn" + (ws.chatOpen ? " on" : "")}
          title="Director"
          onClick={() => ws.toggle("chatOpen")}
        >
          <PanelRight size={14} />
        </button>

      </div>
    </header>
  );
}
