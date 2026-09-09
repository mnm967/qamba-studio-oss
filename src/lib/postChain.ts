// The post chain: which finishing passes a clip gets in the FINAL render.
//
// Two things this module exists to keep straight.
//
// A toggle used to enqueue its GPU job the instant you flipped it. So "I'd like
// grain on this shot" spent pod time immediately, on whichever take happened to
// be active, and the result landed as a derived `assets` row that nothing on
// the timeline pointed at — the clip still played the un-graded take, and the
// switch read as "applied" because a job existed. Post is stored INTENT now:
// `clips.post` records it, `tl_render` applies it, and nothing runs until you
// render.
//
// And a clip either INHERITS the project's chain or overrides it. `null` means
// inherit — NOT "no passes" — so turning grain on for the project reaches every
// clip that never asked for something different, and a clip that genuinely
// wants nothing stores `{}` (custom, all off). Collapsing those two into one
// value is how "I set it on the project and half the timeline ignored it"
// happens.
//
// Dependency-free on purpose (same reason as realtimeTables.ts): db/types.ts
// imports PostChain from here, and the worker's twin is worker/post_chain.py.

export type PostOpId = "upscale" | "ltx_refine" | "interpolate" | "facefix"
  | "h3_facefix" | "color_match" | "grain";

/** Only the ops that are ON need a key; absent reads as off. */
export type PostChain = Partial<Record<PostOpId, boolean>>;

export interface PostOpDef {
  id: PostOpId;
  label: string;
  /** Drives ComfyUI. Decides the render's lane — see chainNeedsGpu. */
  gpu: boolean;
  /** Which side of the clip's normalize step the worker runs this on.
   *  `source` = on the clip's own [in, out] window at the take's geometry,
   *  before ops/fit (an upscaler wants the original pixels — but only of the
   *  frames the cut keeps: running these on the whole downloaded take is what
   *  made a render OOM, see worker/handlers/render.source_window);
   *  `finish` = on the normalized frame (grain applied at source resolution
   *  and then rescaled is mush). Mirrors POST_STAGE in worker/post_chain.py;
   *  the UI does not branch on it, the render does. */
  stage: "source" | "finish";
  hint: string;
  /** Set where the pass needs something the pod does not have.
   *
   *  Currently unset on every op, and getting there is the interesting part.
   *  Three of the five carried one and ALL THREE WERE WRONG (verified against
   *  the live pod 2026-08-23): `upscale` waited on numz's SeedVR2 pack, but
   *  SeedVR2 is CORE ComfyUI since v0.28.0; `color_match` waited on VRGDG's
   *  ColorMatchToReference, but KJNodes' ColorMatch was installed all along;
   *  `facefix` was right about Impact, which is now installed pinned. What
   *  those two actually lacked was WEIGHTS, which no label mentioned.
   *
   *  And it was wrong in the other direction too, which is worse: `interpolate`
   *  carried NO warning while its node (`RIFE VFI`) was equally absent — so the
   *  one pass that would certainly fail was the one presented as fine. Core
   *  supplies it now as FrameInterpolate.
   *
   *  So: keep this in step with the pod, and prefer checking /object_info over
   *  trusting the label. Surfaced, not hidden — a render that requests an
   *  unavailable pass FAILS by name rather than quietly finishing without it. */
  unavailable?: string;
  /** RETIRED: still understood, no longer OFFERED. The op stays in POST_ORDER,
   *  in the worker and in `describeChain` — stored chains keep their meaning
   *  and an old render still reproduces — but the pickers stop listing it, so
   *  it cannot be turned back ON.
   *
   *  Retiring rather than deleting, because deleting is the silent half: the
   *  worker reads the project's chain off the row itself (that is how a clip
   *  inherits one), so an op dropped from this list on the browser side alone
   *  goes on running with nothing on screen naming it. And `offeredOps` keeps
   *  showing a retired pass while it is ON for the same reason — the row is
   *  how you turn it off, and a project already carrying one would otherwise
   *  render a pass it can neither see nor stop.
   *
   *  The string is the reason, shown on the row. */
  retired?: string;
}

