// Reading a failed workflow and proposing what to change.
//
// WHY THIS IS NOT IN compat.ts. That module answers "will this run here" and
// its own header says the split out loud: which classes and files are missing
// is EXACT, how big they are is ESTIMATED, and "choosing a substitute node,
// repairing the graph" is deliberately absent. This is that absent part, kept
// in its own file so the arithmetic stays arithmetic.
//
// MOST OF A REPAIR IS NOT AI, and getting that boundary wrong is how a fixer
// becomes untrustworthy. ComfyUI's validation errors are richly structured —
// measured against a live engine (2026-08-20), a `value_not_in_list` carries
// `extra_info.input_config[0]`, which is THE FULL LIST OF LEGAL VALUES the
// engine will accept for that input. So "this graph names a checkpoint you do
// not have" is answered by matching one string against a list the engine
// itself handed back: exact, offline, free, and reproducible. Handing that to
// a model would be slower, cost money, and — the real objection — produce a
// filename that may not exist, which is the one failure mode a repair must
// never have.
//
// So the split here is:
//   DETERMINISTIC  a named file that is not installed, a preview-only output,
//                  a required input with a known default, a pack to install.
//   AI             only what is left: substituting an unavailable node class,
//                  and deciding which node is the prompt when nothing is
//                  tagged. `aiRepairRequest()` builds that ask; it is a
//                  separate step and its results arrive as ordinary proposals
//                  that still have to survive `applyRepairs`.
//
// NOTHING HERE EDITS ANYTHING. Every function is pure: faults in, proposals
// out, and `applyRepairs` returns a NEW graph. What to accept is the user's,
// which is why each proposal carries a confidence and a human sentence rather
// than being applied on sight.
import type { ApiGraph, NodeSpec, SlotMap } from "./workflowAdapter.ts";
import { packFor } from "./compat.ts";
// Shared with `api/director/fix-workflow.js` — the route builds its OWN prompt
// from these, so a client can never post a system string to a paid backend,
// and the browser can still show exactly what will be sent.
import { fixSystem, fixUser, parseFixReply } from "../../director/workflow_fix.js";

/* ── what went wrong ────────────────────────────────────────────────────── */

export type FaultKind =
  | "missing_file"        // value_not_in_list — the engine gave us the legal list
  | "missing_class"       // missing_node_type — a pack is not installed
  | "missing_input"       // required_input_missing
  | "dead_wire"           // a link pointing at a node that is not in the graph
  | "preview_only"        // it renders and saves nothing
  | "no_prompt_slot"      // nothing tagged, so the author's own prompt renders
  | "unknown";

export interface WorkflowFault {
  kind: FaultKind;
  /** the node the engine blamed, when it named one */
  node?: string;
  class_type?: string;
  /** the input on that node */
  input?: string;
  /** what the graph asked for */
  got?: string;
  /** what the engine says it WILL accept — the whole point of `missing_file` */
  options?: string[];
  message: string;
}

/* ── parsing ComfyUI's refusal ──────────────────────────────────────────── */

interface ComfyNodeError {
  class_type?: string;
  errors?: {
    type?: string; message?: string; details?: string;
    extra_info?: { input_name?: string; received_value?: unknown; input_config?: unknown };
  }[];
}

/**
 * ComfyUI's 400 body, in every shape it reaches us in.
 *
 * Three, and the third is why this takes `unknown`: the engine returns an
 * object, `localRender` throws its `message` as a STRING, and the worker
 * stores `last_error.message` as `"ComfyUI rejected graph: {…}"` — our own
 * prefix in front of the JSON. A parser that only took the object would work
 * in a unit test and find nothing on any real row.
 */
