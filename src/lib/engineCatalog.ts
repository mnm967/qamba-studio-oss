// What the local engine can be given: model FAMILIES, each with the variants
// it actually ships in.
//
// WHY FAMILIES AND VARIANTS. "Wan 2.2 5B" is not a download, it is a choice
// between a 9.5GB fp16 file and a 3.2GB Q4_K_M quantisation of the same
// weights — and on a 16GB laptop that is the difference between swapping and
// working. Presenting one row per model forced a pick nobody can make: either
// list the fp16 and tell most machines they cannot run it, or list the quant
// and quietly give everyone a lossy version. The family is the model; the
// variant is how much of it your machine can hold.
//
// SHOW EVERYTHING, GREY OUT WHAT WILL NOT FIT. Including the families a
// machine has no hope of running — someone on a laptop should be able to see
// that MiniMax H3 exists and what it would take, not conclude the app only
// does stills.
//
// EVERY NUMBER HERE IS MEASURED. Sizes come from the HuggingFace API's own
// file listing, not from model cards; gated files were dropped rather than
// listed hopefully (Flux.1's `ae.safetensors` answers 401 without a token, so
// the whole family is absent — a first run must not require an account).
// `vram_gb` is a working set while rendering, which is always more than the
// file: weights, plus the text encoder that loads beside them, plus
// activations.
//
// GGUF NEEDS A CUSTOM NODE. `UnetLoaderGGUF` comes from city96/ComfyUI-GGUF,
// which the installer adds — a variant marked `gguf` is unusable without it,
// and that is a dependency worth stating rather than discovering when the
// loader has no entry for your file.

export type Media = "image" | "video" | "audio";
export type Precision = "fp16" | "fp8" | "int8" | "gguf";

/** ComfyUI's models/ subdirectory a file belongs in. Getting this wrong is
 *  silent: the loader simply will not list the file. */
export type ModelDir =
  | "checkpoints" | "diffusion_models" | "text_encoders" | "vae"
  | "loras" | "upscale_models"
  // Core ComfyUI reads FILM and RIFE from their own directory, via
  // `FrameInterpolationModelLoader` — not from `upscale_models`. It has to be
  // in the Rust `MODEL_DIRS` too, or the file lands somewhere and `files`
  // never reports it: the same trap `relink_data.sh` documents on the pod for
  // `latent_upscale_models`.
  | "frame_interpolation"
  // The face detector both face passes name. NESTED, and that is the Impact
  // Subpack's own layout: `UltralyticsDetectorProvider` lists
  // `models/ultralytics/bbox` and `.../segm` as separate pools, so a `.pt` in
  // the parent is offered by neither. It has to be in the Rust `MODEL_DIRS`
  // and `model_dir_kind` too — the same trap the line above records.
  | "ultralytics/bbox"
  // AND THAT TRAP WAS OPEN HERE TOO, in a union whose own comment names it.
  // `LatentUpscaleModelLoader` is a DIFFERENT loader from `UpscaleModelLoader`
  // and reads a DIFFERENT directory, and LTX 2.5's two-pass recipe cannot run
  // without the x2 upsampler that lives in it — so the file had nowhere to be
  // declared, the catalogue simply omitted it, and
  // `gen_desktop_model_map.mjs` dropped the whole family with
  // "the engine window cannot download ltx-2.5-latent-spatial-upscaler…".
  // Three lists were inconsistent about it at once, each failing differently:
  // `planner.rs::collect_weights` already routed `latent_upscaler` here (so
  // the readiness check looked in the right place), `MODEL_DIRS` did not scan
  // it (so a downloaded file was invisible to `files`), and
  // `engine_model_path` refused the write outright — a Get button that
  // answers `unknown model directory 'latent_upscale_models'`.
  | "latent_upscale_models"
  // MMAudio's four files, in the one folder kijai/ComfyUI-MMAudio registers
  // for itself (`folder_paths.add_model_folder_path("mmaudio", …)`) and all
  // four of its loaders read from — the transformer, the audio VAE,
  // Synchformer and the CLIP tower share one directory rather than going to
  // the three they would belong in elsewhere.
  | "mmaudio"
  // MiniMax H3's official PDD acceleration, in the folder
  // Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc registers for itself
  // (`folder_paths.add_model_folder_path("pdd_acc", …)`) and reads its
  // `pdd_file` dropdown from. NOT `loras`, and that is the whole reason it
  // needs a directory of its own: these files are a rank-64 trunk LoRA plus a
  // per-interval HEAD BANK, and a plain `LoraLoaderModelOnly` loads the trunk,
  // silently drops the heads and spams ~50 `ERROR lora … adaln_proj` lines.
  // Filing them under `loras` would put them in front of the composer's LoRA
  // picker, which is exactly the loader that cannot apply them.
  | "pdd_acc";

export interface EngineFile {
  /** Where the weights come from upstream. */
  url: string;
  filename: string;
  dir: ModelDir;
  size_mb: number;
  /** shared between variants or families — the downloader skips it when it is
   *  already on disk, which is most of why a second Wan is cheap */
  shared?: boolean;
  /**
   * Why `url` cannot be fetched without an account, when it cannot.
   *
   * MEASURED, never assumed: the test is an anonymous ranged GET, and 401 is
   * the answer — `Lightricks/LTX-2.5` reports `gated: "auto"` on the API and
   * still refuses the bytes, so reading the metadata is not enough. A gated
   * file is USELESS to a first run, which is why Flux.1 is absent from this
   * catalogue entirely. It becomes usable the moment the studio MIRRORS it
   * (see `mirrorUrl`), so this is a reason to show, not a reason to drop.
   */
  gated?: string;
  /**
   * Why the studio deliberately does NOT host this file, when it does not.
   *
   * A FAMILY'S LICENCE IS NOT ALWAYS ITS FILES' LICENCE, and the Flux 2
   * autoencoder is the case: Klein 4B is Apache 2.0 throughout except for this
   * one object, which is shared with Flux 2 dev and taken from that repo (see
   * `FLUX2_VAE` for why one filename can only be one object here). Mirroring is
   * redistribution and the bucket is public, so a file whose terms the studio
   * has not cleared stays upstream — where it is an anonymous 206, so nothing
   * about the install breaks.
   *
   * It is a REASON rather than a boolean for the same purpose `gated` is: the
   * publisher prints it, so the next person to run a family publish is told why
   * one file was skipped instead of wondering whether it failed.
   *
   * Distinct from `gated`, which is about the SOURCE refusing us. This is about
   * us declining to become a source.
   */
  noMirror?: string;
}

export interface ModelVariant {
  id: string;
  /** how it is known: "fp16", "Q4_K_M", "fp8 (high+low)" */
  label: string;
  precision: Precision;
  files: EngineFile[];
  /** working set while rendering, including the text encoder beside it */
  vram_gb: number;
  /**
   * `vram_gb` here is DERIVED from the weights, not a tier a render passed at.
   *
   * THE TWO NUMBERS LOOK IDENTICAL ON SCREEN AND MEAN OPPOSITE THINGS. H3's
   * figures are floors a render actually cleared under a driver-enforced cap;
   * these are roughly "the files plus working room", which the H3 benchmark
   * specifically disproved as a predictor — its GGUF rungs are 12-18GB files
   * that rendered inside **6GB**, because ComfyUI answers a small card by
   * streaming weights out of host memory. So an estimate is very likely
   * PESSIMISTIC, and printing it as a flat verdict tells someone their machine
   * cannot do a thing nobody has tried.
   *
   * Set it wherever the number was reasoned rather than measured. `fitNote`
   * softens its language and the row says so; nothing else changes, because a
   * guess is still the best guide there is until somebody runs the benchmark.
   */
  vramEstimated?: boolean;
  /**
   * System RAM the render actually needs, measured as `MemTotal - MemAvailable`
   * at its peak — so reclaimable page cache is NOT counted, and this is the
   * figure a machine has to have rather than the process's RSS (which is much
   * larger for an mmap'd checkpoint and would refuse machines that work).
   *
   * IT IS A SECOND GATE, NOT A DETAIL. The H3 tier benchmark's clearest
   * cross-cutting result: the same GGUF rung that renders inside a hard 6GB of
   * VRAM wants 23-43GB of RAM to do it, because ComfyUI answers a small card by
   * streaming weights from host memory. A 16GB-RAM machine with a fine GPU was
   * oom-killed in 110 seconds. Quoting VRAM alone is how that user is promised
   * a render that cannot happen.
   *
   * Unset means nobody measured it — the fit check then ignores RAM for that
   * row rather than inventing a number.
   */
  ram_gb?: number;
  /** what you give up, in a phrase — the reason to pick a bigger one */
  quality: string;
  tag?: string;
  /**
   * The REFERENCE checkpoint that goes with this rung, when one exists.
   *
   * MiniMax H3 ships as a PAIR: `fl2va` does i2v/t2v/flf and cannot do r2v at
   * all, and r2v is what every episode block — and every composer clip with a
   * character sheet staged — renders in. The two are separate weights, so
   * "which reference checkpoint" is a question with a per-rung answer: a GGUF
   * rung needs the GGUF ref2va (the stock `UNETLoader` will not even list a
   * `.gguf`), and the pod-matching rung needs the pod's unpruned one.
   *
   * NOT IN `files`, because it doubles the download and buys exactly one
   * capability — the same reasoning that made it an add-on in the first place.
   * It lives HERE so that one object is both what the add-on fetches and what
   * `localGraphs.buildH3` names, which is the drift this replaces: the graph
   * had no idea the reference checkpoint existed and quietly rendered r2v on
   * the fl2va weights.
   *
   * Absent means this rung has no verified reference mode — `localModels` then
   * does not offer r2v on it at all, rather than offering one that renders
   * with the wrong weights.
   */
  refCheckpoint?: EngineFile;
  /**
   * The rung to recommend when it fits, ahead of biggest-that-fits.
   *
   * `bestVariant` otherwise takes the largest `vram_gb` a machine can hold, and
   * that is a proxy for quality which the H3 measurements broke: the pod's own
   * unpruned set has the highest floor of any rung AND is beaten by the pruned
   * one at every tier — same architecture, 25GB less download, 11GB less RAM,
   * no measured quality difference. So a 24GB card offered "biggest" would be
   * handed the worse deal. Same shape as `studioDefaultFor` one level up: name
   * the preference explicitly rather than hoping a heuristic lands on it.
   */
  preferred?: boolean;
}

/**
 * An adapter that belongs to ONE family.
 *
 * This is the answer to "is turbo a separate model?" — no. The studio's own
 * model_map says so: `minimax-h3-turbo` is the base entry plus
 * `turbo_lora: minimax_h3_turbo_v4_step600_ema.safetensors`, and
 * `minimax-h3-lightx2v` is the same weights with a different distillation and
 * `turbo_apply: "plain"`. Listing those as families would triple the catalogue
 * with rows that share every gigabyte of their weights, and would hide the one
 * fact that matters: you download H3 once, then decide how it runs.
 *
 * `kind` is what the adapter buys, because that is how you choose between two
 * of them: speed, quality, or a capability the base model does not have.
 */
export interface FamilyAddon {
  id: string;
  name: string;
  kind: "speed" | "quality" | "capability";
  blurb: string;
  files: EngineFile[];
  tag?: string;
  /**
   * Variant ids this add-on belongs to — shown only when one of them is
   * installed, and hidden otherwise.
   *
   * H3's reference checkpoint is the case: it comes in five precisions and
   * exactly one of them matches the rung you installed (a `.gguf` will not load
   * in a `UNETLoader`, and the pod-matching rung wants the pod's unpruned
   * file). Listing all five unconditionally would put four ~20GB rows on screen
   * that are wrong for you, and picking one of them is a 20GB download that
   * cannot render.
   *
   * Absent means the add-on belongs to the whole family, which is every other
   * one here.
   */
  forVariants?: string[];
  /** what it changes about the render recipe, if anything */
  recipe?: string;
  /** the same thing a RENDER can act on. `recipe` is a sentence for a human;
   *  a distillation that says "4 steps" and then samples 30 because nothing
   *  read the sentence is the adapter loading and doing nothing — the exact
   *  silent-downgrade shape this codebase keeps naming. Only set it where the
   *  adapter genuinely rewrites the recipe; a quality LoRA changes nothing. */
  sampling?: {
    steps?: number; cfg?: number; sampler?: string; scheduler?: string;
    /** MiniMax H3's `[video, audio]` sigma shift — see `Sampling.h3Shift`.
     *  It rides the ADAPTER because the pod's 20-step templates carry no
     *  shift node, and the 4-step recipe was only ever measured with one. */
    h3Shift?: [number, number];
  };
  /**
   * The custom-node PACK this adapter cannot be applied correctly without,
   * named as its directory — which is what `engine_status.nodes` reports.
   *
   * A class name would be the more precise thing to want and the wrong thing
   * to write: the status probe lists `custom_nodes/*` directories, so a class
   * name could never match and the check would pass by accident today and
   * keep failing the day someone installs the pack.
   *
   * Not the same as "the file is missing". larryvrh's H3 turbo is applied as a
   * runtime BYPASS by `MiniMaxH3TurboLoRA`, and its own blurb says why: merged
   * — or loaded as a plain `LoraLoaderModelOnly`, which is all the local
   * builder can do — the delta is rounded away on int8 weights and the 6-step
   * schedule it exists for is exactly the signal that gets lost. So the pack's
   * absence must HIDE the pick rather than degrade it, or the fast preset
   * silently becomes a slow bad one. lightx2v's distillation is a plain LoRA
   * by design and declares nothing here.
   */
  needsPack?: string;
}

export interface ModelFamily {
  id: string;
  name: string;
  media: Media;
  /** what it is for, in the words of someone deciding whether to download it */
  blurb: string;
  license: string;
  /**
   * The licence's own text, where redistributing the weights OBLIGES us to
   * pass it on.
   *
   * Not decoration and not for every family. LTX 2.5 is the case: its
   * community licence permits mirroring outright (§3, "reproduce and
   * distribute copies… in any medium") and conditions it — §3.2 requires that
   * third-party recipients get a copy of the agreement, §3.1 that the use
   * restrictions travel with it. A first run downloading from OUR bucket is
   * exactly such a recipient, and until this existed there was nowhere in the
   * app that told them so.
   *
   * The mirror carries the text as an object beside the weights as well; this
   * is the half a human can actually read before pressing Get.
   */
  licenseUrl?: string;
  /** what every variant of this family also needs — text encoder, VAE */
  shared: EngineFile[];
  variants: ModelVariant[];
  /**
   * The variants that are ONE checkpoint at different precisions, and are
   * therefore interchangeable at render time.
   *
   * WHY THIS IS A LIST AND NOT A FLAG ON EACH VARIANT. `variants` means two
   * different things in this file, and nothing until now separated them:
   * usually it is a precision ladder over one set of weights (Klein 4B's
   * bf16→Q3, Qwen-Edit's fp8→Q2), and sometimes it is several DIFFERENT
   * checkpoints filed under one family. `gen_desktop_model_map.mjs` turns
   * this list into the rung table `resolve.load_map()` and
   * `desktop_render_models` both read, so anything in it may be substituted
   * for anything else in it — silently, in a render somebody paid for.
   *
   * The three families that are NOT ladders, and why each is absent here:
   *  · `sdxl` — Turbo is distilled to 4 steps and Base wants 30. Swapping
   *    them renders one at the other's recipe.
   *  · `stable-audio` — three checkpoints, and `sa-sfx-base` is 50 steps at
   *    cfg 7 against the distilled rungs' 8 at cfg 1. It is also the only one
   *    a negative prompt reaches.
   *  · `minimax-h3`'s `h3-dasiwa` — a community merge. It declares no
   *    per-variant recipe, so nothing derivable would catch it, and its own
   *    note says it is "warmer and more contrasty" AND has no verified r2v.
   *    An episode substituted onto it would change look and lose the one mode
   *    every block renders in.
   *
   * So it is an OPT-IN naming the group, not an opt-out: a variant added
   * later is not interchangeable until someone says it is, and the omission
   * of `h3-dasiwa` from H3's list is visible where the list is written rather
   * than being an absence you have to notice. Every id must name a real
   * variant — `engineCatalog.test.ts` pins that.
   */
  swappable?: string[];
  /** LoRAs and decoders that attach to THIS family — turbo distillations,
   *  quality adapters, and the odd capability like H3's stills decoder. */
  addons?: FamilyAddon[];
  recipe?: string;
  tag?: string;
  /**
   * The `model_catalog` id of the STUDIO DEFAULT this family provides — the
   * model a project renders with when nobody has picked one
   * (`projectSettings.resolveDefaults`).
   *
   * WHY IT IS AN ID AND NOT A BOOLEAN. A flag would say "this one is special"
   * and nothing would ever check it again; naming the id makes the claim
   * falsifiable, and `engineCatalog.test.ts` fails when `resolveDefaults`'s
   * fallbacks stop pointing here. `projectSettings` cannot be imported from a
   * test (it builds a Supabase client at module load), so the test parses its
   * source for the literals — the same shape `scoreTrack.test.ts` uses.
   *
   * It is also what SORTS the download list: someone installing the engine to
   * run this studio's own pipeline should not have to scroll past three
   * models the pipeline does not use to find the one it does.
   */
  studioDefaultFor?: string;
  /** a second thing this family can do, stated on the card — H3 renders
   *  stills as well as video, which is invisible if it only appears under
   *  "Video models" */
  also?: string;
  /**
   * This family renders through the studio's own BUNDLED PIPELINE rather than
   * through `localGraphs`, and which catalogue row it turns on when it does.
   *
   * Every other family here is a `local:` id the composer picks and
   * `localRender` builds a graph for. MMAudio is not: its whole tail — mux the
   * new track onto the take with ffmpeg, publish a derived `audio` take,
   * re-anchor the block — is `worker/handlers/v2a.py`, and a second
   * implementation of that in TypeScript is the twin drift this codebase keeps
   * paying for. So the job goes to the bundled Python exactly as it does on
   * the pod, and what changes on the desktop is only WHERE.
   *
   * That makes the row a normal `model_catalog` row that is sometimes local,
   * which is why this names the row rather than minting an id: one model, one
   * row, one set of measured capabilities, and a MARK (`capabilities.desktop`,
   * see `desktopRows.ts`) that moves it between tiers.
   *
   * `packs` are `custom_nodes` directory names, checked against
   * `engine_status.nodes` — the same gate `FamilyAddon.needsPack` uses, and
   * the reason a pack whose dependencies failed is excluded from that list.
   */
  bundled?: {
    /** the `model_catalog` id this family makes runnable here */
    catalogRow: string;
    /** the `jobs.kind` it renders under */
    kind: string;
    /** `custom_nodes` directories the graph needs */
    packs: string[];
  };
  /**
   * Files that are NOT model weights and are not addressed by name — a
   * directory some node fetches for itself at render time, pre-seeded so it
   * does not have to.
   *
   * MMAudio is the case and the only one: its 44k branch snapshot-downloads a
   * BigVGAN vocoder into `models/mmaudio/nvidia/…` the first time it runs, so
   * a machine that downloaded 5.1GB and went offline finds out mid-render.
   * These are fetched by `download_file_set`, which is the one path here that
   * can write a subdirectory.
   */
  seeds?: { id: string; label: string; dir: ModelDir; size_mb: number;
            files: { url: string; path: string; size_mb: number }[] }[];
}

