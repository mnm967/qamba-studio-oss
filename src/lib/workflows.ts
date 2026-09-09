// The workflow inspector's analysis half — pure functions over a template's
// raw text plus the model_map, no React and no supabase, so it is testable
// under `node --test`.
//
// WHY THIS EXISTS AT ALL. `worker/resolve.py` parameterises a template by
// walking every node and matching on `class_type`: a `UNETLoader` gets the
// mode's checkpoint, a class in LATENT_CLASSES gets width/height/length, a
// `KSampler` gets the seed, and so on. Nothing declares that contract and
// nothing checks it — so a template that happens to build its model another
// way (CheckpointLoaderSimple, a custom loader pack) renders perfectly and
// SILENTLY IGNORES the parameter. No error, no log line, just a clip at the
// template's literal resolution with the template's literal seed. That is the
// silent downgrade this codebase keeps getting bitten by, and it is the one
// thing a read-only inspector can genuinely prevent: `contractOf` reports,
// per template, which knobs resolve() can actually turn.
//
// The class sets below are duplicated from resolve.py. `workflows.test.ts`
// parses that file and fails if the two drift — the duplication is deliberate
// (the browser cannot import Python) and the test is what makes it safe.

/** Latent builders resolve() writes width/height/length into. */
export const LATENT_CLASSES = new Set([
  "Wan22ImageToVideoLatent", "WanImageToVideo", "WanFirstLastFrameToVideo",
  "EmptyHunyuanLatentVideo", "EmptyHunyuanVideo15Latent", "EmptyLTXVLatentVideo",
  "HunyuanVideo15ImageToVideo", "LTXVImgToVideo",
  "MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo", "EmptyMiniMaxH3LatentAV",
]);

/** Classes that take the prompt as a plain string input instead of going
 *  through CLIPTextEncode (MiniMax H3 conditions inside the latent builder). */
export const PROMPT_INPUT_CLASSES = new Set([
  "MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo",
]);

export const MODEL_LOADER_CLASSES = new Set([
  "UNETLoader", "UnetLoaderGGUF", "UnetLoaderGGUFAdvanced",
]);

/**
 * There are THREE ways a template gets parameterised, and only one of them is
 * resolve(). Treating them alike is what made the first version of this
 * inspector report four "silently ignored" defects against `post_rife.json` —
 * a graph that had no prompt, no latent and no sampler because it was a frame
 * interpolator, and which never went near resolve() in the first place. (That
 * file is gone: the post chain builds its graphs in worker/graphs.py now, so
 * the passes can be conditional. The lesson it taught this table stands.)
 *
 *  resolve      — model_map names the file (or a handler passes it as the
 *                 `resolve(workflow=…)` override). Parameterised by class_type;
 *                 `contractOf` is the check.
 *  substitution — `_run_workflow_file` replaces `__HOLE__` markers in the raw
 *                 TEXT, so the file is only valid JSON afterwards. The check is
 *                 whether the handler's keys and the file's holes agree.
 *  node-ids     — the handler reaches into g["5"]["inputs"]["seed"] by hand.
 *                 Brittle in a way nothing else here is: renumber a node and
 *                 the write lands somewhere else or raises. The check is
 *                 whether every pinned id still exists.
 */
export type Dialect = "resolve" | "substitution" | "node-ids";

export interface HandlerUse {
  /** file and symbol that names this template */
  where: string;
  dialect: Dialect;
  /** node ids the handler writes into by hand, for the `node-ids` dialect */
  pins?: { node: string; input?: string; what: string }[];
  /** the (model, mode) a `resolve(workflow=…)` override stands in for */
  as?: { model: string; mode: string };
  /** the tiers whose worker can actually reach this handler. Absent means
   *  every tier — which is right for anything `plan_cli.KINDS` allows and
   *  wrong for the v1 studio's own paths, which only the pod runs. */
  tiers?: string[];
}

/** Templates no model_map mode names, because a handler names them in code.
 *  Without this they read as orphans, which would be wrong in the one
 *  direction that matters — "delete this, nothing uses it". */
