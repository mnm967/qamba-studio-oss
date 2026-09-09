// The repair flow, end to end: read a failure, propose, accept, save.
//
// `workflowRepair.ts` is the pure half (faults in, proposals out) and this is
// the half that touches the world — the engine's schema, the hosted route, the
// row. Split for the reason `comfyProgress.ts` is split out of `localRender`:
// the pure half has to be testable under `node --test`, and this file reaches
// Supabase and `/api`, neither of which exists there.
//
// THE ORDER IS THE DESIGN. Arithmetic first, a model only for the residue:
//
//   1. gather faults   — the stored failure, plus what is wrong before running
//   2. propose         — deterministic; ComfyUI's own reply answers most of it
//   3. ask a model     — ONLY for missing classes no pack provides
//   4. accept          — the user's, per proposal
//   5. save            — patched graph + slots back onto the row, status reset
//
// Step 3 is skipped whenever step 2 covered everything, which is the common
// case. A fixer that calls a model on every failure spends money to restate
// what the engine already said, and teaches people to distrust it.
import { localOneShot } from "./director.ts";
import { supabase } from "./supabase";
import { loadWorkflow, patchWorkflow, type CustomWorkflow } from "./db/customWorkflows.ts";
import { getInstalledNodes, getObjectInfo } from "./comfyLocal.ts";
import {
  aiRepairsFromReply, applyRepairs, dedupeFaults, openClassFaults, parseComfyError,
  proposeRepairs, staticFaults, type Repair, type RepairEnv, type WorkflowFault,
} from "./workflowRepair.ts";
import { fixSystem, fixUser, parseFixReply } from "../../director/workflow_fix.js";
import type { ObjectInfo } from "./workflowAdapter.ts";

export interface Diagnosis {
  faults: WorkflowFault[];
  repairs: Repair[];
  /** the engine's schema, carried so an AI substitution can be wiring-checked */
  objectInfo?: ObjectInfo;
  /** true when a model could add something the arithmetic could not */
  aiAvailable: boolean;
  /** class names the target engine has, when one could be asked */
  installed?: Set<string>;
  /** WHICH engine answered. A verdict is about a machine, and saying "runs
   *  here" without naming which one is what let a green tick from the laptop
   *  stand in for the machine that actually renders. */
  engine?: EngineSource;
}

export interface EngineSource {
  kind: "local" | "cloud";
  label: string;
  /** when the cloud published its inventory; empty for a live local engine */
  at?: string;
}

/**
 * Everything wrong with this workflow, and what to do about it.
 *
 * `installed` decides how much can be said, and it is OPTIONAL on purpose: a
 * pod failure is diagnosed from the stored error alone, with no engine to ask.
 * Passing an empty set would be worse than passing none — `staticFaults` reads
 * a non-empty set as "I checked", and an empty one would report every class in
 * the graph as missing. Same rule `compat.ts` states: "not checked" is never
 * "fine", and it is never "broken" either.
 */
export async function diagnose(
  wf: CustomWorkflow,
  opts: { installed?: Set<string>; objectInfo?: ObjectInfo; engine?: EngineSource } = {},
): Promise<Diagnosis> {
  const oi = opts.objectInfo;
  const env: RepairEnv = {
    installed: opts.installed,
    // A reclass has to know what the NEW class requires — see `fillFor`.
    // Without a schema it declines rather than producing a graph that fails
    // on a different error.
    specFor: oi ? (c) => oi[c] : undefined,
  };
  const faults: WorkflowFault[] = dedupeFaults([
    ...parseComfyError(wf.last_error),
    ...staticFaults(wf.api_graph ?? {}, wf.slots ?? {}, opts.installed),
  ]);
  const unique = faults;
  return {
    faults: unique,
    repairs: proposeRepairs(wf.api_graph ?? {}, wf.slots ?? {}, unique, env),
    aiAvailable: openClassFaults(unique).length > 0 && !!opts.installed?.size,
    installed: opts.installed,
    objectInfo: oi,
    engine: opts.engine,
  };
}

/** The local engine's full schema, or undefined when there is no engine to ask.
 *  Both halves come from ONE request — the class list and the per-class inputs
 *  are the same document, and asking twice is a second megabyte for nothing. */
export async function localEngine(): Promise<{ installed: Set<string>; objectInfo: ObjectInfo } | undefined> {
  try {
    const oi = await getObjectInfo();
    const names = Object.keys(oi ?? {});
    // compat.ts's rule: a real engine reports ~850 classes, so a short list is
    // a truncated response or a stub, and believing one would make the fixer
    // report half the graph as missing.
    return names.length >= 50 ? { installed: new Set(names), objectInfo: oi } : undefined;
  } catch {
    return undefined;
  }
}

/** The class list alone, for a caller that needs nothing else. */
export async function localInstalled(): Promise<Set<string> | undefined> {
  try {
    const names = await getInstalledNodes();
    // compat.ts's rule, repeated because the consequence is worse here: a real
    // engine reports ~850 classes, so a short list is a truncated response or a
    // stub — and believing one would make the fixer propose replacing half the
    // graph as missing.
    return names.size >= 50 ? names : undefined;
  } catch {
    return undefined;
  }
}

export interface AiFixResult {
  repairs: Repair[];
  backend?: string;
  cost_usd?: number;
  fellBack?: { from: string; to: string; reason: string }[];
  /** why nothing came back, when nothing did */
  note?: string;
}