const HF = "https://huggingface.co";
const WAN22 = `${HF}/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files`;
const WAN21 = `${HF}/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files`;
const WAN22Q = `${HF}/QuantStack/Wan2.2-TI2V-5B-GGUF/resolve/main`;
const WAN14Q = `${HF}/QuantStack/Wan2.2-I2V-A14B-GGUF/resolve/main`;
const WAN13Q = `${HF}/samuelchristlie/Wan2.1-T2V-1.3B-GGUF/resolve/main`;
const H3 = `${HF}/Comfy-Org/MiniMax-H3/resolve/main`;
const H3Q = `${HF}/Abiray/MiniMax-H3-GGUF/resolve/main`;
const KREA2 = `${HF}/Comfy-Org/Krea-2/resolve/main`;
/** byteshape's GGUF quantisations of the same turbo checkpoint. Chosen over
 *  the other three repos on HuggingFace by probing the files, not the cards:
 *  its header declares `general.architecture = qwen_image` with 430 tensors
 *  (the base model's own count, once the fp8 file's `_scale` pairs are
 *  discounted) and three clean metadata keys, where one rival ships stray
 *  `egg_*` keys and another publishes K_S and K_M at byte-identical sizes —
 *  which cannot both be true and means one of the two is mislabelled. */
const KREA2Q = `${HF}/byteshape/Krea-2-Turbo-GGUF/resolve/main`;
/** huihui-ai's abliteration of the same Qwen3-VL-4B, repackaged for ComfyUI.
 *  See the addon below for why it loads despite naming its tensors
 *  differently from the stock file. */
const H3TURBO = `${HF}/larryvrh/MiniMax-H3-Turbo-Lora/resolve/main`;
const H3LX = `${HF}/lightx2v/Minimax-h3-Turbo/resolve/main`;
/** Kijai's ComfyUI repack of lightx2v's 4-step distillation — the adapter every
 *  passing cell of the tier benchmark rendered through. */
const H3LX4 = `${HF}/Kijai/MiniMax-H3_comfy/resolve/main`;
/** drbaph's pruned ComfyUI repack of larryvrh's turbo v4 EMA, which is the LoRA
 *  the DaSiWa workflow ships with (591MB against larryvrh's own 748MB — a
 *  different file, not a mirror of the one above). */
const H3EMA = `${HF}/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI/resolve/main`;
const H3VAE = `${HF}/Mamad8/MiniMax-H3-Image-VAE/resolve/main`;
/** alibaba-pai's OFFICIAL 8-step Parallel Decoding Distillation for H3 — the
 *  same objects the engine window's model list pdd puts on the pod. Public: an anonymous
 *  ranged GET is a 302 to the CDN, measured 2026-09-04. */
const H3PDD = `${HF}/alibaba-pai/MiniMax-H3-Acc-LoRAs/resolve/main`;
/** Jojocodex's camera-motion adapter. Public, Apache 2.0 by its own card. Both
 *  step counts are published; the catalogue names the 3000-step file, which is
 *  the author's later checkpoint and the one `model_map` renders with. */
const H3CAM = `${HF}/Jojocodex/minimax-h3-Camera-Motion-lora/resolve/main`;
const KIJAI_WAN = `${HF}/Kijai/WanVideo_comfy/resolve/main`;
const QWENE = `${HF}/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files`;
const QWEN = `${HF}/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files`;
/** unsloth's quantisations of the SAME 2511 checkpoint the pod renders on.
 *  Header-probed rather than taken on trust: `general.architecture =
 *  qwen_image`, 1934 tensors, GGUF v3 — the architecture city96's
 *  `UnetLoaderGGUF` handles and the installer already provides. */
const QWENEQ = `${HF}/unsloth/Qwen-Image-Edit-2511-GGUF/resolve/main`;
const MUSIC3 = `${HF}/Comfy-Org/MiniMax-Music-3/resolve/main`;
// Kijai's safetensors repack of MMAudio. MIT, ungated — verified by an
// anonymous ranged GET (206) rather than taken from the model card, the
// standing rule for anything listed here.
const MMAUDIO = `${HF}/Kijai/MMAudio_safetensors/resolve/main`;
// The vocoder MMAudio's 44k branch fetches for itself on its first render.
// MIT, ungated. Only the generator and the python beside it are taken: the
// node's own `snapshot_download` passes `ignore_patterns=["*3m*"]`, which
// still pulls a 1.5GB discriminator optimizer nobody infers with.
const BIGVGAN = `${HF}/nvidia/bigvgan_v2_44khz_128band_512x/resolve/main`;
const SAUDIO = `${HF}/Comfy-Org/stable-audio-3/resolve/main`;
const LTX25 = `${HF}/Lightricks/LTX-2.5/resolve/main`;
/** LiconStudio's own repo for the MSR IC-LoRA — UNGATED and Apache-2.0, which
 *  is why it is the one LTX 2.5 file with no `gated` marker. It is the LoRA the
 *  `ComfyUILTX25MSRICLoRALoader` in `workflows/ltx25_r2v.json` names. */
const LTXMSR = `${HF}/LiconStudio/LTX-2.5-Multiple-Subject-Reference/resolve/main`;
/** Abiray's GGUF conversions of the DISTILLED transformer — the same publisher
 *  as the MiniMax H3 quantisations the tier benchmark ran on, and ungated.
 *  Header-probed 2026-09-01: `general.architecture = ltxv`, gguf v3, 4349
 *  tensors, and its own metadata names `ltx_version 2.5.0` /
 *  `gemma4-12b-ltx-v1`, so it is the 2.5 distilled checkpoint and not the dev
 *  one (`vantagewithai` ships both under near-identical sizes). */
const LTXQ = `${HF}/Abiray/LTX-2.5-Distilled-GGUF/resolve/main`;
/**
 * NOT USED, and worth writing down rather than rediscovering.
 *
 * `dummy9996/LTX-2.5-22b-ungate` re-uploads four of the gated files UNGATED,
 * and they are the same bytes — verified 2026-09-01 by comparing LFS sha256
 * oids against `Lightricks/LTX-2.5` read with the studio's own HF token:
 * the int8 transformer, both VAEs and BOTH latent upscalers all match exactly.
 * So mirroring those four is optional if it ever matters.
 *
 * It is not pointed at here because a first run depends on this catalogue and
 * that is an unaffiliated account: `EngineFile` carries no checksum, so a
 * re-upload swapped or taken down is undetectable at fetch time. The identity
 * check proves what is there TODAY. Mirror instead — that is what "mirror
 * only" on this family has always meant.
 */
const _LTX_UNGATED_MIRROR = `${HF}/dummy9996/LTX-2.5-22b-ungate/resolve/main`;
void _LTX_UNGATED_MIRROR;
const ANIMA = `${HF}/Gazingstars123/Anima-2.9B/resolve/main`;
const HIDREAM = `${HF}/Comfy-Org/HiDream-O1-Image/resolve/main`;
const ACE = `${HF}/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files`;
const FLUX2G = `${HF}/city96/FLUX.2-dev-gguf/resolve/main`;
const FLUX2 = `${HF}/Comfy-Org/flux2-dev/resolve/main/split_files`;

/**
 * FLUX.2 [klein], and the split that decides everything below is the LICENCE
 * rather than the size. BFL's own model card says it outright: they released
 * "the FLUX.2 [klein] 4B models under an Apache 2.0 license and the FLUX.2
 * [klein] 9B models under a non-commercial license". So these are two
 * FAMILIES, not one ladder — `license` is a family-level field, and a single
 * row spanning both would have to state one licence for weights governed by
 * two. It is also the practical difference: the 4B is the only Black Forest
 * Labs model in this catalogue the studio can mirror.
 *
 * THE REPO NAMES CARRY AN UPSTREAM TYPO (`vae-text-encorder-…`). It is the
 * path, not a mistake to tidy.
 *
 * KLEIN'S ENCODER IS QWEN3, NOT FLUX 2 DEV'S MISTRAL — and the two are not
 * interchangeable however alike the graphs look. the engine window's model list's own klein
 * target records what happens if you try: "mat1 and mat2 shapes cannot be
 * multiplied". 4B pairs with Qwen3-4B and 9B with Qwen3-8B, so neither can be
 * `shared` across the pair either.
 */
const KLEIN4 = `${HF}/Comfy-Org/vae-text-encorder-for-flux-klein-4b/resolve/main/split_files`;
const KLEIN9 = `${HF}/Comfy-Org/vae-text-encorder-for-flux-klein-9b/resolve/main/split_files`;
const KLEIN4FP8 = `${HF}/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main`;
const KLEIN4Q = `${HF}/unsloth/FLUX.2-klein-4B-GGUF/resolve/main`;
const KLEIN9Q = `${HF}/unsloth/FLUX.2-klein-9B-GGUF/resolve/main`;

/**
 * Anima's text encoder, from CircleStone's OWN repo rather than from Civitai.
 *
 * THIS FAMILY WAS LISTED AS GATED AND DID NOT NEED TO BE. The encoder is a
 * plain Qwen3-0.6B tower, and `circlestone-labs/Anima` — the upstream the 2.9B
 * is expanded from — publishes it ungated at exactly the same size
 * (1,192,135,096 bytes = 1137 MiB, measured; an anonymous ranged GET answers
 * 206). The Civitai object this used to name answers **200 with the model's
 * HTML page** to the same request, which is the trap the engine window's model list guards
 * on and the reason the file was marked `gated` in the first place. So the
 * gate was a property of the SOURCE, not of the weights, and one url removes
 * it: Anima installs on a first run with no account and no mirror.
 */
const ANIMA_TE = `${HF}/circlestone-labs/Anima/resolve/main/split_files`;

/** Measured with an anonymous ranged GET on 2026-08-28, which is the only test
 *  that answers this — the HF API reports `gated: "auto"` for LTX 2.5 and
 *  still refuses the bytes. Everything named here is 401 without an account
 *  and 200 from the studio's mirror. */
const GATE_LTX = "Lightricks gates LTX 2.5 behind licence acceptance";
/** No longer used: Anima's encoder is served ungated by `circlestone-labs/Anima`
 *  (see `ANIMA_TE`). Kept because the measurement is the useful part — a
 *  Civitai download answering 200 with a web page is the trap, not the 401. */
const _GATE_ANIMA = "Anima's text encoder is a Civitai download behind a token";
void _GATE_ANIMA;
/** Measured 2026-09-01: an anonymous ranged GET of the Civitai download answers
 *  **200 with the model's HTML page**, which is the trap the engine window's model list
 *  already guards on — a client that trusts the status code stores a web page
 *  as a checkpoint. Sniff the bytes, not the status. */
const GATE_DASIWA = "Civitai serves this only to a signed-in account";
/** The same measurement, on the combat adapter, 2026-09-04: an anonymous
 *  download 307s to `/login?…&reason=download-auth` and following that redirect
 *  answers **200 with `text/html`**. So this is not a 401 anyone would notice —
 *  it is a web page wearing a `.safetensors` name, and the mirror is the only
 *  source a first run has. */
const GATE_COMBAT = "Civitai serves this only to a signed-in account";

/** Every Wan wants this text encoder, and it is bigger than the 1.3B model
 *  itself — which is why the second Wan family costs almost nothing. */
const UMT5: EngineFile = {
  url: `${WAN22}/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`,
  filename: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  dir: "text_encoders", size_mb: 6424, shared: true,
};
const WAN_VAE: EngineFile = {
  url: `${WAN22}/vae/wan_2.1_vae.safetensors`,
  filename: "wan_2.1_vae.safetensors", dir: "vae", size_mb: 242, shared: true,
};
/**
 * The 5B has its OWN decoder and the two are not interchangeable.
 *
 * Wan 2.2 TI2V-5B compresses 16x spatially into a 48-channel latent; every
 * other Wan here (2.1, and the 2.2 A14B pair) uses the 16-channel 2.1 VAE.
 * The 5B row declared the 2.1 file for its whole life, so the download
 * completed, the row read "installed", and the only renderable local video
 * model on this machine could not be decoded — the failure arrives at
 * `VAEDecode`, several minutes into a sample, naming a channel count.
 * `Wan22ImageToVideoLatent` is the tell: it exists precisely because this
 * family's latent is a different shape.
 */
const WAN22_VAE: EngineFile = {
  url: `${WAN22}/vae/wan2.2_vae.safetensors`,
  filename: "wan2.2_vae.safetensors", dir: "vae", size_mb: 1345, shared: true,
};

/**
 * ONE text encoder now serves every MiniMax H3 rung but the pod-matching one.
 *
 * It is the benchmark's most useful single finding. Abiray's Q4 GGUF encoder —
 * the file the GGUF rungs used to be paired with — OOMs during text encode at
 * 8, 12 AND 16GB, because ComfyUI partial-loads its 14.6GB to about 13.4GB and
 * leaves the encode's 1.45GiB activation nowhere to go. This one is 14.9GB of
 * nvfp4, dequantises on Turing and Ampere through comfy kitchen (so it is not
 * Blackwell-only), and turned every one of those failures into a render.
 *
 * `shared: true` because six rows want it: the downloader fetches it once and
 * every later H3 variant is that much cheaper.
 */
const H3_TE_NVFP4: EngineFile = {
  url: `${H3}/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`,
  filename: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  dir: "text_encoders", size_mb: 14960, shared: true,
};

/**
 * The Flux 2 autoencoder — Flux 2 dev and BOTH Klein families decode through
 * it, so it is written once and shared.
 *
 * HOISTED BECAUSE THE NAME IS AMBIGUOUS UPSTREAM AND THE MIRROR IS KEYED BY
 * BARE FILENAME. Comfy-Org publish `flux2-vae.safetensors` TWICE: once in
 * `flux2-dev` (336,213,556 bytes) and once in each klein repack (336,211,292).
 * The 2KB delta looks like the metadata noise a re-serialisation leaves, and
 * it is not — header-diffed, 251 tensors on both sides and only ELEVEN key
 * names in common, because one is stored in diffusers naming
 * (`decoder.mid_block.attentions.0.to_k`) and the other in ComfyUI's own
 * (`decoder.mid.attn_1.k`). Same autoencoder, two serialisations, one
 * filename — and this catalogue can only offer one object under that name.
 *
 * The pod's copy is the flux2-dev one and it is what Klein renders on there
 * (the engine window's model list's klein target says so in as many words: "Reuses the
 * mistral text encoder + flux2 VAE already pulled for FLUX.2-dev"), so that is
 * the url. Core does the conversion, not us: `comfy/sd.py` rewrites a
 * diffusers-keyed VAE through `diffusers_convert.convert_vae_state_dict` the
 * moment it sees `decoder.up_blocks.0.resnets.0.norm1.weight`.
 *
 * IT IS THE ONE KLEIN 4B FILE THE STUDIO DOES NOT MIRROR, deliberately: this
 * object comes from the non-commercially-licensed flux2-dev repo, and
 * `resolveSource` falls back per FILE, so Klein 4B takes five files from the
 * mirror and this one from HuggingFace, where it is an anonymous 206.
 *
 * AND THE CONTROL THAT MAKES THE ABOVE WORTH KNOWING: `qwen_image_vae
 * .safetensors` is published by the same org under the same name in TWO repos
 * too (Krea 2's and Qwen-Image's), and those two ARE byte-identical —
 * 253,806,246 bytes each, 194 tensors, every name, dtype, shape and offset
 * equal. So a shared filename across Comfy-Org repacks is usually one file and
 * occasionally is not; the header diff is what tells them apart, and it costs
 * a ranged read of a few hundred bytes.
 */
const FLUX2_VAE: EngineFile = {
  url: `${FLUX2}/vae/flux2-vae.safetensors`,
  filename: "flux2-vae.safetensors", dir: "vae", size_mb: 321, shared: true,
  noMirror: "shared with Flux 2 dev and taken from its repo, whose licence is "
    + "non-commercial — it downloads anonymously, so it stays upstream",
};