export function parseComfyError(raw: unknown): WorkflowFault[] {
  let body: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    const at = raw.indexOf("{");
    if (at >= 0) { try { body = JSON.parse(raw.slice(at)); } catch { /* not json */ } }
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    // a stored `last_error` row wraps the text one level down
    body = typeof o.message === "string" ? parseObj(o.message) ?? o : o;
  }
  if (!body) {
    // `JSON.stringify(null)` is the STRING "null" and `?? ""` stringifies to
    // '""' — both truthy, so a nullish error would report a fault that is not
    // one. Nothing in means nothing out.
    const text = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw);
    return text.trim() ? [{ kind: "unknown", message: text.slice(0, 400) }] : [];
  }

  const out: WorkflowFault[] = [];
  const err = body.error as Record<string, unknown> | undefined;
  if (err?.type === "missing_node_type") {
    const x = (err.extra_info ?? {}) as Record<string, string>;
    out.push({ kind: "missing_class", node: x.node_id, class_type: x.class_type,
               message: String(err.message ?? "a node class is not installed") });
  }
  for (const [node, ne] of Object.entries((body.node_errors ?? {}) as Record<string, ComfyNodeError>)) {
    for (const e of ne.errors ?? []) {
      const xi = e.extra_info ?? {};
      const base = { node, class_type: ne.class_type, input: xi.input_name,
                     message: `${e.message ?? "error"}${e.details ? `: ${e.details}` : ""}` };
      if (e.type === "value_not_in_list") {
        // input_config is [ [ …legal values… ], {…} ] — the list is what makes
        // this repairable without a model.
        const cfg = xi.input_config as unknown[] | undefined;
        const opts = Array.isArray(cfg?.[0]) ? (cfg![0] as unknown[]).map(String) : undefined;
        out.push({ ...base, kind: "missing_file", got: xi.received_value == null
          ? undefined : String(xi.received_value), options: opts });
      } else if (e.type === "required_input_missing") {
        out.push({ ...base, kind: "missing_input" });
      } else if (e.type === "exception_during_inner_validation") {
        out.push({ ...base, kind: "dead_wire" });
      } else {
        out.push({ ...base, kind: "unknown" });
      }
    }
  }
  if (!out.length && err?.message) out.push({ kind: "unknown", message: String(err.message) });
  return out;
}

function parseObj(s: string): Record<string, unknown> | null {
  const at = s.indexOf("{");
  if (at < 0) return null;
  try { return JSON.parse(s.slice(at)); } catch { return null; }
}

/**
 * Faults a graph has before anything is submitted.
 *
 * The import report already says these; repeating them here is what lets the
 * fixer be offered on a graph that has NEVER run, which is the common case —
 * an import lands as a draft and the first thing anyone wants is "make it
 * runnable", not "run it and see".
 */
export function staticFaults(graph: ApiGraph, slots: SlotMap, installed?: Set<string>): WorkflowFault[] {
  const out: WorkflowFault[] = [];
  if (installed?.size) {
    const seen = new Set<string>();
    for (const [id, n] of Object.entries(graph)) {
      if (!n?.class_type || seen.has(n.class_type) || installed.has(n.class_type)) continue;
      seen.add(n.class_type);
      out.push({ kind: "missing_class", node: id, class_type: n.class_type,
                 message: `${n.class_type} is not installed on this engine` });
    }
  }
  if (!slots.output?.length) {
    const prev = Object.entries(graph).filter(([, n]) => PREVIEW.has(n.class_type));
    for (const [id, n] of prev) {
      out.push({ kind: "preview_only", node: id, class_type: n.class_type,
                 message: `#${id} ${n.class_type} only previews — nothing is saved` });
    }
  }
  if (!slots.prompt) {
    out.push({ kind: "no_prompt_slot",
               message: "no prompt input is tagged, so the workflow's own prompt renders" });
  }
  return out;
}

const PREVIEW = new Set(["PreviewImage", "PreviewAny", "SaveImageWebsocket"]);
/** What a preview node becomes. Keyed by what it previews. */
const PREVIEW_SAVE: Record<string, string> = {
  PreviewImage: "SaveImage", PreviewAny: "SaveImage", SaveImageWebsocket: "SaveImage",
};

/* ── matching a filename against what is installed ──────────────────────── */