export const HANDLER_TEMPLATES: Record<string, HandlerUse> = {
  "lipsync_latentsync.json": {
    where: "worker/handlers/legacy.py — run_lipsync (LIPSYNC_WF)",
    dialect: "node-ids",
    // The v1 studio's path, and no kind in `plan_cli.KINDS` reaches it — so
    // on the desktop tier this file is named in code that machine never runs.
    tiers: ["aws"],
    pins: [
      { node: "1", input: "file", what: "the shot's video" },
      { node: "3", input: "audio", what: "the dialogue track" },
      { node: "5", input: "seed", what: "seed (and inference_steps)" },
      { node: "7", what: "the output the handler fetches" },
    ],
  },
  "minimax_h3_r2v_audiolock.json": {
    where: "worker/handlers/blocks.py — AUDIOLOCK_WF, via resolve(workflow=…)",
    dialect: "resolve",
    // The block's own H3 checkpoint, whichever it picked; r2v is fixed.
    as: { model: "minimax-h3", mode: "r2v" },
  },
};

export type TemplateFormat = "api" | "ui" | "stub" | "invalid";

export interface WorkflowNode {
  id: string;
  class_type: string;
  inputs: Record<string, unknown>;
}

export interface ParsedTemplate {
  name: string;
  format: TemplateFormat;
  /** the template's own `_comment`, which is where its provenance is written */
  comment: string | null;
  nodes: WorkflowNode[];
  /** `__MULT__`-style holes: these files are only valid JSON after the
   *  handler substitutes on raw TEXT (numeric holes sit unquoted). */
  placeholders: string[];
  /** where each hole lands, so the substitution dialect can be inspected
   *  as precisely as the resolve one */
  holes: { token: string; node: string; class_type: string; input: string }[];
  error: string | null;
  bytes: number;
}

const isLink = (v: unknown): v is [string, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "string";

/** Parse a template the way the worker does, including the two dialects that
 *  are not plain API JSON: `_stub` placeholders and `__SUB__` text holes. */
export function parseTemplate(name: string, raw: string): ParsedTemplate {
  const HOLE = /__[A-Z0-9_]+__/g;
  const placeholders = [...new Set(raw.match(HOLE) ?? [])];

  // Quote the unquoted holes rather than blanking them, so each one survives
  // parsing as a string value and can be traced to the node input it fills —
  // `__MULT__` is worth showing as "RIFE VFI #3.multiplier", not as a 0.
  // A hole embedded inside a larger string would break that rewrite, so the
  // blunt substitution stays as the fallback.
  const quoted = raw.replace(HOLE, (m, off: number) =>
    raw[off - 1] === '"' && raw[off + m.length] === '"' ? m : `"${m}"`);
  let text = quoted;
  let parsed: Record<string, unknown> | null = null;
  for (const attempt of [quoted, placeholders.reduce((s, p) => s.split(p).join("0"), raw)]) {
    try {
      parsed = JSON.parse(attempt);
      text = attempt;
      break;
    } catch { /* try the next dialect */ }
  }

  const base = { name, placeholders, holes: [] as ParsedTemplate["holes"], bytes: raw.length };
  if (parsed === null) {
    let error = "unknown parse failure";
    try { JSON.parse(text); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    return { ...base, format: "invalid", comment: null, nodes: [], error };
  }

  const comment = typeof parsed._comment === "string" ? parsed._comment : null;
  if (parsed._stub) {
    return { ...base, format: "stub", comment, nodes: [], error: null };
  }
  // ComfyUI's own "Save" writes the UI graph; the worker needs the one from
  // "Save (API Format)". They are not interchangeable and the difference is
  // easy to miss by eye.
  if (Array.isArray(parsed.nodes) && Array.isArray(parsed.links)) {
    return { ...base, format: "ui", comment, nodes: [], error: null };
  }

  const nodes: WorkflowNode[] = [];
  for (const [id, v] of Object.entries(parsed)) {
    if (id.startsWith("_")) continue;
    const n = v as { class_type?: string; inputs?: Record<string, unknown> };
    if (!n || typeof n.class_type !== "string") continue;
    nodes.push({ id, class_type: n.class_type, inputs: n.inputs ?? {} });
  }

  const holes: ParsedTemplate["holes"] = [];
  if (placeholders.length) {
    for (const n of nodes) {
      for (const [input, v] of Object.entries(n.inputs)) {
        if (typeof v === "string" && placeholders.includes(v)) {
          holes.push({ token: v, node: n.id, class_type: n.class_type, input });
        }
      }
    }
  }
  return { ...base, holes, format: "api", comment, nodes, error: null };
}

/* ── the resolve() contract ─────────────────────────────────────────────── */

export type ContractStatus = "ok" | "risk" | "na";

export interface ContractRow {
  id: string;
  label: string;
  status: ContractStatus;
  /** what resolve() will do, or what it will silently fail to do */
  detail: string;
}

/** The model_map entry for the model that renders this template, when known.
 *  It refines the check: a missing `VAELoader` only matters if the entry
 *  actually declares a `vae` for resolve() to write. */
export interface ModelSpec {
  vae?: string;
  audio_vae?: string;
  text_encoders?: string[];
  style_lora?: string;
  steps?: number;
  sampler?: string;
  fps?: number;
}

const has = (nodes: WorkflowNode[], cls: string) =>
  nodes.some((n) => n.class_type === cls);
const all = (nodes: WorkflowNode[], cls: string) =>
  nodes.filter((n) => n.class_type === cls);

/** Which node ids are wired into some other node's `positive` / `negative`.
 *  resolve() writes prompt text ONLY into a CLIPTextEncode reachable this
 *  way, so an unwired encoder keeps whatever text the template shipped. */
function promptSinks(nodes: WorkflowNode[]) {
  const pos = new Set<string>(), neg = new Set<string>();
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (!isLink(v)) continue;
      if (k === "positive") pos.add(v[0]);
      else if (k === "negative") neg.add(v[0]);
    }
  }
  return { pos, neg };
}