const gguf = (url: string, filename: string, size_mb: number): EngineFile =>
  ({ url, filename, dir: "diffusion_models", size_mb });

/**
 * H3's REFERENCE checkpoints, one per rung — see `ModelVariant.refCheckpoint`.
 *
 * ONE OBJECT SERVES TWO CONSUMERS: the variant names it (so `buildH3` can load
 * it for r2v) and the matching add-on fetches it. Written once here rather than
 * twice down there, because the failure of the two disagreeing is a graph that
 * loads a file the downloader never offered.
 *
 * THE K_S AND K_M LABELS ARE ONE FILE EACH, and for ref2va that covers all
 * THREE pairs — Q3, Q4 and Q5 — where fl2va's Q4_K_S/M genuinely differ.
 * Probed over ranged reads without downloading: identical tensor tables, and
 * identical sha256 over four spread 256KB slices of the data region. The same
 * probe run across checkpoints is the control that makes this trustworthy —
 * ref2va's Q4_K_M shares a tensor TABLE with fl2va's Q4_K_S (same architecture,
 * same recipe) and has entirely different data, so a matching table alone
 * proves nothing.
 */
const H3_REF = {
  /** matches `h3-int8` — the pruned pair Comfy-Org publishes together */
  pruned: {
    url: `${H3}/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors`,
    filename: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    dir: "diffusion_models", size_mb: 19999,
  } as EngineFile,
  /** matches `h3-int8-studio` — what the render pod itself loads for r2v */
  studio: {
    url: `${H3}/diffusion_models/minimax_h3_ref2va_int8_convrot.safetensors`,
    filename: "minimax_h3_ref2va_int8_convrot.safetensors",
    dir: "diffusion_models", size_mb: 32462,
  } as EngineFile,
  q5: gguf(`${H3Q}/unet/MiniMax-H3-Ref2VA-Q5_K_M.gguf`, "MiniMax-H3-Ref2VA-Q5_K_M.gguf", 22781),
  q4: gguf(`${H3Q}/unet/MiniMax-H3-Ref2VA-Q4_K_M.gguf`, "MiniMax-H3-Ref2VA-Q4_K_M.gguf", 18934),
  q3: gguf(`${H3Q}/unet/MiniMax-H3-Ref2VA-Q3_K_M.gguf`, "MiniMax-H3-Ref2VA-Q3_K_M.gguf", 14846),
};

/**
 * The add-on that fetches one of them. Derived from the same object, so the
 * download and the graph can never name different files.
 *
 * `clipsOnly` is the honest limit on the quantised rungs and it is structural
 * rather than a quality judgement: an EPISODE renders through the studio's own
 * Python pipeline, which builds from `workflows/minimax_h3_r2v.json` — and that
 * template loads through the stock `UNETLoader`, which cannot open a `.gguf`
 * (only Wan has a GGUF template; no H3 one exists). So a GGUF reference
 * checkpoint reaches the composer, where the graph is built in TypeScript and
 * picks its loader per file, and cannot reach a storyboard.
 */
const refAddon = (
  key: keyof typeof H3_REF, forVariants: string[], note: string, clipsOnly = false,
): FamilyAddon => ({
  id: `h3-ref2va-${key}`,
  name: "Reference-to-video",
  kind: "capability",
  tag: note,
  recipe: `r2v · up to 9 reference images + 3 audio${clipsOnly ? " · composer clips" : ""}`,
  blurb: "The reference checkpoint. Character sheets, the location plate and voice-timbre "
    + "clips are all staged as references, and the base checkpoint cannot read them at "
    + "all — without this the engine renders clips from prose and never from your bible."
    + (clipsOnly
      ? " This one drives COMPOSER CLIPS only: an episode renders through the studio's "
        + "Python pipeline, whose r2v workflow loads through the stock loader and cannot "
        + "open a .gguf. Storyboards need the int8 rung."
      : ""),
  forVariants,
  files: [H3_REF[key]],
});