/**
 * How well a wanted filename matches an installed one, 0..1.
 *
 * THE HARD CASE IS THE DIRECTORY PREFIX, not the spelling. ComfyUI reports
 * installed files as the engine sees them — `SDXL/sd_xl_base_1.0.safetensors`,
 * `Krea2/krea2_turbo_fp8_scaled.safetensors` — while a downloaded graph names
 * the bare file, or names it under whatever folder its author used. So the
 * basename is compared, not the path, and a match on it is worth far more than
 * shared words.
 *
 * Scoring is deliberately blunt and explainable: an exact basename is 1, and
 * anything else is token overlap, which degrades sensibly (`wan2.2_5b_fp16`
 * against `Wan2.2-TI2V-5B-Q6_K` shares wan2.2 and 5b). It is NOT fuzzy string
 * distance: edit distance rates `flux1-dev` and `flux1-schnell` as near
 * neighbours, and they are different models.
 */
export function fileScore(want: string, have: string): number {
  const bn = (s: string) => s.split(/[\\/]/).pop()!.toLowerCase();
  const a = bn(want), b = bn(have);
  if (a === b) return 1;
  const stem = (s: string) => s.replace(/\.[a-z0-9]+$/i, "");
  if (stem(a) === stem(b)) return 0.97;               // same file, different extension
  const toks = (s: string) => new Set(stem(s).split(/[^a-z0-9.]+/i).filter((t) => t.length > 1));
  const ta = toks(a), tb = toks(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  // Jaccard rather than "fraction of what we wanted": a one-token name would
  // otherwise score 1.0 against every file containing that token.
  return hit / (ta.size + tb.size - hit);
}

/** The best installed file for a wanted one, when it is good enough to offer. */
export function bestFile(want: string, options: string[]): { name: string; score: number } | null {
  let best: { name: string; score: number } | null = null;
  for (const o of options) {
    const score = fileScore(want, o);
    if (!best || score > best.score) best = { name: o, score };
  }
  // Below this two unrelated checkpoints still share "safetensors"-ish tokens,
  // and a confident swap to the wrong model is worse than saying "pick one".
  return best && best.score >= 0.34 ? best : null;
}

/* ── proposals ──────────────────────────────────────────────────────────── */

export type Confidence = "exact" | "likely" | "guess";

export interface RepairPatch {
  /** write a literal into a node's input */
  set?: { node: string; input: string; value: unknown };
  /** change a node's class, keeping its inputs — and adding any the new class
   *  requires that the old one did not have (see `fillFor`). */
  reclass?: { node: string; class_type: string; set?: Record<string, unknown> };
  /** tag a slot on the workflow row rather than editing the graph */
  slot?: { key: "prompt" | "negative" | "seed"; node: string; input: string; class_type: string };
}

export interface Repair {
  id: string;
  kind: FaultKind;
  confidence: Confidence;
  /** one line, imperative — what accepting this does */
  title: string;
  /** why, including the evidence it came from */
  detail: string;
  /** null when there is nothing to change in the graph (install a pack, etc.) */
  patch: RepairPatch | null;
  /** set when the fix is an action outside the graph */
  action?: { install?: { name: string; url: string }; manual?: string };
  /** true when a model wrote this rather than arithmetic */
  ai?: boolean;
}

export interface RepairEnv {
  /** class names the target engine has, from /object_info */
  installed?: Set<string>;
  /** the engine's schema for a class, when it can be asked. Without it a
   *  reclass cannot know what the NEW class requires, and this module will not
   *  guess — see `fillFor`. */
  specFor?: (class_type: string) => NodeSpec | undefined;
  /** legal values per class+input, when the engine's schema is available.
   *  Used only where the FAULT did not carry its own list. */
  optionsFor?: (class_type: string, input: string) => string[] | undefined;
}

/**
 * What a node must gain to become `class_type`, and whether it safely can.
 *
 * A RECLASS IS NOT JUST A NAME, and assuming it was is a bug this module
 * shipped with: swapping `PreviewImage` for `SaveImage` took a graph the
 * engine ACCEPTED (200) and made it fail validation (400), because SaveImage
 * requires `filename_prefix` and PreviewImage has no such input. Measured
 * against a live engine — a unit test on hand-written fixtures would never
 * have found it, because the fixture would have had whatever the author of
 * the fixture expected.
 *
 * So the new class's required inputs are read from the engine's own schema:
 *   · a WIDGET the node lacks is filled from the schema's default;
 *   · a WIRE input the node lacks cannot be filled from anywhere, so the
 *     reclass is refused rather than producing a graph that fails differently.
 * With no schema to consult it returns `null` — "we could not check" is not
 * "it is fine", the rule compat.ts already states.
 */
export function fillFor(
  node: { class_type: string; inputs: Record<string, unknown> },
  class_type: string,
  spec?: NodeSpec,
): { set: Record<string, unknown>; blocked: string[] } | null {
  if (!spec?.input?.required) return null;
  const set: Record<string, unknown> = {};
  const blocked: string[] = [];
  for (const [name, cfg] of Object.entries(spec.input.required)) {
    if (name in node.inputs) continue;
    const d = widgetDefault(cfg as unknown[]);
    if (d === undefined) blocked.push(name);
    else set[name] = d;
  }
  return { set, blocked };
}

/** The value a widget input takes when nobody supplies one. Wire inputs (IMAGE,
 *  LATENT, MODEL…) have no default and come back undefined, which is what makes
 *  `blocked` above meaningful. */
function widgetDefault(cfg: unknown[]): unknown {
  const [type, opts] = cfg ?? [];
  // A COMBO arrives as the list of legal values itself.
  if (Array.isArray(type)) return type[0];
  const o = (opts ?? {}) as Record<string, unknown>;
  if ("default" in o) return o.default;
  if (type === "STRING") return "";
  if (type === "INT" || type === "FLOAT") return 0;
  if (type === "BOOLEAN") return false;
  return undefined;                                   // a wire, or an unknown type
}

/**
 * The same fault reported twice is one problem, not two.
 *
 * A missing class is named by BOTH the engine's stored refusal and the static
 * check against /object_info, and offering the same install twice reads as a
 * worse-broken workflow than it is. Pure and exported so every caller dedupes
 * identically.
 */
export function dedupeFaults(faults: WorkflowFault[]): WorkflowFault[] {
  const seen = new Set<string>();
  return faults.filter((f) => {
    const k = `${f.kind}:${f.node ?? ""}:${f.class_type ?? ""}:${f.input ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * What can be done about these faults, most confident first.
 *
 * A proposal is an OFFER, never an edit — see the header. Ordering matters
 * because the list is meant to be read top-down and accepted in order: an
 * exact swap that the engine itself supplied the answer for should never sit
 * below a guess.
 */
export function proposeRepairs(
  graph: ApiGraph, slots: SlotMap, faults: WorkflowFault[], env: RepairEnv = {},
): Repair[] {
  const out: Repair[] = [];
  let n = 0;
  const id = (k: string) => `${k}-${++n}`;

  for (const f of faults) {
    if (f.kind === "missing_file") {
      const options = f.options?.length ? f.options
        : (f.class_type && f.input ? env.optionsFor?.(f.class_type, f.input) : undefined);
      const want = f.got ?? String(graph[f.node ?? ""]?.inputs?.[f.input ?? ""] ?? "");
      const hit = options?.length && want ? bestFile(want, options) : null;
      if (hit && f.node && f.input) {
        out.push({
          id: id("file"), kind: f.kind,
          // The engine handed back the list, so this is arithmetic on its own
          // answer — but an inexact basename is still a judgement about which
          // model the author meant, and it is labelled as one.
          confidence: hit.score >= 0.97 ? "exact" : hit.score >= 0.6 ? "likely" : "guess",
          title: `Use ${hit.name} for ${f.input}`,
          detail: `#${f.node} ${f.class_type ?? ""} asks for "${want}", which is not installed. `
            + `The engine offers ${options!.length} file(s) for this input; ${hit.name} is the `
            + `closest (${Math.round(hit.score * 100)}% match).`,
          patch: { set: { node: f.node, input: f.input, value: hit.name } },
        });
      } else {
        out.push({
          id: id("file"), kind: f.kind, confidence: "guess",
          title: `Install or choose a file for ${f.input ?? "this input"}`,
          detail: `#${f.node ?? "?"} asks for "${want || "a file"}" and nothing installed `
            + `resembles it${options?.length ? ` (${options.length} option(s) available)` : ""}. `
            + "Download the weights the author names, or pick a substitute by hand.",
          patch: null,
          action: { manual: want || undefined },
        });
      }
    } else if (f.kind === "missing_class") {
      const pack = f.class_type ? packFor(f.class_type) : undefined;
      // A UUID class is a SUBGRAPH, not a pack — telling someone to install it
      // sends them looking for a repository that does not exist.
      const subgraph = !!f.class_type && UUID.test(f.class_type);
      out.push({
        id: id("class"), kind: f.kind, confidence: subgraph || pack ? "exact" : "guess",
        title: subgraph ? "Re-export this workflow with its subgraphs expanded"
          : pack ? `Install ${pack.name}` : `Find the pack that provides ${f.class_type}`,
        detail: subgraph
          ? `#${f.node ?? "?"} is a subgraph, not a node class — its id is a UUID. ComfyUI `
            + "cannot resolve one from an API graph, so open the workflow in ComfyUI, use "
            + "Convert to Nodes, and re-import."
          : pack ? `#${f.node ?? "?"} needs ${f.class_type}, which ${pack.name} provides.`
          : `#${f.node ?? "?"} needs ${f.class_type} and no known pack provides it. The `
            + "author's description on the model page is usually where this is named.",
        patch: null,
        action: subgraph ? { manual: "Convert to Nodes in ComfyUI, then re-import" }
          : pack ? { install: pack } : undefined,
      });
    } else if (f.kind === "preview_only" && f.node) {
      const save = PREVIEW_SAVE[f.class_type ?? ""] ?? "SaveImage";
      const have = !env.installed?.size || env.installed.has(save);
      const fill = fillFor(graph[f.node], save, env.specFor?.(save));
      // `blocked` means the saver needs a WIRE this node does not have — the
      // swap would trade a graph that runs and saves nothing for one that does
      // not run at all. Say what is missing instead of doing that.
      if (!have || (fill && fill.blocked.length)) {
        out.push({
          id: id("save"), kind: f.kind, confidence: "guess",
          title: `Replace #${f.node} with a save node`,
          detail: !have
            ? `${save} is not installed on this engine.`
            : `${f.class_type} writes nothing, and ${save} cannot simply take its place: it `
              + `also needs ${fill!.blocked.join(", ")}, which #${f.node} has no wire for. `
              + "Add the right save node for this output in ComfyUI.",
          patch: null,
        });
      } else {
        out.push({
          id: id("save"), kind: f.kind,
          // Exact only when the schema was actually consulted. With none, the
          // swap is plausible and unverified — which is what "guess" means.
          confidence: fill ? "exact" : "guess",
          title: `Turn #${f.node} into a ${save}`,
          detail: `${f.class_type} displays a result without writing one, so the job would `
            + `finish with no asset. ${save} takes the same images input`
            + (fill && Object.keys(fill.set).length
              ? `, and the ${Object.keys(fill.set).join(", ")} it also requires is filled from `
                + "the engine's own default."
              : ", so the swap is the class name and nothing else."),
          patch: { reclass: { node: f.node, class_type: save,
                              ...(fill && Object.keys(fill.set).length ? { set: fill.set } : {}) } },
        });
      }
    } else if (f.kind === "missing_input" && f.node && f.input) {
      out.push({
        id: id("input"), kind: f.kind, confidence: "guess",
        title: `Give #${f.node} a value for ${f.input}`,
        detail: `${f.class_type ?? "the node"} requires ${f.input} and the graph supplies `
          + "neither a value nor a wire. This is usually a wire that did not survive "
          + "conversion — check the node in ComfyUI.",
        patch: null,
      });
    } else if (f.kind === "no_prompt_slot") {
      // The one place a heuristic is worth it: the prompt is nearly always a
      // text encoder, and a graph with exactly one candidate needs no model.
      const cands = Object.entries(graph).filter(([, node]) =>
        /CLIPTextEncode|TextEncode|CLIPTextEncodeSDXL/i.test(node.class_type)
        && typeof node.inputs?.text === "string");
      if (cands.length === 1) {
        const [node, spec] = cands[0];
        out.push({
          id: id("slot"), kind: f.kind, confidence: "likely",
          title: `Tag #${node} ${spec.class_type} as the prompt`,
          detail: "It is the only text encoder in this graph carrying a literal string, so "
            + "it is what the author typed the prompt into.",
          patch: { slot: { key: "prompt", node, input: "text", class_type: spec.class_type } },
        });
      } else {
        out.push({
          id: id("slot"), kind: f.kind, confidence: "guess",
          title: "Tag the node that takes the prompt",
          detail: cands.length
            ? `${cands.length} text encoders carry a literal string, so which one is the `
              + "positive prompt is a judgement — the negative one is usually the shorter."
            : "No text encoder in this graph carries a literal string, so the prompt may "
              + "arrive through a node this studio does not recognise.",
          patch: null,
        });
      }
    } else if (f.kind === "dead_wire") {
      out.push({
        id: id("wire"), kind: f.kind, confidence: "guess",
        title: `#${f.node ?? "?"}.${f.input ?? "an input"} points at a node that is gone`,
        detail: `${f.message}. A wire lost in conversion cannot be reconnected from here — `
          + "the node it came from is not in the graph to reconnect to.",
        patch: null,
      });
    } else {
      out.push({ id: id("other"), kind: "unknown", confidence: "guess",
                 title: "Unrecognised failure", detail: f.message, patch: null });
    }
  }

  const rank: Record<Confidence, number> = { exact: 0, likely: 1, guess: 2 };
  return out.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── applying them ──────────────────────────────────────────────────────── */