/** Mirror of resolve.py's start/end detection: the LoadImage feeding a
 *  `start_image`/`first_frame` input is the source still, the one feeding
 *  `end_image`/`last_frame` is the FLF tail.
 *
 *  …AND LTX 2.5 PINS BY INDEX INSTEAD. Core's `LTXVAddGuide` calls its picture
 *  `image` at both ends of the clip and says WHICH end in `frame_idx` — 0 for
 *  the first frame, negative for the last. Name-matching alone therefore finds
 *  neither, so this page would report a correct flf template as having no end
 *  hook, and `resolve()` would put the start frame into both guides. Both
 *  halves learned it together; this is the browser's. */
function imageSlots(nodes: WorkflowNode[]) {
  let start: string | null = null, end: string | null = null;
  for (const n of nodes) {
    for (const k of ["start_image", "first_frame"]) {
      const v = n.inputs[k];
      if (isLink(v)) start = v[0];
    }
    for (const k of ["end_image", "last_frame"]) {
      const v = n.inputs[k];
      if (isLink(v)) end = v[0];
    }
    if (n.class_type === "LTXVAddGuide" && isLink(n.inputs.image)) {
      const at = Number(n.inputs.frame_idx ?? 0);
      if (at < 0) end = (n.inputs.image as [string, number])[0];
      else start = (n.inputs.image as [string, number])[0];
    }
  }
  return { start, end };
}

/**
 * What resolve() can and cannot set on this graph.
 *
 * `mode` decides whether an absent hook is a defect or simply not applicable
 * — a t2v template has no business carrying a LoadImage. Rows are ordered
 * worst-first by the caller, not here.
 */