/** Mastering canon order — restore, refine, then frame rate, then faces, then
 *  grade, then grain. Restore before refine so the generative pass is handed
 *  clean pixels; interpolate after both so the new frames are made from the
 *  final picture rather than being resynthesised out from under it.
 *  Grain last is the point of grain: it must sit on top of everything, or the
 *  upscaler treats it as detail and sharpens the noise. */
export const POST_ORDER: PostOpId[] = ["upscale", "ltx_refine", "interpolate",
  "facefix", "h3_facefix", "color_match", "grain"];

export const POST_OPS: PostOpDef[] = [
  {
    id: "upscale", label: "Upscale (SeedVR2)", gpu: true, stage: "source",
    hint: "Restores and re-detects detail before the frame is fitted to the "
        + "timeline — a restore pass, not just a bigger picture. Preserves the "
        + "take: use this when the shot is right and only the pixels are soft. "
        + "~150s for 2s of 1280x704 — it samples in ONE step. 3B by default; "
        + "7B is the same pass on a bigger checkpoint.",
  },
  {
    id: "ltx_refine", label: "Refine (LTX 2.5)", gpu: true, stage: "source",
    hint: "Re-samples the shot through LTX 2.5 at low denoise — the second "
        + "pass of its own pipeline, run over footage. Sharper than a restore "
        + "and it will move the look, because it regenerates rather than "
        + "recovers. Keeps the original soundtrack. ~315s for 2s, including "
        + "LTX's cold load. How far it travels, and at what size, are settings "
        + "below.",
  },
  {
    id: "interpolate", label: "Interpolate (FILM / RIFE)", gpu: true, stage: "source",
    hint: "Doubles the frame rate. Only changes the output when the timeline "
        + "runs faster than the source — at matching fps the extra frames are "
        + "resampled straight back out. Nearly free: 3-6s for 2s of footage.",
  },
  {
    id: "facefix", label: "Face Detailer", gpu: true, stage: "source",
    // SUPERSEDED BY `h3_facefix`, and the measurement is in that op's hint:
    // per-frame inpainting through an image model that never saw the shot has
    // no temporal term at all, so it ADDS 22% frame-to-frame movement to the
    // face it is meant to fix, at ~7s a frame. The H3 pass is steadier (1.02x
    // against 1.22x), 2.6x faster, and generative-vs-restore is a choice you
    // still have between `ltx_refine` and `upscale`.
    retired: "Retired — use Face Refine (H3)",
    hint: "Per-frame face restore. Genuinely expensive — one diffusion pass "
        + "per face per frame, measured at ~7s per frame, so a 12s shot is "
        + "over half an hour. Hero shots only.",
  },
  {
    id: "h3_facefix", label: "Face Refine (H3)", gpu: true, stage: "source",
    // MEASURED against the detailer on one clip (2026-09-05, 48 frames of
    // 1280x736, face ~14% of frame height, same seed). The two numbers point
    // OPPOSITE WAYS and the hint says so, because a switch that claims the
    // wrong one of them is how somebody spends GPU time on the wrong pass.
    hint: "Tracks the face and re-generates the whole sequence through H3 in "
        + "ONE pass, so it is STEADY where the detailer shimmers: measured at "
        + "1.02x the source's own frame-to-frame movement in the face, against "
        + "the detailer's 1.22x. It is NOT the sharper one — on anime the "
        + "detailer came back visibly crisper at every canvas, and this moves "
        + "the face further from the original (0.87 vs 0.96). Reach for it "
        + "when a face is small in frame and FLICKERS; reach for the detailer "
        + "when one frame has to look its best. ~100s for 2s at 768, about "
        + "2.6x faster than the detailer. An alternative to it, not a stack.",
  },
  {
    id: "color_match", label: "Color Match", gpu: true, stage: "finish",
    hint: "Matches this clip's grade to the project's grade reference — the "
        + "shot whose colour the rest of the cut should follow. Pick it right "
        + "below this switch; without one the render fails rather than "
        + "delivering the clip ungraded. ~6s for 2s.",
  },
  {
    id: "grain", label: "Film Grain", gpu: false, stage: "finish",
    hint: "Temporal film grain over the finished frame, after it is fitted to "
        + "the timeline. Needs no models, so it runs anywhere.",
  },
];