export interface RepairResult {
  graph: ApiGraph;
  slots: SlotMap;
  /** ids of the repairs that changed something */
  applied: string[];
  /** ids that could not be applied, with why — never silently skipped */
  skipped: { id: string; reason: string }[];
}

/**
 * Apply chosen repairs to a copy.
 *
 * NEVER MUTATES, for the reason `resolve_custom` does not either: the stored
 * row is the graph every later render starts from, and an in-place edit would
 * make one accepted proposal permanent before anyone pressed save.
 *
 * A repair that cannot land is REPORTED, not dropped. A fixer that says "3
 * fixes applied" having applied two is worse than one that fixes nothing,
 * because the render then fails for a reason the user believes was handled.
 */
export function applyRepairs(graph: ApiGraph, slots: SlotMap, repairs: Repair[]): RepairResult {
  const g: ApiGraph = JSON.parse(JSON.stringify(graph));
  const s: SlotMap = JSON.parse(JSON.stringify(slots ?? {}));
  const applied: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const r of repairs) {
    const p = r.patch;
    if (!p) { skipped.push({ id: r.id, reason: "nothing to change in the graph" }); continue; }
    if (p.set) {
      const n = g[p.set.node];
      if (!n) { skipped.push({ id: r.id, reason: `#${p.set.node} is not in the graph` }); continue; }
      n.inputs[p.set.input] = p.set.value;
      applied.push(r.id);
    } else if (p.reclass) {
      const n = g[p.reclass.node];
      if (!n) { skipped.push({ id: r.id, reason: `#${p.reclass.node} is not in the graph` }); continue; }
      n.class_type = p.reclass.class_type;
      // The inputs the new class requires and the old one did not have. Without
      // this a reclass produces a graph that fails validation on a DIFFERENT
      // error, which reads as the fixer having made things worse.
      for (const [k, v] of Object.entries(p.reclass.set ?? {})) {
        if (!(k in n.inputs)) n.inputs[k] = v;
      }
      applied.push(r.id);
    } else if (p.slot) {
      if (!g[p.slot.node]) { skipped.push({ id: r.id, reason: `#${p.slot.node} is not in the graph` }); continue; }
      (s as Record<string, unknown>)[p.slot.key] =
        { node: p.slot.node, input: p.slot.input, class_type: p.slot.class_type };
      applied.push(r.id);
    } else {
      skipped.push({ id: r.id, reason: "the patch names no change" });
    }
  }
  return { graph: g, slots: s, applied, skipped };
}