export function contractOf(
  nodes: WorkflowNode[],
  opts: { mode?: string; model?: ModelSpec } = {},
): ContractRow[] {
  const { mode, model } = opts;
  const rows: ContractRow[] = [];
  const row = (id: string, label: string, status: ContractStatus, detail: string) =>
    rows.push({ id, label, status, detail });

  // ── checkpoint
  const loaders = nodes.filter((n) => MODEL_LOADER_CLASSES.has(n.class_type));
  if (loaders.length) {
    const kinds = [...new Set(loaders.map((n) => n.class_type))].join(", ");
    row("checkpoint", "Checkpoint", "ok",
      `${loaders.length} x ${kinds} ${loaders.length > 1 ? "take" : "takes"} `
      + "the mode's checkpoint/high/low");
  } else {
    row("checkpoint", "Checkpoint", "risk",
      "no UNETLoader / UnetLoaderGGUF — the mode's `checkpoint` is never written, "
      + "so whatever filename the template ships is what renders");
  }

  // ── text encoder
  const encs = model?.text_encoders?.length ?? 0;
  if (has(nodes, "DualCLIPLoader")) {
    row("clip", "Text encoder", encs >= 2 ? "ok" : "risk",
      encs >= 2 ? "DualCLIPLoader takes text_encoders[0] and [1]"
        : "DualCLIPLoader needs two `text_encoders` in model_map; the entry declares "
          + `${encs}, so the template's literals stay`);
  } else if (has(nodes, "CLIPLoader")) {
    row("clip", "Text encoder", encs ? "ok" : "na",
      encs ? "CLIPLoader takes text_encoders[0]"
        : "CLIPLoader present but the entry declares no `text_encoders`");
  } else {
    row("clip", "Text encoder", encs ? "risk" : "na",
      encs ? `entry declares ${encs} text encoder(s) and the graph loads none — unused`
        : "no CLIP loader in this graph");
  }

  // ── vae
  const vaes = all(nodes, "VAELoader");
  if (vaes.length) {
    // resolve() picks the audio VAE by finding "audio" in the shipped filename.
    const audio = vaes.filter((n) => String(n.inputs.vae_name ?? "").toLowerCase().includes("audio"));
    row("vae", "VAE", model?.vae ? "ok" : "na",
      model?.vae
        ? `${vaes.length} VAELoader${vaes.length > 1 ? "s" : ""}${
            audio.length ? `, ${audio.length} matched as audio by filename` : ""}`
        : "VAELoader present but the entry declares no `vae`");
  } else {
    row("vae", "VAE", model?.vae ? "risk" : "na",
      model?.vae ? "entry declares a `vae` and the graph has no VAELoader — unused"
        : "no VAELoader (the model may carry its VAE in the checkpoint)");
  }

  // ── prompt
  const { pos, neg } = promptSinks(nodes);
  const encoders = all(nodes, "CLIPTextEncode");
  const wiredPos = encoders.filter((n) => pos.has(n.id));
  const wiredNeg = encoders.filter((n) => neg.has(n.id));
  const inline = nodes.filter((n) => PROMPT_INPUT_CLASSES.has(n.class_type) && "prompt" in n.inputs);
  if (inline.length) {
    row("prompt", "Prompt", "ok",
      `${inline[0].class_type} carries the prompt as a plain string input (no CLIPTextEncode)`);
  } else if (wiredPos.length) {
    row("prompt", "Prompt", "ok",
      `positive → node ${wiredPos.map((n) => n.id).join(", ")}`
      + (wiredNeg.length ? `; negative → node ${wiredNeg.map((n) => n.id).join(", ")}`
         : "; NO negative sink — the job's negative prompt is dropped"));
  } else {
    const stranded = encoders.length - wiredPos.length - wiredNeg.length;
    row("prompt", "Prompt", "risk",
      encoders.length
        ? `${encoders.length} CLIPTextEncode node(s) but none wired to a \`positive\` input`
          + `${stranded > 0 ? ` (${stranded} stranded)` : ""} — the job's prompt never reaches the graph`
        : "nothing takes the prompt — this graph renders the same thing every time");
  }

  // ── dimensions + length
  const latents = nodes.filter((n) => LATENT_CLASSES.has(n.class_type));
  if (latents.length) {
    const keys = ["width", "height", "length"] as const;
    const missing = keys.filter((k) => !latents.some((n) => k in n.inputs));
    row("dims", "Size & length", missing.length ? "risk" : "ok",
      missing.length
        ? `${latents[0].class_type} takes ${keys.filter((k) => !missing.includes(k)).join(", ") || "none"}`
          + ` — ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} silently ignored`
        : `${latents[0].class_type} takes width, height and length`);
  } else {
    row("dims", "Size & length", "risk",
      "no latent builder resolve() recognises — width, height and length are all "
      + "silently ignored, whatever the job asks for");
  }

  // ── seed
  const seeded = [
    ...all(nodes, "KSampler").map((n) => `${n.class_type} #${n.id}.seed`),
    ...all(nodes, "KSamplerAdvanced").map((n) => `${n.class_type} #${n.id}.noise_seed`),
    ...all(nodes, "RandomNoise").map((n) => `RandomNoise #${n.id}.noise_seed`),
  ];
  row("seed", "Seed", seeded.length ? "ok" : "risk",
    seeded.length ? seeded.join(", ")
      : "no KSampler / KSamplerAdvanced / RandomNoise — the seed is never written, "
        + "so every render of this template repeats the template's own seed");

  // ── steps / sampler
  const sched = has(nodes, "BasicScheduler");
  const ks = has(nodes, "KSampler") || has(nodes, "KSamplerAdvanced");
  if (ks) {
    row("steps", "Steps / cfg", "ok", "KSampler takes both `steps` and `cfg`");
  } else if (sched) {
    row("steps", "Steps / cfg", "ok",
      "BasicScheduler takes `steps` (explicit argument, then model_map `steps`)"
      + `${model?.sampler ? "; KSamplerSelect takes the entry's `sampler`" : ""}`
      + "; cfg is fixed by the guider");
  } else {
    row("steps", "Steps / cfg", model?.steps ? "risk" : "na",
      model?.steps
        ? `entry declares steps=${model.steps} and this graph has no sampler node to write it into`
        : "no sampler node resolve() writes steps into");
  }

  // ── source / end stills
  const { start, end } = imageSlots(nodes);
  const loads = all(nodes, "LoadImage");
  const wantsStart = mode === "i2v" || mode === "flf";
  const wantsEnd = mode === "flf";
  if (start) {
    row("start", "Source still", "ok", `LoadImage #${start} feeds the first frame`);
  } else if (loads.length) {
    // resolve()'s fall-through: any LoadImage that is neither start nor end
    // still gets the source image. Deliberate, and surprising.
    row("start", "Source still", wantsStart ? "ok" : "na",
      `no first_frame/start_image link; ${loads.length} LoadImage node(s) take the `
      + "source still via resolve()'s fall-through");
  } else {
    row("start", "Source still", wantsStart ? "risk" : "na",
      wantsStart ? `mode '${mode}' passes a source image and this graph has no LoadImage`
        : "no LoadImage (text-to-video)");
  }
  if (end || wantsEnd) {
    row("end", "End still", end ? "ok" : "risk",
      end ? `LoadImage #${end} feeds the last frame`
        : `mode '${mode}' passes an end image and no node takes a last_frame/end_image link`);
  }
  // The fall-through above is a real trap once a template carries a LoadImage
  // for something other than the shot's own stills.
  const extra = loads.filter((n) => n.id !== start && n.id !== end);
  if (extra.length && (start || end)) {
    row("loadimage", "Other LoadImage", "risk",
      `#${extra.map((n) => n.id).join(", #")} — resolve() overwrites EVERY remaining `
      + "LoadImage with the source still, including ones staged for another purpose");
  }

  // ── style LoRA
  const loraNodes = all(nodes, "LoraLoaderModelOnly");
  const placeholder = loraNodes.filter((n) => String(n.inputs.lora_name ?? "").includes("STYLE"));
  if (placeholder.length) {
    row("lora", "Style LoRA", model?.style_lora ? "ok" : "risk",
      model?.style_lora
        ? `STYLE placeholder #${placeholder[0].id} takes the entry's style_lora`
        : "graph carries a STYLE placeholder and the entry has no `style_lora` — resolve() RAISES");
  } else if (model?.style_lora) {
    row("lora", "Style LoRA", "ok",
      loraNodes.length
        ? "entry's style_lora is spliced in only if no LoraLoaderModelOnly exists — this graph "
          + `has ${loraNodes.length}, so the baked-in loader keeps its own file`
        : "no LoraLoaderModelOnly, so resolve() splices the entry's style_lora after the model loader");
  }

  // ── H3 reference slots
  if (has(nodes, "MiniMaxH3ReferenceToVideo")) {
    row("refs", "Reference slots", "ok",
      "_wire_refs replaces the template's placeholder slots with the block's staged "
      + "refs (≤9 images, ≤3 videos, ≤3 audio)");
  }

  // ── audiolock
  const audioSlice = all(nodes, "LoadAudio")
    .filter((n) => String(n.inputs.audio ?? "").includes("AUDIO_SLICE"));
  if (audioSlice.length) {
    row("audio", "Locked audio", "ok",
      `LoadAudio #${audioSlice[0].id} takes the block's pre-sliced wav (AUDIO_SLICE placeholder)`);
  }

  return rows;
}