export const FAMILIES: ModelFamily[] = [
  /* ── image ─────────────────────────────────────────────────────────── */
  {
    id: "sd15", name: "Stable Diffusion 1.5", media: "image",
    // RAIL carries USE-BASED RESTRICTIONS (§5 + Attachment A) that travel with
    // every copy, so mirroring these weights obliges the studio to put the
    // terms in front of whoever downloads them.
    licenseUrl: "https://huggingface.co/spaces/CompVis/stable-diffusion-license",
    license: "CreativeML Open RAIL-M", tag: "start here",
    blurb: "The safe first install. Renders 512x512 in seconds on Apple silicon, runs on "
      + "almost anything, and every add-on below is built for it.",
    recipe: "20 steps · cfg 7 · 512x512",
    shared: [],
    variants: [{
      id: "sd15-fp16", label: "fp16 (pruned)", precision: "fp16", vram_gb: 4,
      quality: "the full model — SD 1.5 is small enough not to need quantising",
      tag: "recommended",
      files: [{
        url: `${HF}/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors`,
        filename: "v1-5-pruned-emaonly.safetensors", dir: "checkpoints", size_mb: 4067,
      }],
    }],
    addons: [
      { id: "lcm-sd15", name: "LCM — 4-step rendering", kind: "speed", tag: "5x faster",
        recipe: "4 steps · cfg 1.5 · LCM sampler",
        sampling: { steps: 4, cfg: 1.5, sampler: "lcm", scheduler: "sgm_uniform" },
        blurb: "Latent Consistency adapter: ~20 steps down to 4. The biggest speed win "
          + "on a laptop, at a small cost in fine detail.",
        files: [{ url: `${HF}/latent-consistency/lcm-lora-sdv1-5/resolve/main/pytorch_lora_weights.safetensors`,
          filename: "lcm-lora-sdv15.safetensors", dir: "loras", size_mb: 128 }] },
      { id: "vae-ft-mse", name: "Improved VAE (ft-MSE)", kind: "quality",
        blurb: "A better decoder — noticeably cleaner faces and text. Pick it in the VAE "
          + "slot instead of the checkpoint's own.",
        files: [{ url: `${HF}/stabilityai/sd-vae-ft-mse-original/resolve/main/vae-ft-mse-840000-ema-pruned.safetensors`,
          filename: "vae-ft-mse-840000-ema-pruned.safetensors", dir: "vae", size_mb: 319 }] },
    ],
  },
  {
    id: "sdxl", name: "SDXL", media: "image", license: "STAI (Turbo: non-commercial)",
    // Base's terms, because Base is the half that is mirrored — Turbo carries
    // `noMirror` and stays upstream under Stability's non-commercial licence.
    licenseUrl: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md",
    blurb: "A generation on from 1.5 — better anatomy, text and composition at 1024px. "
      + "Wants roughly twice the memory while it renders.",
    recipe: "Base: 30 steps cfg 7 · Turbo: 1-4 steps cfg 1",
    shared: [],
    variants: [
      {
        id: "sdxl-turbo", label: "Turbo fp16", precision: "fp16", vram_gb: 10,
        quality: "distilled to 1-4 steps — much faster, slightly less detail than Base",
        tag: "1-step",
        files: [{
          // THE ONE FILE IN THIS FAMILY UNDER A NON-COMMERCIAL LICENCE, and
          // the family's own `license` string has said so all along without
          // anything acting on it. SDXL Base is OpenRAIL++-M (redistributable)
          // and Turbo is `sai-nc-community`, so the two cannot be mirrored on
          // the same terms — the second `noMirror` case, and the same shape as
          // the Flux 2 VAE: a file whose licence differs from its family's.
          noMirror: "Stability's Turbo licence is non-commercial where SDXL Base's "
            + "is not — it downloads anonymously, so it stays upstream",
          url: `${HF}/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors`,
          filename: "sd_xl_turbo_1.0_fp16.safetensors", dir: "checkpoints", size_mb: 6617,
        }],
      },
      {
        id: "sdxl-base", label: "Base 1.0 fp16", precision: "fp16", vram_gb: 11,
        quality: "the full model at full step count — the best SDXL quality",
        files: [{
          url: `${HF}/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors`,
          filename: "sd_xl_base_1.0.safetensors", dir: "checkpoints", size_mb: 6617,
        }],
      },
    ],
    addons: [
      { id: "lcm-sdxl", name: "LCM for SDXL", kind: "speed",
        recipe: "4 steps · cfg 1.5 · LCM sampler",
        sampling: { steps: 4, cfg: 1.5, sampler: "lcm", scheduler: "sgm_uniform" },
        blurb: "The same 4-step trick for SDXL. Redundant next to Turbo, which is already "
          + "distilled — this is for Base.",
        files: [{ url: `${HF}/latent-consistency/lcm-lora-sdxl/resolve/main/pytorch_lora_weights.safetensors`,
          filename: "lcm-lora-sdxl.safetensors", dir: "loras", size_mb: 376 }] },
    ],
  },
  {
    id: "krea2", name: "Krea 2 Turbo", media: "image",
    license: "Krea 2 Community",
    // MIRRORED, so §3.1(a) applies: someone downloading from the studio's
    // bucket is a third-party recipient who must be given the agreement, and
    // this is the half a human can read before pressing Get. §2.3 is the term
    // that matters — Commercial Use only while total annual revenue is under
    // $1M — and it is the studio's own fact to check, exactly like LTX 2.5's.
    licenseUrl: "https://krea.ai/krea-2-licensing",
    studioDefaultFor: "krea2-local",
    blurb: "The studio default for storyboard panels and character sheets. "
      + "Turbo-distilled, so it is few-step despite the size.",
    recipe: "8 steps · cfg 1",
    shared: [
      // bf16, AND THE fp8 IT REPLACES RENDERED GARBAGE — measured on the pod
      // 2026-09-02, one variable, three renders of one prompt at one seed
      // through this exact graph:
      //
      //   qwen3vl_4b_fp8_scaled.safetensors   heavy chromatic fringing,
      //                                       posterised, unusable
      //   qwen3vl_4b_bf16.safetensors         clean
      //   the pod's abliterated bf16          clean
      //
      // The composition was RIGHT in all three — the boat, the harbour wall,
      // the mist — so the encoder was conditioning correctly and the damage is
      // in its numerics. It reproduced on the fp8 checkpoint and on the Q4_K_M
      // GGUF alike, which is what makes it the ENCODER rather than the
      // quantisation of the model beside it.
      //
      // Why it went unnoticed: the pod has never loaded this file. Its own
      // `model_map` krea2 entry names an abliterated **bf16**, so the studio's
      // whole panel pipeline runs on weights the desktop catalogue does not
      // offer, and the one file the desktop DID offer was the one nothing had
      // rendered with. The general rule: a catalogue file the pod does not use
      // in production is an unverified file.
      //
      // 3.4GB more to download and it is not peak memory — the encoder is
      // loaded and freed BEFORE the diffusion weights, so this costs the
      // download and not the rung's `vram_gb`, exactly as Qwen-Edit's row
      // notes. `…-int8_convrot` (4830MB) exists upstream and might be the
      // small rung that works, since comfy_kitchen dequantises int8_convrot
      // natively where this box's cu128 torch left the fp8 path on `eager` —
      // untested, so not offered.
      { url: `${KREA2}/text_encoders/qwen3vl_4b_bf16.safetensors`,
        filename: "qwen3vl_4b_bf16.safetensors", dir: "text_encoders", size_mb: 8465 },
      { url: `${KREA2}/vae/qwen_image_vae.safetensors`,
        filename: "qwen_image_vae.safetensors", dir: "vae", size_mb: 242, shared: true },
    ],
    // THE QUANT LADDER, and why it was missing. This row shipped as a single
    // 18GB rung — so the model the studio draws every panel and character
    // sheet with excluded every 16GB Mac and every 12GB card, which is most of
    // the machines that install a local engine at all. The GGUFs need no new
    // dependency: `UnetLoaderGGUF` is the same city96 pack the installer
    // already adds for Wan, and the architecture the files declare
    // (`qwen_image`) is one it handles.
    //
    // `vram_gb` on the fp8 row is measured; the rest are DERIVED from it by
    // the same rule the file's own numbers follow — the diffusion weights
    // rounded up, plus the ~5GB the encoder, VAE and 1024px activations cost
    // beside them. Said out loud because this file's header promises measured
    // numbers and these four are arithmetic.
    swappable: ["krea2-fp8", "krea2-q6", "krea2-q4", "krea2-q4s", "krea2-q3"],
    variants: [
      { id: "krea2-fp8", label: "fp8 scaled", precision: "fp8", vram_gb: 18,
        quality: "what the studio cloud renders on", tag: "matches the cloud",
        files: [{ url: `${KREA2}/diffusion_models/krea2_turbo_fp8_scaled.safetensors`,
          filename: "krea2_turbo_fp8_scaled.safetensors", dir: "diffusion_models", size_mb: 12533 }] },
      { id: "krea2-q6", label: "Q6_K", precision: "gguf", vram_gb: 16,
        quality: "very close to fp8 — the choice when 18GB is just out of reach",
        files: [gguf(`${KREA2Q}/Krea-2-Turbo-Q6_K-7.29bpw.gguf`,
          "Krea-2-Turbo-Q6_K-7.29bpw.gguf", 11144)] },
      { id: "krea2-q4", label: "Q4_K_M", precision: "gguf", vram_gb: 13,
        quality: "some loss on fine texture and small text; the best quality per gigabyte",
        tag: "recommended",
        files: [gguf(`${KREA2Q}/Krea-2-Turbo-Q4_K_M-4.93bpw.gguf`,
          "Krea-2-Turbo-Q4_K_M-4.93bpw.gguf", 7531)] },
      { id: "krea2-q4s", label: "Q4_K_S", precision: "gguf", vram_gb: 12,
        quality: "a shade below Q4_K_M for one gigabyte less",
        files: [gguf(`${KREA2Q}/Krea-2-Turbo-Q4_K_S-4.27bpw.gguf`,
          "Krea-2-Turbo-Q4_K_S-4.27bpw.gguf", 6523)] },
      // Tagged for 12GB rather than the 12GB rung above it, deliberately: a
      // "12GB" card reports 12,282MB = 11.99GB, so `fits` rejects a 12 and
      // clears an 11. The label has to name what the hardware actually does.
      { id: "krea2-q3", label: "Q3_K_M", precision: "gguf", vram_gb: 11,
        quality: "noticeably lossy — the last resort on a small machine",
        tag: "fits a 12GB card",
        files: [gguf(`${KREA2Q}/Krea-2-Turbo-Q3_K_M-3.91bpw.gguf`,
          "Krea-2-Turbo-Q3_K_M-3.91bpw.gguf", 5971)] },
      // Q8_0 is deliberately absent: at 13.7GB it is LARGER than the fp8 file
      // it would be quantising, so it costs more memory for no reason.
    ],
  },

  /* ── video ─────────────────────────────────────────────────────────── */
  {
    id: "qwen-edit", name: "Qwen-Image-Edit 2511", media: "image",
    license: "Apache 2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    tag: "the only local editor",
    blurb: "The one local model that can work FROM pictures — edit a frame, or compose "
      + "up to three references into a new one. Everything else here is text-only, so a "
      + "job carrying references falls back to this.",
    recipe: "20 steps · cfg 2.5 · up to 3 references",
    shared: [
      // 8.9GB, and it is loaded and freed BEFORE the diffusion weights, so it
      // costs download and not peak memory — which is why the VRAM figures
      // below track the UNET rather than the pair.
      { url: `${QWEN}/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors`,
        filename: "qwen_2.5_vl_7b_fp8_scaled.safetensors", dir: "text_encoders", size_mb: 8950 },
      // The same decoder Krea 2 uses — fetched once, then shared between them.
      { url: `${QWEN}/vae/qwen_image_vae.safetensors`,
        filename: "qwen_image_vae.safetensors", dir: "vae", size_mb: 242, shared: true },
    ],
    swappable: ["qwen-fp8", "qwen-q5", "qwen-q4", "qwen-q3", "qwen-q2"],
    variants: [
      { id: "qwen-fp8", label: "fp8 mixed", precision: "fp8", vram_gb: 24,
        quality: "what the studio cloud renders on", tag: "matches the cloud",
        files: [{ url: `${QWENE}/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors`,
          filename: "qwen_image_edit_2511_fp8mixed.safetensors",
          dir: "diffusion_models", size_mb: 19583 }] },
      { id: "qwen-q5", label: "Q5_K_S", precision: "gguf", vram_gb: 18,
        quality: "near-lossless; the usual choice when fp8 will not fit",
        files: [gguf(`${QWENEQ}/qwen-image-edit-2511-Q5_K_S.gguf`,
          "qwen-image-edit-2511-Q5_K_S.gguf", 13464)] },
      { id: "qwen-q4", label: "Q4_K_M", precision: "gguf", vram_gb: 17,
        quality: "some loss on fine texture; the best quality per gigabyte",
        tag: "recommended",
        files: [gguf(`${QWENEQ}/qwen-image-edit-2511-Q4_K_M.gguf`,
          "qwen-image-edit-2511-Q4_K_M.gguf", 12631)] },
      { id: "qwen-q3", label: "Q3_K_M", precision: "gguf", vram_gb: 14,
        quality: "visibly lossy, and identity holds less well across references",
        files: [gguf(`${QWENEQ}/qwen-image-edit-2511-Q3_K_M.gguf`,
          "qwen-image-edit-2511-Q3_K_M.gguf", 9461)] },
      { id: "qwen-q2", label: "Q2_K", precision: "gguf", vram_gb: 12,
        quality: "the last resort — offered because an editor you can run beats one you "
          + "cannot", tag: "fits a 12GB card",
        files: [gguf(`${QWENEQ}/qwen-image-edit-2511-Q2_K.gguf`,
          "qwen-image-edit-2511-Q2_K.gguf", 7122)] },
    ],
  },
  {
    id: "wan21-1.3b", name: "Wan 2.1 · 1.3B", media: "video", license: "Apache 2.0",
    tag: "smallest video model",
    blurb: "Text to video, 480p, no audio. The only video family that runs comfortably on "
      + "a 16GB machine — and most of its download is the text encoder every Wan shares.",
    recipe: "20 steps · 480p · ~5s",
    shared: [UMT5, WAN_VAE],
    swappable: ["wan13-fp16", "wan13-q4", "wan13-q3"],
    variants: [
      { id: "wan13-fp16", label: "fp16", precision: "fp16", vram_gb: 6,
        quality: "the full model", tag: "recommended",
        files: [{ url: `${WAN21}/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors`,
          filename: "wan2.1_t2v_1.3B_fp16.safetensors", dir: "diffusion_models", size_mb: 2707 }] },
      { id: "wan13-q4", label: "Q4_K_M", precision: "gguf", vram_gb: 4,
        quality: "visible softening on fine detail; fine for motion tests",
        files: [gguf(`${WAN13Q}/Wan2.1-T2V-1.3B-Q4_K_M.gguf`, "Wan2.1-T2V-1.3B-Q4_K_M.gguf", 942)] },
      { id: "wan13-q3", label: "Q3_K_M", precision: "gguf", vram_gb: 3,
        quality: "noticeably lossy — the last resort on a small machine",
        files: [gguf(`${WAN13Q}/Wan2.1-T2V-1.3B-Q3_K_M.gguf`, "Wan2.1-T2V-1.3B-Q3_K_M.gguf", 696)] },
    ],
    // No step distill listed. The LightX2V adapter this row used to offer is a
    // FOURTEEN-B file — see the note on the 14B family — and the 1.3B is 1536
    // wide. Nothing here fits it, so nothing here offers it.
  },
  {
    id: "wan22-5b", name: "Wan 2.2 · TI2V 5B", media: "video", license: "Apache 2.0",
    blurb: "Text OR image to video at 720p. The real step up in coherence and motion, and "
      + "the family where quantisation earns its keep: Q4_K_M is a third of the fp16.",
    recipe: "30 steps · cfg 5 · 24fps · 720p",
    shared: [UMT5, WAN22_VAE],
    swappable: ["wan5b-fp16", "wan5b-q8", "wan5b-q6", "wan5b-q4", "wan5b-q3"],
    variants: [
      { id: "wan5b-fp16", label: "fp16", precision: "fp16", vram_gb: 11,
        quality: "the full model",
        files: [{ url: `${WAN22}/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`,
          filename: "wan2.2_ti2v_5B_fp16.safetensors", dir: "diffusion_models", size_mb: 9536 }] },
      { id: "wan5b-q8", label: "Q8_0", precision: "gguf", vram_gb: 8,
        quality: "near-lossless — the usual choice when fp16 will not fit",
        files: [gguf(`${WAN22Q}/Wan2.2-TI2V-5B-Q8_0.gguf`, "Wan2.2-TI2V-5B-Q8_0.gguf", 5151)] },
      { id: "wan5b-q6", label: "Q6_K", precision: "gguf", vram_gb: 7,
        quality: "very close to fp16, hard to tell apart in motion",
        files: [gguf(`${WAN22Q}/Wan2.2-TI2V-5B-Q6_K.gguf`, "Wan2.2-TI2V-5B-Q6_K.gguf", 4014)] },
      { id: "wan5b-q4", label: "Q4_K_M", precision: "gguf", vram_gb: 6,
        quality: "some detail loss; the best quality-per-gigabyte on a laptop",
        tag: "fits a laptop",
        files: [gguf(`${WAN22Q}/Wan2.2-TI2V-5B-Q4_K_M.gguf`, "Wan2.2-TI2V-5B-Q4_K_M.gguf", 3277)] },
      { id: "wan5b-q3", label: "Q3_K_M", precision: "gguf", vram_gb: 5,
        quality: "noticeably lossy",
        files: [gguf(`${WAN22Q}/Wan2.2-TI2V-5B-Q3_K_M.gguf`, "Wan2.2-TI2V-5B-Q3_K_M.gguf", 2427)] },
    ],
    // Also no step distill, and for the same measured reason as the 1.3B: the
    // LightX2V file is 5120-wide (14B) and the 5B is 3072. Read straight off
    // the safetensors header — `blocks.0.cross_attn.k.lora_down.weight` is
    // [32, 5120] — the same shape-check discipline CLAUDE.md uses for H3
    // adapters, and cheaper than discovering it after a 30-step sample.
  },
  {
    id: "wan22-14b", name: "Wan 2.2 · I2V 14B", media: "video", license: "Apache 2.0",
    blurb: "The full-size Wan. Every variant is TWO models — a "
      + "high-noise and a low-noise expert that run in sequence — so the download and "
      + "the memory are both doubled.",
    recipe: "high+low noise pair · 720p",
    shared: [UMT5, WAN_VAE],
    swappable: ["wan14b-fp8", "wan14b-q4", "wan14b-q3"],
    variants: [
      { id: "wan14b-fp8", label: "fp8 scaled (pair)", precision: "fp8", vram_gb: 20,
        quality: "what the studio cloud renders on",
        files: [
          { url: `${WAN22}/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors`,
            filename: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors", dir: "diffusion_models", size_mb: 13633 },
          { url: `${WAN22}/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors`,
            filename: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors", dir: "diffusion_models", size_mb: 13633 },
        ] },
      { id: "wan14b-q4", label: "Q4_K_M (pair)", precision: "gguf", vram_gb: 12,
        quality: "the 14B on a 12GB card — worth it over the 5B fp16",
        tag: "best on 12GB",
        files: [
          gguf(`${WAN14Q}/HighNoise/Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf`,
               "Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf", 9206),
          gguf(`${WAN14Q}/LowNoise/Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf`,
               "Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf", 9206),
        ] },
      { id: "wan14b-q3", label: "Q3_K_M (pair)", precision: "gguf", vram_gb: 9,
        quality: "lossy, but the only way 14B fits under 10GB",
        files: [
          gguf(`${WAN14Q}/HighNoise/Wan2.2-I2V-A14B-HighNoise-Q3_K_M.gguf`,
               "Wan2.2-I2V-A14B-HighNoise-Q3_K_M.gguf", 6840),
          gguf(`${WAN14Q}/LowNoise/Wan2.2-I2V-A14B-LowNoise-Q3_K_M.gguf`,
               "Wan2.2-I2V-A14B-LowNoise-Q3_K_M.gguf", 6840),
        ] },
    ],
    // The one Wan family this adapter actually fits. It was listed on the 1.3B
    // and the 5B and on neither does it apply: its tensors are 5120 wide,
    // which is the 14B's hidden size. ComfyUI's loader skips a key it cannot
    // reshape and applies the rest, so the wrong pairing does not error — it
    // renders 20 steps' worth of nothing at the 4-step settings the adapter
    // asks for, which looks like the model being bad.
    addons: [
      { id: "wan-lightx2v", name: "LightX2V 4-step distill", kind: "speed", tag: "4 steps",
        recipe: "4 steps · cfg 1",
        blurb: "Step distillation for Wan: 20 steps down to 4, which on a laptop is the "
          + "difference between a coffee break and a preview.",
        sampling: { steps: 4, cfg: 1 },
        files: [{ url: `${KIJAI_WAN}/Wan21_T2V_14B_lightx2v_cfg_step_distill_lora_rank32.safetensors`,
          filename: "Wan21_T2V_14B_lightx2v_cfg_step_distill_lora_rank32.safetensors",
          dir: "loras", size_mb: 307 }] },
    ],
  },
  {
    id: "minimax-h3", name: "MiniMax H3", media: "video",
    studioDefaultFor: "h3-turbo-local",
    license: "MiniMax community",
    licenseUrl: "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    blurb: "What the studio's episodes are rendered with — native audio, 24fps, and the "
      + "reference system the storyboard pipeline is built around. A 2026-09-01 tier "
      + "benchmark measured every rung below on capped hardware: it renders inside 6GB of "
      + "VRAM, provided the machine has the system RAM to stream it from.",
    recipe: "20 steps · 17n+5 frames · 24fps",
    shared: [
      { url: `${H3}/vae/minimax_h3_video_vae_fp16.safetensors`,
        filename: "minimax_h3_video_vae_fp16.safetensors", dir: "vae", size_mb: 4967 },
      { url: `${H3}/vae/minimax_h3_audio_vae_fp32.safetensors`,
        filename: "minimax_h3_audio_vae_fp32.safetensors", dir: "vae", size_mb: 577 },
    ],
    // EVERY NUMBER IN THESE ROWS IS A MEASUREMENT, and `vram_gb` here means
    // something narrower than it does elsewhere in this file: the SMALLEST TIER
    // THE ROW RENDERED AT. It cannot be a working set for H3, because ComfyUI
    // 0.34 fills whatever it is given — the pruned rung peaked 21.5GB on a 24GB
    // card, 13.5GB on a 16GB one and 7.97GB inside a hard 8GB ceiling, all
    // rendering the same clip. The floor is the only figure that answers "will
    // this run here", which is also exactly what `fits()` asks.
    //
    // AND IT MAY NOT BE INTERPOLATED. ComfyUI's low-VRAM behaviour is
    // non-monotonic: below a threshold it abandons partial residency for full
    // streaming, so the GGUF rungs paired with the GGUF text encoder FAIL at
    // 8/12/16GB and PASS at 6. Nothing here is inferred from a neighbouring
    // tier; `benchmark_results.md` records which cells were run.
    swappable: ["h3-int8", "h3-int8-studio", "h3-q5", "h3-q4", "h3-q3"],
    variants: [
      { id: "h3-int8", label: "int8 convrot (pruned)", precision: "int8",
        vram_gb: 8, ram_gb: 48, preferred: true, tag: "recommended",
        refCheckpoint: H3_REF.pruned,
        quality: "the official weights at full quality — and the best-measured rung: it "
          + "rendered inside a driver-enforced 8GB ceiling, where the unpruned set needs "
          + "16GB and 11GB more RAM to do the same job",
        files: [
          { url: `${H3}/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors`,
            filename: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
            dir: "diffusion_models", size_mb: 19999 },
          H3_TE_NVFP4,
        ] },
      // "Pruned" is not a lossy quantisation of the row above — it is the same
      // int8 weights with the timestep embedder replaced by a precomputed
      // lookup table (`adaln_t_table`; 932 tensors against the unpruned file's
      // 1035, read off the safetensors headers). Comfy-Org ships both, and the
      // benchmark found no quality difference and a large capacity one.
      { id: "h3-int8-studio", label: "int8 convrot (unpruned)", precision: "int8",
        vram_gb: 16, ram_gb: 59, tag: "matches the cloud", refCheckpoint: H3_REF.studio,
        quality: "byte-identical to what the studio cloud loads. 24GB more download and "
          + "11GB more RAM than the pruned rung, and it needs a 16GB card rather than an "
          + "8GB one — for no measured quality gain",
        files: [
          { url: `${H3}/diffusion_models/minimax_h3_fl2va_int8_convrot.safetensors`,
            filename: "minimax_h3_fl2va_int8_convrot.safetensors", dir: "diffusion_models", size_mb: 32462 },
          { url: `${H3}/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors`,
            filename: "qwen3vl_32b_minimax_h3_int8_convrot.safetensors", dir: "text_encoders", size_mb: 25884 },
        ] },
      // A COMMUNITY MERGE, AND IT IS A LOOK RATHER THAN A SHORTCUT. DaSiWa's
      // Hybrid 4Turbo is an int8 H3 merge distributed on Civitai; rendered
      // through the studio's OWN recipe (the same graph as the pruned rung, one
      // checkpoint filename different) it passed a driver-enforced 8GB with the
      // same 48GB of RAM and the same wall time — 465s against the official
      // set's 471s. So it is NOT faster: the speed its author's own workflow
      // shows comes from Spectrum block-caching and a different distillation,
      // neither of which this ships. What it does give is a different picture:
      // warmer, higher-contrast, more graded, on the same seed and prompt.
      //
      // CLIPS ONLY, and that is a measurement rather than caution. The drop-in
      // test exercised the fl2va path (i2v/t2v/flf). Its author calls it a
      // fl2va+ref2va hybrid and the reference NODE does accept it — but the one
      // run that used that node staged no reference images, so
      // reference-conditioned r2v is untested and an EPISODE (which renders
      // r2v) is not something this row may claim.
      { id: "h3-dasiwa", label: "DaSiWa Hybrid 4Turbo", precision: "int8",
        vram_gb: 8, ram_gb: 48, tag: "a different look",
        quality: "a community merge of the same architecture — warmer and more contrasty "
          + "than the official weights at the same seed, for the same memory and the same "
          + "time. Text and image to video only: its reference mode was never verified "
          + "with references staged, so it offers no r2v and episodes stay on the "
          + "official checkpoints",
        files: [
          { url: "https://civitai.com/api/download/models/3272675?fileId=3156813",
            filename: "DasiwaMinimaxH3_dasiwaHybrid4turboV1.safetensors",
            dir: "diffusion_models", size_mb: 19996, gated: GATE_DASIWA },
          H3_TE_NVFP4,
        ] },
      // THE GGUF RUNGS ARE PAIRED WITH THE nvfp4 SAFETENSORS ENCODER, NOT WITH
      // ABIRAY'S Q4 GGUF ONE, and that pairing is the single most consequential
      // correction the benchmark produced. With the GGUF encoder ComfyUI
      // partial-loads it to ~13.4GB and the encode's 1.45GiB activation has
      // nowhere to go: `torch.OutOfMemoryError` in `MiniMaxH3ImageToVideo`, ~75
      // seconds in, at 8GB AND 12GB AND 16GB — the UNet is never reached. It is
      // a text-encoder defect, not a quantisation defect, and swapping in the
      // encoder above fixes every one of those cells.
      //
      // nvfp4 dequantises on Turing and Ampere through comfy kitchen's
      // `dequantize_nvfp4` — verified by rendering on a T4. It has no Blackwell
      // requirement, which is the thing that made this substitution possible.
      { id: "h3-q5", label: "Q5_K_M", precision: "gguf", vram_gb: 6, ram_gb: 31,
        refCheckpoint: H3_REF.q5,
        quality: "the closest quantisation to the int8 weights — and it renders inside a "
          + "hard 6GB where the int8 rung needs 8, because a GGUF streams. It is LARGER on "
          + "disk than the pruned int8 file, so the reason to take it is memory, not size",
        files: [
          gguf(`${H3Q}/unet/MiniMax-H3-FL2VA-Q5_K_M.gguf`, "MiniMax-H3-FL2VA-Q5_K_M.gguf", 22781),
          H3_TE_NVFP4,
        ] },
      { id: "h3-q4", label: "Q4_K_M", precision: "gguf", vram_gb: 6, ram_gb: 27,
        refCheckpoint: H3_REF.q4,
        tag: "best per gigabyte",
        quality: "some loss on fine detail, and 21GB less system RAM than the int8 rung — "
          + "the sweet spot on a machine that is short of memory rather than short of card",
        files: [
          gguf(`${H3Q}/unet/MiniMax-H3-FL2VA-Q4_K_M.gguf`, "MiniMax-H3-FL2VA-Q4_K_M.gguf", 18944),
          H3_TE_NVFP4,
        ] },
      // Q3_K_S and Q5_K_S are deliberately absent: header-probed, their tensor
      // tables are identical to the _K_M files and so is the sha256 of the
      // tensor DATA REGION — one artifact published under two labels in each
      // case. Only Q4_K_S genuinely differs, and by 10MB.
      { id: "h3-q3", label: "Q3_K_M", precision: "gguf", vram_gb: 6, ram_gb: 23,
        refCheckpoint: H3_REF.q3,
        tag: "fits a 6GB card",
        quality: "lossy on a model whose whole point is fidelity, and slow — but it is the "
          + "only rung measured rendering inside a hard 6GB ceiling",
        files: [
          gguf(`${H3Q}/unet/MiniMax-H3-FL2VA-Q3_K_M.gguf`, "MiniMax-H3-FL2VA-Q3_K_M.gguf", 14846),
          H3_TE_NVFP4,
        ] },
    ],
    // Turbo is an ADAPTER, not a model — exactly as model_map has it
    // (`minimax-h3-turbo` = this family + `turbo_lora`). Two distillations
    // exist and they are applied differently: larryvrh's needs its own node
    // pack and sampler, lightx2v's is a plain LoraLoaderModelOnly. Measured on
    // the pod: 20 steps 111s -> 6 steps 41s, a 2.7x speedup.
    addons: [
      // THE ADAPTER EVERY PASSING BENCHMARK CELL RENDERED THROUGH, and the
      // reason the tier table is a 4-step table rather than a 20-step one. It
      // is an ordinary `LoraLoaderModelOnly` — no pack — so unlike the turbo v4
      // below it cannot be silently degraded by an installer that skipped
      // something.
      //
      // ITS RECIPE DISAGREES WITH THE POD'S, deliberately. `model_map`'s
      // `minimax-h3-lightx2v` runs the 4-step at strength 0.75 on `er_sde` with
      // no sigma shift; the benchmark used the community-converged form —
      // strength 1.0, `res_multistep`/`simple`, `MiniMaxH3SigmaShift` 12
      // (video) / 3 (audio) — and that is what produced clean 4-step output on
      // every variant here. `MiniMaxH3SigmaShift` is core ComfyUI (it lives in
      // `comfy_extras/nodes_minimax_h3.py`), checked rather than assumed.
      { id: "h3-lightx2v-4", name: "LightX2V 4-step", kind: "speed", tag: "the measured recipe",
        recipe: "4 steps · res_multistep/simple · sigma shift 12/3 · no extra node",
        sampling: { steps: 4, sampler: "res_multistep", scheduler: "simple", h3Shift: [12, 3] },
        blurb: "Step distillation down to four. Every rung in the tier benchmark was "
          + "measured with this adapter on, so the VRAM floors quoted above are the floors "
          + "you get by installing it — and it is the difference between three minutes and "
          + "twenty on a small card.",
        files: [{ url: `${H3LX4}/loras/minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors`,
          filename: "minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors",
          dir: "loras", size_mb: 1866 }] },
      // The distillation the DaSiWa workflow ships with, and a DIFFERENT FILE
      // from larryvrh's below despite the shared lineage: drbaph's pruned
      // ComfyUI repack is 592MB against 748MB, and — the part that matters —
      // it applies as a plain `LoraLoaderModelOnly`, so it needs none of the
      // node pack the row below is hidden without. Measured at 4 steps on the
      // DaSiWa checkpoint at 8, 12, 16 and 24GB.
      { id: "h3-turbo-v4-plain", name: "Turbo v4 EMA (4-step, no pack)", kind: "speed",
        tag: "4 steps", recipe: "4 steps · res_multistep/simple · sigma shift 12/3",
        sampling: { steps: 4, sampler: "res_multistep", scheduler: "simple", h3Shift: [12, 3] },
        blurb: "The 4-step distillation the DaSiWa build is published with. Interchangeable "
          + "with LightX2V above on any H3 rung — both were measured rendering the same "
          + "clip — and a third the size.",
        files: [{ url: `${H3EMA}/minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors`,
          filename: "minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors",
          dir: "loras", size_mb: 592 }] },
      { id: "h3-turbo-v4", name: "Turbo v4 (larryvrh)", kind: "speed", tag: "2.7x measured",
        recipe: "6 steps · needs the MiniMax-H3-Turbo node pack",
        sampling: { steps: 6 },
        // Checked against a live local engine: neither `MiniMaxH3TurboLoRA`
        // nor `MiniMaxH3TurboSampler` is among the 857 classes the installer
        // produces, and the pack directory is not there to install them.
        needsPack: "ComfyUI-MiniMax-H3-Turbo",
        blurb: "Step distillation, applied as a runtime bypass rather than merged — "
          + "merging rounds part of the delta away on int8 weights, which is the signal "
          + "that makes 6 steps work.",
        files: [{ url: `${H3TURBO}/minimax_h3_turbo_v4_step600_ema.safetensors`,
          filename: "minimax_h3_turbo_v4_step600_ema.safetensors", dir: "loras", size_mb: 748 }] },
      { id: "h3-lightx2v-8", name: "LightX2V 8-step", kind: "speed",
        recipe: "8 steps · sa_solver · no extra node",
        // The machine-readable half of that sentence. Without it the adapter
        // loads and the render still samples 20 steps — the distillation
        // doing nothing, which is what `FamilyAddon.sampling` exists to stop.
        sampling: { steps: 8, sampler: "sa_solver" },
        blurb: "The other distillation. Depends on no custom node at all — an ordinary "
          + "LoRA — but rewrites the sampler and step count. Check the AUDIO before "
          + "trusting it on a dialogue block.",
        files: [{ url: `${H3LX}/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors`,
          filename: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
          dir: "loras", size_mb: 1864 }] },
      // REF2VA IS WHAT AN EPISODE RENDERS ON, and it was absent for as long as
      // this family existed. `master_pass` renders a block in `r2v` — the mode
      // the whole reference system is built around — and `fl2va` cannot do r2v
      // at all, so a machine could hold 57GB of H3 and still not render one
      // block of a storyboard. It is not only episodes: a COMPOSER clip with a
      // character sheet staged is r2v too, and until `refCheckpoint` existed
      // that path loaded the fl2va weights and quietly ignored the sheet.
      //
      // THE TWO PATHS REACH DIFFERENT DISTANCES, which is why three of these
      // rows say "composer clips". A clip is built by `localGraphs.buildH3`,
      // TypeScript, which picks its loader per FILE and so can open a `.gguf`.
      // An EPISODE is built by the studio's Python from
      // `workflows/minimax_h3_r2v.json`, which loads through the stock
      // `UNETLoader` — and there is no H3 GGUF template (only Wan has one) and
      // no `model_map` entry setting `gguf`. So storyboards need one of the two
      // safetensors rows whatever else is installed.
      //
      // FIVE ROWS, ONE VISIBLE. The reference checkpoint comes in the same
      // precisions as the rungs above and they are NOT interchangeable: a
      // `.gguf` cannot load in the stock `UNETLoader` the safetensors path
      // uses, and the pod-matching rung wants the pod's own unpruned file.
      // `forVariants` shows only the one that matches what you installed —
      // four wrong ~20GB rows on screen is four ways to spend a download on
      // something that cannot render. Every file comes from `H3_REF`, which is
      // the same object the variant names, so the download and the graph
      // cannot disagree.
      //
      // DaSiWa has NO row here on purpose: its reference mode was never
      // verified with references actually staged, so the catalogue does not
      // offer one. That is the same claim its own `quality` line makes.
      refAddon("pruned", ["h3-int8"], "for the pruned int8 rung"),
      refAddon("studio", ["h3-int8-studio"], "for the unpruned int8 rung"),
      refAddon("q5", ["h3-q5"], "for Q5_K_M", true),
      refAddon("q4", ["h3-q4"], "for Q4_K_M", true),
      refAddon("q3", ["h3-q3"], "for Q3_K_M", true),
      { id: "h3-image-vae", name: "T1 stills decoder", kind: "capability",
        tag: "renders images", recipe: "1 frame · needs the patched length=1 node",
        blurb: "Lets H3 render STILLS as well as video. The published trick decodes five "
          + "frames and keeps frame 0, which is why those look soft — frame 0 carries "
          + "motion invented to reach frame 1. This decodes one frame as one frame.",
        files: [{ url: `${H3VAE}/minimax_h3_t1_image_vae_step1597.safetensors`,
          filename: "minimax_h3_t1_image_vae_step1597.safetensors", dir: "vae", size_mb: 4966 }] },
      // THE STUDIO'S OWN PIPELINE REACHES FOR THIS ONE BY ITSELF.
      // `handlers/blocks._block_loras` appends `combat` to every block of an
      // ACTION scene when the model declares it — so on a desktop that has not
      // got the file, `resolve.lora_stack` answers "this model does not declare
      // combat" and a fight renders without it: correct degradation, and
      // visible only in `master_pass`'s adapter log line.
      //
      // MEASURED on the pod, seed fixed, plain H3 (2026-08-22): +40.7% motion
      // and +85.6% sharpness on one scene, +71.0% / +35.6% on an unrelated
      // second one, against a two-identical-renders floor of -0.8% / -11.7%.
      // What it does is visible rather than only numeric — the control threw a
      // punch and reset to guard, the combat arm delivered the written chain.
      // The author's advertised AUDIO gain does NOT survive the same test and
      // is not claimed here.
      { id: "h3-combat", name: "Combat Base V2", kind: "quality", tag: "fight motion",
        recipe: "strength 1.0 · no trigger · res_multistep/simple",
        blurb: "Fight choreography and impact — the studio applies it to every action "
          + "block on its own. Run it at 1.0 with NO trigger word: adding the author's "
          + "own `prfight2, prfin1` measured 18.5% SOFTER on the same seed. Trained "
          + "against fl2va, so text/image-to-video is its home ground; it renders clean "
          + "on reference mode too, which is what an episode block uses.",
        files: [{ url: "https://civitai.com/api/download/models/3246572?fileId=3129355",
          filename: "h3_combat_v2.safetensors", dir: "loras", size_mb: 148,
          gated: GATE_COMBAT }] },
      // The other adapter the pipeline reaches for by itself: `_block_loras`
      // appends `camera` to a block whose shots ask for a move. Its trigger is
      // NOT optional — the author trained on it and the token has to OPEN the
      // description — so `model_map`'s `lora_triggers` carries it and
      // `h3_prompt` places it at the head of the compiled prose. Nothing here
      // has to be typed.
      { id: "h3-camera", name: "Camera Motion", kind: "quality", tag: "camera moves",
        recipe: "trigger `camera motion` — placed by the compiler, not typed",
        blurb: "The cinematography H3 is weakest at: push-in, pull-back and handheld "
          + "tracking are the author's strongest three, orbit, aerial and crane-tilt the "
          + "next, and a plain pan the weakest — combine that one with another move. "
          + "Applies whole (no `adaln_proj`, so no ERROR lora lines).",
        files: [{ url: `${H3CAM}/camera_motion_h3_lora_v1_3000_pruned.safetensors`,
          filename: "camera_motion_h3_lora_v1_3000_pruned.safetensors",
          dir: "loras", size_mb: 148 }] },
      // NOT A LoRA PICK, AND THE DIRECTORY IS WHAT ENFORCES THAT. These are a
      // trunk LoRA plus a per-interval head bank, and `installedAddons` only
      // offers an add-on whose files land in `loras` — so this can never reach
      // the composer's picker, which would apply it through
      // `LoraLoaderModelOnly` and silently drop the heads. What it turns on is
      // the `minimax-h3-pdd` entry of the desktop model map, i.e. EPISODE
      // renders through the studio's own pipeline, where `resolve()` splices
      // `MiniMaxH3PDDAccApply` and takes the sigmas off the node.
      //
      // IT IS THE ONE DISTILL THAT SURVIVES THE PRUNED CHECKPOINTS WHOLE. Every
      // other adaln-carrying adapter here logs ~50 `ERROR lora … adaln_proj`
      // lines against them; the pack rebases those modules onto the pruned
      // curve table and the first live render logged zero. Both files are
      // fetched because the file follows the CHECKPOINT — FL2VA for
      // t2v/i2v/flf, Ref2VA for the reference mode an episode block renders in
      // — and the two trunks share identical key sets, so a crossed pairing
      // applies cleanly and renders silently wrong (the node fingerprints the
      // trunk and refuses).
      { id: "h3-pdd", name: "PDD 8-step (official)", kind: "speed",
        tag: "episodes only", recipe: "8 steps · euler on the node's own sigmas",
        needsPack: "ComfyUI-MiniMax-H3-PDD-Acc",
        blurb: "MiniMax's own 8-step acceleration, and the only one with a REFERENCE "
          + "build — so a whole episode runs on it, not just clips. About Turbo's speed "
          + "with cleaner frames side by side (no cross-dissolve ghosting), and unlike Turbo it needs no "
          + "sampler swap. Pick \u201cMiniMax H3 \u00b7 PDD 8-step\u201d in the episode "
          + "wizard; it is not a stackable adapter and does not appear in the clip "
          + "composer.",
        files: [
          { url: `${H3PDD}/MiniMax-H3-FL2VA-Acc-8Step.safetensors`,
            filename: "MiniMax-H3-FL2VA-Acc-8Step.safetensors",
            dir: "pdd_acc", size_mb: 1309 },
          { url: `${H3PDD}/MiniMax-H3-Ref2VA-Acc-8Step.safetensors`,
            filename: "MiniMax-H3-Ref2VA-Acc-8Step.safetensors",
            dir: "pdd_acc", size_mb: 1309 },
        ] },
    ],
    also: "with the stills decoder below, H3 also renders images — it is the studio's "
      + "`h3-image` model",
  },
  {
    // NOT MIRRORED, DELIBERATELY. CircleStone's licence permits Distribution
    // (§3) and only for Non-Commercial Purposes (§2b) — and §1b counts
    // "making the CircleStone Models available to third-parties on a hosted
    // basis" as Distribution, which is exactly what a public bucket is. It
    // costs nothing to leave upstream: every file here is an anonymous 206.
    id: "anima", name: "Anima 2.9B", media: "image", license: "CircleStone (non-commercial)",
    blurb: "Anime and illustration, prompted with danbooru tags plus artist and year tags. "
      + "The only non-distilled image model here, so it wants a real step count and a real "
      + "cfg — and unlike the others it takes a negative prompt that actually does something.",
    recipe: "32 steps · cfg 4 · euler/sgm_uniform",
    shared: [
      // NOT GATED ANY MORE, AND IT NEVER HAD TO BE — see `ANIMA_TE`. This used
      // to name a Civitai object behind a token, which made the whole family
      // uninstallable on a first run for want of its 1.1GB encoder. The same
      // file, byte-for-byte the same size, is published ungated by CircleStone
      // themselves; measured 206 to an anonymous ranged GET where the Civitai
      // url answers 200-with-an-HTML-page.
      { url: `${ANIMA_TE}/text_encoders/qwen_3_06b_base.safetensors`,
        filename: "qwen_3_06b_base.safetensors", dir: "text_encoders", size_mb: 1137 },
      { url: `${KREA2}/vae/qwen_image_vae.safetensors`,
        filename: "qwen_image_vae.safetensors", dir: "vae", size_mb: 242, shared: true },
    ],
    swappable: ["anima-bf16", "anima-int8"],
    variants: [
      { id: "anima-bf16", label: "bf16", precision: "fp16", vram_gb: 10,
        quality: "the full model", tag: "recommended",
        files: [{ url: `${ANIMA}/Anima-2.9B-preview-v1.safetensors`,
          filename: "anima_29b_preview_v1.safetensors",
          dir: "diffusion_models", size_mb: 5573 }] },
      { id: "anima-int8", label: "int8 convrot", precision: "int8", vram_gb: 7,
        quality: "half the weights; the rung for a laptop",
        files: [{ url: `${ANIMA}/Anima-2.9B-preview-v1_int8_convrot.safetensors`,
          filename: "anima_29b_preview_v1_int8_convrot.safetensors",
          dir: "diffusion_models", size_mb: 2940 }] },
    ],
  },
  {
    id: "hidream-o1", name: "HiDream O1", media: "image", license: "MIT",
    // The UPSTREAM MODEL PAGE, not a LICENSE file: HiDream ship none in the O1
    // repo and declare MIT in the card's front-matter, so the page is the
    // authority for these weights being MIT. Checked reachable without an
    // account — `HiDream-I1-Full/blob/main/LICENSE`, the obvious guess, is a
    // 404. The full MIT text travels with the mirror as `NOTICE-hidream-o1.md`.
    licenseUrl: "https://huggingface.co/HiDream-ai/HiDream-O1-Image",
    blurb: "A reference-driven image model with its own seam smoothing — it takes up to ten "
      + "reference images, more than anything else here, and is the one local family that "
      + "samples through a noise-scaled custom sampler rather than a plain KSampler.",
    recipe: "40 steps · cfg 5 · noise scale 8",
    shared: [],
    swappable: ["hidream-fp8", "hidream-bf16"],
    variants: [
      { id: "hidream-fp8", label: "fp8 scaled", precision: "fp8", vram_gb: 13,
        quality: "what the studio cloud renders on", tag: "matches the cloud",
        files: [{ url: `${HIDREAM}/checkpoints/hidream_o1_image_fp8_scaled.safetensors`,
          filename: "hidream_o1_image_fp8_scaled.safetensors",
          dir: "checkpoints", size_mb: 7694 }] },
      { id: "hidream-bf16", label: "bf16", precision: "fp16", vram_gb: 22,
        quality: "the full model",
        files: [{ url: `${HIDREAM}/checkpoints/hidream_o1_image_bf16.safetensors`,
          filename: "hidream_o1_image_bf16.safetensors",
          dir: "checkpoints", size_mb: 15607 }] },
    ],
  },
  {
    // NOT MIRRORED, DELIBERATELY — same reasoning as Anima and the Klein 9B
    // below. The FLUX Non-Commercial License v2.1 permits Distribution (§3,
    // conditioned on passing the licence on) and restricts every use of it,
    // Distribution included, to Non-Commercial Purposes (§2b). All four files
    // fetch anonymously, so nothing is lost by leaving them upstream.
    id: "flux2", name: "Flux 2 dev", media: "image", license: "FLUX.1 non-commercial",
    blurb: "Black Forest Labs' second generation, prompted in plain prose rather than tags. "
      + "Takes reference images through a latent rather than a text encoder, which is a "
      + "different kind of likeness from Qwen-Edit's.",
    recipe: "20 steps · up to 4 references",
    shared: [
      { url: `${FLUX2}/text_encoders/mistral_3_small_flux2_fp4_mixed.safetensors`,
        filename: "mistral_3_small_flux2_fp4_mixed.safetensors",
        dir: "text_encoders", size_mb: 11707 },
      FLUX2_VAE,
    ],
    swappable: ["flux2-q4", "flux2-q3"],
    variants: [
      { id: "flux2-q4", label: "Q4_K_M", precision: "gguf", vram_gb: 24,
        quality: "what the studio cloud renders on", tag: "matches the cloud",
        files: [gguf(`${FLUX2G}/flux2-dev-Q4_K_M.gguf`, "flux2-dev-Q4_K_M.gguf", 19152)] },
      { id: "flux2-q3", label: "Q3_K_M", precision: "gguf", vram_gb: 20,
        quality: "visibly lossy on fine detail — the smallest rung there is",
        files: [gguf(`${FLUX2G}/flux2-dev-Q3_K_M.gguf`, "flux2-dev-Q3_K_M.gguf", 15221)] },
    ],
    // Flux.1 stays absent — BFL gates its `ae.safetensors` (401 to an anonymous
    // ranged GET), so it cannot be a first-run download. Flux.2 [klein] used
    // to be excluded for the same stated reason and it was WRONG: only ONE
    // klein file is gated (`black-forest-labs/FLUX.2-klein-9b-fp8`, measured
    // 401), and every other one — both Comfy-Org repacks, BFL's own 4B fp8,
    // and unsloth's whole GGUF ladder for each size — answers 206 anonymously.
    // Both sizes are their own families below.
  },
  {
    id: "flux2-klein-4b", name: "Flux 2 Klein · 4B", media: "image",
    license: "Apache 2.0",
    licenseUrl: "https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/blob/main/LICENSE.md",
    blurb: "Flux 2's architecture at a size a laptop actually holds, distilled to four "
      + "steps. It takes references through a latent exactly as Flux 2 dev does — and it "
      + "is the only Black Forest Labs model here released under Apache 2.0 rather than a "
      + "non-commercial licence.",
    recipe: "4 steps · cfg 1 · up to 4 references",
    shared: [
      // fp4, matching the choice Flux 2 dev's row already makes for its own
      // encoder — the bf16 `qwen_3_4b.safetensors` is 7.6GB and would be the
      // largest single file in a family whose whole point is fitting.
      { url: `${KLEIN4}/text_encoders/qwen_3_4b_fp4_flux2.safetensors`,
        filename: "qwen_3_4b_fp4_flux2.safetensors", dir: "text_encoders", size_mb: 3670 },
      FLUX2_VAE,
    ],
    // FOUR STEPS AT cfg 1.0 IS BFL'S OWN NUMBER, not a guess: the model card
    // calls this "our fastest distilled model for sub-second image generation"
    // and its example runs `guidance_scale=1.0, num_inference_steps=4`. The
    // BASE (undistilled) 4B is deliberately not offered — it wants real
    // guidance and therefore a negative prompt, and `negative` is a
    // family-level field here, so it would be a second family for a checkpoint
    // nobody has measured on this hardware.
    //
    // `vram_gb` is ESTIMATED on every rung — weights plus about 4GB of VAE and
    // 1MP activations — because nothing here has been benchmarked. The
    // encoder is loaded and freed BEFORE the diffusion weights, so it costs
    // download rather than peak memory, exactly as Qwen-Edit's row notes.
    swappable: [
      "klein4b-bf16", "klein4b-fp8", "klein4b-q5", "klein4b-q4", "klein4b-q3"],
    variants: [
      { id: "klein4b-bf16", label: "bf16", precision: "fp16", vram_gb: 11,
        vramEstimated: true, quality: "the full model",
        files: [{ url: `${KLEIN4}/diffusion_models/flux-2-klein-4b.safetensors`,
          filename: "flux-2-klein-4b.safetensors", dir: "diffusion_models", size_mb: 7392 }] },
      { id: "klein4b-fp8", label: "fp8", precision: "fp8", vram_gb: 8,
        vramEstimated: true, tag: "recommended",
        quality: "BFL's own fp8 build — half the download, and the rung to start on",
        files: [{ url: `${KLEIN4FP8}/flux-2-klein-4b-fp8.safetensors`,
          filename: "flux-2-klein-4b-fp8.safetensors", dir: "diffusion_models", size_mb: 3882 }] },
      { id: "klein4b-q5", label: "Q5_K_M", precision: "gguf", vram_gb: 7,
        vramEstimated: true,
        quality: "near-lossless; the choice when fp8 is just out of reach",
        files: [gguf(`${KLEIN4Q}/flux-2-klein-4b-Q5_K_M.gguf`,
          "flux-2-klein-4b-Q5_K_M.gguf", 2931)] },
      { id: "klein4b-q4", label: "Q4_K_M", precision: "gguf", vram_gb: 6,
        vramEstimated: true,
        quality: "some loss on fine texture; the best quality per gigabyte",
        files: [gguf(`${KLEIN4Q}/flux-2-klein-4b-Q4_K_M.gguf`,
          "flux-2-klein-4b-Q4_K_M.gguf", 2484)] },
      { id: "klein4b-q3", label: "Q3_K_M", precision: "gguf", vram_gb: 5,
        vramEstimated: true, tag: "fits a 6GB card",
        quality: "visibly lossy — the last resort on a small machine",
        files: [gguf(`${KLEIN4Q}/flux-2-klein-4b-Q3_K_M.gguf`,
          "flux-2-klein-4b-Q3_K_M.gguf", 2026)] },
    ],
  },
  {
    // NOT MIRRORED, DELIBERATELY: this half of the Klein pair is under the
    // same FLUX Non-Commercial License as Flux 2 dev. The 4B above is Apache
    // 2.0 and IS mirrored — that is the whole reason they are two families.
    id: "flux2-klein-9b", name: "Flux 2 Klein · 9B", media: "image",
    license: "FLUX non-commercial",
    licenseUrl: "https://huggingface.co/black-forest-labs/FLUX.2-klein-9B/blob/main/LICENSE.md",
    blurb: "The bigger half of the Klein pair — better prompt adherence and finer detail "
      + "than the 4B, at rather more than twice the weights. Non-commercial, unlike the 4B.",
    recipe: "4 steps · cfg 1 · up to 4 references",
    shared: [
      // The pod's own encoder for Klein, which is what makes this the tested
      // pairing rather than the plausible one: `model_map.full.json`'s `klein`
      // entry names exactly this file.
      { url: `${KLEIN9}/text_encoders/qwen_3_8b_fp8mixed.safetensors`,
        filename: "qwen_3_8b_fp8mixed.safetensors", dir: "text_encoders", size_mb: 8263 },
      FLUX2_VAE,
    ],
    // GGUF ALL THE WAY UP, and that is not a preference — `black-forest-labs/
    // FLUX.2-klein-9b-fp8` is the ONE Klein file that is gated (measured 401
    // to an anonymous ranged GET, where every other file in both sizes answers
    // 206). unsloth's ladder is ungated, so the quantisations are the only
    // 9B weights a first run can fetch without an account. Q8_0 is therefore
    // the top rung rather than a middle one.
    swappable: ["klein9b-q8", "klein9b-q6", "klein9b-q5", "klein9b-q4", "klein9b-q3"],
    variants: [
      { id: "klein9b-q8", label: "Q8_0", precision: "gguf", vram_gb: 14,
        vramEstimated: true,
        quality: "as close to the full model as an ungated file gets",
        files: [gguf(`${KLEIN9Q}/flux-2-klein-9b-Q8_0.gguf`,
          "flux-2-klein-9b-Q8_0.gguf", 9516)] },
      { id: "klein9b-q6", label: "Q6_K", precision: "gguf", vram_gb: 12,
        vramEstimated: true, quality: "very close to Q8 for two gigabytes less",
        files: [gguf(`${KLEIN9Q}/flux-2-klein-9b-Q6_K.gguf`,
          "flux-2-klein-9b-Q6_K.gguf", 7501)] },
      { id: "klein9b-q5", label: "Q5_K_M", precision: "gguf", vram_gb: 11,
        vramEstimated: true, quality: "near-lossless",
        files: [gguf(`${KLEIN9Q}/flux-2-klein-9b-Q5_K_M.gguf`,
          "flux-2-klein-9b-Q5_K_M.gguf", 6694)] },
      { id: "klein9b-q4", label: "Q4_K_M", precision: "gguf", vram_gb: 10,
        vramEstimated: true, tag: "recommended",
        quality: "some loss on fine texture; the best quality per gigabyte",
        files: [gguf(`${KLEIN9Q}/flux-2-klein-9b-Q4_K_M.gguf`,
          "flux-2-klein-9b-Q4_K_M.gguf", 5636)] },
      { id: "klein9b-q3", label: "Q3_K_M", precision: "gguf", vram_gb: 8,
        vramEstimated: true, tag: "fits a 12GB card",
        quality: "visibly lossy — take the 4B instead unless you need 9B's prompt "
          + "adherence",
        files: [gguf(`${KLEIN9Q}/flux-2-klein-9b-Q3_K_M.gguf`,
          "flux-2-klein-9b-Q3_K_M.gguf", 4549)] },
    ],
  },
  {
    id: "ltx25", name: "LTX 2.5", media: "video",
    license: "LTX-2.x Community",
    licenseUrl: "https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x",
    tag: "mirror only",
    blurb: "The video model that OBEYS WRITTEN CAMERA DIRECTION — it delivers a dutch "
      + "roll and a true profile, both of which H3 refuses, and it is "
      + "3-5x cheaper per second. Native audio, 24fps. The encoder, the VAEs and the "
      + "upsampler are gated by Lightricks and come from the studio's mirror; the "
      + "quantised rungs are not gated and come straight from their publisher.",
    recipe: "two-pass distilled · 8n+1 frames · 24fps",
    shared: [
      { url: `${LTX25}/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`,
        filename: "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
        dir: "text_encoders", size_mb: 14661, gated: GATE_LTX },
      { url: `${LTX25}/vae/ltx-2.5-video-vae-conv-bf16.safetensors`,
        filename: "ltx-2.5-video-vae-conv-bf16.safetensors",
        dir: "vae", size_mb: 1385, gated: GATE_LTX },
      { url: `${LTX25}/vae/ltx-2.5-audio-vae-bf16.safetensors`,
        filename: "ltx-2.5-audio-vae-bf16.safetensors",
        dir: "vae", size_mb: 348, gated: GATE_LTX },
      // THE TWO FILES BELOW WERE MISSING, and their absence is what dropped
      // LTX 2.5 out of `model_map.desktop.json` entirely — the generator's own
      // report read "the engine window cannot download
      // ltx-2.5-latent-spatial-upscaler…, LTX-2.5-Licon-MSR-V1…". Neither is
      // optional and neither is a nicety:
      //
      //   the x2 latent upsampler IS the pipeline. `latent_scale: 0.5` means
      //   the distilled pass samples a HALF-SIZE latent and this node is what
      //   brings it back before the 4-sigma refine, so without it the recipe
      //   has no second half. It could not even be DECLARED until
      //   `latent_upscale_models` was added to `ModelDir` (see there).
      //
      //   the MSR IC-LoRA carries the learned SLOT EMBEDDINGS, and
      //   `resolve()` RAISES without it rather than degrading — a reference
      //   guide with no LoRA is misconfiguration, not a weaker render. It is
      //   also the one LTX file nobody needs to mirror: LiconStudio publish it
      //   themselves, ungated, Apache-2.0.
      { url: `${LTX25}/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors`,
        filename: "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
        dir: "latent_upscale_models", size_mb: 950, gated: GATE_LTX },
      { url: `${LTXMSR}/LTX-2.5-Licon-MSR-V1.safetensors`,
        filename: "LTX-2.5-Licon-MSR-V1.safetensors", dir: "loras", size_mb: 1248 },
    ],
    swappable: ["ltx25-int8", "ltx25-q5", "ltx25-q4", "ltx25-q3"],
    variants: [
      { id: "ltx25-int8", label: "int8 convrot (distilled)", precision: "int8", vram_gb: 28, vramEstimated: true,
        quality: "what the studio cloud renders on", tag: "matches the cloud",
        files: [{
          url: `${LTX25}/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`,
          filename: "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
          dir: "diffusion_models", size_mb: 20508, gated: GATE_LTX }] },
      // QUANTISED RUNGS. Header-probed before being listed, the way this file
      // demands: `general.architecture = ltxv`, which is in city96's
      // `IMG_ARCH_LIST`, so these load through the same `UnetLoaderGGUF` the
      // installer already adds for Wan and H3 — no new pack, no patch. Same
      // publisher as the H3 GGUFs the tier benchmark ran on, and UNGATED,
      // which is the point: they are the only part of LTX 2.5 a first run can
      // fetch without the studio mirroring anything.
      //
      // `vram_gb` HERE IS AN ESTIMATE, unlike H3's — those numbers are floors
      // a render actually passed at under an enforced cap, and nothing has
      // benchmarked LTX. Read them as "about the weights plus working room",
      // not as a measured tier, and do not compare them with H3's rungs.
      //
      // WHAT QUANTISING DOES NOT FIX: the 14.7GB TEXT ENCODER, which is the
      // bigger half of the download and unmoved by any of this. Its GGUFs are
      // `general.architecture = gemma4` (probed), and `TXT_ARCH_LIST` stops at
      // `gemma3` — the one repo that ships a gemma4 TE GGUF also ships a PATCH
      // to ComfyUI-GGUF, which is the tell. An nvfp4 `comfy_quant` safetensors
      // TE does exist at 11.2GB and keeps the one-`CLIPLoader` shape 2.5 needs;
      // it is not listed because it is one unproven uploader's file and this
      // catalogue is what a first run depends on.
      { id: "ltx25-q5", label: "Q5_K_M", precision: "gguf", vram_gb: 24, vramEstimated: true,
        quality: "nearest the int8 weights the studio cloud renders on",
        files: [gguf(`${LTXQ}/LTX-2.5-Distilled-Q5_K_M.gguf`,
          "LTX-2.5-Distilled-Q5_K_M.gguf", 17277)] },
      { id: "ltx25-q4", label: "Q4_K_M", precision: "gguf", vram_gb: 20, vramEstimated: true,
        quality: "the usual best-per-gigabyte rung", tag: "no gate",
        files: [gguf(`${LTXQ}/LTX-2.5-Distilled-Q4_K_M.gguf`,
          "LTX-2.5-Distilled-Q4_K_M.gguf", 14961)] },
      { id: "ltx25-q3", label: "Q3_K_M", precision: "gguf", vram_gb: 17, vramEstimated: true,
        quality: "smallest rung offered — visibly lossy on fine detail",
        files: [gguf(`${LTXQ}/LTX-2.5-Distilled-Q3_K_M.gguf`,
          "LTX-2.5-Distilled-Q3_K_M.gguf", 12325)] },
    ],
  },
  /* ── audio ─────────────────────────────────────────────────────────── */
  //
  // THERE WAS NO LOCAL AUDIO AT ALL before these two. The catalogue listed
  // image and video families only, so a soundtrack, a sound effect or a score
  // meant waking a $3.36/hr box — for a model that in one case is 3.3GB and
  // runs on a laptop. Both graphs are stock ComfyUI: checked against a live
  // local engine's 857 classes, `MiniMaxMusic3TextEncode`,
  // `EmptyMiniMaxMusic3LatentAudio`, `EmptyLatentAudio`, `VAEDecodeAudio` and
  // `SaveAudioMP3` are all core.
  {
    id: "stable-audio", name: "Stable Audio 3", media: "audio",
    license: "Stability Community",
    // The Community Licence's own §II.1(b) is the obligation: a redistributor
    // must give recipients a copy of the agreement. Pointed at stability.ai
    // rather than at `stabilityai/stable-audio-3-medium/LICENSE.md`, which is
    // the text we mirror but sits in a GATED repo — a licence link that asks
    // the reader to log in is not one they can read before pressing Get.
    // NOTE the encoder beside these checkpoints is a SECOND licence: t5gemma
    // is Gemma-licensed, and `notices/NOTICE-gemma-t5gemma.md` on the mirror
    // carries that half.
    licenseUrl: "https://stability.ai/community-license-agreement",
    tag: "smallest model here",
    blurb: "Sound effects and short beds from a description — a door, rain on a roof, a "
      + "room tone. The small checkpoint plus its encoder is 3.3GB, which makes it the "
      + "one model in this catalogue that runs on essentially any machine.",
    recipe: "distilled: 8 steps cfg 1 · base: 50 steps cfg 7",
    shared: [
      // ONE encoder serves every checkpoint in the repo.
      { url: `${SAUDIO}/text_encoders/t5gemma_b_b_ul2.safetensors`,
        filename: "t5gemma_b_b_ul2.safetensors", dir: "text_encoders", size_mb: 1132 },
    ],
    variants: [
      { id: "sa-sfx", label: "small SFX (distilled)", precision: "fp16", vram_gb: 5,
        quality: "8 steps — near-instant, and what you want for effects",
        tag: "recommended",
        files: [{ url: `${SAUDIO}/checkpoints/stable_audio_3_small_sfx.safetensors`,
          filename: "stable_audio_3_small_sfx.safetensors", dir: "checkpoints", size_mb: 2165 }] },
      // The base twin is NOT redundant: at cfg 7 it evaluates a negative
      // branch, which the distilled one at cfg 1 structurally cannot.
      { id: "sa-sfx-base", label: "small SFX (base)", precision: "fp16", vram_gb: 5,
        quality: "50 steps at cfg 7 — slower, and the only one a negative prompt reaches",
        files: [{ url: `${SAUDIO}/checkpoints/stable_audio_3_small_sfx_base.safetensors`,
          filename: "stable_audio_3_small_sfx_base.safetensors", dir: "checkpoints", size_mb: 2165 }] },
      { id: "sa-medium", label: "medium (distilled)", precision: "fp16", vram_gb: 12,
        quality: "the bigger checkpoint — richer texture and longer coherent beds",
        files: [{ url: `${SAUDIO}/checkpoints/stable_audio_3_medium.safetensors`,
          filename: "stable_audio_3_medium.safetensors", dir: "checkpoints", size_mb: 8795 }] },
    ],
  },
  {
    // LICENCE CORRECTED 2026-09-02: this row said "Apache 2.0" for its whole
    // life, and the model is MIT. The mistake is Comfy-Org's repack, which
    // tags itself `license: apache-2.0` while the model it repackages
    // (`ACE-Step/Ace-Step1.5`) declares MIT in both its card front-matter and
    // its body. Read the licence off the ORIGINAL repo, never off a
    // repackaging — the same check moved Music 3 the other way, where the
    // repack claims apache-2.0 over a genuine MiniMax community licence.
    // MIT still obliges a redistributor to carry the notice, which is why
    // this has a licenseUrl at all.
    id: "acestep", name: "ACE-Step 1.5", media: "audio", license: "MIT",
    licenseUrl: "https://huggingface.co/ACE-Step/Ace-Step1.5",
    blurb: "The fast songwriter — roughly 4x Music 3's speed, and "
      + "the one with typed controls for tempo, key and time signature. It does NOT sing a "
      + "written lyric reliably: on the same eight-line lyric it returned four lines in "
      + "order where Music 3 returned all eight. Reach for it for instrumentals and beds.",
    recipe: "turbo: distilled · euler/simple",
    shared: [
      // TWO encoders, and both are required: `DualCLIPLoader` takes the 0.6b
      // embedder AND the 1.7b planner. Loading one is not a smaller model, it
      // is a graph that fails validation.
      { url: `${ACE}/text_encoders/qwen_0.6b_ace15.safetensors`,
        filename: "qwen_0.6b_ace15.safetensors", dir: "text_encoders", size_mb: 1136 },
      { url: `${ACE}/text_encoders/qwen_1.7b_ace15.safetensors`,
        filename: "qwen_1.7b_ace15.safetensors", dir: "text_encoders", size_mb: 3537 },
      { url: `${ACE}/vae/ace_1.5_vae.safetensors`,
        filename: "ace_1.5_vae.safetensors", dir: "vae", size_mb: 322 },
    ],
    variants: [
      { id: "ace-turbo", label: "1.5 turbo", precision: "fp16", vram_gb: 10,
        quality: "what the studio cloud renders on", tag: "matches the cloud",
        files: [{ url: `${ACE}/diffusion_models/acestep_v1.5_turbo.safetensors`,
          filename: "acestep_v1.5_turbo.safetensors",
          dir: "diffusion_models", size_mb: 4566 }] },
    ],
  },
  {
    id: "music3", name: "MiniMax Music 3", media: "audio",
    // "MiniMax community" is RIGHT, and it is worth saying why against the
    // evidence: Comfy-Org's repack tags itself `license: apache-2.0`, and the
    // model it repackages carries a `LICENSE` reading "MiniMax-Music3
    // COMMUNITY LICENSE" — a permissive grant with an Acceptable Use Policy
    // and commercial terms attached. Its clause 1 is the obligation this link
    // discharges: the notice must travel with every copy, and a first run
    // downloading from our bucket is a copy.
    license: "MiniMax community",
    licenseUrl: "https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE",
    blurb: "Full songs with sung vocals, up to five minutes. It is the model that sings a "
      + "written lyric essentially verbatim, measured against ACE-Step, which "
      + "returned four of eight lines. Most of the download is its 8B planner.",
    recipe: "50 steps · the planner picks the length",
    shared: [
      // The PRUNED int8 encoder: 8.8GB against the bf16's 17.6GB, and it is
      // loaded and freed before the diffusion weights, so it costs download
      // rather than peak memory.
      { url: `${MUSIC3}/text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors`,
        filename: "minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
        dir: "text_encoders", size_mb: 8771 },
      { url: `${MUSIC3}/vae/minimax_music3_dav.safetensors`,
        filename: "minimax_music3_dav.safetensors", dir: "vae", size_mb: 207 },
    ],
    swappable: ["music3-fp16", "music3-int8"],
    variants: [
      { id: "music3-fp16", label: "fp16", precision: "fp16", vram_gb: 12,
        quality: "what the studio cloud renders on", tag: "matches the cloud",
        files: [{ url: `${MUSIC3}/diffusion_models/minimax_music3_dit_fp16.safetensors`,
          filename: "minimax_music3_dit_fp16.safetensors",
          dir: "diffusion_models", size_mb: 4687 }] },
      { id: "music3-int8", label: "int8 convrot", precision: "int8", vram_gb: 10,
        quality: "half the diffusion weights; the encoder beside it is unchanged",
        files: [{ url: `${MUSIC3}/diffusion_models/minimax_music3_dit_int8_convrot.safetensors`,
          filename: "minimax_music3_dit_int8_convrot.safetensors",
          dir: "diffusion_models", size_mb: 2386 }] },
    ],
  },
  // THE ONE FAMILY HERE THAT DOES NOT RENDER THROUGH `localGraphs`. It scores
  // a clip you already have rather than making one from a prompt, and its tail
  // — mux, publish a derived take, re-anchor the block — is the studio's own
  // Python. See `ModelFamily.bundled`.
  {
    id: "mmaudio", name: "MMAudio · Large 44k v2", media: "audio",
    license: "MIT", licenseUrl: "https://github.com/hkchengrex/MMAudio/blob/main/LICENSE",
    tag: "video → audio",
    blurb: "Scores a SILENT clip by watching it — footsteps that land on the footfall, a "
      + "door that closes when the door closes. It is the one model here that takes a "
      + "video as its input, so it works on anything already on the timeline, whatever "
      + "made it. 44.1kHz mono, up to 30 seconds.",
    recipe: "25 steps · cfg 4.5 · watched at 25fps",
    // All four go in ONE directory, which is the pack's doing rather than
    // tidiness: it registers `mmaudio` itself and every loader reads its
    // dropdown from there.
    //
    // `size_mb` IS MEBIBYTES (bytes / 1048576), like every other family here —
    // and these four were first written from HuggingFace's byte count over
    // 1e6, which overstated each by 4.8%. Caught by the pod publisher's own
    // size guard ("a same-named file of the wrong size is a different file")
    // rather than by review; it is the same number `variantMb`, the download
    // copy and the VRAM budget all read.
    shared: [
      { url: `${MMAUDIO}/apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors`,
        filename: "apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors",
        dir: "mmaudio", size_mb: 1882 },
      { url: `${MMAUDIO}/mmaudio_vae_44k_fp16.safetensors`,
        filename: "mmaudio_vae_44k_fp16.safetensors", dir: "mmaudio", size_mb: 583 },
      { url: `${MMAUDIO}/mmaudio_synchformer_fp16.safetensors`,
        filename: "mmaudio_synchformer_fp16.safetensors", dir: "mmaudio", size_mb: 453 },
    ],
    variants: [
      { id: "mm-44k-fp16", label: "large 44k v2 (fp16)", precision: "fp16",
        // Measured on the pod at 32s cold / 11s warm for an 8s clip. The
        // number here is the four files resident plus the vocoder and
        // activations; `vramEstimated` until this machine has rendered one.
        vram_gb: 8, vramEstimated: true,
        quality: "what the studio cloud scores with",
        tag: "matches the cloud",
        files: [{ url: `${MMAUDIO}/mmaudio_large_44k_v2_fp16.safetensors`,
          filename: "mmaudio_large_44k_v2_fp16.safetensors",
          dir: "mmaudio", size_mb: 1966 }] },
    ],
    bundled: {
      catalogRow: "mmaudio-large-44k-v2-local",
      kind: "v2a_gen",
      packs: ["ComfyUI-MMAudio", "ComfyUI-VideoHelperSuite"],
    },
    seeds: [{
      id: "mmaudio-bigvgan", label: "BigVGAN vocoder", dir: "mmaudio", size_mb: 466,
      files: [
        { url: `${BIGVGAN}/bigvgan_generator.pt`,
          path: "nvidia/bigvgan_v2_44khz_128band_512x/bigvgan_generator.pt", size_mb: 466 },
        { url: `${BIGVGAN}/config.json`,
          path: "nvidia/bigvgan_v2_44khz_128band_512x/config.json", size_mb: 1 },
        { url: `${BIGVGAN}/bigvgan.py`,
          path: "nvidia/bigvgan_v2_44khz_128band_512x/bigvgan.py", size_mb: 1 },
        { url: `${BIGVGAN}/activations.py`,
          path: "nvidia/bigvgan_v2_44khz_128band_512x/activations.py", size_mb: 1 },
        { url: `${BIGVGAN}/env.py`,
          path: "nvidia/bigvgan_v2_44khz_128band_512x/env.py", size_mb: 1 },
        { url: `${BIGVGAN}/meldataset.py`,
          path: "nvidia/bigvgan_v2_44khz_128band_512x/meldataset.py", size_mb: 1 },
        { url: `${BIGVGAN}/utils.py`,
          path: "nvidia/bigvgan_v2_44khz_128band_512x/utils.py", size_mb: 1 },
      ],
    }],
  },
];

/* ── post-process ─────────────────────────────────────────────────────── */

/**
 * Tools, not generators: they run AFTER a render. Kept out of the family lists
 * because they are not a choice between alternatives — you either want an
 * upscale pass or you do not, and it works on whatever produced the frames.
 */
export interface PostTool {
  id: string; name: string; blurb: string; files: EngineFile[];
  vram_gb: number; license: string; note?: string;
}

const SEEDVR2 = `${HF}/Comfy-Org/SeedVR2/resolve/main`;
const FRAMEINT = `${HF}/Comfy-Org/frame_interpolation/resolve/main/frame_interpolation`;

export const POST_PROCESS: PostTool[] = [
  {
    // THIS ENTRY NAMED THE WRONG FILE AND OMITTED A REQUIRED ONE. It pointed
    // at `numz/SeedVR2_comfyUI`, a third-party repack whose filename the
    // studio's own graph never loads, and listed no VAE at all — while
    // `seedvr2_graph` opens with `UNETLoader` + `VAELoader` and cannot run
    // without both. Fetching it therefore cost 3.2GB and produced a tool that
    // could not be driven. Corrected to the two files the graph actually
    // names, from Comfy-Org's own repo.
    //
    // Its note was wrong too: SeedVR2 has been CORE since ComfyUI v0.28.0.
    // The pack it named is a different project with different node ids.
    id: "seedvr2-3b", name: "SeedVR2 3B — video upscale", vram_gb: 12,
    license: "Apache 2.0",
    blurb: "A diffusion RESTORE for video, temporally consistent. The enlarge is a plain "
      + "lanczos resize and this re-detects detail at the target size — which is why "
      + "running it at scale 1.0 to clean up a soft render is a legitimate thing to do. "
      + "One step: anything that 'improves' the step count is fighting the model.",
    files: [
      { url: `${SEEDVR2}/diffusion_models/seedvr2_3b_int8_convrot.safetensors`,
        filename: "seedvr2_3b_int8_convrot.safetensors",
        dir: "diffusion_models", size_mb: 3298 },
      { url: `${SEEDVR2}/vae/seedvr2_ema_vae_fp16.safetensors`,
        filename: "seedvr2_ema_vae_fp16.safetensors", dir: "vae", size_mb: 478 },
    ],
  },
  // THE 7B PAIR. Same architecture, same ONE-STEP recipe, same VAE and the
  // same int8_convrot quantisation as the 3B above — so `seedvr2_graph` did
  // not change at all: the studio picks between them by KEY
  // (`graphs.SEEDVR2_MODELS`, `settings.post_upscale_model`) and the worker
  // owns the filename. Two rows rather than variants because `PostTool` has no
  // variant shape and these are two published checkpoints, not two rungs of
  // one.
  //
  // NOT SeedVR **1**. `ByteDance-Seed/SeedVR-7B` is the original paper's
  // model — a multi-step restorer published as a raw 33GB `.pth` that
  // `UNETLoader` cannot read and `steps=1` is meaningless for. The successor
  // is what Comfy-Org repacks and what these rows name.
  //
  // `vram_gb` 24 is DERIVED, not measured: the 3B's 12 plus the 4.7GB the
  // checkpoint grows by, rounded up for the wider activations. Erring high is
  // the safe direction here — this field is what warns, and the SDXL Turbo row
  // is the standing lesson about understating it.
  {
    id: "seedvr2-7b", name: "SeedVR2 7B — video upscale", vram_gb: 24,
    license: "Apache 2.0",
    blurb: "The larger restore. Everything the 3B does, on 8.0GB of weights instead of "
      + "3.2 — slower per frame, and on anime footage the 3B tested sharper, so try both on your own. "
      + "Additive: it does not replace the 3B, and the finishing chain picks between them "
      + "per project.",
    files: [
      { url: `${SEEDVR2}/diffusion_models/seedvr2_7b_int8_convrot.safetensors`,
        filename: "seedvr2_7b_int8_convrot.safetensors",
        dir: "diffusion_models", size_mb: 7949 },
      { url: `${SEEDVR2}/vae/seedvr2_ema_vae_fp16.safetensors`,
        filename: "seedvr2_ema_vae_fp16.safetensors", dir: "vae", size_mb: 478 },
    ],
  },
  {
    id: "seedvr2-7b-sharp", name: "SeedVR2 7B (sharp) — video upscale", vram_gb: 24,
    license: "Apache 2.0",
    blurb: "ByteDance's SECOND 7B checkpoint, published alongside the first and described "
      + "as the sharper of the two — a different file, not a setting. Same size and same "
      + "recipe. About 2.5x the detail of the plain 7B in side-by-side tests.",
    files: [
      { url: `${SEEDVR2}/diffusion_models/seedvr2_7b_sharp_int8_convrot.safetensors`,
        filename: "seedvr2_7b_sharp_int8_convrot.safetensors",
        dir: "diffusion_models", size_mb: 7949 },
      { url: `${SEEDVR2}/vae/seedvr2_ema_vae_fp16.safetensors`,
        filename: "seedvr2_ema_vae_fp16.safetensors", dir: "vae", size_mb: 478 },
    ],
  },
  {
    id: "frame-interp", name: "FILM + RIFE — frame interpolation", vram_gb: 4,
    license: "Apache 2.0",
    blurb: "Doubles or quadruples a clip's frame rate. BOTH are 88MB together and they "
      + "fail differently — FILM holds up better through large motion, RIFE is several "
      + "times faster — so there is no reason to choose between them at this size.",
    files: [
      { url: `${FRAMEINT}/film_net_fp16.safetensors`,
        filename: "film_net_fp16.safetensors", dir: "frame_interpolation", size_mb: 66 },
      { url: `${FRAMEINT}/rife_v4.26_heavy.safetensors`,
        filename: "rife_v4.26_heavy.safetensors", dir: "frame_interpolation", size_mb: 22 },
    ],
  },
  {
    // THE ONE FILE BOTH FACE PASSES NAME. `apply_facefix` and
    // `apply_h3_facefix` each default `detector="bbox/face_yolov8m.pt"`, so
    // without it the Impact Subpack's provider and the H3 tracker both have an
    // empty dropdown — which ComfyUI reports as `value_not_in_list` on a
    // detector nobody chose, after the pass's own model has loaded. Only the
    // H3 one is installable here (Impact is not added — `facefix` is retired),
    // which is what the blurb leads with; the file is the same either way.
    //
    // face_yolov8m OVER THE ...8n (nano) BUILD, which is the pod's own choice
    // and for its reason: this runs once per FRAME, so the few milliseconds
    // between them are irrelevant beside a diffusion pass, and the medium
    // model misses fewer faces at a distance.
    id: "face-detector", name: "Face detector — YOLOv8m", vram_gb: 1,
    license: "Apache 2.0",
    blurb: "50MB, and what finds the faces Face Refine (H3) repairs — that pass cannot "
      + "run without it. The retired Face Detailer names the same file, so one download "
      + "serves either, but its own node pack is not installed here.",
    files: [{
      url: `${HF}/Bingsu/adetailer/resolve/main/face_yolov8m.pt`,
      filename: "face_yolov8m.pt", dir: "ultralytics/bbox", size_mb: 50,
      // NOT MIRRORED, and this is a licence judgement rather than a
      // measurement: the repo declares Apache 2.0 while the architecture it
      // trains is Ultralytics' YOLOv8, which is AGPL — and the studio's own
      // rule is permissive-only, read rather than inferred. It downloads
      // anonymously (verified: a ranged GET returns 206), so mirroring buys
      // nothing and declining costs nothing.
      noMirror: "the repo says Apache 2.0 over an AGPL architecture; it fetches "
        + "anonymously from HuggingFace, so it stays upstream",
    }],
  },
  {
    id: "nomos8kdat", name: "4xNomos8kDAT — image upscale", vram_gb: 4,
    license: "CC-BY-4.0",
    blurb: "A 4x enlarger that invents nothing, used as the first half of the tile-refine "
      + "pass (enlarge, then a low-denoise diffusion pass puts micro-detail back).",
    files: [{ url: `${HF}/Phips/4xNomos8kDAT/resolve/main/4xNomos8kDAT.safetensors`,
      filename: "4xNomos8kDAT.safetensors", dir: "upscale_models", size_mb: 143 }],
  },
];

/* ── an optional mirror ───────────────────────────────────────────────── */

/**
 * Weights served from a bucket of your own instead of from upstream.
 *
 * WHY IT EXISTS. Every url above points at HuggingFace, which is fine until it
 * is not: LTX 2.5 and Flux.2-klein answer **401 to an anonymous ranged GET**,
 * and Anima's text encoder is behind a Civitai token. A first run must not
 * require somebody else's account, so a family whose files are all gated
 * cannot honestly be listed at all — unless whoever is running this has
 * already fetched them and put them somewhere their own machines can reach.
 *
 * NOTHING IS CONFIGURED HERE BY DEFAULT. `cdnBase()` reads
 * `VITE_B2_CDN_BASE`; unset — which is how this ships — `mirrorUrl` returns
 * null, `resolveSource` falls through to upstream for every file, and a gated
 * file is reported as gated rather than offered. Point that variable at a
 * bucket and publish an index beside the objects (the shape is `MirrorIndex`
 * below — `files`, `at`, and the base the objects are served from) and rows
 * start resolving to it. No publisher ships with this build; writing one is
 * a `PUT` per file and a JSON document.
 *
 * TWO THINGS TO GET RIGHT IF YOU DO. The host has to be on the desktop
 * capability allow-list (`src-tauri/capabilities/default.json`) or Rust
 * refuses the request and the download simply never starts — it is not on
 * there today, because there is no mirror today. And `download_model_file`
 * takes any url and speaks Range, so a mirrored file resumes exactly like an
 * upstream one; a mirror that does not serve Range makes every interrupted
 * download start over.
 *
 * KEYED BY FILENAME, which dedupes for free: `qwen_image_vae.safetensors` is
 * one file shared by Krea 2 and Qwen-Image-Edit, and one object serves both.
 *
 * WHAT IS PUBLISHED IS A FACT, NOT A FLAG. The publisher writes an index
 * beside the objects and `mirrorIndex()` reads it — one request for the whole
 * catalogue rather than a HEAD per file, so a row can say "this is mirrored"
 * or "upstream wants an account" honestly instead of offering a button that
 * 404s.
 *
 * THE LICENCE IS A SEPARATE QUESTION FROM THE MECHANISM, and the more
 * important one. Mirroring is REDISTRIBUTION; an upstream gate is very often a
 * licence-acceptance gate, and a public bucket is world-readable by URL. Some
 * of these families permit redistribution and some plainly do not — the
 * `license` field on each says which, `noMirror` marks the individual files
 * whose terms differ from their family's, and the decision is the operator's
 * rather than this module's. It only makes it expressible.
 */
const MIRROR_PREFIX = "engine/weights/";
const MIRROR_TIMEOUT_MS = 6000;

const cdnBase = (): string =>
  ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_B2_CDN_BASE ?? "")
    .replace(/\/$/, "");

/** The mirror URL for a file, or null when no bucket is configured. */
export function mirrorUrl(f: Pick<EngineFile, "filename">, base = cdnBase()): string | null {
  return base ? `${base}/${MIRROR_PREFIX}${f.filename}` : null;
}

/** What the publisher writes beside the objects. */
export interface MirrorIndex {
  /** filenames present in the bucket */
  files: Set<string>;
  at: string | null;
  /**
   * The host the objects are served from.
   *
   * Carried ON the index rather than re-read from the environment at every
   * call, so ONE place decides it — which is also what makes a CDN in front of
   * the bucket a change to this field and nothing else, and what lets a test
   * exercise the mirror without a bucket.
   */
  base: string;
}

let mirrorCache: Promise<MirrorIndex> | null = null;

/**
 * Which weights the studio actually hosts. One fetch for the whole catalogue,
 * cached for the session; a bucket with no index (or no bucket at all) is an
 * EMPTY index rather than an error, so every row falls back to upstream and
 * the screen reads exactly as it did before this existed.
 */
export function mirrorIndex(): Promise<MirrorIndex> {
  if (mirrorCache) return mirrorCache;
  const base = cdnBase();
  const empty: MirrorIndex = { files: new Set(), at: null, base };
  if (!base) return (mirrorCache = Promise.resolve(empty));
  // THE ONE MUTABLE OBJECT UNDER THIS PREFIX, and the CDN in front of it caches
  // for 30 days. `cache: "no-store"` only governs the BROWSER's cache — the
  // edge happily served a four-day-old empty index over a bucket holding 136GB
  // of weights, measured (`cf-cache-status: HIT`, age 7513). Every desktop
  // would have read "no mirror" and fallen back upstream, which for a gated
  // file is no source at all. A changing query is a distinct edge cache key, so
  // this asks the origin every time; the object is a few hundred bytes and it
  // is read once per app start. A publisher should purge the edge as well —
  // belt and braces, because the two failures look identical from here.
  const bust = `?t=${Date.now()}`;
  // TIMED OUT, because one caller cannot afford to wait forever. `.catch()`
  // below handles a fetch that FAILS; a fetch that never settles is a
  // different animal, and `FirstRunSetupModal` awaits this before it can
  // recommend anything — so a captive-portal wifi that accepts the connection
  // and answers nothing would hang the first screen of the app on a request
  // whose worst honest answer is "no mirror". 6s: long enough for a cold edge
  // fetch of a few hundred bytes, short enough not to read as a freeze.
  mirrorCache = fetch(`${base}/${MIRROR_PREFIX}index.json${bust}`,
    { cache: "no-store", signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS) })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { files?: string[]; at?: string } | null) =>
      j && Array.isArray(j.files)
        ? { files: new Set(j.files), at: j.at ?? null, base }
        : empty)
    .catch(() => empty);
  return mirrorCache;
}