export const POST_OP = Object.fromEntries(POST_OPS.map((o) => [o.id, o])) as Record<PostOpId, PostOpDef>;

/* ───────────────────────────────────────────── how a pass is tuned ─────── */
// Twin of POST_OPTS / REFINE_SIZES in worker/handlers/render.py and of
// LTX_REFINE_PRESETS / SEEDVR2_MODELS in worker/graphs.py, pinned across the
// two languages by postChain.test.ts. These are KEYS, never filenames or sigma
// strings: a settings row holding `seedvr2_7b_int8_convrot.safetensors` is a
// render that dies inside ComfyUI on an enum the day the box is re-fetched,
// and the browser has no business knowing what is on the pod's disk.
//
// PROJECT-WIDE, like the grade reference and for the same reason — a cut whose
// shots were refined at different strengths does not agree with itself.

export type RefineSize = "native" | "fit" | "2x";
export type RefineSigmas = "" | "faithful" | "native" | "balanced" | "sharp";
export type UpscaleModelId = "3b" | "7b" | "7b-sharp";

export const REFINE_SIZES: { id: RefineSize; label: string; hint: string }[] = [
  { id: "native", label: "Native", hint:
    "Sample at the take's own frame. Detail only, and the cheapest of the "
    + "three — nothing is resized, so nothing is resampled." },
  { id: "fit", label: "Delivery frame", hint:
    "Enlarge to the size the cut delivers, then refine — a lanczos resize in "
    + "front of the sampler, so any size and any shape works. MEASURED the "
    + "cheapest of the three enlarges (30s against x2's 40s on a 2s shot) and "
    + "the one that moves the picture least, but it adds almost no detail: on "
    + "a real take it came back 3% SOFTER than the source at 0.976 "
    + "correlation. Reach for it to reframe cheaply, not to sharpen. Capped "
    + "at 2x, and it falls back to native when the take is already the "
    + "delivery size." },
  { id: "2x", label: "LTX x2 upsampler", hint:
    "LTX's own learned latent upsampler, and MEASURED the only refine mode "
    + "that really adds detail — +47% edge energy at the delivered frame "
    + "against the delivery frame's -3%, because the detail comes from the "
    + "upsampler rather than from the extra sampling. It costs a third more "
    + "time and moves the shot more (0.952 correlation), and the ratio is "
    + "FIXED at 2. If you want sharper and the take must survive intact, the "
    + "SeedVR2 restore beat every refine mode here." },
];

export const REFINE_SIGMA_PRESETS: { id: RefineSigmas; label: string; hint: string }[] = [
  { id: "", label: "Match the size", hint:
    "Let the size mode choose: a low start when nothing is being enlarged, a "
    + "high one when new detail has to be invented. This is what every render "
    + "before these settings used." },
  { id: "faithful", label: "Faithful", hint:
    "0.35 → 0. The shortest trip: sharpen the take without letting the "
    + "sampler re-decide it. Reach for this when identity or wardrobe drifts." },
  { id: "native", label: "Light", hint: "0.55 → 0. The studio's own native-size default." },
  { id: "balanced", label: "Balanced", hint: "0.7 → 0. More freedom, more detail, more drift." },
  { id: "sharp", label: "Sharp", hint:
    "0.85 → 0. LTX's own high-resolution refine schedule — a lot of denoise. "
    + "Right after a 2x upsample, where there is genuinely new detail to "
    + "invent; on a native-size pass it re-decides the shot." },
];

