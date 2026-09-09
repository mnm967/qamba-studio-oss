// WHAT EACH FINISHING PASS NEEDS BEFORE IT CAN RUN ON THIS MACHINE.
//
// The place picker's first version asked four questions about the machine —
// is this a desktop build, is the Python installed, is there an ffmpeg, is the
// engine up — and then offered "On this machine" for a chain of passes whose
// WEIGHTS might be nowhere on the disk. `apply_upscale` raises on a checkpoint
// it cannot find and `_require_nodes` raises on a class the engine does not
// have, so the render was guaranteed to fail — after SeedVR2 and LTX had
// already spent twenty minutes on the clips ahead of the one that failed.
//
// THE PRECEDENT IS `renderableHere`, which asks exactly this of a BLOCK render
// ("a key this build does not carry can never render here, and one whose 57GB
// is not downloaded is a job that would fail on its first resolve") and hands
// back the missing files so the engine window can be pointed at them. This is
// that, per post pass.
//
// TWO KINDS OF GAP, and they are not the same offer:
//
//   WEIGHTS   are a download — an engineCatalog row or a model_map entry — so
//             the gap is a button onto the Models tab.
//   NODES     are a custom pack. `install_engine` adds seven, KJNodes and
//             H3-FaceRefine among them, so `color_match` and `h3_facefix` are
//             a download away rather than impossible. IMPACT IS NOT among
//             them, deliberately — `facefix` is retired — so on OUR engine
//             that pass has nowhere to come from and the honest answer is
//             "turn it off or render in the cloud" rather than a button that
//             cannot help. A LINKED ComfyUI may well have it, which is why
//             this is measured against the engine's own class list rather
//             than assumed from a hard-coded list of what we install.
//
// PURE. `postLocalGaps` is a comparison between a requirement table and an
// inventory; gathering the inventory is `renderPlace.renderPlaceFacts`.
import { POST_OP, type PostOpId, type PostOptions } from "./postChain.ts";
import { POST_PROCESS, type PostTool } from "./engineCatalog.ts";

/** What one pass demands of the machine. */
export interface OpNeed {
  /** engineCatalog POST_PROCESS row ids — each is one Get button. */
  tools: string[];
  /** model_map keys, judged by `desktop_render_models` (which follows a
   *  linked ComfyUI's tree and the quantisation rungs, so it is a better
   *  answer than a filename comparison would be). */
  models: string[];
  /** ComfyUI class names `_require_nodes` will demand. Only the ones a pass
   *  ALWAYS needs — the conditional ones (`LTXVLatentUpsampler` on a 2x
   *  refine, `VAEDecodeTiled` above 1080p) are deliberately absent: they
   *  depend on the clip as well as the settings, and a gate that guessed
   *  wrong would refuse a render that would have worked. */
  nodes: string[];
}

const NONE: OpNeed = { tools: [], models: [], nodes: [] };

/**
 * The requirement table, twinned with `worker/handlers/post.py`'s own
 * `_require_nodes` calls and `load_map()` reads — `postLocal.test.ts` parses
 * that file and fails when the two disagree, because a requirement that has
 * quietly stopped being one is a render this refuses for no reason, and one
 * that has quietly started is the failure this module exists to prevent.
 */
