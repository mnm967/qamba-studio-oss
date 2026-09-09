// UI-format ComfyUI graph → API-format prompt, plus the slot map that lets the
// studio drive an imported graph the way it drives a bundled template.
//
// WHY THIS IS NOT A ONE-LINER. What a user downloads from Civitai is almost
// always the UI graph — `app.graph.serialize()`, the thing ComfyUI's own "Save"
// writes — and `POST /prompt` accepts only the API form. The two are different
// documents, not two spellings of one:
//
//   UI    nodes[] with pos/size/order, links[] as a flat table, and every
//         widget value in a POSITIONAL array (`widgets_values`) whose mapping
//         onto named inputs lives in the node's class definition, not the file.
//   API   {id: {class_type, inputs}}, every input named, links written inline
//         as [origin_id, slot].
//
// So a faithful conversion needs the node schema. ComfyUI's frontend has it
// loaded; we get it from `/object_info` when a local engine is reachable, and
// fall back to a table of the classes this studio actually renders on plus
// core. `uiToApi` reports which nodes it could not map rather than emitting a
// graph that looks fine and silently drops a widget — the silent downgrade
// this codebase keeps getting bitten by.
//
// The other half is the four kinds of node that exist ONLY in the editor and
// have to be resolved away, because ComfyUI's backend has never heard of them:
// reroutes, bypassed nodes (pass a link through by type), muted nodes (delete),
// and the virtual-wiring packs (Get/SetNode, Anything Everywhere). A converter
// that just skips what it doesn't recognise produces a graph with dangling
// inputs, which fails on the pod with a validation error naming a node the user
// never saw.
//
// The slot tagger deliberately reuses `workflows.ts`'s class sets rather than
// re-declaring them: those are pinned against worker/resolve.py by
// workflows.test.ts, so the tagger inherits that guarantee and cannot drift
// from what the worker will actually parameterise.
import {
  LATENT_CLASSES, MODEL_LOADER_CLASSES, PROMPT_INPUT_CLASSES,
  type WorkflowNode,
} from "./workflows.ts";

/* ── the two document shapes ────────────────────────────────────────────── */

export interface UiNodeInput {
  name: string;
  type: string;
  link: number | null;
  /** present when a widget was converted to an input — it still occupies its
   *  slot in `widgets_values`, and the LINK wins when both are set */
  widget?: { name: string };
}

export interface UiNodeOutput {
  name?: string;
  type?: string;
  links?: number[] | null;
  slot_index?: number;
}

export interface UiNode {
  id: number | string;
  type: string;
  /** LiteGraph mode: 0 ALWAYS · 2 NEVER (muted) · 4 BYPASS. 2 and 4 are the
   *  ones that matter and they mean OPPOSITE things — see `resolveLink`. */
  mode?: number;
  inputs?: UiNodeInput[];
  outputs?: UiNodeOutput[];
  widgets_values?: unknown[] | Record<string, unknown>;
  title?: string;
  properties?: Record<string, unknown>;
}

/** [link_id, origin_node, origin_slot, target_node, target_slot, type] */
export type UiLink = [number, number | string, number, number | string, number, string?];

export interface UiGraph {
  nodes: UiNode[];
  links?: (UiLink | null)[];
  groups?: unknown[];
  /** ComfyUI subgraphs. Their contents are node classes the backend cannot
   *  resolve by name, so a graph carrying them cannot be flattened here. */
  definitions?: { subgraphs?: unknown[] };
  extra?: Record<string, unknown>;
}

export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
export type ApiGraph = Record<string, ApiNode>;

/* ── the node schema, when we have one ──────────────────────────────────── */

/** One entry of ComfyUI's `/object_info`. Only the parts we read. */
export interface NodeSpec {
  input?: {
    required?: Record<string, unknown[]>;
    optional?: Record<string, unknown[]>;
  };
  output?: unknown[];
  category?: string;
  output_node?: boolean;
}
export type ObjectInfo = Record<string, NodeSpec>;

/** Input types that are WIDGETS (typed by hand) rather than wires. Anything
 *  else — MODEL, IMAGE, LATENT, CLIP, VAE, CONDITIONING, a custom pack's own
 *  type — arrives over a link. */
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

const isWidgetEntry = (entry: unknown): boolean => {
  if (!Array.isArray(entry)) return false;
  const t = entry[0];
  // a combo is declared as its list of options, so a non-string type IS a widget
  return typeof t !== "string" || WIDGET_TYPES.has(t);
};

/**
 * The widget names of a class, in the order their values appear in
 * `widgets_values` — which is the whole reason `/object_info` is worth
 * fetching. `control_after_generate` is the trap: ComfyUI appends an extra
 * UI-only value after a seed widget, so a naive positional zip puts "fixed"
 * into the input after the seed for every sampler in the graph.
 */
export function widgetNames(spec: NodeSpec): string[] {
  const out: string[] = [];
  for (const group of [spec.input?.required, spec.input?.optional]) {
    for (const [name, entry] of Object.entries(group ?? {})) {
      if (!isWidgetEntry(entry)) continue;
      out.push(name);
      const opts = Array.isArray(entry) && entry.length > 1 ? entry[1] : null;
      if (opts && typeof opts === "object" && (opts as Record<string, unknown>).control_after_generate) {
        out.push(CONTROL_SLOT);
      }
    }
  }
  return out;
}

/** Sentinel for a positional slot that has no input behind it. */
const CONTROL_SLOT = "__control_after_generate__";

/**
 * Fallback widget order for classes we render on, used when no engine is
 * reachable to ask. Deliberately NOT a full mirror of ComfyUI: a wrong guess
 * here writes a value into the wrong input, so a class that is absent from
 * this table is reported unmapped instead of being guessed at.
 *
 * Ordering is the class's own `INPUT_TYPES` order, which is what the UI
 * serialises against.
 */
