// Imported ComfyUI graphs. See supabase/migrations/20260816090000_custom_workflows.sql
// for why the graph is stored in both formats and why `slots` is a column.
import { supabase } from "../supabase";
import { comfySourceUrl } from "../comfyImport";

// Re-exported so a caller reaching for the db layer finds them where it
// expects; they live in a pure module so they can be tested.
export { comfyImportName, comfySourceUrl } from "../comfyImport";
import {
  detectSlots, requiredClasses, requiredFiles, toApiGraph,
  type ApiGraph, type ObjectInfo, type SlotMap, type UiGraph,
} from "../workflowAdapter";

export interface WorkflowRequirements {
  classes: string[];
  files: { input: string; value: string; class_type: string }[];
}

export interface CustomWorkflow {
  id: string;
  owner_id: string | null;
  project_id: string | null;
  name: string;
  base_model: string | null;
  source: "import" | "civitai" | "comfyui" | "paste" | "file";
  source_url: string | null;
  civitai_model_id: number | null;
  civitai_version_id: number | null;
  ui_graph: UiGraph | null;
  api_graph: ApiGraph;
  slots: SlotMap;
  requirements: WorkflowRequirements;
  status: "draft" | "ready" | "error";
  last_error: Record<string, unknown> | null;
  last_tested_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Owner's workflows plus any shared project's. `project_id is null` is the
 *  account-wide shelf, and it must appear whichever project is open — RLS
 *  already decides what is visible, so this filter is about relevance, not
 *  access. */
export async function loadWorkflows(projectId?: string | null): Promise<CustomWorkflow[]> {
  let q = supabase.from("custom_workflows").select("*")
    .order("updated_at", { ascending: false });
  if (projectId) q = q.or(`project_id.eq.${projectId},project_id.is.null`);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as CustomWorkflow[];
}

/** `from` is the plane. Everything on a screen leaves it alone and gets the
 *  open project's; the desktop worker passes the plane of the job it is
 *  running, which is not necessarily the one on screen (see jobIO.ts). */
export async function loadWorkflow(
  id: string, from: (t: string) => any = (t) => supabase.from(t),
): Promise<CustomWorkflow | null> {
  const { data, error } = await from("custom_workflows").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data ?? null) as CustomWorkflow | null;
}

export interface ImportInput {
  name: string;
  /** either format; whichever it is, both columns are filled from it */
  graph: unknown;
  projectId?: string | null;
  baseModel?: string | null;
  source?: CustomWorkflow["source"];
  sourceUrl?: string | null;
  civitaiModelId?: number | null;
  civitaiVersionId?: number | null;
  /** the target engine's schema, when one was reachable — it makes the
   *  conversion exact instead of table-driven */
  objectInfo?: ObjectInfo;
  /** UPDATE this row instead of inserting. The round trip from ComfyUI needs
   *  it: saving the same workflow twice is the normal way to work, and two
   *  clicks should not leave two rows with the same name and different ages. */
  replaceId?: string | null;
}

export interface ImportResult {
  row: CustomWorkflow;
  /** what conversion lost or could not map, for the screen to show */
  warnings: { level: string; message: string; node?: string; class_type?: string }[];
  unmapped: string[];
}

/**
 * Convert, tag and store in one step.
 *
 * `status` starts at 'draft' whatever happens here. A graph is only 'ready'
 * once something has RUN it — a clean conversion means the document is
 * well-formed, not that the pod has the nodes or that the render works, and
 * conflating the two would put a green light on a workflow whose first render
 * fails.
 */
export async function importWorkflow(input: ImportInput): Promise<ImportResult> {
  const conv = toApiGraph(input.graph, input.objectInfo);
  if (!Object.keys(conv.api).length) {
    throw new Error(conv.warnings[0]?.message ?? "the file is not a ComfyUI graph");
  }
  const slots = detectSlots(conv.api);
  const requirements: WorkflowRequirements = {
    classes: requiredClasses(conv.api),
    files: requiredFiles(conv.api),
  };

  const row = {
    name: input.name.trim() || "Untitled workflow",
    project_id: input.projectId ?? null,
    base_model: input.baseModel ?? null,
    source: input.source ?? "import",
    source_url: input.sourceUrl ?? null,
    civitai_model_id: input.civitaiModelId ?? null,
    civitai_version_id: input.civitaiVersionId ?? null,
    // Only a genuine UI export is kept — storing the API graph in both columns
    // would make "Open in ComfyUI" reopen a graph with no layout while
    // claiming it is the original.
    ui_graph: (input.graph as UiGraph)?.nodes ? (input.graph as UiGraph) : null,
    api_graph: conv.api,
    slots,
    requirements,
    status: "draft" as const,
  };

  // A re-import of the same Civitai version updates in place (the partial
  // unique index), so importing twice does not litter the library.
  const { data, error } = input.replaceId
    // …and a named replacement keeps the row's OWN id, because a re-import is
    // the same workflow: anything pointing at it (a composer pick, a queued
    // job's `workflow_id`) has to keep resolving. Status goes back to draft
    // with it — the graph changed, so whatever ran last proves nothing about
    // this one.
    ? await supabase.from("custom_workflows")
        .update({ ...row, last_error: null }).eq("id", input.replaceId).select().single()
    : input.civitaiVersionId
    ? await supabase.from("custom_workflows")
        .upsert(row, { onConflict: "owner_id,civitai_version_id" }).select().single()
    : await supabase.from("custom_workflows").insert(row).select().single();
  if (error) throw error;

  return { row: data as CustomWorkflow, warnings: conv.warnings, unmapped: conv.unmapped };
}

/** Re-tag an existing graph, keeping any slot a human has corrected.
 *  The stored map wins: a correction is the truth about this graph, and a
 *  smarter detector shipping later must not silently overwrite it. */
export async function retagWorkflow(w: CustomWorkflow): Promise<CustomWorkflow> {
  const fresh = detectSlots(w.api_graph);
  const merged = { ...fresh, ...w.slots };
  return patchWorkflow(w.id, { slots: merged });
}

export async function patchWorkflow(
  id: string, patch: Partial<Pick<CustomWorkflow,
    "name" | "base_model" | "slots" | "status" | "last_error" | "api_graph" | "ui_graph"
    | "project_id" | "requirements" | "last_tested_at">>,
  from: (t: string) => any = (t) => supabase.from(t),
): Promise<CustomWorkflow> {
  const { data, error } = await from("custom_workflows")
    .update(patch).eq("id", id).select().single();
  if (error) throw error;
  return data as CustomWorkflow;
}

export async function deleteWorkflow(id: string): Promise<void> {
  const { error } = await supabase.from("custom_workflows").delete().eq("id", id);
  if (error) throw error;
}

/** Record the outcome of a test render. Clearing `last_error` on success is
 *  the half that is easy to forget, and a stale error next to a working
 *  workflow is worse than no status at all. */
export async function recordTest(
  id: string, ok: boolean, error?: { message: string; node?: string; class_type?: string },
  from: (t: string) => any = (t) => supabase.from(t),
): Promise<CustomWorkflow> {
  return patchWorkflow(id, {
    status: ok ? "ready" : "error",
    last_error: ok ? null : { ...error, at: new Date().toISOString() },
    last_tested_at: new Date().toISOString(),
  }, from);
}

/** The row a previous import of this ComfyUI file created, if there is one. */
export async function findComfyImport(file: string): Promise<CustomWorkflow | null> {
  const { data, error } = await supabase.from("custom_workflows").select("*")
    .eq("source", "comfyui").eq("source_url", comfySourceUrl(file))
    .order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return (data ?? null) as CustomWorkflow | null;
}