/**
 * The `node-ids` contract: a handler that writes into g["5"]["inputs"]["seed"]
 * is pinned to this file's numbering, and nothing in the file says so. Renumber
 * a node — or re-export the graph from ComfyUI, which renumbers freely — and
 * the write lands on a different node or raises a KeyError mid-render.
 */
export function pinContract(
  nodes: WorkflowNode[],
  pins: NonNullable<HandlerUse["pins"]>,
): ContractRow[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return pins.map((p) => {
    const n = byId.get(p.node);
    if (!n) {
      return {
        id: `pin-${p.node}`, label: `Node #${p.node}`, status: "risk" as const,
        detail: `the handler writes ${p.what} here and this graph has no node #${p.node}`,
      };
    }
    if (p.input && !(p.input in n.inputs)) {
      return {
        id: `pin-${p.node}`, label: `Node #${p.node}`, status: "risk" as const,
        detail: `${n.class_type} has no \`${p.input}\` input — the handler writes ${p.what} into it`,
      };
    }
    return {
      id: `pin-${p.node}`, label: `Node #${p.node}`, status: "ok" as const,
      detail: `${n.class_type}${p.input ? `.${p.input}` : ""} — ${p.what}`,
    };
  });
}

/** The `substitution` contract: every hole in the file, and where it lands. */
export function substitutionContract(p: ParsedTemplate): ContractRow[] {
  return p.placeholders.map((token) => {
    const at = p.holes.filter((h) => h.token === token);
    return {
      id: `hole-${token}`, label: token,
      status: at.length ? ("ok" as const) : ("risk" as const),
      detail: at.length
        ? at.map((h) => `${h.class_type} #${h.node}.${h.input}`).join(", ")
        : "substituted somewhere the parser cannot place — check the raw file",
    };
  });
}