export const FALLBACK_WIDGETS: Record<string, string[]> = {
  // core loaders
  UNETLoader: ["unet_name", "weight_dtype"],
  // the GGUF loader is UNETLoader minus the dtype — it reads the quant from
  // the file. In MODEL_LOADER_CLASSES, so an imported GGUF graph is common.
  UnetLoaderGGUF: ["unet_name"],
  UnetLoaderGGUFAdvanced: ["unet_name", "dequant_dtype", "patch_dtype"],
  CheckpointLoaderSimple: ["ckpt_name"],
  VAELoader: ["vae_name"],
  CLIPLoader: ["clip_name", "type", "device"],
  DualCLIPLoader: ["clip_name1", "clip_name2", "type", "device"],
  LoraLoaderModelOnly: ["lora_name", "strength_model"],
  LoraLoader: ["lora_name", "strength_model", "strength_clip"],
  UpscaleModelLoader: ["model_name"],
  LatentUpscaleModelLoader: ["model_name"],
  // conditioning
  CLIPTextEncode: ["text"],
  ConditioningZeroOut: [],
  // latents
  EmptyLatentImage: ["width", "height", "batch_size"],
  EmptySD3LatentImage: ["width", "height", "batch_size"],
  EmptyHunyuanLatentVideo: ["width", "height", "length", "batch_size"],
  EmptyLTXVLatentVideo: ["width", "height", "length", "batch_size"],
  EmptyMiniMaxH3LatentAV: ["width", "height", "length", "batch_size"],
  MiniMaxH3ImageToVideo: ["prompt", "width", "height", "length", "batch_size"],
  MiniMaxH3ReferenceToVideo: ["prompt", "width", "height", "length", "batch_size"],
  WanImageToVideo: ["width", "height", "length", "batch_size"],
  Wan22ImageToVideoLatent: ["width", "height", "length", "batch_size"],
  WanFirstLastFrameToVideo: ["width", "height", "length", "batch_size"],
  // LTX 2.5. Core classes, so their order is knowable without an engine and
  // was read off a live /object_info rather than guessed. Three of the six
  // carry no widgets at all — listed anyway, because an EMPTY entry is the
  // statement "this class has nothing to map", where absence means "nobody
  // looked" and costs the graph an `unmapped` warning it does not deserve.
  LTXVAudioVAEDecode: [],
  LTXVCropGuides: [],
  // Core, and the only LTX node here with widgets that DECIDE something:
  // `frame_idx` is which end of the clip the picture is pinned at (0 first,
  // -1 last), which is the whole difference between i2v and flf. In
  // `INPUT_TYPES` order after the four link-typed inputs.
  LTXVAddGuide: ["frame_idx", "strength"],
  LTXVLatentUpsampler: [],
  LTXVDualCFGGuider: ["video_cfg", "audio_cfg"],
  ManualSigmas: ["sigmas"],
  // samplers
  KSampler: ["seed", CONTROL_SLOT, "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  KSamplerAdvanced: [
    "add_noise", "noise_seed", CONTROL_SLOT, "steps", "cfg", "sampler_name",
    "scheduler", "start_at_step", "end_at_step", "return_with_leftover_noise",
  ],
  KSamplerSelect: ["sampler_name"],
  RandomNoise: ["noise_seed", CONTROL_SLOT],
  BasicScheduler: ["scheduler", "steps", "denoise"],
  ModelSamplingAuraFlow: ["shift"],
  CFGNorm: ["strength"],
  // io
  LoadImage: ["image", "upload"],
  LoadAudio: ["audio", "upload"],
  SaveImage: ["filename_prefix"],
  PreviewImage: [],
  SaveVideo: ["filename_prefix", "format", "codec"],
  CreateVideo: ["fps"],
  SaveAudio: ["filename_prefix"],
  // The animated-image savers are what most community video graphs actually
  // end on — a real Civitai Hunyuan import reported SaveAnimatedWEBP unmapped,
  // and its "5 literal values" is exactly this widget list.
  SaveAnimatedWEBP: ["filename_prefix", "fps", "lossless", "quality", "method"],
  SaveAnimatedPNG: ["filename_prefix", "fps", "compress_level"],
  VAEDecode: [],
  VAEEncode: [],
};

/* ── nodes that exist only in the editor ────────────────────────────────── */

/** Pure annotation / UI furniture: dropped, and their absence changes nothing. */
export const UI_ONLY_CLASSES = new Set([
  "Note", "MarkdownNote", "Bookmark (rgthree)", "Label (rgthree)",
  "Fast Groups Bypasser (rgthree)", "Fast Groups Muter (rgthree)",
  "FancyTimerNode", "SystemNotification|pysssss", "Image Comparer (rgthree)",
  "PreviewAny", "easy showAnything", "WidgetToString",
]);

/** Nodes whose whole job is to move a value somewhere else. Resolved THROUGH
 *  (the consumer is rewired to the real producer) rather than dropped. */
export const PASSTHROUGH_CLASSES = new Set(["Reroute", "RerouteNode", "PrimitiveNode", "Any Switch (rgthree)"]);

/**
 * Packs that wire by NAME instead of by link. `GetNode`/`SetNode` (KJNodes) we
 * can follow, because the pairing is a widget value. `Anything Everywhere`
 * (cg-use-everywhere) broadcasts a value to every unconnected input of a
 * matching type at prompt-build time, inside the extension — there is no
 * record in the file of where it lands, so a graph using it converts with
 * holes and the only honest thing to do is say so.
 */
export const VIRTUAL_WIRE_CLASSES = new Set([
  "Anything Everywhere", "Anything Everywhere3", "Anything Everywhere?",
  "Prompts Everywhere", "Seed Everywhere", "Simple String",
]);