export function needsFor(op: PostOpId, opts: PostOptions): OpNeed {
  switch (op) {
    case "upscale":
      return {
        // The catalogue files a SeedVR2 checkpoint per row and the setting
        // names the same three by their bare size, so the row id is derivable
        // rather than a second table to keep in step. Pinned.
        tools: [`seedvr2-${opts.post_upscale_model}`],
        models: [],
        // CORE since ComfyUI v0.28.0 — the pass spent its life gated on a
        // third-party pack that was never installed here.
        nodes: ["SeedVR2Preprocess", "SeedVR2Conditioning", "SeedVR2PostProcessing"],
      };
    case "ltx_refine":
      return { tools: [], models: ["ltx-25"],
               nodes: ["LTXVConcatAVLatent", "LTXVAudioVAEEncode"] };
    case "interpolate":
      // One row carrying BOTH weights (FILM and RIFE, 92MB together), which is
      // also what the pass picks between at render time.
      return { tools: ["frame-interp"], models: [],
               nodes: ["FrameInterpolationModelLoader", "FrameInterpolate"] };
    case "facefix":
      // Krea 2 is what the detailer re-samples through — `_image_model` reads
      // `image_models["krea2"]`, and it names the entry rather than raising a
      // KeyError on a machine whose map predates the encoder's substitution.
      // The DETECTOR is the other half and it is not optional: both face
      // passes default `detector="bbox/face_yolov8m.pt"`, so without it the
      // Subpack's provider has an empty dropdown and ComfyUI rejects the
      // prompt on a value nobody chose.
      //
      // NOTE the engine installer does NOT add Impact (this pass is retired),
      // so on our own engine the node gap below always fires and the weights
      // never get asked about. Both are still listed: a LINKED ComfyUI can
      // have the pack, and the pass is still selectable.
      return { tools: ["face-detector"], models: ["krea2"],
               nodes: ["FaceDetailer", "UltralyticsDetectorProvider"] };
    case "h3_facefix":
      return {
        // The SAME detector file — `H3FaceTrackCrop` takes it directly. One
        // download serves either pass.
        tools: ["face-detector"], models: ["minimax-h3"],
        // `VRGDG_MiniMaxH3AudioDrive` is left out on purpose: the pass only
        // asks for it when the CLIP has audio, which this cannot know.
        nodes: ["H3FaceTrackCrop", "H3InjectVideoLatent", "H3PerFrameDenoise",
                "H3FaceStitch", "MiniMaxH3ReferenceToVideo"],
      };
    case "color_match":
      // The transfer runs on whichever of the two KJNodes classes is present
      // (`_color_match_node` prefers V2), so EITHER satisfies it — expressed
      // as the newest, with `nodeAlternatives` carrying the fallback. The
      // learned-LUT grade is a different pack AND a 4.1GB checkpoint that the
      // engine window cannot fetch, so it is a node gap here, not a download.
      return {
        tools: [], models: [],
        nodes: opts.post_grade_method === "vcg"
          ? ["VCGLoadModel", "VCGGenerateLUT", "VCGApplyLUT"]
          : ["ColorMatchV2"],
      };
    case "grain":
      return NONE;   // ffmpeg, which the place check already asked about
    default:
      return NONE;
  }
}

/** Classes any ONE of which satisfies a requirement. Keyed by the class the
 *  table names, so the table stays readable. */
const NODE_ALTERNATIVES: Record<string, string[]> = {
  // `ColorMatch` is DEPRECATED upstream and still ships; `_color_match_node`
  // resolves the pair newest-first against the live engine and falls back.
  ColorMatchV2: ["ColorMatchV2", "ColorMatch"],
};

/** Everything this machine has to answer with. */
export interface Inventory {
  /** Every model file present, by bare filename — `engineStatus().files`,
   *  which spans every model directory and follows a linked ComfyUI. */
  files: ReadonlySet<string>;
  /** The engine's own class names. NULL means the engine is not running and
   *  nothing was asked; a node gap is then never REPORTED, because "I could
   *  not look" and "it is absent" are different answers and only one of them
   *  should refuse a render. The place check already blocks a ComfyUI chain
   *  on a dead engine, so this is not a hole. */
  nodes: ReadonlySet<string> | null;
  /** `desktop_render_models`, by model_map key. A key that is ABSENT from the
   *  map is a different gap from one that is present and not downloaded. */
  models: ReadonlyMap<string, { ready: boolean; missing: string[] }>;
}

export interface OpGap {
  op: PostOpId;
  label: string;
  /** Downloadable rows, named for the sentence and the Models tab. */
  downloads: { id: string; name: string; sizeMb: number }[];
  /** model_map entries not on this disk yet, with how much is missing. */
  models: { key: string; missing: number; first: string }[];
  /** Entries the desktop map does not carry AT ALL — no download exists. */
  unsupported: string[];
  /** Classes the running engine does not have. Not a download. */
  nodes: string[];
}

const toolById = (id: string): PostTool | undefined =>
  POST_PROCESS.find((t) => t.id === id);

const toolMissing = (t: PostTool, files: ReadonlySet<string>) =>
  t.files.some((f) => !files.has(f.filename));

const toolMb = (t: PostTool) =>
  // The DISTINCT files: SeedVR2's three rows share one VAE, and counting a
  // shared file once per row would quote a download half a gigabyte too big.
  Math.round(t.files.reduce((n, f) => n + (f.size_mb ?? 0), 0));

/**
 * Every reason the active chain could not run here, one entry per pass.
 *
 * Empty means every pass this cut would run has what it needs. A pass with
 * nothing missing contributes nothing, so the common case is an empty array
 * and no sentence at all.
 */