/** Test seam — the harness drives the mirrored/absent states without a bucket. */
export function primeMirror(index: MirrorIndex | null): void {
  mirrorCache = index ? Promise.resolve(index) : null;
}

/**
 * Where a file should actually be fetched from, and whether it can be at all.
 *
 * The mirror WINS when it has the file — it is nearer, it is not rate-limited,
 * and for a gated file it is the only source there is. A gated file with no
 * mirror is `url: null`: the caller must refuse rather than start a download
 * that answers 401 after the progress bar has appeared.
 */
export function resolveSource(
  f: EngineFile, mirror: MirrorIndex | null,
): { url: string | null; via: "mirror" | "upstream"; why?: string } {
  const m = mirror?.files.has(f.filename) ? mirrorUrl(f, mirror.base) : null;
  if (m) return { url: m, via: "mirror" };
  if (f.gated) return { url: null, via: "upstream", why: f.gated };
  return { url: f.url, via: "upstream" };
}

/** Files of a variant that nothing can fetch right now, with the reason. */
export function blockedFiles(
  fam: ModelFamily, v: ModelVariant, mirror: MirrorIndex | null,
): { file: EngineFile; why: string }[] {
  return variantFiles(fam, v)
    .map((f) => ({ file: f, src: resolveSource(f, mirror) }))
    .filter((x) => !x.src.url)
    .map((x) => ({ file: x.file, why: x.src.why ?? "no source" }));
}