/**
 * Named-wire pairs, in every spelling that turns up.
 *
 * KJNodes calls them `SetNode`/`GetNode`; ComfyUI-Easy-Use calls them
 * `easy setNode`/`easy getNode` and they are EVERYWHERE — measured on a real
 * Civitai WAN 2.2 download, 42 of its 86 nodes were one or the other. Missing
 * that spelling does not fail loudly: the pair survives conversion as ordinary
 * nodes, the CLIPTextEncode behind them is no longer wired to anything named
 * `positive`, and the graph imports with no prompt slot at all.
 */
const SET_NODE = new Set(["SetNode", "SetNode|pysssss", "easy setNode"]);
const GET_NODE = new Set(["GetNode", "GetNode|pysssss", "easy getNode"]);

/* ── conversion ─────────────────────────────────────────────────────────── */

export type WarnLevel = "info" | "warn" | "error";

export interface ConversionWarning {
  level: WarnLevel;
  /** node id it concerns, when it concerns one */
  node?: string;
  class_type?: string;
  message: string;
}

export interface Conversion {
  api: ApiGraph;
  warnings: ConversionWarning[];
  /** classes we had no widget schema for — their literals are missing from the
   *  API graph, so the render would use ComfyUI's defaults */
  unmapped: string[];
  /** true when nothing structural was lost */
  clean: boolean;
}

export const isUiGraph = (x: unknown): x is UiGraph =>
  !!x && typeof x === "object" && Array.isArray((x as UiGraph).nodes);

export const isApiGraph = (x: unknown): x is ApiGraph => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const vals = Object.entries(x as Record<string, unknown>)
    .filter(([k]) => !k.startsWith("_"))
    .map(([, v]) => v);
  return vals.length > 0 && vals.every(
    (v) => !!v && typeof v === "object" && typeof (v as ApiNode).class_type === "string");
};

const MUTED = 2;
const BYPASS = 4;

/**
 * Convert a serialised UI graph into the API prompt ComfyUI executes.
 *
 * `objectInfo` is what makes it exact; without it the fallback table covers
 * the classes this studio renders on and everything else is reported.
 */
export function uiToApi(graph: UiGraph, objectInfo?: ObjectInfo): Conversion {
  const warnings: ConversionWarning[] = [];
  const unmapped = new Set<string>();
  const warn = (level: WarnLevel, message: string, n?: UiNode) =>
    warnings.push({ level, message, node: n ? String(n.id) : undefined, class_type: n?.type });

  const byId = new Map<string, UiNode>();
  for (const n of graph.nodes ?? []) byId.set(String(n.id), n);

  // link id → where it comes from
  const origin = new Map<number, { node: string; slot: number; type?: string }>();
  for (const l of graph.links ?? []) {
    if (!Array.isArray(l) || l.length < 5) continue;
    origin.set(Number(l[0]), { node: String(l[1]), slot: Number(l[2]), type: l[5] });
  }

  if (graph.definitions?.subgraphs?.length) {
    warn("error", `graph contains ${graph.definitions.subgraphs.length} subgraph definition(s) — `
      + "subgraph contents are not node classes the backend can resolve, so they cannot be "
      + "flattened here. Open the graph in ComfyUI and use Convert to Nodes first.");
  }

  /** SetNode name → the node id that feeds it, for GetNode resolution. */
  const setters = new Map<string, UiNode>();
  for (const n of graph.nodes ?? []) {
    if (!SET_NODE.has(n.type)) continue;
    const key = firstWidget(n);
    if (typeof key === "string") setters.set(key, n);
  }

  const isDropped = (n: UiNode) =>
    n.mode === MUTED || UI_ONLY_CLASSES.has(n.type) || VIRTUAL_WIRE_CLASSES.has(n.type);

  /**
   * Follow a link back to a node that will exist in the API graph.
   *
   * The three editor-only hops, and why each behaves the way it does:
   *  · reroute / passthrough — take its first linked input;
   *  · BYPASS (mode 4) — the node is skipped but its wire is kept: find an
   *    input carrying the same TYPE as the output being asked for and follow
   *    that. This is what ComfyUI does, and it is why bypass and mute are not
   *    interchangeable;
   *  · GetNode — jump to the SetNode that shares its name.
   * A muted (mode 2) producer has no output at all, so the consumer's input is
   * genuinely missing and the caller is told.
   */
  const resolveLink = (
    linkId: number | null | undefined, seen = new Set<number>(),
  ): [string, number] | null => {
    if (linkId == null) return null;
    if (seen.has(linkId)) return null;   // a cycle through reroutes
    seen.add(linkId);
    const src = origin.get(Number(linkId));
    if (!src) return null;
    const n = byId.get(src.node);
    if (!n) return null;

    if (n.mode === MUTED) return null;
    if (UI_ONLY_CLASSES.has(n.type)) return null;

    if (PASSTHROUGH_CLASSES.has(n.type)) {
      const first = (n.inputs ?? []).find((i) => i.link != null);
      return resolveLink(first?.link, seen);
    }
    if (GET_NODE.has(n.type)) {
      const key = firstWidget(n);
      const setter = typeof key === "string" ? setters.get(key) : undefined;
      if (!setter) {
        warn("error", `GetNode "${String(key)}" has no matching SetNode — the input it feeds is empty`, n);
        return null;
      }
      const fed = (setter.inputs ?? []).find((i) => i.link != null);
      return resolveLink(fed?.link, seen);
    }
    if (n.mode === BYPASS) {
      const wantType = n.outputs?.[src.slot]?.type ?? src.type;
      const match = (n.inputs ?? []).find((i) => i.link != null && i.type === wantType)
        ?? (n.inputs ?? []).find((i) => i.link != null);
      if (!match) return null;
      return resolveLink(match.link, seen);
    }
    return [String(n.id), src.slot];
  };

  const api: ApiGraph = {};
  for (const n of graph.nodes ?? []) {
    if (isDropped(n) || PASSTHROUGH_CLASSES.has(n.type) || n.mode === BYPASS
        || GET_NODE.has(n.type) || SET_NODE.has(n.type)) {
      if (VIRTUAL_WIRE_CLASSES.has(n.type)) {
        warn("error", `${n.type} wires by broadcast, not by link — every input it fed is `
          + "missing from the converted graph. Wire those inputs explicitly in ComfyUI, "
          + "or the render fails validation.", n);
      }
      continue;
    }

    const spec = objectInfo?.[n.type];
    const names = spec ? widgetNames(spec) : FALLBACK_WIDGETS[n.type];
    const inputs: Record<string, unknown> = {};

    // widgets first, so a converted-widget LINK overwrites the stale literal
    // the editor keeps alongside it
    const wv = n.widgets_values;
    if (Array.isArray(wv) && wv.length) {
      if (!names) {
        unmapped.add(n.type);
        warn("warn", `no widget schema for ${n.type} — its ${wv.length} literal value(s) are `
          + "dropped and ComfyUI's defaults render instead", n);
      } else {
        names.forEach((name, i) => {
          if (name === CONTROL_SLOT || i >= wv.length) return;
          inputs[name] = wv[i];
        });
        if (wv.length > names.length) {
          warn("info", `${n.type} carries ${wv.length} widget values for ${
            names.filter((x) => x !== CONTROL_SLOT).length} known inputs — extras ignored`, n);
        }
      }
    } else if (wv && typeof wv === "object") {
      // newer frontends serialise widgets by name
      Object.assign(inputs, wv as Record<string, unknown>);
    }

    for (const input of n.inputs ?? []) {
      if (input.link == null) continue;
      const from = resolveLink(input.link);
      if (!from) {
        warn("error", `${n.type} #${n.id}.${input.name} is wired to something that does not `
          + "survive conversion (muted, or an unresolvable virtual wire)", n);
        continue;
      }
      inputs[input.name] = from;
    }

    api[String(n.id)] = {
      class_type: n.type,
      inputs,
      ...(n.title && n.title !== n.type ? { _meta: { title: n.title } } : {}),
    };
  }

  return {
    api,
    warnings,
    unmapped: [...unmapped],
    clean: !warnings.some((w) => w.level === "error") && unmapped.size === 0,
  };
}