/**
 * Ask a model about the classes arithmetic could not place.
 *
 * Returns proposals, never edits. Everything it suggests has already been
 * checked against the installed list on BOTH sides — the route validates and
 * `aiRepairsFromReply` validates again — so the worst a confabulating model
 * achieves is an empty list.
 */
export async function aiFix(
  wf: CustomWorkflow, d: Diagnosis, backend?: string,
): Promise<AiFixResult> {
  const open = openClassFaults(d.faults);
  if (!open.length) return { repairs: [], note: "nothing here needs a model" };
  if (!d.installed?.size) {
    return { repairs: [], note: "no engine to check a substitution against" };
  }
  const graph = wf.api_graph ?? {};
  // THE PROMPT IS THE SHARED ONE (`director/workflow_fix.js`) and the model is
  // whatever this machine can reach — a key of your own, or the Ollama on
  // loopback. The cloud build put a route in front of this so a client could
  // not hand a paid backend a system prompt of its own; with the call made
  // here, on a credential the caller already owns, that concern is gone and
  // the prompt still lives in one place so both halves cannot drift.
  const faults = open.map((f) => ({
    class_type: f.class_type, node: f.node,
    inputs: Object.keys(graph[f.node ?? ""]?.inputs ?? {}),
  }));
  const installed = [...d.installed];
  const out = await localOneShot(
    fixSystem() as string, fixUser(faults, installed) as string, backend);
  if (!out) {
    return {
      repairs: [],
      note: "no model on this machine could be asked — add a provider key, or "
          + "install a local model in the engine window",
    };
  }
  // VALIDATED TWICE, and that is what makes it safe to run the model here at
  // all: `parseFixReply` drops any class the engine does not have, and
  // `aiRepairsFromReply` checks the surviving ones against the WIRING. So the
  // worst a confabulating model achieves is an empty list.
  const parsed = parseFixReply(out.text, d.installed) as { substitutions?: unknown[] };
  const repairs = aiRepairsFromReply(
    JSON.stringify({ substitutions: parsed.substitutions ?? [] }), open,
    // The graph and the schema are what turn the model's claim about MEANING
    // into a check about WIRING — see `substitutionCheck`.
    { installed: d.installed, specFor: d.objectInfo ? (c) => d.objectInfo![c] : undefined },
    graph);
  return {
    repairs,
    backend: out.backend,
    note: repairs.length ? undefined
      // The honest outcome most of the time: most custom nodes have no stock
      // equivalent, and the prompt says an empty list is a good answer.
      : "no honest substitute was found — the pack itself has to be installed",
  };
}

export interface SaveResult {
  workflow: CustomWorkflow;
  applied: string[];
  skipped: { id: string; reason: string }[];
}

/**
 * Write accepted repairs back onto the row.
 *
 * The status goes back to `draft`, never straight to `ready`: a workflow is
 * only ever proven by a render, which is the rule `recordTest` and the worker's
 * `record_success` both follow. Marking a patched graph ready would put a green
 * tick on something nobody has run.
 *
 * `last_error` is CLEARED, because it describes a graph that no longer exists —
 * leaving it would show the old failure beside the fix that addressed it.
 */
export async function saveRepairs(
  wf: CustomWorkflow, repairs: Repair[],
): Promise<SaveResult> {
  const out = applyRepairs(wf.api_graph ?? {}, wf.slots ?? {}, repairs);
  if (!out.applied.length) {
    return { workflow: wf, applied: [], skipped: out.skipped };
  }
  const workflow = await patchWorkflow(wf.id, {
    api_graph: out.graph, slots: out.slots,
    status: "draft", last_error: null,
  });
  return { workflow, applied: out.applied, skipped: out.skipped };
}

/**
 * The engine to judge a graph against: this machine's if it is running, the
 * POD's otherwise.
 *
 * LOCAL FIRST, and the order is a judgement rather than a convenience. A
 * running local engine is live and exact, and on the desktop's local tier it
 * IS the machine that will render. The pod's inventory is a published snapshot
 * — right about the pod and possibly minutes old — but it is the only answer
 * available in the web build, and the only one at all while the pod is
 * stopped, which is precisely when "will this run" is worth asking.
 *
 * Returning null rather than an empty set is the whole contract: "not checked"
 * must never render as "nothing installed".
 */
export async function targetEngine(): Promise<
  { installed: Set<string>; objectInfo: ObjectInfo; engine: EngineSource } | null> {
  const local = await localEngine();
  if (local) {
    return { ...local, engine: { kind: "local", label: "this machine's ComfyUI" } };
  }
  return null;
}

/**
 * Diagnose a workflow by id against whichever engine can be asked.
 *
 * The convenience entry point for a surface that has an id and nothing else.
 */
export async function diagnoseById(id: string): Promise<Diagnosis & { workflow: CustomWorkflow }> {
  const wf = await loadWorkflow(id);
  if (!wf) throw new Error("that workflow is not in the library any more");
  const eng = await targetEngine();
  const d = await diagnose(wf, { installed: eng?.installed, objectInfo: eng?.objectInfo,
                                 engine: eng?.engine });
  return { ...d, workflow: wf };
}

/** Jobs that failed on this workflow, newest first — the pod's side of the story. */
export async function recentFailures(workflowId: string, limit = 5) {
  const { data } = await supabase.from("jobs")
    .select("id,status,error_msg,created_at")
    .eq("status", "error")
    .contains("payload", { workflow_id: workflowId })
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}