/* ── helpers ─────────────────────────────────────────────────────────── */

/**
 * One media group's families, STUDIO DEFAULT FIRST.
 *
 * The rest keep their declaration order, which is deliberately
 * smallest-and-safest first — that ladder is the right one for someone
 * picking a model their laptop can hold, and the wrong one for someone who
 * installed the engine to run this studio's own pipeline locally. Leading
 * with the default serves the second reader without reshuffling the first's
 * list: it is a stable partition, not a re-sort.
 */
const byStudioDefault = (fams: ModelFamily[]): ModelFamily[] =>
  [...fams.filter((f) => f.studioDefaultFor), ...fams.filter((f) => !f.studioDefaultFor)];

export const imageFamilies = () =>
  byStudioDefault(FAMILIES.filter((f) => f.media === "image"));
export const audioFamilies = () =>
  byStudioDefault(FAMILIES.filter((f) => f.media === "audio"));
export const videoFamilies = () =>
  byStudioDefault(FAMILIES.filter((f) => f.media === "video"));

/** The catalog ids this catalogue claims to cover as studio defaults. Checked
 *  against `projectSettings.resolveDefaults` by `engineCatalog.test.ts`. */
export const studioDefaultIds = (): string[] =>
  FAMILIES.map((f) => f.studioDefaultFor).filter((x): x is string => !!x);