const firstWidget = (n: UiNode): unknown =>
  Array.isArray(n.widgets_values) ? n.widgets_values[0]
    : n.widgets_values && typeof n.widgets_values === "object"
      ? Object.values(n.widgets_values)[0] : undefined;

/** API graph → the node list `workflows.ts`'s contract functions read. */
export function apiNodes(api: ApiGraph): WorkflowNode[] {
  return Object.entries(api)
    .filter(([id]) => !id.startsWith("_"))
    .map(([id, n]) => ({ id, class_type: n.class_type, inputs: n.inputs ?? {} }));
}

/** Accept either format and return the API one. */
export function toApiGraph(doc: unknown, objectInfo?: ObjectInfo): Conversion {
  if (isUiGraph(doc)) return uiToApi(doc, objectInfo);
  if (isApiGraph(doc)) {
    return { api: doc as ApiGraph, warnings: [], unmapped: [], clean: true };
  }
  return {
    api: {}, unmapped: [], clean: false,
    warnings: [{ level: "error", message: "not a ComfyUI graph — expected either a UI export "
      + "(nodes + links) or an API export (id → {class_type, inputs})" }],
  };
}

/* ── slot tagging ───────────────────────────────────────────────────────── */

export interface Slot { node: string; input: string; class_type: string }
export interface SizeSlot {
  node: string; class_type: string;
  width?: string; height?: string; length?: string;
}

export interface SlotMap {
  prompt?: Slot;
  negative?: Slot;
  seed?: Slot;
  size?: SizeSlot;
  start_frame?: Slot;
  end_frame?: Slot;
  /** the H3 reference builder, whose slots `_wire_refs` rewrites wholesale */
  refs?: { node: string; class_type: string };
  output?: { node: string; class_type: string }[];
  model?: { node: string; input: string; class_type: string }[];
}

/**
 * Nodes that write a file the worker can fetch back.
 *
 * MUST STAY IN STEP WITH `resolve_custom.SAVE_CLASSES` — the worker refuses a
 * graph whose only outputs are previews ("nothing is saved to disk, so the job
 * would finish with no asset"), and this list used to count `PreviewImage` as
 * an output. So a preview-only graph imported with an output slot tagged, a
 * clean report and a content compat panel, and was then refused at RENDER
 * time — after queueing to the pod. Caught on real Civitai data: one of two
 * usable SDXL image workflows sampled ends on three `PreviewImage` nodes.
 * `test_resolve_custom.py` pins the two lists against each other.
 */
const OUTPUT_CLASSES = new Set([
  "SaveImage", "SaveVideo", "SaveAudio", "SaveAnimatedWEBP", "SaveAnimatedPNG",
  "VHS_VideoCombine", "SaveWEBM",
]);

/** Nodes that display a result without writing one. Tracked rather than merely
 *  excluded, so the import can say WHICH nodes need replacing. */
const PREVIEW_CLASSES = new Set(["PreviewImage", "PreviewAny", "SaveImageWebsocket"]);

const SEED_INPUTS = ["seed", "noise_seed"];

/** Which nodes are wired into some other node's `positive` / `negative`. The
 *  same walk resolve.py does, and the reason an unwired CLIPTextEncode is not
 *  the prompt slot: its text never reaches the sampler. */