/* ── model_map ↔ template mapping ───────────────────────────────────────── */

export interface WorkflowUse {
  model: string;
  mode: string;
  checkpoint: string | null;
}

export interface ModelMap {
  [tier: string]: {
    models?: Record<string, {
      modes?: Record<string, { workflow?: string; checkpoint?: string; high?: string; low?: string }>;
    } & ModelSpec>;
    image_models?: Record<string, { family?: string }>;
  };
}

/** workflow filename → every (model, mode) on this tier that names it. */
export function workflowUsage(mm: ModelMap, tier: string): Map<string, WorkflowUse[]> {
  const out = new Map<string, WorkflowUse[]>();
  for (const [model, entry] of Object.entries(mm[tier]?.models ?? {})) {
    for (const [mode, spec] of Object.entries(entry.modes ?? {})) {
      if (!spec.workflow) continue;
      const list = out.get(spec.workflow) ?? [];
      list.push({ model, mode, checkpoint: spec.checkpoint ?? spec.high ?? null });
      out.set(spec.workflow, list);
    }
  }
  return out;
}

export type TemplateHealth = "ok" | "warn" | "broken" | "unused";

export interface TemplateRow {
  parsed: ParsedTemplate;
  uses: WorkflowUse[];
  /** set when a handler names the file in code rather than model_map */
  handler: HandlerUse | null;
  /** how this template is parameterised — decides which contract applies */
  dialect: Dialect | null;
  health: TemplateHealth;
  /** the worst-case one-liner for the list */
  note: string;
}

/**
 * Fold parsed templates together with who uses them.
 *
 * "unused" is scoped to the tier and says so: a template no model_map mode and
 * no handler names is dead weight on THIS tier, which is a fact worth showing
 * and not on its own a reason to delete anything.
 */
export function templateRows(
  parsed: ParsedTemplate[],
  usage: Map<string, WorkflowUse[]>,
  tier?: string,
): TemplateRow[] {
  return parsed.map((p) => {
    const uses = usage.get(p.name) ?? [];
    const handler = HANDLER_TEMPLATES[p.name] ?? null;
    // A HANDLER IS TIER-SCOPED TOO, and counting one that the tier's worker
    // cannot reach would report a template as live on a machine that never
    // runs it — the one direction this page must not be wrong in. The handler
    // is still SHOWN (it says what the file is for); it just stops counting
    // as a use, so the row reads unused here and the note says why.
    const handlerHere = !!handler
      && (!tier || !handler.tiers || handler.tiers.includes(tier));
    const used = uses.length > 0 || handlerHere;
    const dialect = uses.length ? "resolve" : handler?.dialect ?? null;

    // What is WRONG with the file, independent of whether anything runs it.
    let defect: string | null = null;
    if (p.format === "invalid") defect = `does not parse: ${p.error}`;
    else if (p.format === "ui") defect = "saved in ComfyUI's UI format — the worker needs Save (API Format)";
    else if (p.format === "stub") defect = "stub — resolve() refuses it; the real graph was never captured";

    // Severity is defect x reachability. A broken file nothing runs is a
    // tidy-up; the same file wired to a mode is a job that fails on claim.
    let health: TemplateHealth = "ok";
    let note = "";
    if (!used) {
      health = "unused";
      const why = handler
        ? `${handler.where} names it, but that path does not run on this tier`
        : "no model_map mode and no handler names this file";
      note = defect ? `${defect} — and ${why}` : why;
    } else if (defect) {
      health = "broken";
      note = defect;
    } else if (p.placeholders.length) {
      note = `text-substituted (${p.placeholders.join(", ")}) before parsing`;
    }
    return { parsed: p, uses, handler, dialect, health, note };
  });
}