/** Everything a variant needs: its own files plus the family's shared ones. */
export const variantFiles = (fam: ModelFamily, v: ModelVariant): EngineFile[] =>
  [...v.files, ...fam.shared];

export const variantMb = (fam: ModelFamily, v: ModelVariant) =>
  variantFiles(fam, v).reduce((n, f) => n + f.size_mb, 0);

/** What is still to fetch, given what is on disk. Shared files make the second
 *  variant of a family much cheaper, and quoting the full size would be a
 *  number the user never actually pays. */
export const variantRemainingMb = (fam: ModelFamily, v: ModelVariant, have: Set<string>) =>
  variantFiles(fam, v).filter((f) => !have.has(f.filename)).reduce((n, f) => n + f.size_mb, 0);

export const variantInstalled = (fam: ModelFamily, v: ModelVariant, have: Set<string>) =>
  variantFiles(fam, v).every((f) => have.has(f.filename));

/**
 * Every downloadable entry, keyed exactly as the engine screen keys it.
 *
 * The Rust download registry knows FILENAMES and nothing about the catalogue,
 * so this is what turns "umt5_xxl_fp8… is downloading" back into "the Wan 2.2
 * 5B row should show a progress bar". The keys have to match the ones the
 * screen passes to `get()` — `${fam.id}/${v.id}` for a variant, the bare id
 * for an add-on or a post-process tool — or a restored download attaches to
 * nothing and the row still offers a Download button.
 */