function condSinks(nodes: WorkflowNode[]) {
  const pos = new Set<string>(), neg = new Set<string>();
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (!Array.isArray(v) || typeof v[0] !== "string") continue;
      if (k === "positive") pos.add(v[0]);
      else if (k === "negative") neg.add(v[0]);
    }
  }
  return { pos, neg };
}

/**
 * Find the inputs the studio needs to drive: prompt, seed, size, stills,
 * output. This is the contract a custom workflow is executed through — the
 * worker writes `api[slot.node].inputs[slot.input]` and nothing else.
 *
 * Everything here is a LOOKUP, never an inference from position or from the
 * author's node titles: a slot the tagger is unsure of is left unset so the
 * user is asked, rather than filled with a guess that renders the wrong thing.
 */
export function detectSlots(api: ApiGraph): SlotMap {
  const nodes = apiNodes(api);
  const out: SlotMap = {};

  // ── prompt. H3 carries it as a plain string on the latent builder; every
  // other family goes through a CLIPTextEncode that has to be WIRED to reach
  // the sampler.
  const inline = nodes.find((n) => PROMPT_INPUT_CLASSES.has(n.class_type) && "prompt" in n.inputs);
  if (inline) {
    out.prompt = { node: inline.id, input: "prompt", class_type: inline.class_type };
  } else {
    const { pos, neg } = condSinks(nodes);
    const encoders = nodes.filter((n) => n.class_type === "CLIPTextEncode");
    const p = encoders.find((n) => pos.has(n.id));
    const ng = encoders.find((n) => neg.has(n.id));
    if (p) out.prompt = { node: p.id, input: "text", class_type: p.class_type };
    if (ng) out.negative = { node: ng.id, input: "text", class_type: ng.class_type };
    // A single unwired encoder in an otherwise sane graph is the common
    // Civitai shape (the author used a Get/Set pair we could not follow).
    // Offer it as the prompt rather than reporting none — it is still an
    // explicit node id the user can correct in the picker.
    if (!p && encoders.length === 1) {
      out.prompt = { node: encoders[0].id, input: "text", class_type: encoders[0].class_type };
    }
  }

  // ── seed
  for (const n of nodes) {
    const key = SEED_INPUTS.find((k) => k in n.inputs && !Array.isArray(n.inputs[k]));
    if (!key) continue;
    // a sampler's own seed outranks a Seed/SeedNode helper, which may be
    // feeding several samplers through a wire we already resolved
    const isSampler = /KSampler|RandomNoise|SamplerCustom/.test(n.class_type);
    if (!out.seed || isSampler) out.seed = { node: n.id, input: key, class_type: n.class_type };
    if (isSampler) break;
  }

  // ── size + length
  const latent = nodes.find((n) => LATENT_CLASSES.has(n.class_type))
    ?? nodes.find((n) => "width" in n.inputs && "height" in n.inputs);
  if (latent) {
    out.size = {
      node: latent.id, class_type: latent.class_type,
      ...("width" in latent.inputs ? { width: "width" } : {}),
      ...("height" in latent.inputs ? { height: "height" } : {}),
      ...("length" in latent.inputs ? { length: "length" } : {}),
    };
  }

  // ── source / end stills. The link tells us which LoadImage is the first
  // frame; resolve.py reads the same two input-name families.
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (!Array.isArray(v) || typeof v[0] !== "string") continue;
      const src = nodes.find((x) => x.id === v[0]);
      if (!src || src.class_type !== "LoadImage") continue;
      if (["start_image", "first_frame", "image1"].includes(k)) {
        out.start_frame = { node: src.id, input: "image", class_type: src.class_type };
      } else if (["end_image", "last_frame"].includes(k)) {
        out.end_frame = { node: src.id, input: "image", class_type: src.class_type };
      }
    }
  }
  if (!out.start_frame) {
    const loads = nodes.filter((n) => n.class_type === "LoadImage");
    if (loads.length === 1) {
      out.start_frame = { node: loads[0].id, input: "image", class_type: loads[0].class_type };
    }
  }

  const refs = nodes.find((n) => n.class_type === "MiniMaxH3ReferenceToVideo");
  if (refs) out.refs = { node: refs.id, class_type: refs.class_type };

  const outputs = nodes.filter((n) => OUTPUT_CLASSES.has(n.class_type));
  if (outputs.length) {
    out.output = outputs.map((n) => ({ node: n.id, class_type: n.class_type }));
  }

  const models = nodes.filter((n) => MODEL_LOADER_CLASSES.has(n.class_type)
    || n.class_type === "CheckpointLoaderSimple");
  if (models.length) {
    out.model = models.map((n) => ({
      node: n.id, class_type: n.class_type,
      input: n.class_type === "CheckpointLoaderSimple" ? "ckpt_name" : "unet_name",
    }));
  }

  return out;
}

/* ── validation against a target engine ─────────────────────────────────── */

export type IssueKind =
  | "missing_node" | "missing_model" | "no_prompt" | "no_output" | "preview_only"
  | "no_size" | "dangling_input" | "bad_dims" | "bad_frames";

export interface ValidationIssue {
  kind: IssueKind;
  level: WarnLevel;
  node?: string;
  class_type?: string;
  message: string;
  /** what an automatic repair would need to decide */
  hint?: string;
}

export interface TargetEnv {
  /** class names the engine reports from /object_info */
  classes?: Set<string>;
  /** filenames the engine has, by loader input name (unet_name, lora_name…) */
  files?: Record<string, Set<string>>;
}

/** MiniMax H3's two hard grids (invariant #5). A graph that violates either
 *  does not render slightly wrong — it fails in the latent builder. */
export const H3_FRAME_BASE = 5;
export const H3_FRAME_STEP = 17;
export const DIM_STEP = 32;