export const UPSCALE_MODELS: { id: UpscaleModelId; label: string; hint: string }[] = [
  { id: "3b", label: "SeedVR2 3B", hint:
    "The default, and MEASURED the sharpest pass in the whole chain: +160% "
    + "edge energy at the delivered frame while holding 0.970 correlation to "
    + "the source — more detail than any refine mode, and less drift. 3.5GB, "
    + "77s for 2s of 1280x704." },
  { id: "7b", label: "SeedVR2 7B", hint:
    "The larger checkpoint: same architecture, same one-step recipe, same "
    + "VAE, ~8.3GB. MEASURED THE SOFTEST OF THE THREE, twice — +27% edge "
    + "energy at 1080p and +40% at 4K, against the 3B's +160% and +95%. "
    + "Bigger is not better on this footage; if you want a 7B, take the "
    + "sharp one. Needs the SeedVR2 7B weights (Engine window › Models)." },
  { id: "7b-sharp", label: "SeedVR2 7B (sharp)", hint:
    "ByteDance's second 7B checkpoint, and it does what its name says: "
    + "MEASURED about 2.5x the detail of the plain 7B (+67% against +27% at "
    + "1080p, +51% against +40% at 4K), with slightly less drift than the 3B. "
    + "Still short of the 3B on detail, so take it when the take must move as "
    + "little as possible. Needs the SeedVR2 7B (sharp) weights (Engine window › Models)." },
];

export type GradeMethod =
  | "mkl" | "hm" | "reinhard" | "mvgd" | "hm-mkl-hm"
  | "reinhard_lab_gpu" | "vcg";

/** WHICH colour transfer the grade runs. All of these are the one node's own
 *  algorithms, so this is a look, not a pipeline change — and each fits the
 *  clip's whole distribution to the reference's, which is why the reference is
 *  one frame (a contact sheet, in source mode).
 *
 *  `reinhard_lab_gpu` is ColorMatchV2-only. The worker REFUSES it on a pod
 *  that has neither the node nor the method rather than falling back to mkl:
 *  a cut grades consistently by construction, so a silent substitution is
 *  invisible in the one place you would look for it.
 *
 *  Twin of graphs.COLOR_MATCH_METHODS. */
export const GRADE_METHODS: { id: GradeMethod; label: string; hint: string }[] = [
  { id: "mkl", label: "MKL", hint:
    "The default. Monge-Kantorovich: one linear transform fitted to the full "
    + "colour covariance, so it moves the whole distribution rather than "
    + "clipping it. MEASURED the closest match to a reference of anything "
    + "here (gap 0.002-0.010 across six shots) — which is what it optimises "
    + "for, so read it that way: it makes a shot's colour STATISTICS match, "
    + "and against a warm reference that drives every shot amber whether it "
    + "was a night city or a daylight exterior." },
  { id: "vcg", label: "Learned LUT (VCG)", hint:
    "Generates a 3D LUT from the reference with a diffusion model, then "
    + "applies it — so unlike everything else here it can map different parts "
    + "of the colour cube differently, which is what a grade means to a "
    + "colourist. MEASURED the only arm that puts a warm reference's look on a "
    + "face while the skin still reads as lamplight and a blue hair streak "
    + "stays blue; it scores WORST on distribution match precisely because it "
    + "is not trying to match one. Reach for it when each shot should keep its "
    + "own identity. ~8-14s a clip against MKL's 2-4s, and it needs the pack "
    + "and its 4.1GB checkpoint on the render engine." },
  { id: "reinhard_lab_gpu", label: "Reinhard (Lab, GPU)", hint:
    "Mean/std in Lab on the GPU via Kornia, and the fast one: MEASURED 2.0x "
    + "quicker than MKL (8.0s against 16.2s over 231 frames at 1280x736, "
    + "three runs each, <1% spread) because every other statistical method "
    + "here runs color-matcher on the CPU frame by frame. Lands very slightly "
    + "wider of the reference than MKL and is a touch warmer in the mids — "
    + "1.6% mean pixel difference, the same shot to the eye. Reach for it on "
    + "long clips. Needs the ColorMatchV2 node on the render engine; the render refuses by name "
    + "rather than substituting one." },
  { id: "reinhard", label: "Reinhard", hint:
    "Per-channel mean and standard deviation in RGB. Nominally the gentlest "
    + "of the set and MEASURED THE OPPOSITE on a real cross-shot grade: it "
    + "overshot the reference's spread by 3x MKL's error and came back with "
    + "crushed shadows and blown lamps. It is also the SLOWEST (24.5s where "
    + "MKL is 16.2s). One pairing, so not a verdict — but check the picture "
    + "before shipping it." },
  { id: "mvgd", label: "MVGD", hint:
    "An analytical multivariate-Gaussian transfer. Like MKL it uses the full "
    + "covariance; a second opinion when MKL lands oddly. Untested here." },
  { id: "hm", label: "Histogram", hint:
    "Classical histogram matching — the most literal of the set. UNTESTED "
    + "here, and treat it with suspicion: the compound that pairs this stage "
    + "with MVGD measured unusable on cel-shaded footage (blotchy faces), "
    + "because flat anime shading gives histogram matching a sparse histogram "
    + "to quantise. Check a face at 1:1." },
  { id: "hm-mkl-hm", label: "HM-MKL-HM", hint:
    "Histogram matching either side of MKL. Untested here, and it carries the "
    + "same histogram stage as the compound that measured unusable on this "
    + "footage — check a face at 1:1 before shipping it." },
];