/* ── the AI half ────────────────────────────────────────────────────────── */

export interface AiRepairAsk {
  /** what to send; the caller owns the transport (hosted route or llm_task) */
  system: string;
  user: string;
  /** the faults this ask covers, so a reply can be checked against them */
  faults: WorkflowFault[];
}

/**
 * The ask for what arithmetic could not answer.
 *
 * Only faults with NO deterministic proposal reach here — substituting an
 * unavailable node class for an installed equivalent, mainly, which needs
 * knowledge of what the packs do rather than a list the engine handed back.
 * Returns null when there is nothing worth spending a call on, so a caller can
 * treat "no AI needed" as the normal case rather than an error.
 *
 * The reply is constrained to a substitution among INSTALLED classes and
 * nothing else. A model asked to rewrite a graph will happily invent nodes,
 * and an invented class fails exactly like the missing one it replaced — with
 * the difference that the user was told it had been fixed.
 */
export function aiRepairRequest(
  graph: ApiGraph, faults: WorkflowFault[], env: RepairEnv = {},
): AiRepairAsk | null {
  const open = openClassFaults(faults);
  if (!open.length) return null;
  return {
    faults: open,
    system: fixSystem(),
    user: fixUser(
      open.map((f) => ({ class_type: f.class_type, node: f.node,
                         inputs: Object.keys(graph[f.node ?? ""]?.inputs ?? {}) })),
      env.installed?.size ? [...env.installed] : []),
  };
}