export const isH3Frames = (n: number) => n >= H3_FRAME_BASE && (n - H3_FRAME_BASE) % H3_FRAME_STEP === 0;
export const pad17 = (n: number) =>
  n <= H3_FRAME_BASE ? H3_FRAME_BASE
    : H3_FRAME_BASE + Math.ceil((n - H3_FRAME_BASE) / H3_FRAME_STEP) * H3_FRAME_STEP;

/** Python's `round`, which is half-to-EVEN — and the difference is not
 *  academic here: 720/32 is exactly 22.5, so JS's half-up gives 736 and the
 *  worker gives 704 for the single most common illegal height there is. A hint
 *  that names a size the pod would not produce is worse than no hint. */
const pyRound = (x: number) => {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
};

/**
 * The nearest LEGAL size — deliberately not the nearest NATIVE one.
 *
 * `graphs.h3_snap_dims` picks from H3's published native list, optimising for
 * aspect ratio; measured against the real function, that sends both 1280x720
 * and 1920x1080 to 736x416. That is the right trade for a builder choosing a
 * size on the studio's behalf, and the wrong advice for an imported graph: a
 * custom graph's width/height reach ComfyUI unmodified, so the only thing
 * wrong with 720 is that it is not a multiple of 32, and the smallest fix that
 * keeps the author's framing is 704. Advising a 3x downscale to "fix" a
 * rounding error would be a silent downgrade of exactly the kind this codebase
 * keeps naming.
 */
export const snapDim = (n: number) => Math.max(DIM_STEP, pyRound(n / DIM_STEP) * DIM_STEP);

/**
 * Everything that would make this graph fail, or render something other than
 * what was asked for, on the given engine.
 *
 * The engine half is only checked when `env.classes` is populated — an empty
 * set means "we could not ask", and reporting every class as missing would be
 * worse than reporting nothing.
 */
export function validateGraph(api: ApiGraph, slots: SlotMap, env: TargetEnv = {}): ValidationIssue[] {
  const nodes = apiNodes(api);
  const issues: ValidationIssue[] = [];
  const add = (i: ValidationIssue) => issues.push(i);

  if (env.classes?.size) {
    const seen = new Set<string>();
    for (const n of nodes) {
      if (env.classes.has(n.class_type) || seen.has(n.class_type)) continue;
      seen.add(n.class_type);
      add({
        kind: "missing_node", level: "error", node: n.id, class_type: n.class_type,
        message: `${n.class_type} is not installed on the target engine`,
        hint: "install the pack that provides it, or replace the node with a core equivalent",
      });
    }
  }

  if (env.files) {
    for (const n of nodes) {
      for (const [k, v] of Object.entries(n.inputs)) {
        const pool = env.files[k];
        if (!pool || typeof v !== "string" || !pool.size) continue;
        // authors ship absolute Windows paths; compare on the basename too
        const base = v.split(/[\\/]/).pop() ?? v;
        if (pool.has(v) || pool.has(base)) continue;
        add({
          kind: "missing_model", level: "error", node: n.id, class_type: n.class_type,
          message: `${n.class_type} #${n.id}.${k} wants "${v}", which the engine does not have`,
          hint: `pick one of the ${pool.size} installed file(s) for ${k}`,
        });
      }
    }
  }

  // dangling links: an input pointing at a node that is not in the graph
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (!Array.isArray(v) || typeof v[0] !== "string") continue;
      if (api[v[0]]) continue;
      add({
        kind: "dangling_input", level: "error", node: n.id, class_type: n.class_type,
        message: `${n.class_type} #${n.id}.${k} points at node #${v[0]}, which is not in the graph`,
      });
    }
  }

  if (!slots.prompt) {
    add({ kind: "no_prompt", level: "warn",
      message: "no prompt input found — this graph renders the same thing every time",
      hint: "tag the node that takes the prompt by hand" });
  }
  if (!slots.output?.length) {
    // Name the preview nodes when that is what happened. "No output node" on a
    // graph that visibly ends in three PreviewImages reads as a detection bug,
    // and the fix (swap them for a Save node) is not guessable from it.
    const previews = Object.entries(api)
      .filter(([, n]) => PREVIEW_CLASSES.has(n.class_type))
      .map(([id, n]) => `#${id} ${n.class_type}`);
    add(previews.length
      ? { kind: "preview_only", level: "error",
          message: `this workflow only previews its result (${previews.join(", ")}) — nothing `
            + "is saved, so the job would finish with no asset",
          hint: "replace the preview node with a Save node in ComfyUI and re-import" }
      : { kind: "no_output", level: "error",
          message: "no output node — nothing is saved, so the job would finish with no asset" });
  }
  if (!slots.size) {
    add({ kind: "no_size", level: "warn",
      message: "no latent builder found — width, height and length are fixed by the graph" });
  }

  // H3's grids, checked only where an H3 node is what reads the numbers
  const h3 = nodes.find((n) => n.class_type.startsWith("MiniMaxH3"));
  if (h3 && slots.size) {
    const s = api[slots.size.node]?.inputs ?? {};
    const w = s.width, h = s.height;
    // Reported as a PAIR, because the fix is a pair: h3_snap_dims decides both
    // together (a native size wins only if it keeps the aspect), so advising
    // each axis on its own can name a size the worker would never choose.
    if (typeof w === "number" && typeof h === "number"
        && (w % DIM_STEP !== 0 || h % DIM_STEP !== 0)) {
      const [sw, sh] = [snapDim(w), snapDim(h)];
      add({
        kind: "bad_dims", level: "error", node: slots.size.node, class_type: slots.size.class_type,
        message: `${w}x${h} is not on MiniMax H3's ${DIM_STEP}px grid — the latent builder rejects it`,
        hint: `snap to ${sw}x${sh}`,
      });
    }
    const len = s.length;
    if (typeof len === "number" && !isH3Frames(len)) {
      add({
        kind: "bad_frames", level: "error", node: slots.size.node, class_type: slots.size.class_type,
        message: `length=${len} is not on MiniMax H3's 17n+5 frame grid`,
        hint: `use ${pad17(len)}`,
      });
    }
  }

  return issues;
}