// NOT OFFERED: `hm-mvgd-hm`. color-matcher declares it and its own paper
// reports it as outperforming the single methods — and it MEASURED UNUSABLE
// on this studio's footage (2026-09-05): faces come back in coarse blotches
// with colour fringing on the hair. Its gap-to-reference score is competitive,
// so the number does not catch it; correlation to source does (0.965-0.987
// against every other arm's 0.99+). Twin of graphs.COLOR_MATCH_REFUSED, which
// keeps the reason on the worker side so the node's own combo list cannot be
// read as an oversight.

export type H3FaceCanvas = "auto" | "512" | "768" | "1024";

/** What the H3 face pass generates at. Cost scales with AREA, so this is the
 *  setting most able to turn a hero-shot pass into one that will not fit —
 *  768 is 2.25x the latent tokens of 512. Twin of graphs.H3_FACE_CANVASES. */
export const H3_FACE_CANVASES: { id: H3FaceCanvas; label: string; hint: string }[] = [
  { id: "768", label: "768", hint:
    "H3's native short edge, and the MEASURED best of the four on a small "
    + "face: clearly sharper than 512 and 97s against 1024's 167s for the "
    + "same 2s clip. The default." },
  { id: "auto", label: "Auto", hint:
    "Size the canvas from the largest crop so no frame is upscaled past what "
    + "it has detail for, floored at 512. Right for footage whose faces are "
    + "already large — and MEASURED WRONG for the small faces this pass "
    + "exists for, where it picks 512 and comes back soft. It was the default "
    + "for exactly one afternoon." },
  { id: "512", label: "512", hint:
    "Cheaper — 44% of 768's latent tokens, and below H3's native short edge. "
    + "Measurably softer on a small face; reach for it on a long clip, or "
    + "where the face is already large in frame." },
  { id: "1024", label: "1024", hint:
    "1.8x the tokens of 768 and 1.7x the time, for a crop the stitch-back "
    + "then resamples down into the original frame anyway. Measured the "
    + "sharpest H3 arm, by a small margin over 768 — a hero-shot setting." },
];

export const H3_FACE_DENOISE_MIN = 0.1;
export const H3_FACE_DENOISE_MAX = 0.9;

/** The tuning, as it sits on `projects.settings` — flat, like `post_ref_*`. */
export interface PostOptions {
  post_refine_size: RefineSize;
  post_refine_sigmas: RefineSigmas;
  /** LTX video_cfg. 1.0 is the distilled recipe; see the hint in PostOptionsPanel. */
  post_refine_cfg: number;
  post_upscale_model: UpscaleModelId;
  /** Which colour transfer the grade runs. See GRADE_METHODS. */
  post_grade_method: GradeMethod;
  post_h3face_canvas: H3FaceCanvas;
  /** How far the face pass travels. NOT comparable to the detailer's number of
   *  the same name: H3 is flow matching with a large sigma shift, so the pack
   *  warns that an ordinary detailer's 0.25 lands at an effective sigma of
   *  0.800 and rewrites the frame. 0.4 is the pack author's own base. */
  post_h3face_denoise: number;
}

/** The defaults, which are exactly what every render before these settings
 *  did — so a project that never touches them is byte-identical. */
