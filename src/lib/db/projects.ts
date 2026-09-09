// Project/episode data access. Every project lives on this machine.
import { mediaUrl } from "../supabase";
import { createLocalProject, deleteLocalProject, localProjects, localStoreFor }
  from "../localPlane.ts";
import { localFrom as localTable } from "../localQuery.ts";
import type { Episode, Medium, Project } from "./types";

/** Where a project's rows live. Only one answer in this build; the type is
 *  kept so the create form's storage field still reads as a choice that was
 *  made rather than a value that was assumed. */
export type ProjectStorage = "local";

export async function loadProjects(): Promise<Project[]> {
  return localProjects() as Project[];
}

export async function loadProject(id: string): Promise<Project | null> {
  const local = localStoreFor(id);
  if (!local) return null;
  return (local.find("projects", id) ?? null) as Project | null;
}

export async function createProject(p: {
  medium: Medium;
  title: string;
  logline?: string;
  genre?: string[];
  style?: string;
  aspect?: string;
  size_id?: string;
  settings?: Record<string, any>;
  storage?: ProjectStorage;
}): Promise<Project> {
  const { storage: _storage, ...fields } = p;
  // The local plane creates the initial episode itself: every child table
  // hangs off an episode, and a project without one is a project where half
  // the app has nowhere to write.
  return (await createLocalProject(fields)) as Project;
}

export async function updateProject(id: string, patch: Partial<Project>): Promise<void> {
  const local = localStoreFor(id);
  if (!local) throw new Error(`project ${id} is not on this machine`);
  local.update("projects", local.rows("projects").filter((r) => r.id === id), patch);
}

export async function deleteProject(id: string): Promise<void> {
  // A local project is a directory: the rows and every byte of media go with
  // it, because nothing else on this machine points at either.
  return deleteLocalProject(id);
}

/**
 * A function that takes a project id decides its own store; everything else
 * follows the open one. That rule matters most right after a project is
 * created — `mainEpisode` runs while the projects LIST is still on screen, so
 * a routed query would find no open project to answer from.
 */
function tableFor(projectId: string): (t: string) => any {
  const local = localStoreFor(projectId);
  if (!local) throw new Error(`project ${projectId} is not on this machine`);
  return (t: string) => localTable(local, t);
}

export async function loadEpisodes(projectId: string): Promise<Episode[]> {
  const { data, error } = await tableFor(projectId)("episodes")
    .select("*")
    .eq("project_id", projectId)
    .order("idx");
  if (error) throw error;
  return (data ?? []) as Episode[];
}

/** Returns the primary episode for a project (MAIN for film/MV, first episode for series).
 *  Auto-heals legacy or 0-episode series by creating the initial episode if none exist. */
export async function mainEpisode(projectId: string): Promise<Episode | null> {
  const eps = await loadEpisodes(projectId);
  if (eps.length > 0) {
    return eps.find((e) => e.code === "MAIN") ?? eps[0] ?? null;
  }
  // Auto-heal empty projects:
  const proj = await loadProject(projectId);
  if (!proj) return null;
  const isSeries = proj.medium === "series";
  const { data: newEp, error } = await tableFor(projectId)("episodes")
    .insert({
      project_id: projectId,
      code: isSeries ? "EP01" : "MAIN",
      title: isSeries ? "Episode 1" : proj.title,
      idx: 0,
      status: "draft",
    })
    .select()
    .single();
  if (error) {
    console.error("Failed to auto-create default episode:", error);
    return null;
  }
  return newEp as Episode;
}

export async function createEpisode(projectId: string, code: string, title: string): Promise<Episode> {
  const { data: existing } = await tableFor(projectId)("episodes")
    .select("idx")
    .eq("project_id", projectId)
    .order("idx", { ascending: false })
    .limit(1);
  const idx = existing?.length ? existing[0].idx + 1 : 0;
  const { data, error } = await tableFor(projectId)("episodes")
    .insert({ project_id: projectId, code, title, idx, status: "draft" })
    .select()
    .single();
  if (error) throw error;
  return data as Episode;
}

/* ═══════════════════════════════════════════════════════ project covers ══ */

/** The face of one project on the home grid. */
export interface ProjectCover {
  /** The take's own last frame, extracted at render time. What the card DRAWS. */
  still: string | null;
  /** The take itself, for hover. Never fetched until something plays it. */
  video: string | null;
}

/**
 * THE COVER IS A STILL, AND THE STILL ALREADY EXISTS.
 *
 * `handle_master_pass` extracts every take's last frame, registers it
 * (`kind: "frame"`, tag `chain`) and records it on the take as
 * `meta.last_frame_asset_id` — it is the chain anchor the next block opens on.
 * A `<video>` that never plays paints NOTHING however much of it the browser
 * has, so the card draws the still and keeps the take for hover.
 *
 * Still the NEWEST take rather than the ACTIVE one, deliberately: `state` lives
 * on `block_takes`, not on the asset, so "canonical" costs a join — and a cover
 * that moves the moment a render lands is the behaviour this screen had.
 *
 * A cover is decoration, so a failure here returns no cover rather than taking
 * the grid down with it.
 */
export async function loadProjectCovers(projectIds: string[]): Promise<Map<string, ProjectCover>> {
  type Take = { project_id: string; b2_key: string; meta: Record<string, unknown> | null };

  const takes = await Promise.all(projectIds.map(async (pid): Promise<Take | null> => {
    try {
      // Covers are a browse, and the most visible one in the app — a binned or
      // hidden take must not end up as the face of a project on the home grid.
      const { data } = await tableFor(pid)("assets")
        .select("project_id,b2_key,meta")
        .eq("project_id", pid)
        .eq("kind", "video")
        .contains("tags", ["block-take"])
        .is("deleted_at", null)
        .is("hidden", false)
        .order("created_at", { ascending: false })
        .limit(1);
      return ((data ?? [])[0] ?? null) as Take | null;
    } catch { return null; }
  }));

  const frameId = (t: Take | null) => {
    const id = t?.meta?.["last_frame_asset_id"];
    return typeof id === "string" ? id : null;
  };
  const stills = new Map<string, string>();
  await Promise.all(takes.map(async (t) => {
    const id = frameId(t);
    if (!t || !id) return;
    try {
      const { data } = await tableFor(t.project_id)("assets")
        .select("id,b2_key").eq("id", id).is("deleted_at", null).limit(1);
      const f = ((data ?? [])[0] ?? null) as { b2_key: string } | null;
      if (f) stills.set(id, f.b2_key);
    } catch { /* the take's own video still covers the card */ }
  }));

  const out = new Map<string, ProjectCover>();
  for (const t of takes) {
    if (!t) continue;
    const id = frameId(t);
    const stillKey = id ? stills.get(id) ?? null : null;
    out.set(t.project_id, {
      still: stillKey ? mediaUrl(stillKey) : null,
      video: mediaUrl(t.b2_key),
    });
  }
  return out;
}