/** The classes a graph needs, so an import can say what has to be installed. */
export function requiredClasses(api: ApiGraph): string[] {
  return [...new Set(apiNodes(api).map((n) => n.class_type))].sort();
}

/** Every filename a graph names, by loader input — what a download manager
 *  has to fetch before the graph can run. */
export function requiredFiles(api: ApiGraph): { input: string; value: string; class_type: string }[] {
  const FILE_INPUTS = new Set([
    "unet_name", "ckpt_name", "vae_name", "clip_name", "clip_name1", "clip_name2",
    "lora_name", "model_name", "control_net_name", "style_model_name", "upscale_model",
  ]);
  const out: { input: string; value: string; class_type: string }[] = [];
  for (const n of apiNodes(api)) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (FILE_INPUTS.has(k) && typeof v === "string" && v) {
        out.push({ input: k, value: v, class_type: n.class_type });
      }
    }
  }
  return out;
}

/** Write the studio's values into a tagged graph. Pure — returns a copy, so an
 *  imported graph is never mutated by a render. */
export function applySlots(api: ApiGraph, slots: SlotMap, values: {
  prompt?: string; negative?: string; seed?: number;
  width?: number; height?: number; length?: number;
  start_frame?: string; end_frame?: string;
}): ApiGraph {
  const out: ApiGraph = JSON.parse(JSON.stringify(api));
  const put = (slot: Slot | undefined, v: unknown) => {
    if (!slot || v === undefined || !out[slot.node]) return;
    out[slot.node].inputs[slot.input] = v;
  };
  put(slots.prompt, values.prompt);
  put(slots.negative, values.negative);
  put(slots.seed, values.seed);
  put(slots.start_frame, values.start_frame);
  put(slots.end_frame, values.end_frame);
  if (slots.size && out[slots.size.node]) {
    const inp = out[slots.size.node].inputs;
    if (slots.size.width && values.width !== undefined) inp[slots.size.width] = values.width;
    if (slots.size.height && values.height !== undefined) inp[slots.size.height] = values.height;
    if (slots.size.length && values.length !== undefined) inp[slots.size.length] = values.length;
  }
  return out;
}

/* ── API → UI, so a graph can be OPENED in ComfyUI's own editor ─────────── */

/** Laid-out columns. Nothing here is load-bearing; it just has to be legible. */
const COL_W = 380;
const ROW_H = 190;

/**
 * Turn an API graph into one ComfyUI's editor can open.
 *
 * WHY THIS HAS TO EXIST. ComfyUI's workflow browser reads
 * `user/default/workflows/*.json` and expects a UI document — nodes with
 * positions and a POSITIONAL `widgets_values` array. Handed an API graph it
 * opens a tab and draws NOTHING: measured, on a real 0.33 engine with our own
 * `minimax_h3_flf.json`, which is the worst possible failure — a tab named
 * after your workflow with an empty canvas in it. Every template this repo
 * ships is API format (that is what the worker executes), so without this
 * there is nothing to open.
 *
 * IT IS THE EXACT INVERSE OF `uiToApi`, AND THAT IS THE TEST. `widgetNames`
 * already knows the one thing that makes positional widgets hard — ComfyUI
 * appends a UI-only value after a seed (`control_after_generate`), so a naive
 * zip puts "fixed" into the input after it — and that knowledge is shared
 * rather than re-derived here. The property that keeps this honest is a round
 * trip: `uiToApi(apiToUi(g))` must equal `g`, which is asserted over every
 * template in the repo. A converter checked only by eye is one that silently
 * writes a value into the wrong widget.
 *
 * WITHOUT A SCHEMA it falls back to `FALLBACK_WIDGETS`, and a class in neither
 * is reported UNMAPPED rather than guessed at — the same rule the other
 * direction follows, for the same reason.
 */