export const POST_OPTIONS_DEFAULT: PostOptions = {
  post_refine_size: "native",
  post_refine_sigmas: "",
  post_refine_cfg: 1,
  post_upscale_model: "3b",
  post_grade_method: "mkl",
  post_h3face_canvas: "768",
  post_h3face_denoise: 0.4,
};

export const REFINE_CFG_MIN = 1;
export const REFINE_CFG_MAX = 3;

/** Read whatever is on the row. An unreadable value falls back to the DEFAULT,
 *  never to an adjacent setting — the worker's `_post_opts` does the same, and
 *  the two agreeing is what stops the panel describing a render nobody gets. */
export function normalizePostOptions(v: unknown): PostOptions {
  const st = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const one = <T extends string>(k: string, ids: readonly T[], dflt: T): T =>
    (ids as readonly string[]).includes(String(st[k])) ? (st[k] as T) : dflt;
  const cfg = Number(st.post_refine_cfg);
  const face = Number(st.post_h3face_denoise);
  return {
    post_refine_size: one("post_refine_size", REFINE_SIZES.map((s) => s.id), "native"),
    post_refine_sigmas: one("post_refine_sigmas", REFINE_SIGMA_PRESETS.map((s) => s.id), ""),
    post_refine_cfg: Number.isFinite(cfg)
      ? Math.min(REFINE_CFG_MAX, Math.max(REFINE_CFG_MIN, cfg))
      : POST_OPTIONS_DEFAULT.post_refine_cfg,
    post_upscale_model: one("post_upscale_model", UPSCALE_MODELS.map((m) => m.id), "3b"),
    post_grade_method: one("post_grade_method", GRADE_METHODS.map((m) => m.id), "mkl"),
    post_h3face_canvas: one("post_h3face_canvas", H3_FACE_CANVASES.map((c) => c.id), "768"),
    post_h3face_denoise: Number.isFinite(face)
      ? Math.min(H3_FACE_DENOISE_MAX, Math.max(H3_FACE_DENOISE_MIN, face))
      : POST_OPTIONS_DEFAULT.post_h3face_denoise,
  };
}

/** Which tuning rows are worth showing for a chain — the same rule every other
 *  surface here follows: a control that cannot reach the render is worse than
 *  no control, so the refine's rows appear only when the refine is on. */
export function tunableOps(chain: PostChain | null | undefined): Set<PostOpId> {
  return new Set(activeOps(chain).filter(
    (id) => id === "ltx_refine" || id === "upscale" || id === "h3_facefix"
         || id === "color_match"));
}

const IDS = new Set<string>(POST_ORDER);

/** Read whatever is on the row into a chain, or null for "inherit".
 *
 *  Strict about shape rather than forgiving: a jsonb column takes anything, and
 *  a chain of `{"grian": true}` that silently reads as empty is a toggle that
 *  looks on and renders off. Unknown keys are dropped, and a value that is not
 *  an object at all is inherit. */
export function normalizeChain(v: unknown): PostChain | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const out: PostChain = {};
  for (const [k, on] of Object.entries(v as Record<string, unknown>)) {
    if (IDS.has(k) && on === true) out[k as PostOpId] = true;
  }
  return out;
}

/** The ops that will actually run, in the order they will run. */
export function activeOps(chain: PostChain | null | undefined): PostOpId[] {
  if (!chain) return [];
  return POST_ORDER.filter((id) => chain[id] === true);
}

/** The ops a picker should render, in POST_ORDER: everything still offered,
 *  plus any RETIRED pass this chain already has switched on.
 *
 *  Read here rather than filtered at each call site, for the reason
 *  PostChainToggles reads its own entitlement: three surfaces mount that
 *  component and a rule repeated three times is one that is wrong in the
 *  fourth. See `PostOpDef.retired` for why a retired-but-ON pass keeps its
 *  row. */
export function offeredOps(chain: PostChain | null | undefined): PostOpDef[] {
  return POST_ORDER
    .map((id) => POST_OP[id])
    .filter((op) => !op.retired || chain?.[op.id] === true);
}