export function allDownloadables(): { key: string; files: EngineFile[] }[] {
  const out: { key: string; files: EngineFile[] }[] = [];
  for (const fam of FAMILIES) {
    for (const v of fam.variants) out.push({ key: `${fam.id}/${v.id}`, files: variantFiles(fam, v) });
    for (const a of fam.addons ?? []) out.push({ key: a.id, files: a.files });
  }
  for (const t of POST_PROCESS) out.push({ key: t.id, files: t.files });
  return out;
}

/**
 * Whether a machine can run this rung — on BOTH axes.
 *
 * `ramGb` defaults to unbounded so every existing two-argument call means what
 * it always did; a row with no measured `ram_gb` is never refused on RAM,
 * because "nobody measured it" is not "it needs nothing".
 */
export const fits = (v: ModelVariant, budgetGb: number, ramGb = Infinity) =>
  v.vram_gb <= budgetGb && (v.ram_gb ?? 0) <= ramGb;

/** The best variant of a family this machine can run, or null. */
export const bestVariant = (
  fam: ModelFamily, budgetGb: number, ramGb = Infinity,
): ModelVariant | null => {
  const ok = (v: ModelVariant) => fits(v, budgetGb, ramGb);
  // The rung the family NOMINATES wins when it fits — see `ModelVariant.
  // preferred`. Biggest-that-fits is the fallback, not the rule.
  return fam.variants.find((v) => v.preferred && ok(v))
    ?? [...fam.variants].sort((a, b) => b.vram_gb - a.vram_gb).find(ok)
    ?? null;
};

/** The smallest a family can possibly be, for the "needs at least" line on a
 *  family nothing here can run. */
export const minVram = (fam: ModelFamily) =>
  Math.min(...fam.variants.map((v) => v.vram_gb));

/**
 * Why a whole family is out of reach, phrased for the pill that says so.
 *
 * It has to distinguish the two budgets, because they point at different
 * shopping. A family refused on VRAM needs a bigger card; one refused on RAM
 * needs memory sticks — and after the H3 benchmark that second case is real and
 * unobvious: every H3 rung clears a 12GB card and the leanest still wants 23GB
 * of system RAM. Quoting the VRAM figure there sends someone to buy the wrong
 * thing.
 */
export function familyBlocker(
  fam: ModelFamily, budgetGb: number, ramGb = Infinity,
): string | null {
  if (bestVariant(fam, budgetGb, ramGb)) return null;
  const vramOk = fam.variants.filter((v) => fits(v, budgetGb));
  if (vramOk.length) {
    const need = Math.min(...vramOk.map((v) => v.ram_gb ?? 0));
    return `needs ~${need}GB of system RAM · not this machine`;
  }
  // Same rule as `fitNote`: a family whose every rung is an ESTIMATE has not
  // been refused by evidence, it has been refused by arithmetic over file
  // sizes. "not this machine" is a verdict and this one has not been earned.
  if (fam.variants.every((v) => v.vramEstimated)) {
    return `~${minVram(fam)}GB estimated · untested on a card this size`;
  }
  return `needs ~${minVram(fam)}GB of VRAM · not this machine`;
}

/** The best family+variant of a medium this machine can run.
 *
 *  This is what the setup wizard quotes, so that what it promises and what the
 *  installer offers are THE SAME LIST — they were not, and a wizard naming a
 *  model the next screen does not have makes both numbers untrustworthy. */
/**
 * What to recommend on a first run: the biggest thing that fits — except that
 * "biggest" was never quite the question, and adding families proved it twice
 * in one afternoon.
 *
 * THE STUDIO DEFAULT WINS WHEN IT FITS. Plain biggest-that-fits handed a 24GB
 * card Qwen-Image-Edit, because an editor happens to want more memory than the
 * model this studio actually draws its panels with. A first run should be
 * pointed at the pipeline's own model, not at whichever row is heaviest.
 *
 * A FILE NOBODY CAN FETCH IS NOT A RECOMMENDATION. Anima's int8 rung fits a
 * 16GB Mac and its text encoder is gated, so the same heuristic cheerfully
 * recommended a laptop a model it could not download — the exact reason this
 * catalogue drops gated families rather than listing them hopefully. Pass the
 * mirror index and a family the studio hosts becomes eligible again.
 */
export function bestFor(
  media: Media, budgetGb: number, mirror: MirrorIndex | null = null, ramGb = Infinity,
): { family: ModelFamily; variant: ModelVariant } | null {
  let best: { family: ModelFamily; variant: ModelVariant } | null = null;
  for (const family of FAMILIES.filter((f) => f.media === media)) {
    const variant = bestVariant(family, budgetGb, ramGb);
    if (!variant) continue;
    if (blockedFiles(family, variant, mirror).length) continue;
    if (family.studioDefaultFor) return { family, variant };
    if (!best || variant.vram_gb > best.variant.vram_gb) best = { family, variant };
  }
  return best;
}

/** Why a variant will not run, in a sentence — the point of listing it anyway. */
export function fitNote(v: ModelVariant, budgetGb: number, ramGb = Infinity): string | null {
  if (fits(v, budgetGb, ramGb)) return null;
  // RAM FIRST, because it is the answer nobody expects and the one a bigger
  // graphics card does not fix. A machine refused here is being told to add
  // memory, not to buy a GPU — and the H3 rungs that fit a small card are
  // exactly the ones that want the most of it.
  if ((v.ram_gb ?? 0) > ramGb) {
    return `needs ~${v.ram_gb}GB of system RAM — this machine has `
      + `${ramGb === Infinity ? "less" : `${Math.round(ramGb)}GB`}`;
  }
  const over = v.vram_gb / Math.max(budgetGb, 0.1);
  // AN ESTIMATE DOES NOT GET TO SAY "out of reach". That verdict is earned by
  // a measurement, and for an unbenchmarked family the number is derived from
  // file size — which the H3 tier work showed can be 3x the real floor. Said
  // flatly it refuses a machine on nobody's evidence.
  if (v.vramEstimated) return `~${v.vram_gb}GB estimated, not measured — may not fit`;
  // 1.5x, not more: a 40GB model on a 10GB budget is not "may swap", it is a
  // load that fails, and softening that invites a 30GB download first.
  if (over > 1.5) return `needs ~${v.vram_gb}GB — out of reach on this machine`;
  return `needs ~${v.vram_gb}GB — may swap or fail to load`;
}

export const fmtSize = (mb: number) =>
  mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;

/** GGUF variants need city96/ComfyUI-GGUF's `UnetLoaderGGUF`. The installer
 *  adds it; this is what lets the UI say so before someone downloads 9GB. */
export const needsGgufNode = (v: ModelVariant) => v.precision === "gguf";

/* ── half-finished downloads ────────────────────────────────────────────── */

/**
 * MB already on disk for `filename`, from `engine_status.partial_mb`.
 *
 * Tries the exact filename first, then the STEM: a `.part` written before the
 * suffix changed replaced the extension rather than appending to it
 * (`umt5_xxl_fp8_e4m3fn_scaled.part`), so its key carries no extension and an
 * exact match misses it entirely — which is how an existing 966MB download
 * stayed invisible with no way to resume it.
 */
export function partialFor(filename: string, partial: Record<string, number>): number {
  if (partial[filename]) return partial[filename];
  const stem = filename.replace(/\.[^.]+$/, "");
  return partial[stem] ?? 0;
}

/** Every catalogue file, by filename — what turns a stray `.part` back into
 *  something resumable (it needs the URL and the directory). */
export function fileIndex(): Map<string, { file: EngineFile; owner: string; label: string }> {
  const out = new Map<string, { file: EngineFile; owner: string; label: string }>();
  // Shared files first, and their label names EVERY family that wants them:
  // the Wan text encoder is declared by four families, and taking the first
  // would caption a 6.5GB resume "Wan 2.1 · 1.3B" when it is equally the
  // encoder for the 5B and 14B rows the user was actually downloading.
  const sharedOwners = new Map<string, string[]>();
  for (const fam of FAMILIES) {
    for (const f of fam.shared) {
      sharedOwners.set(f.filename, [...(sharedOwners.get(f.filename) ?? []), fam.name]);
      out.set(f.filename, { file: f, owner: fam.id, label: fam.name });
    }
  }
  for (const [filename, names] of sharedOwners) {
    const e = out.get(filename);
    if (e) e.label = names.length > 1 ? `shared by ${names.join(", ")}` : names[0];
  }
  for (const fam of FAMILIES) {
    for (const v of fam.variants) {
      for (const f of v.files) {
        if (!out.has(f.filename)) {
          out.set(f.filename, { file: f, owner: `${fam.id}/${v.id}`, label: `${fam.name} · ${v.label}` });
        }
      }
    }
    for (const a of fam.addons ?? []) {
      for (const f of a.files) if (!out.has(f.filename)) out.set(f.filename, { file: f, owner: a.id, label: a.name });
    }
  }
  for (const t of POST_PROCESS) {
    for (const f of t.files) if (!out.has(f.filename)) out.set(f.filename, { file: f, owner: t.id, label: t.name });
  }
  return out;
}