export function apiToUi(api: ApiGraph, objectInfo?: ObjectInfo): {
  graph: UiGraph;
  warnings: string[];
  /** classes whose widget order is unknown, so their values were left out */
  unmapped: string[];
  /** `#node.input` pairs the editor's format has no slot for, so their values
   *  do NOT carry across. Reported rather than dropped in silence: a widget
   *  the schema does not mention is a value that would simply be gone from the
   *  graph you opened, with the node still looking complete. */
  dropped: string[];
} {
  const warnings: string[] = [];
  const unmapped = new Set<string>();
  const dropped: string[] = [];
  const ids = Object.keys(api).filter((k) => !k.startsWith("_"));

  // Column by longest path from a source, so the graph reads left to right the
  // way a hand-built one does.
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;               // a cycle is not ours to fix
    seen.add(id);
    let d = 0;
    for (const v of Object.values(api[id]?.inputs ?? {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string") {
        d = Math.max(d, depthOf(v[0], seen) + 1);
      }
    }
    depth.set(id, d);
    return d;
  };
  for (const id of ids) depthOf(id);

  const perCol = new Map<number, number>();
  const links: UiLink[] = [];
  let linkId = 0;
  // Output slot bookkeeping: a link needs the ORIGIN's slot index, which is
  // the position of that output in the class's own output list.
  const outputsOf = (cls: string): { name: string; type: string }[] => {
    const spec = objectInfo?.[cls];
    const types = (spec?.output ?? []) as unknown[];
    const names = ((spec as unknown as Record<string, unknown>)?.output_name ?? []) as unknown[];
    return types.map((t, i) => {
      const type = Array.isArray(t) ? "COMBO" : String(t);
      return { name: String(names[i] ?? type), type };
    });
  };

  const nodes: UiNode[] = ids.map((id) => {
    const n = api[id];
    const cls = n.class_type;
    const spec = objectInfo?.[cls];
    const col = depth.get(id) ?? 0;
    const row = perCol.get(col) ?? 0;
    perCol.set(col, row + 1);

    // Widgets, in the order the editor serialises them. A link input never
    // contributes a value; a widget with no value in the API graph keeps its
    // slot with null, because dropping it would shift everything after it.
    const order = spec ? widgetNames(spec) : FALLBACK_WIDGETS[cls];
    let widgets_values: unknown[] | undefined;
    if (order) {
      const entries = { ...spec?.input?.required, ...spec?.input?.optional };
      widgets_values = order.map((name) => {
        if (name === CONTROL_SLOT) return "fixed";
        const v = n.inputs?.[name];
        if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string") return null;
        if (v !== undefined) return v;
        // The slot has to exist or everything after it shifts, so an input the
        // graph does not set takes the class's own default — which is what
        // ComfyUI would have applied anyway — and null only when we have none.
        const e = entries[name];
        const opts = Array.isArray(e) && e.length > 1 ? e[1] as Record<string, unknown> : null;
        if (opts && "default" in opts) return opts.default;
        const list = Array.isArray(e) && Array.isArray(e[0]) ? e[0] as unknown[] : null;
        return list?.[0] ?? null;
      });
      // Anything the graph sets that has no slot at all cannot travel.
      const known = new Set(order);
      for (const [k, v] of Object.entries(n.inputs ?? {})) {
        const wired = Array.isArray(v) && v.length === 2 && typeof v[0] === "string";
        if (!wired && !known.has(k)) dropped.push(`#${id}.${k}`);
      }
    } else {
      unmapped.add(cls);
    }

    // Link inputs, in the schema's order where we have one so the slot indexes
    // match what the editor would have written.
    const linkNames = spec
      ? Object.entries({ ...spec.input?.required, ...spec.input?.optional })
          .filter(([, e]) => !isWidgetEntry(e)).map(([k]) => k)
      : Object.entries(n.inputs ?? {})
          .filter(([, v]) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string")
          .map(([k]) => k);
    const inputs: UiNodeInput[] = [];
    for (const name of linkNames) {
      const v = n.inputs?.[name];
      const wired = Array.isArray(v) && v.length === 2 && typeof v[0] === "string";
      if (!wired && !spec) continue;              // no schema: only real wires
      let link: number | null = null;
      if (wired) {
        const [from, slot] = v as [string, number];
        if (api[from]) {
          link = ++linkId;
          const outs = outputsOf(api[from].class_type);
          links.push([link, from, Number(slot) || 0, id, inputs.length,
                      outs[Number(slot) || 0]?.type ?? "*"]);
        } else {
          warnings.push(`#${id}.${name} points at #${from}, which is not in the graph`);
        }
      }
      const entry = { ...spec?.input?.required, ...spec?.input?.optional }[name];
      const type = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : "*";
      inputs.push({ name, type, link });
    }

    // AUTOGROW SLOTS ARE NOT IN THE SCHEMA, and dropping one silently is the
    // worst thing here: `ref_images.ref_image_0` is a staged reference, so a
    // "converted" H3 r2v graph would open having quietly lost its pictures.
    // The class declares the GROUP (`ref_images`) and the node creates the
    // numbered slots when something is wired to them, which is exactly what
    // the serialised graph carries — so anything still wired after the
    // schema pass is appended as its own slot rather than thrown away.
    for (const [name, v] of Object.entries(n.inputs ?? {})) {
      const wired = Array.isArray(v) && v.length === 2 && typeof v[0] === "string";
      if (!wired || inputs.some((i) => i.name === name)) continue;
      const [from, slot] = v as [string, number];
      if (!api[from]) {
        warnings.push(`#${id}.${name} points at #${from}, which is not in the graph`);
        continue;
      }
      const link = ++linkId;
      const outs = outputsOf(api[from].class_type);
      links.push([link, from, Number(slot) || 0, id, inputs.length,
                  outs[Number(slot) || 0]?.type ?? "*"]);
      inputs.push({ name, type: outs[Number(slot) || 0]?.type ?? "*", link });
    }

    const outs = outputsOf(cls).map((o, i) => ({
      name: o.name, type: o.type, slot_index: i,
      links: [] as number[],
    }));

    return {
      id, type: cls, mode: 0,
      pos: [80 + col * COL_W, 80 + row * ROW_H],
      size: [300, 100],
      flags: {}, order: col,
      inputs, outputs: outs,
      properties: { "Node name for S&R": cls },
      ...(widgets_values ? { widgets_values } : {}),
      ...(n._meta?.title ? { title: n._meta.title } : {}),
    } as UiNode;
  });

  // Fill each output's link list now that every link exists.
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  for (const [id, from, slot] of links) {
    const out = byId.get(String(from))?.outputs?.[slot];
    if (out) (out.links as number[]).push(id);
  }

  if (unmapped.size) {
    warnings.push(`no widget order for ${[...unmapped].join(", ")} — their values were left out `
      + "rather than written into the wrong slot. Open this with the engine running to fill them.");
  }
  if (dropped.length) {
    warnings.push(`${dropped.join(", ")} ${dropped.length === 1 ? "has" : "have"} no widget slot `
      + "in the editor's format, so the value does not carry across");
  }

  return {
    graph: {
      nodes, links, groups: [],
      extra: {}, ...({ last_node_id: ids.length, last_link_id: linkId, version: 0.4 }),
    } as UiGraph,
    warnings, unmapped: [...unmapped], dropped,
  };
}