/**
 * The faults worth spending a call on.
 *
 * Exported because the ROUTE needs the same filter — a caller that posted every
 * fault would pay for asks about files the engine already answered and about
 * subgraphs no pack provides.
 */
export function openClassFaults(faults: WorkflowFault[]): WorkflowFault[] {
  return faults.filter((f) => f.kind === "missing_class"
    && f.class_type && !UUID.test(f.class_type) && !packFor(f.class_type));
}

/**
 * Whether one class can actually stand in for another, HERE, in this graph.
 *
 * A MODEL'S "EQUIVALENT" IS A CLAIM ABOUT MEANING; this is the arithmetic that
 * checks it against the wiring. Found by running the real thing: a live model
 * offered `JoinStringMulti` -> `StringConcatenate`, which is a fair reading of
 * what both nodes DO — and a bare class swap still breaks it, because the old
 * node carries `string_1`/`string_2` and the new one requires
 * `string_a`/`string_b`. It also offered `GetImageSize+` -> `GetImageSize`,
 * which IS safe, and nothing about the two suggestions looked different.
 *
 * Three things are checked, all exact:
 *   · outputs — the graph consumes output index N from this node; the
 *     replacement must have one. Fewer outputs is a silently rewired graph.
 *   · required WIRE inputs — a link cannot be conjured, so a replacement
 *     needing one this node has not got cannot be dropped in.
 *   · required WIDGET inputs — those CAN be supplied, from the schema's own
 *     defaults, so they are returned to be written rather than refused.
 * `stale` is reported but not fatal: an input the new class does not declare
 * is ignored by ComfyUI, and saying so is more useful than refusing.
 */