/** Rank for the list: what is broken first, then unused, then the rest. */
export const HEALTH_ORDER: Record<TemplateHealth, number> = {
  broken: 0, warn: 1, unused: 2, ok: 3,
};

/** Image families never reach a template at all — `handlers/images.py`
 *  dispatches on `family` into a hand-written builder in `worker/graphs.py`.
 *  The inspector says so out loud rather than showing an empty pane. */
export const IMAGE_BUILDERS: Record<string, string> = {
  krea2: "graphs.krea2_graph / krea2_ref_graph",
  klein: "graphs.flux2_klein_graph",
  flux: "graphs.flux_ref_graph / flux_kontext_graph",
  flux2: "graphs.flux2_ref_graph",
  qwen: "graphs.qwen_edit_graph / qwen_upscale_graph",
  anima: "graphs.anima_graph",
  h3: "graphs.h3_image_graph",
  hidream_o1: "graphs.hidream_o1_graph",
  // One builder, two nodes: it splits t2i from the reference path the way
  // krea2 splits krea2_graph from krea2_ref_graph, but inside one function
  // because the loader and the save are identical either way.
  sensenova: "graphs.sensenova_graph",
};

export function imageFamilies(mm: ModelMap, tier: string) {
  const out = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(mm[tier]?.image_models ?? {})) {
    const fam = entry.family ?? key;
    out.set(fam, [...(out.get(fam) ?? []), key]);
  }
  return [...out.entries()]
    .map(([family, models]) => ({
      family, models, builder: IMAGE_BUILDERS[family] ?? "graphs.py (unmapped)",
    }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * The generator's own report on what a tier could not carry.
 *
 * `infra/model_map.desktop.json` is GENERATED from the aws map by
 * `scripts/gen_desktop_model_map.mjs`, which drops every entry whose weights
 * the engine window cannot download and RECORDS THE REASON, per entry, in the
 * file. Surfacing it is what keeps the desktop tier legible: without it that
 * tier reads as a studio with almost nothing in it — four reachable templates
 * against the pod's twelve — while the honest answer sits unread two keys
 * away. It is the same rule the `unused` note follows: say why, not just how
 * many.
 *
 * Read off the RAW json rather than through `ModelMap`, because these keys are
 * siblings of the tier and that type's index signature calls every key a tier.
 * Returns null for a hand-written map, which is what the aws one is.
 */
export interface MapProvenance {
  /** the script that wrote it */
  generated: string;
  /** the map it was derived from */
  from: string | null;
  /** entries that did not survive, each with the generator's own reason */
  dropped: { section: string; key: string; why: string }[];
  /** model key -> the `style_loras` keys pruned from it */
  adaptersDropped: { model: string; loras: string[] }[];
  /** entry keys the generator strips from every entry, and why */
  strippedKeys: { key: string; why: string }[];
}

export function mapProvenance(raw: unknown): MapProvenance | null {
  const m = raw as Record<string, unknown> | null | undefined;
  const generated = typeof m?._generated === "string" ? m._generated : null;
  if (!generated) return null;

  const dropped = (Array.isArray(m?._dropped) ? m._dropped : [])
    .map((d) => d as Record<string, unknown>)
    .map((d) => ({
      section: String(d.section ?? ""),
      key: String(d.key ?? ""),
      why: String(d.why ?? ""),
    }))
    .filter((d) => d.key);

  const adapters = (m?._adapters_dropped ?? {}) as Record<string, unknown>;
  const adaptersDropped = Object.entries(adapters)
    .map(([model, v]) => ({
      model,
      loras: (Array.isArray(v) ? v : []).map(String),
    }))
    .filter((a) => a.loras.length);

  const stripped = (m?._stripped_keys ?? {}) as Record<string, unknown>;
  const strippedKeys = Object.entries(stripped)
    .map(([key, why]) => ({ key, why: String(why) }));

  return {
    generated,
    from: typeof m?._from === "string" ? m._from : null,
    dropped, adaptersDropped, strippedKeys,
  };
}