/** Pairs of passes that may not run together, with the reason. Twin of
 *  EXCLUSIVE in worker/post_chain.py, pinned across the two by
 *  postChain.test.ts.
 *
 *  The two face passes are alternatives rather than a stack: one inpaints
 *  every frame through an image model, the other re-generates the tracked
 *  crop through H3, and running both rewrites the same faces twice. Same
 *  shape `resolve()` refuses `refine` + `split_pass` for. */
export const EXCLUSIVE: { ops: PostOpId[]; why: string }[] = [
  { ops: ["facefix", "h3_facefix"],
    why: "the two face passes rewrite the same faces — pick one" },
];

/** The reason two active passes cannot run together, or null. */
export function chainConflict(chain: PostChain | null | undefined): string | null {
  const on = new Set(activeOps(chain));
  for (const { ops, why } of EXCLUSIVE) if (ops.every((o) => on.has(o))) return why;
  return null;
}

/** Flip one pass, resolving any exclusion it creates in favour of the pass
 *  just turned ON.
 *
 *  In the toggles rather than only in the render: a switch you can set to a
 *  combination the worker will refuse is a render that fails minutes later
 *  for a reason the screen showed no sign of. Turning one face pass on turns
 *  the other off, which is what picking between two alternatives looks like
 *  — and both can still be off. */
export function toggleOp(chain: PostChain, id: PostOpId): PostChain {
  const next: PostChain = { ...chain };
  if (next[id] === true) {
    delete next[id];
    return next;
  }
  next[id] = true;
  for (const { ops } of EXCLUSIVE) {
    if (!ops.includes(id)) continue;
    for (const other of ops) if (other !== id) delete next[other];
  }
  return next;
}

/** Does rendering this chain drive ComfyUI? Decides the render's LANE: a
 *  cpu-lane job runs concurrently with the gpu lane (worker.py fills the pool
 *  beside the serial GPU slot), so a render that loads SeedVR2 from the cpu
 *  lane lands a second model beside a live H3 render.
 *
 *  `color_match` counts, though colour transfer loads no model: it runs on a
 *  ComfyUI node, so it occupies the serial queue this flag protects. The test
 *  is "drives ComfyUI", not "uses the GPU" — grain is the only op that is
 *  genuinely ffmpeg-only. Mirrored in worker/post_chain.py's GPU_OPS. */
export function chainNeedsGpu(chain: PostChain | null | undefined): boolean {
  return activeOps(chain).some((id) => POST_OP[id].gpu);
}

export type PostMode = "inherit" | "custom";

export interface ResolvedPost {
  mode: PostMode;
  /** What will run — the project's chain when inheriting, the clip's when not. */
  chain: PostChain;
}

/** One resolution, used by the inspector, by the render's lane pick and (as the
 *  Python twin) by the worker. `clipPost` is the raw `clips.post` value. */
export function resolvePost(clipPost: unknown, projectChain: PostChain | null | undefined): ResolvedPost {
  const own = normalizeChain(clipPost);
  if (own === null) return { mode: "inherit", chain: normalizeChain(projectChain) ?? {} };
  return { mode: "custom", chain: own };
}

/** "Upscale + grain" / "None" — the dropdown's summary line and the note the
 *  render writes onto its own asset. */
export function describeChain(chain: PostChain | null | undefined): string {
  const ops = activeOps(chain);
  if (!ops.length) return "None";
  return ops.map((id) => POST_OP[id].label.replace(/\s*\(.*\)$/, "")).join(" + ");
}

/**
 * Whether a `tl_render` of these clips has to wait for the engine.
 *
 * It used to answer a LANE — the cloud build put a chained cut on the pod's
 * serial gpu queue and a plain one on its cpu queue, so a render driving
 * SeedVR2 could not be claimed beside a live generation. There is one queue
 * here and `localWorker` runs one job at a time by construction, so what is
 * left of the question is the other half: a cut whose chain touches ComfyUI
 * must not be claimed while the engine is down, and a plain ffmpeg export
 * must not be held back by an engine it never asks for.
 */
export function chainNeedsEngine(
  clips: { post?: unknown }[], projectChain: PostChain | null | undefined,
): boolean {
  return clips.some((c) => chainNeedsGpu(resolvePost(c.post, projectChain).chain));
}