export function substitutionCheck(
  graph: ApiGraph, node: string, class_type: string, spec?: NodeSpec,
): { ok: boolean; set: Record<string, unknown>; blocked: string[]; stale: string[];
     lostLinks: string[]; outputsNeeded: number; outputsHave: number } | null {
  const n = graph[node];
  if (!n || !spec?.input?.required) return null;
  const required = spec.input.required;

  // the highest output index anything in the graph takes from this node
  let outputsNeeded = 0;
  for (const other of Object.values(graph)) {
    for (const v of Object.values(other.inputs ?? {})) {
      if (Array.isArray(v) && v.length === 2 && String(v[0]) === node) {
        outputsNeeded = Math.max(outputsNeeded, Number(v[1]) + 1);
      }
    }
  }
  const outputsHave = Array.isArray(spec.output) ? spec.output.length : 0;

  const set: Record<string, unknown> = {};
  const blocked: string[] = [];
  for (const [name, cfg] of Object.entries(required)) {
    if (name in n.inputs) continue;
    const d = widgetDefault(cfg as unknown[]);
    if (d === undefined) blocked.push(name);
    else set[name] = d;
  }
  const declared = (k: string) => k in required
    || !!(spec.input?.optional && k in spec.input.optional);
  const stale = Object.keys(n.inputs).filter((k) => !declared(k));
  // A STALE WIRE IS DATA LOSS, a stale literal is not. Measured on the real
  // thing: a live model offered `JoinStringMulti` -> `StringConcatenate`, and
  // #44's `string_1`/`string_2` are LINKS from two other nodes. ComfyUI
  // ignores an input the class does not declare, so that swap validates
  // cleanly and renders with two empty strings — a different picture, with
  // nothing failing to say so. That is the silent downgrade, so it is refused
  // as a patch and offered as a lead instead. A stale LITERAL only loses a
  // value the class was never going to read.
  const lostLinks = stale.filter((k) => {
    const v = n.inputs[k];
    return Array.isArray(v) && v.length === 2 && graph[String(v[0])];
  });

  return { ok: !blocked.length && !lostLinks.length && outputsHave >= outputsNeeded,
           set, blocked, stale, lostLinks, outputsNeeded, outputsHave };
}