export function postLocalGaps(
  ops: readonly PostOpId[], opts: PostOptions, inv: Inventory,
): OpGap[] {
  const out: OpGap[] = [];
  for (const op of ops) {
    const need = needsFor(op, opts);
    const gap: OpGap = {
      op, label: POST_OP[op]?.label ?? op,
      downloads: [], models: [], unsupported: [], nodes: [],
    };

    for (const id of need.tools) {
      const t = toolById(id);
      // A row the catalogue does not carry is a bug in the table above, not a
      // state of the machine — reported as unsupported rather than silently
      // skipped, which would let the pass through and fail at render time.
      if (!t) { gap.unsupported.push(id); continue; }
      if (toolMissing(t, inv.files)) {
        gap.downloads.push({ id: t.id, name: t.name, sizeMb: toolMb(t) });
      }
    }

    for (const key of need.models) {
      const m = inv.models.get(key);
      if (!m) { gap.unsupported.push(key); continue; }
      if (!m.ready) {
        gap.models.push({ key, missing: m.missing.length, first: m.missing[0] ?? "" });
      }
    }

    if (inv.nodes) {
      for (const cls of need.nodes) {
        const any = NODE_ALTERNATIVES[cls] ?? [cls];
        if (!any.some((c) => inv.nodes!.has(c))) gap.nodes.push(cls);
      }
    }

    if (gap.downloads.length || gap.models.length
        || gap.unsupported.length || gap.nodes.length) {
      out.push(gap);
    }
  }
  return out;
}

/* ── saying it ──────────────────────────────────────────────────────────── */

/** One line per gap, for the picker. `detail` is what to do about it. */
export interface GapLine { label: string; detail: string; fixable: boolean }

const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

/** Human names for the model_map keys a pass can want. The map's own keys are
 *  what the worker resolves; these are what a person reads. */
const MODEL_NAME: Record<string, string> = {
  "ltx-25": "LTX 2.5", "minimax-h3": "MiniMax H3", krea2: "Krea 2",
};

export function gapLines(gaps: readonly OpGap[]): GapLine[] {
  const out: GapLine[] = [];
  // ONE LINE PER THING TO DO, not one per pass that wants it. Both face passes
  // name the same detector, so a chain with both on listed "Face detector —
  // YOLOv8m · 50 MB" twice — which reads as a bug in the list rather than as
  // two passes agreeing. The label is the right key: a download's is its
  // catalogue name and a node line's carries its own pass, so nothing that is
  // genuinely two things collapses into one.
  const seen = new Set<string>();
  const push = (l: GapLine) => { if (!seen.has(l.label)) { seen.add(l.label); out.push(l); } };
  for (const g of gaps) {
    for (const d of g.downloads) {
      push({ label: d.name, detail: gb(d.sizeMb), fixable: true });
    }
    for (const m of g.models) {
      push({
        label: MODEL_NAME[m.key] ?? m.key,
        // The same shape `renderableHere` reports a part-fetched model in:
        // the count is what says whether this is a whole download or the tail
        // of one that was interrupted.
        detail: `${m.missing} file${m.missing === 1 ? "" : "s"} missing`
          + (m.first ? ` — ${m.first}` : ""),
        fixable: true,
      });
    }
    for (const key of g.unsupported) {
      push({
        label: `${g.label} — ${MODEL_NAME[key] ?? key}`,
        detail: "this build cannot download it",
        fixable: false,
      });
    }
    if (g.nodes.length) {
      push({
        label: `${g.label} — ComfyUI nodes`,
        detail: `your engine has no ${g.nodes[0]}`
          + (g.nodes.length > 1 ? ` (+${g.nodes.length - 1} more)` : ""),
        fixable: false,
      });
    }
  }
  return out;
}

/**
 * The one-sentence version, naming the PASSES rather than the files.
 *
 * Which passes is what the reader can act on without leaving the modal: the
 * post card is directly above, and turning one off clears this in a click.
 * The list of files is the detail underneath.
 */
export function gapSentence(gaps: readonly OpGap[]): string {
  const names = gaps.map((g) => g.label.replace(/\s*\(.*\)$/, ""));
  const list = names.length === 1 ? names[0]
    : names.length === 2 ? `${names[0]} and ${names[1]}`
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const onlyDownloads = gaps.every((g) => !g.nodes.length && !g.unsupported.length);
  if (!onlyDownloads) {
    return `${list} cannot run on this machine yet`;
  }
  // AGREE IN NUMBER, both times. One pass reads "Upscale needs", several read
  // "Upscale and Refine need"; one download reads "a model", several read
  // "models". Getting either wrong is the sort of thing a reader notices
  // before they notice what the sentence is telling them.
  const verb = gaps.length === 1 ? "needs" : "need";
  const items = gaps.reduce((n, g) => n + g.downloads.length + g.models.length, 0);
  const what = items === 1 ? "a model" : "models";
  return `${list} ${verb} ${what} this computer does not have yet`;
}