/**
 * Turn a model's reply into proposals, dropping anything it made up.
 *
 * The invented-class check is in `parseFixReply` so both planes share it;
 * marked `ai: true` so the UI can say which suggestions came from a model
 * rather than from the engine's own answer, and never `exact` — a substitution
 * changes what renders, which no amount of model confidence establishes.
 */
export function aiRepairsFromReply(
  reply: string, faults: WorkflowFault[], env: RepairEnv = {}, graph: ApiGraph = {},
): Repair[] {
  const subs = parseFixReply(reply, env.installed);
  const out: Repair[] = [];
  let n = 0;
  for (const sub of subs) {
    const f = faults.find((x) => x.class_type === sub.missing);
    if (!f?.node) continue;
    const why = sub.why || "Suggested as an equivalent.";
    const chk = substitutionCheck(graph, f.node, sub.use, env.specFor?.(sub.use));
    // The model's claim is about MEANING; this is the wiring. A swap that
    // cannot carry the links is offered as a lead, not as a patch — accepting
    // it would trade a graph that fails naming a missing node for one that
    // fails naming a missing input, which is not progress.
    if (chk && !chk.ok) {
      out.push({
        id: `ai-${++n}`, kind: "missing_class", confidence: "guess", ai: true,
        title: `${sub.use} is close, but cannot be dropped in for ${sub.missing}`,
        detail: `${why} It does not fit #${f.node} as wired: `
          + [chk.blocked.length ? `it requires ${chk.blocked.join(", ")}, which nothing feeds` : "",
             chk.lostLinks.length
               ? `${chk.lostLinks.join(", ")} carries a link ${sub.use} does not declare, so the `
                 + "swap would validate and render without it" : "",
             chk.outputsHave < chk.outputsNeeded
               ? `the graph takes ${chk.outputsNeeded} output(s) from this node and ${sub.use} `
                 + `has ${chk.outputsHave}` : ""]
            .filter(Boolean).join("; ")
          + ". Rewire it in ComfyUI, or install the pack that provides the original.",
        patch: null,
      });
      continue;
    }
    out.push({
      id: `ai-${++n}`, kind: "missing_class", confidence: "guess", ai: true,
      title: `Replace ${sub.missing} with ${sub.use}`,
      detail: `${why} ${sub.use} is installed`
        + (chk ? `, takes the wires #${f.node} already has, and has enough outputs for what `
                 + "reads from it" : " on this engine")
        + (chk?.stale.length
          ? `. ${chk.stale.join(", ")} would be left unused` : "")
        + ". Substituting a node changes what renders — check the result rather than "
        + "trusting the swap.",
      patch: { reclass: { node: f.node, class_type: sub.use,
                          ...(chk && Object.keys(chk.set).length ? { set: chk.set } : {}) } },
    });
  }
  return out;
}
