//! The portable engine: a ComfyUI that Qamba Studio installs, owns and runs.
//!
//! WHY NOT "JUST USE THE USER'S PYTHON". Because there isn't one that works.
//! macOS ships 3.9, Homebrew may be on 3.14, and PyTorch publishes wheels for
//! neither; a system Python is also PEP-668 managed, so pip refuses to install
//! into it at all. Every "1-click AI installer" that skips this step turns into
//! a support queue about Python versions. So the engine brings its own
//! interpreter — a python-build-standalone tarball, ~23MB — and everything
//! after that is deterministic.
//!
//! THE RECIPE IS FOUR STEPS AND EACH IS RESUMABLE. Interpreter, ComfyUI source,
//! Python dependencies, then weights. Each checks for its own output before
//! doing anything, so a failed or cancelled install is re-run rather than
//! restarted — which matters when step 4 is several gigabytes.
//!
//! Verified end to end on an M3 Air: CPython 3.12.14, torch 2.13.0 with
//! `mps_available=True`, ComfyUI serving on 127.0.0.1:8188.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

/// Pinned rather than "latest": an install that silently changes interpreter
/// or ComfyUI version between two users is not reproducible, and the whole
/// point of a bundled engine is that it behaves the same everywhere.
const PY_VERSION: &str = "3.12.14";
/// The python-build-standalone release these URLs are composed from. Pinned
/// with the version above for the same reason.
const PY_TAG: &str = "20260814";

/// The interpreter tarball for THIS machine.
///
/// COMPOSED FROM THE TARGET TRIPLE, NOT PICKED BY OS. It used to be two
/// constants — one for Windows, one for "not Windows" — and the second named
/// the `aarch64-apple-darwin` build, so on Linux the installer downloaded an
/// Apple Silicon Python, unpacked it, and reported the engine installed. The
/// failure surfaces much later, as a child process that will not execute.
///
/// `None` where python-build-standalone publishes no build for the target,
/// which is the honest answer: the install button explains itself instead of
/// fetching something that cannot run.
pub(crate) fn py_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        // `-gnu`, not `-musl`: torch's own wheels are glibc-linked, so a musl
        // interpreter could install the engine and not the thing it exists to
        // run.
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        _ => None,
    }
}

pub(crate) fn py_url() -> Result<String, String> {
    let triple = py_triple().ok_or_else(|| format!(
        "there is no portable Python build for {}-{} — install Python {PY_VERSION} \
         yourself and link your own ComfyUI instead",
        std::env::consts::OS, std::env::consts::ARCH))?;
    Ok(format!(
        "https://github.com/astral-sh/python-build-standalone/releases/download/\
         {PY_TAG}/cpython-{PY_VERSION}%2B{PY_TAG}-{triple}-install_only.tar.gz"))
}
const COMFY_URL: &str = "https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.tar.gz";
/// city96/ComfyUI-GGUF provides `UnetLoaderGGUF`. Half the model catalogue is
/// quantised — a 5B video model is 3.2GB as Q4_K_M against 9.5GB as fp16, which
/// is the difference between running and not on a laptop — and without this
/// node every one of those files is invisible to the loader that wants it.
const GGUF_NODE_URL: &str =
    "https://github.com/city96/ComfyUI-GGUF/archive/refs/heads/main.tar.gz";
/// liconstudio/ComfyUI-LTX2.5-MSR provides `ComfyUILTX25MSRMultiReferenceGuide`
/// and `ComfyUILTX25MSRICLoRALoader` — LTX 2.5's REFERENCE mode, which is the
/// one an episode block renders in.
///
/// Without it a machine can hold all 38GB of LTX 2.5 and render text-to-video
/// only: the guide carries the learned slot embeddings that address a reference
/// to a subject, and `buildLtx25` raises rather than dropping them, because a
/// reference render that quietly ignores its references is the silent downgrade
/// this codebase keeps naming.
///
/// Apache-2.0 — declared in the pack's own `pyproject.toml`, which is where to
/// look: GitHub reports no licence for this repo because there is no LICENSE
/// file, and the metadata says otherwise. It declares `dependencies = []`, so
/// unlike the GGUF loader there is nothing to pip-install behind it.
const MSR_NODE_URL: &str =
    "https://github.com/liconstudio/ComfyUI-LTX2.5-MSR/archive/refs/heads/main.tar.gz";

/// kijai/ComfyUI-MMAudio provides `MMAudioModelLoader`,
/// `MMAudioFeatureUtilsLoader` and `MMAudioSampler` — video → audio, the
/// `v2a_gen` job kind, which scores a silent clip by WATCHING it.
///
/// PINNED-INSTALL IS NOT OPTIONAL FOR THIS ONE, and it is the reason
/// `install_node_pack` grew a constraints file. Its `requirements.txt` carries
/// `open_clip_torch>=2.29.0`, which depends on torch AND torchvision and is
/// therefore free to replace this engine's build with whatever pip prefers —
/// the same rope the pod refuses `comfyui_controlnet_aux` for
/// (the engine window's node-pack install). Nothing else in that file is dangerous:
/// librosa, torchdiffeq, einops, timm, omegaconf, accelerate, ftfy.
///
/// MIT. Its 44k branch snapshot-downloads nvidia/bigvgan_v2_44khz_128band_512x
/// into `models/mmaudio/nvidia/` on the FIRST render — internet and
/// `huggingface_hub` are needed once, and the catalogue blurb says so.
const MMAUDIO_NODE_URL: &str =
    "https://github.com/kijai/ComfyUI-MMAudio/archive/refs/heads/main.tar.gz";
/// Kosinkadink/ComfyUI-VideoHelperSuite provides `VHS_LoadVideo`, which is the
/// FIRST node of `graphs.mmaudio_graph` — MMAudio conditions on frames, so
/// without it the pack above is installed and unusable. Declaring only MMAudio
/// on the model_map entry was a lie the desktop generator would have believed.
///
/// GPL-3.0, installed from GitHub onto the user's own machine like every other
/// pack here; nothing is redistributed. Its `requirements.txt` is
/// opencv-python + imageio-ffmpeg, neither of which touches torch.
const VHS_NODE_URL: &str =
    "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite/archive/refs/heads/main.tar.gz";

/// Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc provides `MiniMaxH3PDDAccApply` —
/// MiniMax's OFFICIAL 8-step distillation, and the only one whose reference
/// build lets a whole EPISODE render distilled rather than only a clip.
///
/// IT CANNOT BE A PLAIN LoRA, which is the reason it needs a pack at all. The
/// files are a rank-64 trunk LoRA plus a per-interval HEAD BANK for
/// `final_layer` that `LoraLoaderModelOnly` silently drops; on the pruned
/// int8_convrot checkpoints this catalogue recommends, a plain loader
/// additionally spams ~50 `ERROR lora … adaln_proj` lines and loses that part
/// of the distillation. The Apply node loads both halves, rebases the adaln
/// modules onto the pruned model's own curve table, and EMITS ITS OWN SIGMAS —
/// the trained block boundaries — which is why `resolve()` rewires
/// `SamplerCustomAdvanced` to it and forces plain `euler`.
///
/// Apache-2.0 (the repo's own LICENSE). It has NO `requirements.txt` —
/// verified, a 404 — so it is pure Python over the venv's torch and
/// safetensors and there is nothing for the pinned install to resolve.
const PDD_NODE_URL: &str =
    "https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc/archive/refs/heads/main.tar.gz";

/* ── the finishing chain ─────────────────────────────────────────────────
 *
 * THREE OF THE SEVEN POST PASSES NEEDED A PACK AND HAD NONE, which made them
 * unreachable on a desktop render however much was downloaded: `color_match`
 * runs on KJNodes' `ColorMatch`, `h3_facefix` on Carasibana's H3 tracker, and
 * `facefix` on Impact's `FaceDetailer` — which is the one NOT installed here,
 * because that pass is retired (see the block above the H3 tracker). The other
 * four are core ComfyUI (SeedVR2, frame interpolation), core LTX, or ffmpeg.
 *
 * THE PINS ARE THE WHOLE PRECAUTION, and one line is why they exist:
 * H3-FaceRefine's `ultralytics` depends on torch AND torchvision, so pip is
 * free to satisfy it by replacing this engine's build. `install_node_pack`
 * writes a constraints file from whatever is installed right now, which turns
 * that into a LOUD refusal — a capability lost with a reason rather than a
 * silently CPU-only ComfyUI. Every one of these decisions is
 * the engine window's node-pack install's, transcribed rather than re-derived.
 */

/// kijai/ComfyUI-KJNodes provides `ColorMatch` and `ColorMatchV2` — the
/// `color_match` post pass, which is what makes a cut agree with itself.
///
/// The cheapest pack here by far: its requirements are pillow, matplotlib,
/// mss, opencv-python-headless and `color-matcher` (the transfer library the
/// node wraps), and not one of them touches torch. No weights either — the
/// six algorithms are arithmetic over a reference frame.
///
/// GPL-3.0, installed from GitHub onto the user's own machine like every other
/// pack here; nothing is redistributed.
const KJNODES_NODE_URL: &str =
    "https://github.com/kijai/ComfyUI-KJNodes/archive/refs/heads/main.tar.gz";

/* IMPACT PACK IS DELIBERATELY ABSENT, and it is the one finishing-chain pack
 * that is. `FaceDetailer` is the `facefix` pass, and `facefix` is RETIRED —
 * `POST_OP.retired` says so on the toggle, on a measurement: per-frame
 * inpainting through an image model that never saw the shot has no temporal
 * term at all, so it ADDS 22% frame-to-frame movement to the face it is meant
 * to fix, at ~7s a frame. `h3_facefix` below is steadier (1.02x against 1.22x)
 * and 2.6x faster, and it is installed.
 *
 * So this would be two repos (the pack, plus the Subpack for the detector
 * provider that moved out of it) and a pile of pip dependencies, to unlock a
 * pass the studio recommends against. `postLocal.ts` still asks for those
 * classes, so a chain with Face Detailer on refuses the local plane with the
 * reason rather than rendering — which is the right outcome for a retired
 * pass and needs nothing installed.
 *
 * IF IT IS EVER RE-ADDED: the pack's default branch is `Main`, capital M, and
 * `heads/main.tar.gz` is a 404 there — which is what `url_branch` exists for.
 * The Subpack is not optional (Impact alone is a FaceDetailer with nothing to
 * feed its bbox input), and the pod's own script is the reference for the pins.
 */

/// Carasibana/ComfyUI-H3-FaceRefine provides `H3FaceTrackCrop`,
/// `H3InjectVideoLatent`, `H3PerFrameDenoise` and `H3FaceStitch` — the
/// `h3_facefix` pass, and the OPPOSITE shape from the detailer above: it tracks
/// the face, crops so the head fills a canvas, and re-generates the whole
/// sequence in ONE H3 pass instead of re-deciding a face 24 times a second.
///
/// INSIGHTFACE FAILS OPEN, which is the one thing to know before trusting a
/// result: the pack's own README says identity matching "won't error if
/// InsightFace is missing but the outputs will be much better with it
/// installed" — so a machine without it tracks the wrong face whenever two
/// people are in shot and renders perfectly happily. It is in the pack's
/// requirements and is a SOURCE BUILD (Cython plus a C++ toolchain), so it is
/// the line most likely to be refused here; the install below says so rather
/// than letting it pass unremarked. MIT.
const H3FACE_NODE_URL: &str =
    "https://github.com/Carasibana/ComfyUI-H3-FaceRefine/archive/refs/heads/main.tar.gz";

/// Every custom node pack the installer provides, as
/// `(directory, tarball, step label, why)`.
///
/// THE DIRECTORY NAME IS THE CONTRACT. `engine_status.nodes` lists
/// `custom_nodes/*` by directory, and three separate gates read that list to
/// decide whether a capability exists — `localModels`' `ggufReady` and
/// `modePacks`, and `gen_desktop_model_map.mjs`'s view of what this installer
/// can provide. A renamed directory here silently withdraws a mode.
type NodePack = (&'static str, &'static str, &'static str, &'static str);
const NODE_PACKS: [NodePack; 7] = [
    ("ComfyUI-GGUF", GGUF_NODE_URL, "the GGUF loader", "for quantised models"),
    ("ComfyUI-LTX2.5-MSR", MSR_NODE_URL, "LTX reference nodes",
     "for reference-to-video on LTX 2.5"),
    ("ComfyUI-MMAudio", MMAUDIO_NODE_URL, "MMAudio nodes", "for video to audio"),
    ("ComfyUI-VideoHelperSuite", VHS_NODE_URL, "VideoHelperSuite",
     "loads a clip's frames for MMAudio"),
    ("ComfyUI-MiniMax-H3-PDD-Acc", PDD_NODE_URL, "the H3 PDD nodes",
     "for the official 8-step distillation"),
    // The finishing chain. KJNodes FIRST: it is the cheapest and the only one
    // that cannot fail on a torch pin, so the pass it unlocks is installed
    // before the one that might be refused. (Impact, the third pack these two
    // passes have a sibling in, is deliberately absent — see above.)
    ("ComfyUI-KJNodes", KJNODES_NODE_URL, "the colour-match nodes",
     "for the Color Match finishing pass"),
    ("ComfyUI-H3-FaceRefine", H3FACE_NODE_URL, "the H3 face nodes",
     "for the Face Refine (H3) finishing pass"),
];

/// The pip constraints a pack's dependencies are installed against.
///
/// WHATEVER IS INSTALLED RIGHT NOW IS THE CONTRACT — the pod's own words
/// (the engine window's node-pack install), and the same four packages. A pack is
/// free to declare `open_clip_torch>=2.29.0`, and pip is free to satisfy that
/// by replacing the CUDA/MPS torch every other model on this machine renders
/// on. Pinning turns that into a refusal, which is a capability lost with a
/// reason rather than an engine quietly downgraded.
///
/// Pure so it can be tested without an interpreter: `probe` is the output of
/// the one-line script `install_node_pack` runs.
fn constraints_text(probe: &str) -> String {
    probe
        .lines()
        .filter_map(|l| {
            let (name, ver) = l.trim().split_once('=')?;
            (!name.is_empty() && !ver.is_empty()).then(|| format!("{name}=={ver}"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A pack's `requirements.txt` minus its VCS lines.
///
/// A `git+` requirement is a source BUILD, and its own build system resolves
/// dependencies before our constraints can apply — so it is exactly the line a
/// constraints file cannot protect. Dropping it is the pod's rule too; no pack
/// installed here declares one, and this is what keeps that true if one starts.
fn strip_vcs_lines(req: &str) -> String {
    req.lines()
        .filter(|l| !l.trim_start().starts_with("git+"))
        .filter(|l| !l.trim_start().starts_with("-e git+"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// How to ask pip for torch on this machine.
///
/// Bare PyPI is CPU-ONLY on Windows, which on a machine with an NVIDIA card is
/// an engine that installs perfectly and then renders at a speed nobody wants —
/// the failure the accelerator probe exists to catch, arriving at the one step
/// that could have prevented it. macOS wheels carry MPS from PyPI, so the
/// index is only ever added where it changes the answer.
///
/// Pure, and takes its facts as arguments, so both platforms are testable from
/// either.
pub(crate) fn torch_index_args(windows: bool, has_nvidia: bool) -> Vec<&'static str> {
    if windows && has_nvidia {
        // cu128 is what the studio's own pod runs, so a desktop render and a
        // pod render are the same arithmetic.
        vec!["--index-url", "https://download.pytorch.org/whl/cu128"]
    } else {
        vec![]
    }
}

/// True when this machine has an NVIDIA adapter, for `torch_index_args`.
pub(crate) fn has_nvidia() -> bool {
    crate::hardware::detect().gpus.iter().any(|g| g.vendor == "nvidia")
}

/// Marker a pack carries when its dependencies would not install.
///
/// THE DIRECTORY IS WHAT EVERY GATE READS (`engine_status.nodes`), so a pack
/// whose deps failed is worse than one that is absent: it reads as present and
/// the capability is offered right up to the render that dies inside ComfyUI.
/// The directory is kept rather than deleted — the traceback in here is the
/// whole diagnosis — and `nodes_broken` is what stops it counting.
const PACK_FAILED: &str = ".qamba-pip-failed";

/// Clone one node pack from its GitHub tarball, best effort.
///
/// BEST EFFORT ON PURPOSE: a missing pack costs a capability, not the engine,
/// and failing a multi-gigabyte install over a node fetch would be the wrong
/// trade. What makes that safe is that every consumer asks
/// `engine_status.nodes` before offering the capability — so the failure shows
/// up as a mode that is absent with a reason, never as a job that dies.
///
/// GitHub unpacks `heads/main.tar.gz` as `<repo>-main`, so the move is from
/// there to the directory the status probe reports.
async fn install_node_pack(
    app: &AppHandle, py: &Path, root: &Path, nodes: &Path,
    dir: &str, url: &str, label: &str, note: &str, pins: Option<&Path>,
) -> Result<(), String> {
    let target = nodes.join(dir);
    if target.join("__init__.py").is_file() && !target.join(PACK_FAILED).is_file() {
        return Ok(());
    }
    emit(app, 3, &format!("Installing {label}"), -1.0, note);
    let tgz = root.join(format!("{dir}.tar.gz"));
    download_to(app, url, &tgz, Some(3), &format!("Downloading {label}")).await
        .map_err(|e| format!("{label}: {e}"))?;
    let _ = untar(&tgz, nodes);
    let _ = std::fs::remove_file(&tgz);
    // The repo name AND the branch, both out of the URL: `ComfyUI-LTX2.5-MSR`
    // unpacks as `ComfyUI-LTX2.5-MSR-main` and `ComfyUI-Impact-Pack` as
    // `ComfyUI-Impact-Pack-Main`, and reading both from the URL is what keeps
    // this honest for a pack whose directory we rename or whose default branch
    // is not `main`.
    let unpacked = nodes.join(format!("{}-{}", url_repo(url), url_branch(url)));
    if unpacked.is_dir() {
        let _ = std::fs::remove_dir_all(&target);
        let _ = std::fs::rename(&unpacked, &target);
    }
    let _ = std::fs::remove_file(target.join(PACK_FAILED));
    let req = target.join("requirements.txt");
    if req.is_file() {
        // Filtered into a file of our own rather than passed through: pip has
        // no way to say "this file minus these lines", and rewriting the
        // pack's own requirements would make a re-install of the same pack
        // read differently the second time.
        let filtered = root.join(format!("{dir}.req.txt"));
        let body = std::fs::read_to_string(&req).map_err(|e| format!("{label}: {e}"))?;
        std::fs::write(&filtered, strip_vcs_lines(&body))
            .map_err(|e| format!("{label}: {e}"))?;
        let mut args: Vec<String> = vec!["-m".into(), "pip".into(), "install".into(),
            "--disable-pip-version-check".into(), "-q".into()];
        if let Some(p) = pins {
            args.push("-c".into());
            args.push(p.to_string_lossy().into_owned());
        }
        args.push("-r".into());
        args.push(filtered.to_string_lossy().into_owned());
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let out = run_python(py, &refs, root);
        let _ = std::fs::remove_file(&filtered);
        if let Err(e) = out {
            // The marker is the whole point: the directory is present and
            // importable-looking, so without it every gate goes on offering
            // the capability. Keep the traceback beside it — this is the one
            // place that knows why.
            let _ = std::fs::write(target.join(PACK_FAILED), &e);
            return Err(format!(
                "{label}: a dependency wanted a different PyTorch, so it was refused rather \
                 than allowed to replace this engine's. {}", e.lines().last().unwrap_or("")));
        }
    }
    Ok(())
}

/// `https://github.com/owner/REPO/archive/refs/heads/main.tar.gz` -> `REPO`.
fn url_repo(url: &str) -> &str {
    url.split("/archive/").next().unwrap_or(url).rsplit('/').next().unwrap_or("")
}

/// …and the BRANCH out of the same URL, because it is not always `main`.
///
/// `ltdrdata/ComfyUI-Impact-Pack` has no `main` branch at all — its default is
/// `Main`, capital M, and `heads/main.tar.gz` is a 404 there. Hard-coding the
/// branch in the unpack step meant the archive landed as `<repo>-Main` while
/// the rename looked for `<repo>-main`, so the pack would sit beside its own
/// target directory under a name nothing reads: `__init__.py` never appears
/// where `engine_status` looks, every gate goes on reporting the capability
/// absent, and the download is paid again on the next install.
fn url_branch(url: &str) -> &str {
    url.rsplit('/').next().unwrap_or("").strip_suffix(".tar.gz").unwrap_or("main")
}

/// A STATIC ffmpeg + ffprobe, fetched on demand.
///
/// The worker shells out to the ffmpeg and ffprobe BINARIES — `media.py` and
/// `audio_fx.py` build filtergraphs and run them — so ComfyUI's PyAV, which
/// vendors the ffmpeg LIBRARIES, does nothing for us here. Until this existed
/// a desktop render of a timeline died at `plan_cli.preflight` with "install
/// it (`brew install ffmpeg`)", which is a fix in a terminal for a product
/// whose whole point is not needing one.
///
/// MEASURED, not assumed (2026-08-31, the darwin-arm64 pair):
///  * every filter this worker names is present — acompressor, aecho, chorus,
///    tremolo, bandreject, asoftclip, aphaser, pan, amix, adelay, ebur128,
///    apad, tpad, xfade, tile and the rest — and every encoder except
///    `h264_nvenc`, which no macOS ffmpeg has (Homebrew's included);
///  * this repo's own real-binary suites — `test_audio_fx_ffmpeg.py`,
///    `test_score_ffmpeg.py`, `test_lane_bus_ffmpeg.py` — pass 32/32 against
///    it, which covers the whole effects rack and the ebur128 loudness the
///    score mix places its bed with;
///  * it is **ad-hoc signed**, which is what lets it execute at all: an arm64
///    Mach-O must carry a signature or the kernel SIGKILLs it.
///
/// THE TAG IS NOT THE ASSET'S VERSION. `b6.1.1`'s darwin-arm64 binary is
/// byte-identical to `b6.0`'s (same sha256) and reports `ffmpeg version 6.0`.
/// So do not "correct" any user-facing string to 6.1.1 — it would be a lie
/// about the binary. The newer tag is pinned only because it carries the same
/// ten assets and is at least as new elsewhere.
const FFMPEG_TAG: &str = "b6.1.1";
const FFMPEG_BASE: &str = "https://github.com/eugeneware/ffmpeg-static/releases/download";

/// Directories a user's OWN ffmpeg actually lives in, which a GUI-launched app
/// cannot see. This is the bug that made the feature look absent: macOS gives
/// a Finder-launched `.app` the launchd PATH — measured EMPTY on this machine,
/// i.e. the `/usr/bin:/bin:/usr/sbin:/sbin` fallback — while Homebrew's
/// `/opt/homebrew/bin` is added by shell rc files a GUI app never sources. So
/// a machine with ffmpeg 8.1.2 installed and working in every terminal still
/// failed every render with "this needs ffmpeg on your PATH".
#[cfg(target_os = "macos")]
const EXTRA_PATH: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
#[cfg(target_os = "linux")]
const EXTRA_PATH: &[&str] = &["/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];
#[cfg(target_os = "windows")]
const EXTRA_PATH: &[&str] = &[];

/// Where a local ComfyUI answers. The same literal `comfyLocal.DEFAULT_COMFY`
/// carries on the other side; every render target in this app assumes it.
const DEFAULT_COMFY: &str = "http://127.0.0.1:8188";
/// The label of the ComfyUI window, so a second call focuses the one that is
/// open rather than stacking another copy of a heavy editor.
const COMFY_WINDOW: &str = "comfy";

#[derive(Clone, Serialize)]
pub struct EngineProgress {
    /// 1..=4
    step: u8,
    label: String,
    /// 0.0..=1.0 within this step, or -1 when the step has no measurable size
    pct: f64,
    detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStatus {
    pub installed: bool,
    pub python: Option<String>,
    pub comfy_dir: Option<String>,
    pub root: String,
    /// checkpoints on disk, so the UI never offers "render" with nothing to render
    pub checkpoints: Vec<String>,
    pub loras: Vec<String>,
    /// EVERY model file present, across every directory, by bare filename.
    /// A modern checkpoint is three files in three directories and the text
    /// encoder is shared between models — "is this model installed" is a
    /// question about a SET of filenames, which `checkpoints` alone cannot
    /// answer.
    pub files: Vec<String>,
    /// the same files with their size in MB. Needed because "can this machine
    /// run that workflow" is a question about BYTES, and a filename only
    /// estimates them — `wan2.2_…_14B_fp8` can be read, `minimax_h3_fl2va_
    /// pruned_int8_convrot` cannot. Where the file is on disk the answer is
    /// exact, and the UI says which of the two it used.
    pub file_mb: std::collections::BTreeMap<String, u64>,
    /// Which catalogue row each half-finished download was started for, same
    /// keys as `partial_mb`. Read from a `.owner` sidecar written next to the
    /// `.part`, because the in-memory registry does not survive a restart and
    /// a shared file cannot be attributed from its name alone.
    pub partial_owner: std::collections::BTreeMap<String, String>,
    /// Half-finished downloads with the bytes already on disk, keyed by the
    /// final filename — or, for a `.part` written before the suffix changed,
    /// by its STEM. Match with `partialFor()` on the TS side, which tries
    /// both. Without this a `.part` is invisible: after an app restart the
    /// row offers a plain "Get" with no sign that 966MB of it is already
    /// fetched, and no way to tell that pressing it resumes rather than
    /// restarts.
    pub partial_mb: std::collections::BTreeMap<String, u64>,
    /// Every model file grouped by the directory it is in. `checkpoints` and
    /// `loras` above are two of these — kept as their own fields for the
    /// callers that predate this, but "does this engine have anything to
    /// render with" is a question about `checkpoints` OR `diffusion_models`,
    /// and asking only the first said "no models yet" to a machine holding
    /// two fully-installed Wan GGUFs.
    pub by_dir: std::collections::BTreeMap<String, Vec<String>>,
    /// custom node packs present, by directory name — the UI needs to know
    /// whether a quantised variant has a loader before offering it.
    ///
    /// A pack in `nodes_broken` is EXCLUDED from this list: the directory is
    /// on disk and its `__init__.py` is importable-looking, so counting it
    /// would offer a capability that dies inside ComfyUI.
    pub nodes: Vec<String>,
    /// Packs whose dependencies would not install under the engine's own
    /// constraints. Reported separately from absent so the UI can say
    /// "reinstall the engine" rather than "download it" — the files are
    /// already there and fetching them again fixes nothing.
    pub nodes_broken: Vec<String>,
    /// true when WE started it and the child is still alive
    pub running: bool,
    pub port: u16,
    /// The ComfyUI directory every listing above was read from and every
    /// download lands in — ours, or one the user linked. Reported because
    /// "installed" and "has weights" stopped being the same question: a
    /// linked setup has a full model tree and `installed: false`.
    pub models_dir: String,
    /// true when `models_dir` is the user's own ComfyUI rather than ours.
    pub models_linked: bool,
    /// The engine's own Python is on disk — the half of the utilities install
    /// that lets this machine PLAN. Deliberately not the same question as
    /// `installed`, which additionally wants ComfyUI: a machine that took
    /// "Utilities only", or one that brought its own ComfyUI, is `planner:
    /// true, installed: false`. `planner_ready` (planner.rs) is the fuller
    /// question — it also asks whether the pipeline source is bundled.
    pub planner: bool,
    /// ffmpeg AND ffprobe are reachable by a job we spawn — ours, or a pair
    /// the machine already had. See `child_path` for why that is a different
    /// question from "is ffmpeg on OUR PATH".
    pub ffmpeg: bool,
    /// ...and this one is true only when they are the pair WE installed, so
    /// the UI can say whose is in charge rather than implying it installed
    /// something it skipped.
    pub ffmpeg_ours: bool,
}

/// The engine lives beside the app's own data, not in the user's home: an
/// uninstall should be able to take it with it, and `~/ComfyUI` is a directory
/// the user may already own.
pub fn engine_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("engine")
}

/// The engine's own interpreter. `pub` because `planner.rs` runs the studio's
/// pipeline Python on it — the same CPython ComfyUI was installed against, so
/// there is exactly one Python this app owns and no second thing to install.
pub fn python_bin(root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    return root.join("python").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    return root.join("python").join("bin").join("python3");
}

pub(crate) fn comfy_dir(root: &Path) -> PathBuf {
    root.join("ComfyUI")
}

/// Command-line tools this app installed — today ffmpeg and ffprobe. Beside
/// `python/`, so an uninstall takes them with it.
pub fn tools_dir(root: &Path) -> PathBuf {
    root.join("bin")
}

fn exe_name(stem: &str) -> String {
    if cfg!(windows) { format!("{stem}.exe") } else { stem.to_string() }
}

/// The release asset for THIS machine, or None where the publisher has no
/// build for it (Windows on ARM, say). None means the button explains itself
/// rather than downloading something that cannot run.
fn ff_asset_suffix() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { Some("darwin-arm64") }
        else if cfg!(target_arch = "x86_64") { Some("darwin-x64") }
        else { None }
    } else if cfg!(target_os = "windows") {
        if cfg!(target_arch = "x86_64") { Some("win32-x64") } else { None }
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "aarch64") { Some("linux-arm64") }
        else if cfg!(target_arch = "x86_64") { Some("linux-x64") }
        else { None }
    } else { None }
}

/// Compose the PATH a child of ours runs with: what we inherited, then the
/// places a user's own tools live, then OUR bin directory.
///
/// OURS GOES LAST, deliberately. A working ffmpeg the user already had stays
/// in charge — the preflight has been telling people to `brew install ffmpeg`
/// for as long as it has existed, so that one is the blessed answer and
/// putting ours in front would silently switch every render to a different,
/// older build. Ours fills a gap; it does not take over. (Contrast the
/// interpreter, where we cannot use theirs at all — see `install_utilities`.)
///
/// Pure and order-preserving so it can be tested: duplicates are dropped
/// keeping the FIRST occurrence, because that is the one that would have won.
fn compose_path(inherited: &str, extras: &[&str], sep: char) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in inherited.split(sep).chain(extras.iter().copied()) {
        if part.is_empty() || out.contains(&part) { continue; }
        out.push(part);
    }
    out.join(&sep.to_string())
}

/// The PATH value for any process we spawn that might shell out to ffmpeg —
/// the pipeline (`planner::plan_run`) and ComfyUI itself, whose VideoHelperSuite
/// nodes run ffmpeg to load a reference video.
pub fn child_path(root: &Path) -> String {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let inherited = std::env::var("PATH").unwrap_or_default();
    let ours = tools_dir(root).to_string_lossy().into_owned();
    let mut extras: Vec<&str> = EXTRA_PATH.to_vec();
    extras.push(&ours);
    compose_path(&inherited, &extras, sep)
}

/// Is `stem` runnable from `path`? The same question `shutil.which` asks on
/// the Python side, asked over the PATH the CHILD will get rather than our
/// own — otherwise the status says "no ffmpeg" about a machine where the job
/// would have found one.
fn on_path(path: &str, stem: &str) -> bool {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let name = exe_name(stem);
    path.split(sep).any(|d| !d.is_empty() && Path::new(d).join(&name).is_file())
}

/// ffmpeg AND ffprobe both reachable. Both, because they are separate
/// downloads here and separate binaries everywhere — `preflight` fails a job
/// on either being absent, and half an install is the confusing half.
pub fn ffmpeg_ready(root: &Path) -> bool {
    let p = child_path(root);
    on_path(&p, "ffmpeg") && on_path(&p, "ffprobe")
}

/// Ours specifically, as opposed to one the user already had.
fn ffmpeg_is_ours(root: &Path) -> bool {
    let d = tools_dir(root);
    d.join(exe_name("ffmpeg")).is_file() && d.join(exe_name("ffprobe")).is_file()
}

/// Fetch ffmpeg + ffprobe into `bin/`, unless this machine already has a pair
/// that works.
///
/// Skipping when the system has them is not just politeness — it is ~90MB not
/// downloaded, which is most of what the utilities install would otherwise
/// cost.
async fn install_ffmpeg(app: &AppHandle, root: &Path) -> Result<(), String> {
    if ffmpeg_is_ours(root) || ffmpeg_ready(root) {
        return Ok(());
    }
    let Some(sfx) = ff_asset_suffix() else {
        return Err("there is no prebuilt ffmpeg for this platform — install one yourself \
                    (ffmpeg.org) and it will be picked up".into());
    };
    let dir = tools_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for stem in ["ffmpeg", "ffprobe"] {
        let dest = dir.join(exe_name(stem));
        if dest.is_file() { continue; }
        // Downloaded to a temp name and renamed, so an interrupted fetch is
        // never left looking like a working binary — the rule
        // `local_media_download` already follows for media.
        let tmp = dir.join(format!("{stem}.part"));
        let url = format!("{FFMPEG_BASE}/{FFMPEG_TAG}/{stem}-{sfx}");
        download_to(app, &url, &tmp, Some(1), &format!("Downloading {stem}")).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("could not make {stem} executable: {e}"))?;
        }
        std::fs::rename(&tmp, &dest).map_err(|e| format!("could not install {stem}: {e}"))?;
    }
    Ok(())
}

/// The ComfyUI whose `models/` this app reads and writes.
///
/// OURS by default. But "link the ComfyUI you already have" is a supported
/// setup here, and until now it made the whole Models tab dead: every scan and
/// every download resolved through `comfy_dir(engine_root())`, so a machine
/// with a perfectly good ComfyUI reported no weights installed and greyed out
/// every Get. The weight catalogue is useful to that machine — the download is
/// an HTTPS fetch into a directory, and it needs no engine of ours at all.
///
/// WHAT DELIBERATELY DOES NOT MOVE: `installed`, `python_bin`, Start/Stop and
/// the planner all stay bound to `engine_root` — the engine we INSTALLED. We
/// did not build their Python and must not run the pipeline on it, and their
/// ComfyUI process is theirs to start and stop (the rule `EngineProc` already
/// states). So a linked setup can fetch weights and render over HTTP, and
/// cannot be told to install into itself or be killed from here.
pub(crate) fn comfy_home(app: &AppHandle) -> PathBuf {
    linked_comfy(app).unwrap_or_else(|| comfy_dir(&engine_root(app)))
}

fn link_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("comfy_link.json")
}

/// Does this directory look like a ComfyUI we may write weights into?
///
/// A bar rather than a guess: `main.py` or an existing `models/`. Accepting
/// anything would let a mistyped path scatter nine model directories across
/// someone's home folder, and the mistake is only visible as a download that
/// went somewhere ComfyUI will never read.
fn is_comfy_dir(dir: &Path) -> bool {
    dir.join("main.py").is_file() || dir.join("models").is_dir()
}

/// The linked directory, when one is set and still looks like a ComfyUI.
///
/// A path that has gone away falls back to ours rather than erroring — an
/// external drive that is not mounted today should not make the tab unusable,
/// and the UI reports which one answered either way.
fn linked_comfy(app: &AppHandle) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(link_file(app)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let dir = PathBuf::from(v.get("dir")?.as_str()?);
    is_comfy_dir(&dir).then_some(dir)
}

/// The native folder picker, for "use my own ComfyUI".
///
/// `None` when the user cancels — which is a NORMAL outcome and not an error,
/// so the caller leaves everything as it was rather than reporting a failure.
///
/// It deliberately does NOT link what it returns: validation belongs to
/// `set_linked_comfy`, so a folder chosen here and a path typed by hand meet
/// exactly the same bar. Two ways in, one rule.
///
/// Driven from Rust rather than through the dialog plugin's JS API, which is
/// why `capabilities/default.json` carries no `dialog:` permission — the
/// webview can ask for a directory and can reach none of the rest of that
/// surface (file open with filters, save, message boxes).
#[tauri::command]
pub async fn pick_comfy_dir(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    // The CALLBACK form, not `blocking_pick_folder`: the blocking one
    // deadlocks when it is called from the main thread, and a command is not
    // the place to be certain which thread that is.
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose your ComfyUI folder")
        .pick_folder(move |picked| {
            let _ = tx.send(picked);
        });
    rx.await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Point the model directory at a ComfyUI of the user's own, or (with `None`)
/// back at ours. Returns the directory now in use.
#[tauri::command]
pub fn set_linked_comfy(app: AppHandle, dir: Option<String>) -> Result<String, String> {
    let f = link_file(&app);
    match dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        None => {
            let _ = std::fs::remove_file(&f);
        }
        Some(d) => {
            let path = PathBuf::from(d);
            if !path.is_dir() {
                return Err(format!("{d} is not a directory on this machine"));
            }
            // Checked HERE rather than at read time so the mistake is reported
            // to the person who just typed it, not swallowed as a fallback.
            if !is_comfy_dir(&path) {
                return Err(format!(
                    "{d} does not look like a ComfyUI — expected main.py or a models/ folder \
                     in it. Point at the ComfyUI directory itself, not at models/."
                ));
            }
            if let Some(parent) = f.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&f, serde_json::json!({ "dir": d }).to_string())
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(comfy_home(&app).to_string_lossy().into_owned())
}

/// Every directory ComfyUI loads weights from that we ever write into.
///
/// THIS LIST AND `engine_model_path`'s MUST AGREE, and for a long time they did
/// not: `civitai.modelDir()` routes a TextualInversion to `embeddings` and a
/// ControlNet to `controlnet`, `engine_model_path` refused both, and neither
/// was listed here — so the download button was ENABLED, said "Lands in
/// models/embeddings/", and then failed on `unknown model directory`. Even had
/// the write succeeded the file would have been invisible to `files`, which is
/// what every "is this installed" question reads.
const MODEL_DIRS: [&str; 13] = [
    "checkpoints", "diffusion_models", "text_encoders", "vae", "loras", "upscale_models",
    "embeddings", "controlnet",
    // Core reads FILM and RIFE from here via `FrameInterpolationModelLoader`,
    // not from `upscale_models`. Omitting it is the `latent_upscale_models`
    // trap the pod's `relink_data.sh` already records: the file downloads, the
    // dropdown stays empty, and it reads as a broken model rather than a
    // misfiled one.
    "frame_interpolation",
    // …and that trap was open, in the line above that names it. `collect_weights`
    // has always routed LTX 2.5's `latent_upscaler` here — so the readiness
    // check looked in a directory nothing scanned and nothing could write to.
    // Its x2 upsampler is not optional: the official pipeline samples at half
    // size, upsamples, then refines, which is what `latent_scale: 0.5` means.
    "latent_upscale_models",
    // MMAudio's four files, in the one folder its own pack registers
    // (`folder_paths.add_model_folder_path("mmaudio", …)`) and all four of its
    // loaders read their dropdown from.
    //
    // THE FIRST DIRECTORY COMFYUI ITSELF WRITES INTO: the 44k branch
    // snapshot-downloads a BigVGAN vocoder into `models/mmaudio/nvidia/` on
    // the first render. On the pod that landed root-owned and the first render
    // died on EACCES after the model had loaded; here the whole tree is the
    // user's own, so it is a fact to know rather than a bug to fix.
    // `list_models_sized` does not recurse, so those files stay out of `files`
    // — correct, since nothing addresses them by name.
    "mmaudio",
    // H3's PDD acceleration, in the folder its own pack registers
    // (`folder_paths.add_model_folder_path("pdd_acc", …)`) and reads its
    // `pdd_file` dropdown from. It is NOT `loras`: the files are a trunk LoRA
    // plus a head bank, and the loader that reads this folder is the only one
    // that applies both.
    "pdd_acc",
    // NESTED, and that is the Subpack's own layout rather than a choice:
    // `UltralyticsDetectorProvider` lists `models/ultralytics/bbox` and
    // `models/ultralytics/segm` separately, and a `.pt` in the parent is
    // offered by neither. Both face passes name `bbox/face_yolov8m.pt`, so
    // this is the shelf the detector has to land on. `Path::join` takes the
    // two segments as readily as one; what it needed was saying.
    "ultralytics/bbox",
];

/// `home` is the ComfyUI directory in use — ours or a linked one. Taking the
/// ComfyUI dir rather than the engine root is what lets a linked install be
/// scanned at all: the engine root has no meaning outside our own tree.
fn list_models(home: &Path, kind: &str) -> Vec<String> {
    list_models_sized(home, kind).into_iter().map(|(n, _)| n).collect()
}

/// Half-finished downloads in one model directory, as (key, MB) — see
/// `EngineStatus::partial_mb` for what the key is.
///
/// New downloads APPEND `.part` to the whole filename rather than replacing
/// the extension, so `x.gguf.part` maps back unambiguously. Files written
/// before that change are keyed by their stem and matched on the TS side.
fn list_partials(home: &Path, kind: &str) -> Vec<(String, u64, Option<String>)> {
    let dir = home.join("models").join(kind);
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    // Key by whatever stripping leaves: a full filename for
                    // the current `x.gguf.part`, a bare STEM for a legacy
                    // `x.part` (extension replaced, written before the suffix
                    // changed). Reporting both and letting the caller match on
                    // stem is what makes an already-interrupted download
                    // visible — skipping legacy ones here was a deadlock,
                    // since the rename-forward only happens once a download
                    // STARTS and there was no way to start it.
                    let key = name.strip_suffix(".part")?.to_string();
                    let owner = std::fs::read_to_string(e.path().with_file_name(
                        format!("{name}.owner"))).ok().filter(|o| !o.trim().is_empty());
                    Some((key, e.metadata().map(|m| m.len() / 1_048_576).unwrap_or(0), owner))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The same listing with each file's size in MB (rounded down; a 0 means the
/// stat failed, not that the file is empty).
fn list_models_sized(home: &Path, kind: &str) -> Vec<(String, u64)> {
    let dir = home.join("models").join(kind);
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| {
                    let mb = e.metadata().map(|m| m.len() / 1_048_576).unwrap_or(0);
                    (e.file_name().to_string_lossy().into_owned(), mb)
                })
                .filter(|(n, _)| {
                    n.ends_with(".safetensors") || n.ends_with(".ckpt") || n.ends_with(".gguf")
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Process handle for the engine we started. Deliberately only OURS: an engine
/// the user started in a terminal is theirs to stop, and killing it from here
/// would be a surprise.
#[derive(Default)]
pub struct EngineProc(pub Mutex<Option<std::process::Child>>);

#[tauri::command]
pub fn engine_status(app: AppHandle, proc: State<EngineProc>) -> EngineStatus {
    let root = engine_root(&app);
    let py = python_bin(&root);
    // `installed` stays a question about OUR engine — Start/Stop, the install
    // steps and the planner's Python all key off it. Where the WEIGHTS live is
    // a separate question, answered by `home`.
    let installed = py.is_file() && comfy_dir(&root).join("main.py").is_file();
    let home = comfy_home(&app);
    let linked = linked_comfy(&app).is_some();

    // `try_wait` is what makes this honest: a child that crashed is still in
    // our Option, and reporting it as running would tell the user the engine
    // is up while nothing is listening.
    let running = {
        let mut guard = proc.0.lock().unwrap();
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(_)) => {
                    *guard = None;
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            },
            None => false,
        }
    };

    let file_mb: std::collections::BTreeMap<String, u64> = MODEL_DIRS
        .iter()
        .flat_map(|d| list_models_sized(&home, d))
        .collect();
    let files: Vec<String> = file_mb.keys().cloned().collect();
    let by_dir: std::collections::BTreeMap<String, Vec<String>> = MODEL_DIRS
        .iter()
        .map(|d| ((*d).to_string(), list_models(&home, d)))
        .collect();
    let parts: Vec<(String, u64, Option<String>)> =
        MODEL_DIRS.iter().flat_map(|d| list_partials(&home, d)).collect();
    let partial_mb: std::collections::BTreeMap<String, u64> =
        parts.iter().map(|(k, mb, _)| (k.clone(), *mb)).collect();
    let partial_owner: std::collections::BTreeMap<String, String> = parts
        .iter()
        .filter_map(|(k, _, o)| o.clone().map(|o| (k.clone(), o)))
        .collect();
    let all_nodes: Vec<(String, bool)> = std::fs::read_dir(home.join("custom_nodes"))
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .map(|e| {
                    (e.file_name().to_string_lossy().into_owned(),
                     e.path().join(PACK_FAILED).is_file())
                })
                .collect()
        })
        .unwrap_or_default();
    let nodes: Vec<String> =
        all_nodes.iter().filter(|(_, bad)| !bad).map(|(n, _)| n.clone()).collect();
    let nodes_broken: Vec<String> =
        all_nodes.iter().filter(|(_, bad)| *bad).map(|(n, _)| n.clone()).collect();

    EngineStatus {
        installed,
        planner: py.is_file(),
        ffmpeg: ffmpeg_ready(&root),
        ffmpeg_ours: ffmpeg_is_ours(&root),
        python: installed.then(|| py.to_string_lossy().into_owned()),
        comfy_dir: installed.then(|| comfy_dir(&root).to_string_lossy().into_owned()),
        root: root.to_string_lossy().into_owned(),
        models_dir: home.to_string_lossy().into_owned(),
        models_linked: linked,
        checkpoints: list_models(&home, "checkpoints"),
        loras: list_models(&home, "loras"),
        files,
        file_mb,
        by_dir,
        partial_mb,
        partial_owner,
        nodes,
        nodes_broken,
        running,
        port: 8188,
    }
}

/// `step: None` suppresses the progress events entirely.
///
/// The events go to `engine://progress`, which is the ENGINE INSTALL's own
/// channel — so a caller outside that flow (the Breeze service, which has a
/// channel of its own) would both miss its own progress and push spurious
/// steps into the Engine tab of anyone who had it open.
pub(crate) async fn download_to(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    step: Option<u8>,
    label: &str,
) -> Result<(), String> {
    use tauri_plugin_http::reqwest;

    let res = reqwest::Client::new()
        .get(url)
        .header("user-agent", "QambaStudio/0.1")
        .send()
        .await
        .map_err(|e| format!("{label}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{label}: server answered {}", res.status()));
    }
    let total = res.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
    let mut got: u64 = 0;
    let mut last: u64 = 0;
    let mut res = res;
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("{label}: {e}"))? {
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if got - last > 2_000_000 {
            last = got;
            let Some(step) = step else { continue };
            let _ = app.emit(
                "engine://progress",
                EngineProgress {
                    step,
                    label: label.into(),
                    pct: if total > 0 { got as f64 / total as f64 } else { -1.0 },
                    detail: format!("{:.0} MB", got as f64 / 1_048_576.0),
                },
            );
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// `tar` rather than a crate: macOS and Windows 10+ both ship one that reads
/// gzip, and the alternative is pulling flate2 + tar into a binary that
/// already takes minutes to build for a job the OS does for free.
pub(crate) fn untar(archive: &Path, into: &Path) -> Result<(), String> {
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new("tar");
    cmd.arg("-xzf").arg(archive).arg("-C").arg(into);
    let out = crate::hardware::no_window(&mut cmd)
        .output()
        .map_err(|e| format!("tar failed to start: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "extracting {}: {}",
            archive.file_name().unwrap_or_default().to_string_lossy(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn emit(app: &AppHandle, step: u8, label: &str, pct: f64, detail: &str) {
    let _ = app.emit(
        "engine://progress",
        EngineProgress { step, label: label.into(), pct, detail: detail.into() },
    );
}

/// Run the engine's own python, streaming nothing but reporting failure with
/// the tail of stderr — a pip resolver error is 200 lines of which the last
/// few are the reason.
pub(crate) fn run_python(py: &Path, args: &[&str], cwd: &Path) -> Result<String, String> {
    let mut cmd = std::process::Command::new(py);
    cmd.args(args).current_dir(cwd);
    let out = crate::hardware::no_window(&mut cmd)
        .output()
        .map_err(|e| format!("could not run python: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.lines().rev().take(6).collect();
        return Err(tail.into_iter().rev().collect::<Vec<_>>().join("\n"));
    }
    Ok(stdout)
}

#[tauri::command]
pub async fn install_engine(app: AppHandle) -> Result<EngineStatus, String> {
    let root = engine_root(&app);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let py = python_bin(&root);

    // ── 1. interpreter
    if !py.is_file() {
        emit(&app, 1, "Downloading Python", -1.0, PY_VERSION);
        let tgz = root.join("python.tar.gz");
        let url = py_url()?;
        download_to(&app, &url, &tgz, Some(1), "Downloading Python").await?;
        emit(&app, 1, "Unpacking Python", -1.0, "");
        untar(&tgz, &root)?;
        let _ = std::fs::remove_file(&tgz);
    }
    if !py.is_file() {
        return Err("the Python archive did not contain an interpreter where we expected one".into());
    }
    let ver = run_python(&py, &["-V"], &root)?;
    emit(&app, 1, "Python ready", 1.0, ver.trim());

    // ── 2. ComfyUI
    let comfy = comfy_dir(&root);
    if !comfy.join("main.py").is_file() {
        emit(&app, 2, "Downloading ComfyUI", -1.0, "");
        let tgz = root.join("comfy.tar.gz");
        download_to(&app, COMFY_URL, &tgz, Some(2), "Downloading ComfyUI").await?;
        emit(&app, 2, "Unpacking ComfyUI", -1.0, "");
        untar(&tgz, &root)?;
        let _ = std::fs::remove_file(&tgz);
        // the branch tarball unpacks as ComfyUI-master
        let unpacked = root.join("ComfyUI-master");
        if unpacked.is_dir() {
            let _ = std::fs::remove_dir_all(&comfy);
            std::fs::rename(&unpacked, &comfy).map_err(|e| e.to_string())?;
        }
    }
    if !comfy.join("main.py").is_file() {
        return Err("ComfyUI was downloaded but main.py is missing".into());
    }
    emit(&app, 2, "ComfyUI ready", 1.0, "");

    // ── 3. dependencies. torch on its own first: it is the big one and the
    // only one whose failure is usually about the platform rather than a
    // version pin, so a separate step gives a clearer error.
    emit(&app, 3, "Installing PyTorch", -1.0, "this takes a few minutes");
    run_python(&py, &["-m", "pip", "install", "--disable-pip-version-check", "-q",
                      "--upgrade", "pip"], &root)?;
    let mut torch_args: Vec<&str> = vec!["-m", "pip", "install",
        "--disable-pip-version-check", "-q", "torch", "torchvision", "torchaudio"];
    torch_args.extend(torch_index_args(cfg!(target_os = "windows"), has_nvidia()));
    run_python(&py, &torch_args, &root)?;
    emit(&app, 3, "Installing ComfyUI dependencies", -1.0, "");
    let req = comfy.join("requirements.txt");
    run_python(&py, &["-m", "pip", "install", "--disable-pip-version-check", "-q",
                      "-r", &req.to_string_lossy()], &root)?;

    // Prove the accelerator before claiming success — a torch that installed
    // but cannot see the GPU renders on CPU at a speed nobody wants, and
    // finding that out during the first render wastes the whole download.
    let probe = run_python(
        &py,
        &["-c", "import torch;\
                 mps=getattr(torch.backends,'mps',None);\
                 print(torch.__version__, bool(mps and mps.is_available()), torch.cuda.is_available())"],
        &root,
    )?;
    emit(&app, 3, "Dependencies ready", 1.0, probe.trim());

    for d in MODEL_DIRS {
        let _ = std::fs::create_dir_all(comfy.join("models").join(d));
    }

    // ── 4. the node packs. Mostly pure python, so this adds seconds rather
    // than minutes — and it is done at install time rather than on first use
    // because discovering a missing loader AFTER a 20GB download is the worst
    // possible order.
    //
    // INSTALLED AGAINST A CONSTRAINTS FILE, because one of them (MMAudio)
    // declares a dependency that can replace this engine's torch. See
    // `constraints_text`.
    let nodes = comfy.join("custom_nodes");
    std::fs::create_dir_all(&nodes).map_err(|e| e.to_string())?;
    let pins = root.join("pins.txt");
    let pin_probe = run_python(&py, &["-c",
        "import importlib.metadata as m\n\
         for p in ('torch','torchvision','torchaudio','numpy'):\n\
         \x20   try: print(p + '=' + m.version(p))\n\
         \x20   except Exception: pass"], &root).unwrap_or_default();
    let pins = match std::fs::write(&pins, constraints_text(&pin_probe)) {
        Ok(()) => Some(pins),
        Err(_) => None,
    };
    let mut pack_errs: Vec<String> = Vec::new();
    for (dir, url, label, note) in NODE_PACKS {
        if let Err(e) =
            install_node_pack(&app, &py, &root, &nodes, dir, url, label, note, pins.as_deref())
                .await
        {
            emit(&app, 4, "Node pack skipped", -1.0, &e);
            pack_errs.push(e);
        }
    }

    // ONNXRUNTIME IS NOT DECLARED BY INSIGHTFACE AND IS REQUIRED BY IT, so it
    // is installed beside the H3 face pack rather than left to that pack's own
    // requirements file, which does not name it.
    //
    // THE CPU BUILD, DELIBERATELY, and exactly one of them: the CPU and GPU
    // wheels install the same `onnxruntime` module and the second silently
    // shadows the first. The GPU one wants cuDNN matched to its own build —
    // a second CUDA stack beside torch's, for a model that runs once per frame
    // on a face-sized crop next to a multi-minute H3 sampling pass.
    //
    // A FAILURE HERE IS NOT A FAILED INSTALL. The pack still imports and still
    // renders; what it loses is IDENTITY matching, so on a two-hander it
    // tracks whichever face is nearest the last position — silently. That is
    // the pack's own documented behaviour and the reason this is reported
    // rather than swallowed. Pinned like everything else: it cannot pull
    // torch, and a constraints file costs nothing.
    if nodes.join("ComfyUI-H3-FaceRefine").join("__init__.py").is_file() {
        let mut args: Vec<String> = vec!["-m".into(), "pip".into(), "install".into(),
            "--disable-pip-version-check".into(), "-q".into()];
        if let Some(p) = pins.as_deref() {
            args.push("-c".into());
            args.push(p.to_string_lossy().into_owned());
        }
        args.push("onnxruntime".into());
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        if run_python(&py, &refs, &root).is_err() {
            pack_errs.push(
                "onnxruntime would not install, so Face Refine (H3) will pick faces by                  GEOMETRY rather than by identity — on a two-hander that is the wrong                  face, silently".into());
        }
    }

    // The guard for the guard. The constraints above should make a torch swap
    // impossible; this is what would catch one anyway, and it costs one
    // subprocess against an install measured in gigabytes.
    if let Ok(after) = run_python(&py, &["-c", "import torch; print(torch.__version__)"], &root) {
        let before = probe.split_whitespace().next().unwrap_or("");
        if !before.is_empty() && after.trim() != before {
            pack_errs.push(format!(
                "a node pack changed PyTorch from {before} to {} — reinstall the engine",
                after.trim()));
        }
    }

    // The BigVGAN vocoder MMAudio pulls on its first 44k render goes through
    // `huggingface_hub`. It normally arrives with transformers; checking is one
    // subprocess and the alternative is a render that dies inside a node after
    // the model has loaded.
    if run_python(&py, &["-c", "import huggingface_hub"], &root).is_err() {
        let mut args: Vec<String> = vec!["-m".into(), "pip".into(), "install".into(),
            "--disable-pip-version-check".into(), "-q".into()];
        if let Some(p) = pins.as_deref() {
            args.push("-c".into());
            args.push(p.to_string_lossy().into_owned());
        }
        args.push("huggingface_hub".into());
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let _ = run_python(&py, &refs, &root);
    }

    if !pack_errs.is_empty() {
        // The install SUCCEEDS — a pack costs a capability, not the engine —
        // and every consumer asks `engine_status.nodes` before offering the
        // thing it provides. What must not happen is silence.
        emit(&app, 4, "Installed, with node packs skipped", 1.0, &pack_errs.join(" · "));
    }

    // The full install is a SUPERSET of the utilities one. Without this, a
    // user who took the big install still met "this needs ffmpeg on your
    // PATH" on their first timeline render — the exact failure the utilities
    // option exists to remove, on the path least expecting it.
    install_ffmpeg(&app, &root).await?;

    Ok(engine_status(app.clone(), app.state::<EngineProc>()))
}

/// THE UTILITIES — everything the studio needs that is NOT a render engine.
///
/// Two things, and they are the two a machine can be missing without knowing:
/// the planner's Python, and ffmpeg. Neither renders anything; both are
/// needed before anything else works, and the full install is gigabytes of
/// PyTorch that a user with their own ComfyUI wants none of.
///
/// WHY NOT A PYTHON THEY ALREADY HAVE. Two reasons, both measured rather than
/// assumed. The version: the pipeline uses `X | Y` type syntax, so it needs
/// 3.10+, and a current macOS still ships 3.9 — which fails at IMPORT, not at
/// runtime, so "python3 exists" is not the question. And the packages: a
/// system Python is PEP-668 managed (pip refuses it outright) and a linked
/// ComfyUI's belongs to the user, whose environment we do not get to add to.
/// A private interpreter removes the whole category.
///
/// FFMPEG IS THE OPPOSITE CASE, and the asymmetry is the whole design of
/// `child_path`: a system ffmpeg works fine, so one that is already there is
/// left in charge and nothing is downloaded. What was really broken was that
/// a GUI-launched app could not SEE it — see `EXTRA_PATH`. So this step is
/// usually a no-op on a developer's machine and a ~90MB download on a clean
/// one.
///
/// `requests` is the pipeline's ONLY third-party import — everything else in
/// the closure is stdlib — so the Python half is ~25MB and seconds, against
/// the full install's gigabytes and minutes.
#[tauri::command]
pub async fn install_utilities(app: AppHandle) -> Result<EngineStatus, String> {
    let root = engine_root(&app);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let py = python_bin(&root);

    if !py.is_file() {
        emit(&app, 1, "Downloading Python", -1.0, PY_VERSION);
        let tgz = root.join("python.tar.gz");
        let url = py_url()?;
        download_to(&app, &url, &tgz, Some(1), "Downloading Python").await?;
        emit(&app, 1, "Unpacking Python", -1.0, "");
        untar(&tgz, &root)?;
        let _ = std::fs::remove_file(&tgz);
    }
    if !py.is_file() {
        return Err("the Python archive did not contain an interpreter where we expected one".into());
    }

    // The full install gets `requests` incidentally, through ComfyUI's own
    // requirements; on this path nothing else would ever pull it in, and the
    // planner's first HTTP call would die on an ImportError.
    //
    // SKIPPED WHEN IT IS ALREADY THERE, which is not just speed: the "Get
    // ffmpeg" button on an installed engine comes through here, and an
    // unconditional pip run would put a PyPI round trip — and its failure —
    // in front of a download that has nothing to do with it.
    if run_python(&py, &["-c", "import requests"], &root).is_err() {
        emit(&app, 1, "Installing the planner's one dependency", -1.0, "requests");
        run_python(&py, &["-m", "pip", "install", "--disable-pip-version-check", "-q",
                          "--upgrade", "pip"], &root)?;
        run_python(&py, &["-m", "pip", "install", "--disable-pip-version-check", "-q",
                          "requests"], &root)?;
    }

    let ver = run_python(&py, &["-V"], &root)?;

    // Skipped in silence when the machine already has a working pair — see
    // `install_ffmpeg`. Reported either way, because "ready" over a step that
    // did nothing reads as a broken button.
    let had = ffmpeg_ready(&root);
    emit(&app, 1, "Checking for ffmpeg", -1.0,
         if had { "already on this machine" } else { "fetching a static build" });
    install_ffmpeg(&app, &root).await?;
    emit(&app, 1, "Utilities ready", 1.0,
         &format!("{} · ffmpeg {}", ver.trim(),
                  if had { "already installed" } else { "installed" }));
    Ok(engine_status(app.clone(), app.state::<EngineProc>()))
}

#[tauri::command]
pub fn start_engine(app: AppHandle, proc: State<EngineProc>) -> Result<EngineStatus, String> {
    {
        let mut guard = proc.0.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                return Ok(engine_status(app.clone(), app.state::<EngineProc>()));
            }
            *guard = None;
        }
    }
    let root = engine_root(&app);
    let py = python_bin(&root);
    let comfy = comfy_dir(&root);
    if !py.is_file() || !comfy.join("main.py").is_file() {
        return Err("the engine is not installed yet".into());
    }

    let log = std::fs::File::create(root.join("comfyui.log")).map_err(|e| e.to_string())?;
    let errlog = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(&py);
    cmd.arg("main.py")
        .arg("--port")
        .arg("8188")
        // Loopback only. This engine is for this machine; binding it wider
        // would put an unauthenticated render API on the user's network.
        .arg("--listen")
        .arg("127.0.0.1")
        .current_dir(&comfy)
        // ComfyUI shells out to ffmpeg itself — VideoHelperSuite loads a
        // reference video with it — and it inherits the same GUI-launch PATH
        // the pipeline does, so it needs the same repair.
        .env("PATH", child_path(&root))
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errlog));
    // Long-lived, so on Windows this is the spawn whose console would not
    // merely flash — it would stay on screen for as long as the engine runs.
    let child = crate::hardware::no_window(&mut cmd)
        .spawn()
        .map_err(|e| format!("could not start ComfyUI: {e}"))?;

    *proc.0.lock().unwrap() = Some(child);
    Ok(engine_status(app.clone(), app.state::<EngineProc>()))
}

#[tauri::command]
pub fn stop_engine(app: AppHandle, proc: State<EngineProc>) -> EngineStatus {
    if let Some(mut child) = proc.0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    engine_status(app.clone(), app.state::<EngineProc>())
}

/// The tail of ComfyUI's own log. The engine takes minutes to become ready on
/// a cold start and the only honest progress indicator is what it is printing.
#[tauri::command]
pub fn engine_log(app: AppHandle, lines: Option<usize>) -> String {
    let path = engine_root(&app).join("comfyui.log");
    let body = std::fs::read_to_string(&path).unwrap_or_default();
    let n = lines.unwrap_or(40);
    body.lines()
        .rev()
        .take(n)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

/// ComfyUI's own directory name for a kind the browser asked for.
///
/// Singular aliases are kept because the first version of the catalogue used
/// them, and an unknown one is REFUSED rather than defaulted — a weight file
/// in the wrong directory is invisible to the loader that wants it, which
/// reads as "the download did nothing". Pure, so the test can check it against
/// what `civitai.modelDir()` actually returns without an AppHandle.
fn model_dir_kind(kind: &str) -> Result<&'static str, String> {
    Ok(match kind {
        "checkpoint" | "checkpoints" => "checkpoints",
        "diffusion_models" | "unet" => "diffusion_models",
        "text_encoders" | "clip" => "text_encoders",
        "lora" | "loras" => "loras",
        "vae" => "vae",
        "upscale" | "upscale_models" => "upscale_models",
        // A DIFFERENT directory from the line above, read by a DIFFERENT node
        // (`LatentUpscaleModelLoader`). Refusing it here made LTX 2.5's x2
        // upsampler undownloadable while `collect_weights` was already looking
        // for it in the very place the write was refused.
        "latent_upscale_models" => "latent_upscale_models",
        // Civitai's TextualInversion and ControlNet types land here. They have
        // no `engineCatalog` entry — nothing this app renders names one — but
        // the hub can download them, and refusing the write while the button
        // offers it is worse than either alternative.
        "embedding" | "embeddings" => "embeddings",
        "controlnet" => "controlnet",
        "frame_interpolation" => "frame_interpolation",
        // The face detector both post passes name. NESTED because the Impact
        // Subpack's provider lists `bbox` and `segm` as separate pools — a
        // `.pt` dropped in `models/ultralytics` itself is offered by neither,
        // which is the misfiled-not-missing trap `frame_interpolation` above
        // already records.
        "ultralytics" | "ultralytics/bbox" => "ultralytics/bbox",
        // kijai/ComfyUI-MMAudio registers this folder itself and all four of
        // its loaders read their dropdown from it — the transformer, the audio
        // VAE, Synchformer and the CLIP tower share one directory.
        "mmaudio" => "mmaudio",
        // Same shape: the H3 PDD pack registers `pdd_acc` itself and its Apply
        // node lists that folder. Refused here, the Get button on the PDD
        // add-on would answer `unknown model directory` after the catalogue had
        // already offered it.
        "pdd_acc" => "pdd_acc",
        other => return Err(format!("unknown model directory '{other}'")),
    })
}

/// Where a downloaded weight file should land, by kind. The UI passes this
/// straight to `download_model_file`, so the browser never builds a filesystem
/// path itself.
#[tauri::command]
pub fn engine_model_path(app: AppHandle, kind: String, filename: String) -> Result<String, String> {
    // A filename is attacker-adjacent data (it comes from a Civitai listing),
    // so it is reduced to its own basename before it is joined to a path.
    let base = Path::new(&filename)
        .file_name()
        .ok_or("not a filename")?
        .to_string_lossy()
        .into_owned();
    let kind = model_dir_kind(&kind)?;
    // The same directory `engine_status` scanned — otherwise a linked setup
    // downloads into our empty tree and reports the file as still missing.
    let dir = comfy_home(&app).join("models").join(kind);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(base).to_string_lossy().into_owned())
}

/// The URL a ComfyUI window may be opened at — LOOPBACK ONLY.
///
/// The value arrives from the webview, and a window this app opens LOOKS like
/// this app: our title bar, our window list, our dock icon. Opening an
/// arbitrary one would be a phishing surface built out of our own chrome, so
/// it is checked here rather than trusted for having been ours a moment ago —
/// the same rule `engine_model_path` follows about attacker-adjacent data.
///
/// The POD's ComfyUI is deliberately NOT reachable this way. Its address comes
/// from an API response and it is a remote host; "open a remote page in a
/// window that looks like the app" is a much larger surface than the local
/// engine needs, and that link stays a browser link.
pub(crate) fn comfy_window_url(raw: Option<&str>) -> Result<tauri::Url, String> {
    let raw = raw.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_COMFY);
    let u = tauri::Url::parse(raw).map_err(|e| format!("not a URL: {e}"))?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err(format!("{}: only http(s) opens in a window", u.scheme()));
    }
    let host = u.host_str().unwrap_or("");
    // `host_str` hands back a v6 literal WITH its brackets (`[::1]`), which is
    // not something `IpAddr` parses — so without this strip the v6 loopback was
    // refused. Caught by the test rather than by reading the docs; a bracket
    // trim on a domain name is a no-op either way.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let loopback = bare == "localhost"
        || bare.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false);
    if !loopback {
        return Err(format!(
            "{host} is not this machine — only a local engine opens in a window"));
    }
    Ok(u)
}

/// The filename a staged workflow may be written under.
///
/// The name comes from the webview and is used to build a path, so it is the
/// same attacker-adjacent value `engine_model_path` and `localstore::safe_key`
/// are careful about — except this one lands inside somebody's ComfyUI, where
/// a traversal would overwrite their own work rather than ours.
pub(crate) fn workflow_file_name(raw: &str) -> Result<String, String> {
    let base: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || " ._-".contains(c) { c } else { '-' })
        .collect();
    let base = base.trim().trim_matches('.').trim().to_string();
    if base.is_empty() || base.contains("..") {
        return Err(format!("{raw:?} is not a usable workflow name"));
    }
    let stem: String = base.trim_end_matches(".json").chars().take(80).collect();
    let stem = stem.trim().to_string();
    // At least one real character. Everything above only SUBSTITUTES, so "/"
    // survives as "-" — a legal filename, and not a name anyone meant.
    if !stem.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("{raw:?} is not a usable workflow name"));
    }
    Ok(format!("{stem}.json"))
}

/// The outcome of staging: which file, and whether we left an edited one alone.
#[derive(Serialize)]
pub struct Staged {
    pub file: String,
    /// true when a DIFFERENT copy was already there and was kept — the user's
    /// work, which the caller must offer rather than silently replace
    pub kept: bool,
}

/// Put a workflow where ComfyUI's own browser will list it.
///
/// WHY A FILE AND NOT A DEEP LINK. This frontend (1.49.6) has no `?workflow=`
/// param — its only URL intents are `share` and `template` — and the keys that
/// remember which workflow is open (`Comfy.Workflow.ActivePath`, `OpenPaths`,
/// `LastActivePath`) are sessionStorage/localStorage on ITS origin, which we
/// cannot write and would not want to guess at across versions. What IS stable
/// and documented is the directory: `user/default/workflows/`. Measured on a
/// live 0.33 engine — a file dropped in there appears in the Workflows sidebar
/// and opens with one click, laid out and editable.
///
/// IT NEVER OVERWRITES AN EDITED COPY, and the first version did — which is
/// DATA LOSS, not a rough edge: the filename is derived from the workflow, so
/// pressing "Edit in ComfyUI" a second time rewrote the file from the template
/// and took whatever had been saved in ComfyUI with it. Silently, because a
/// write that succeeds says nothing. So an existing file is compared with what
/// we would write and KEPT when it differs — which, after ComfyUI has saved
/// once, is always (it adds its own `id`, `revision` and `extra.ds`). That is
/// the right reading of a second click anyway: take me back to my work, not
/// reset it. `overwrite` is the explicit "start over from the template", and
/// it is a separate thing a person has to ask for.
///
/// It goes to `comfy_home`, so a LINKED ComfyUI gets it in its own tree.
#[tauri::command]
pub fn stage_comfy_workflow(
    app: AppHandle, name: String, json: String, overwrite: Option<bool>,
) -> Result<Staged, String> {
    let file = workflow_file_name(&name)?;
    // Parsed rather than trusted: a half-written document in someone's
    // workflow browser is a broken entry they have to find and delete.
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("that is not a workflow document: {e}"))?;
    let dir = comfy_home(&app).join("user").join("default").join("workflows");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not open ComfyUI's workflows folder: {e}"))?;
    let path = dir.join(&file);
    let existing = std::fs::read_to_string(&path).ok();
    match stage_action(existing.as_deref(), &json, overwrite == Some(true)) {
        StageAction::Keep => Ok(Staged { file, kept: true }),
        StageAction::Unchanged => Ok(Staged { file, kept: false }),
        StageAction::Write => {
            std::fs::write(&path, json)
                .map_err(|e| format!("could not write the workflow: {e}"))?;
            Ok(Staged { file, kept: false })
        }
    }
}

/// What staging should do about what is already on disk.
#[derive(Debug, PartialEq)]
pub(crate) enum StageAction {
    /// nothing there, or the caller asked to start over
    Write,
    /// somebody edited it — theirs wins, and the caller offers it
    Keep,
    /// byte-identical, so writing would only move the mtime the import list
    /// sorts on
    Unchanged,
}

pub(crate) fn stage_action(existing: Option<&str>, next: &str, overwrite: bool) -> StageAction {
    match existing {
        _ if overwrite => StageAction::Write,
        None => StageAction::Write,
        Some(cur) if cur == next => StageAction::Unchanged,
        Some(_) => StageAction::Keep,
    }
}

/// One workflow sitting in ComfyUI's own folder.
#[derive(Serialize)]
pub struct StagedWorkflow {
    pub file: String,
    /// unix millis, so the screen can say when ComfyUI last wrote it
    pub modified_ms: u64,
    pub bytes: u64,
    /// true when this app put it there — the round trip's own files
    pub ours: bool,
}

/// What is in ComfyUI's workflow folder, newest first.
///
/// EVERYTHING, not just ours. A graph the user built in ComfyUI from scratch
/// is exactly as worth importing as one we staged for them to edit, and
/// filtering to our own prefix would make the obvious thing ("I made this in
/// ComfyUI, bring it into Qamba") the one thing the button could not do.
/// `ours` says which is which instead.
#[tauri::command]
pub fn list_staged_workflows(app: AppHandle) -> Vec<StagedWorkflow> {
    let dir = comfy_home(&app).join("user").join("default").join("workflows");
    let mut out: Vec<StagedWorkflow> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".json") || name.starts_with('.') { return None; }
            let md = e.metadata().ok()?;
            if !md.is_file() { return None; }
            let modified_ms = md.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Some(StagedWorkflow {
                ours: name.starts_with("Qamba - "),
                file: name, modified_ms, bytes: md.len(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

/// Read one back. Same name rule as writing it: the value comes from the
/// webview and is used to build a path.
#[tauri::command]
pub fn read_staged_workflow(app: AppHandle, file: String) -> Result<String, String> {
    let name = workflow_file_name(&file)?;
    let path = comfy_home(&app).join("user").join("default").join("workflows").join(&name);
    std::fs::read_to_string(&path)
        .map_err(|e| format!("could not read {name}: {e}"))
}

/// Open the local ComfyUI in a window of the app's own.
///
/// WHY A WINDOW AND NOT A PANEL, which is the obvious thing to want: ComfyUI
/// REFUSES TO BE FRAMED. `create_origin_only_middleware` in its own server.py
/// returns 403 on `Sec-Fetch-Site: cross-site` before any other check, and
/// that header is on every cross-origin iframe navigation — measured here, the
/// frame "loads" and paints white while the 403 sits in the network log, which
/// is nowhere a user would look. `--enable-cors-header` swaps that middleware
/// out entirely, but only for an engine WE launch, and linking the ComfyUI you
/// already run is a first-class setup here. A TOP-LEVEL navigation carries
/// `Sec-Fetch-Site: none` and every request inside it is same-origin, so a
/// window works for both with no flag, no proxy and no patch.
///
/// THE WINDOW GETS NO IPC. Capabilities are per-window and `default` lists
/// `main` alone, so this page — which we do not own — can reach no command of
/// ours. Nothing is injected into it either: an initialization script on
/// someone else's page is the thing that would make this a bad idea.
#[tauri::command]
pub fn open_comfy_window(
    app: AppHandle, url: Option<String>, workflow: Option<String>,
) -> Result<(), String> {
    let target = comfy_window_url(url.as_deref())?;
    let script = workflow.as_deref().map(open_workflow_script).transpose()?;

    // Already open: raise it, and ask it to switch — an init script only runs
    // on a fresh page, and reloading would throw away whatever is on screen.
    if let Some(w) = app.get_webview_window(COMFY_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        if let Some(js) = &script { let _ = w.eval(js); }
        return w.set_focus().map_err(|e| e.to_string());
    }
    let mut b = tauri::WebviewWindowBuilder::new(
        &app, COMFY_WINDOW, tauri::WebviewUrl::External(target))
        .title("ComfyUI — your engine")
        .inner_size(1440.0, 940.0)
        .min_inner_size(900.0, 600.0);
    if let Some(js) = script { b = b.initialization_script(&js); }
    b.build().map_err(|e| format!("could not open the ComfyUI window: {e}"))?;
    Ok(())
}

/**
Ask ComfyUI to OPEN a staged workflow, rather than leaving it in the sidebar.

THE ONE PLACE THIS APP RUNS SCRIPT IN A PAGE IT DOES NOT OWN, and the reasons
it is narrow enough to be worth it: the window is one we created, the script
runs nowhere else, it touches nothing on disk and changes no setting, it uses
ComfyUI's OWN public entry points (`window.app.loadGraphData` and the
`/api/userdata` route its sidebar reads), and every failure path leaves the
editor exactly as it was — the workflow is still one click away in the sidebar,
which is where it was before this existed. Nothing is injected when no workflow
was asked for.

WHY A SCRIPT AT ALL. This frontend (1.49.6) has no `?workflow=` URL intent —
its only ones are `share` and `template` — and the keys that decide which
document is open (`Comfy.Workflow.ActivePath` / `OpenPaths` /
`LastActivePath`) are sessionStorage and localStorage on ITS origin, so there
is nothing to write from out here and nothing stable to guess at. What IS
stable is that the app object exposes `loadGraphData`, which is the same call
every ComfyUI extension makes.

IT WAITS FOR THE APP'S OWN RESTORE TO FINISH FIRST. Startup calls
`loadGraphData()` itself to bring back the last document; loading ours before
that lands means theirs replaces it, which reads exactly like this doing
nothing. Hence the settle delay and the one re-check.

AND IT RUNS ONCE PER TAB. An init script fires on every navigation, so a
reload would otherwise re-open our workflow over whatever the user had moved
on to — a sessionStorage sentinel keeps it to the first load.
*/
fn open_workflow_script(file: &str) -> Result<String, String> {
    // The name is data, not code: it comes from the webview and is spliced
    // into a script, so it goes through the JSON encoder rather than quotes.
    let f = serde_json::to_string(file).map_err(|e| e.to_string())?;
    Ok(format!(r#"(() => {{
  const FILE = {f}, KEY = "qamba:opened";
  try {{ if (sessionStorage.getItem(KEY) === FILE) return; }} catch (e) {{}}
  const name = FILE.replace(/\.json$/, "");
  const began = Date.now();
  const load = async () => {{
    const r = await fetch("/api/userdata/" + encodeURIComponent("workflows/" + FILE));
    if (!r.ok) throw new Error(String(r.status));
    await window.app.loadGraphData(await r.json(), true, true, name);
  }};
  const tick = async () => {{
    const app = window.app;
    if (!app || !app.graph || !app.canvas || typeof app.loadGraphData !== "function") {{
      if (Date.now() - began < 120000) setTimeout(tick, 250);
      return;
    }}
    try {{
      await load();
      try {{ sessionStorage.setItem(KEY, FILE); }} catch (e) {{}}
      // One re-check: if the app's own restore landed after ours, it won.
      setTimeout(async () => {{
        if (!document.title.includes(name)) {{ try {{ await load(); }} catch (e) {{}} }}
      }}, 1500);
    }} catch (e) {{
      // The sidebar still has it. Never break somebody's editor over this.
    }}
  }};
  setTimeout(tick, 700);
}})();"#))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_staged_workflow_name_cannot_leave_its_folder() {
        assert_eq!(workflow_file_name("Qamba - minimax_h3_flf").unwrap(),
                   "Qamba - minimax_h3_flf.json");
        // …and the extension is not doubled for a name that already has one.
        assert_eq!(workflow_file_name("thing.json").unwrap(), "thing.json");
        for bad in ["../../evil", "..", "  ", "", "/", "./."] {
            assert!(workflow_file_name(bad).is_err(), "{bad:?} should be refused");
        }
        // A separator is not an error — it is not a path here, so it is simply
        // not a separator any more.
        let sub = workflow_file_name("a/b/c").unwrap();
        assert!(!sub.contains('/'), "{sub}");
    }

    /// The rule that is the difference between "take me back to my work" and
    /// destroying it. The first version of this feature wrote unconditionally,
    /// so a second "Edit in ComfyUI" rewrote the file from the template and
    /// took whatever had been saved in ComfyUI with it — silently, because a
    /// write that succeeds says nothing.
    #[test]
    fn staging_never_overwrites_an_edited_copy() {
        let fresh = "{\"nodes\":[]}";
        // Nothing there yet.
        assert_eq!(stage_action(None, fresh, false), StageAction::Write);
        // Ours, untouched: writing again would only move the mtime the import
        // list sorts on.
        assert_eq!(stage_action(Some(fresh), fresh, false), StageAction::Unchanged);
        // EDITED. After ComfyUI saves once this is always the case — it adds
        // its own `id`, `revision` and `extra.ds` — which is the correct
        // reading: once it has been opened and saved, the copy is theirs.
        let theirs = "{\"nodes\":[],\"id\":\"abc\",\"revision\":1}";
        assert_eq!(stage_action(Some(theirs), fresh, false), StageAction::Keep);
        // …and starting over is a thing a person asks for explicitly.
        assert_eq!(stage_action(Some(theirs), fresh, true), StageAction::Write);
    }

    #[test]
    fn the_open_script_carries_the_name_as_data_and_runs_once() {
        let js = open_workflow_script("Qamba - a.json").unwrap();
        // The filename is spliced into a script, so it goes through the JSON
        // encoder — a quote in a workflow name must not become code.
        assert!(js.contains(r#"FILE = "Qamba - a.json""#), "{js}");
        let tricky = "a\";alert(1);//.json";
        let js2 = open_workflow_script(tricky).unwrap();
        assert!(js2.contains(&serde_json::to_string(tricky).unwrap()),
                "the name is not JSON-encoded into the script");

        // An init script fires on every navigation, so a reload must not
        // re-open our workflow over whatever the user moved on to.
        assert!(js.contains("sessionStorage.getItem"), "no run-once guard");
        // And it waits for the app's own restore rather than racing it.
        assert!(js.contains("app.canvas") && js.contains("setTimeout(tick"), "no readiness wait");
    }

    /// The whole security boundary of the ComfyUI window is this function.
    #[test]
    fn a_comfy_window_opens_on_loopback_and_nowhere_else() {
        // The default, and the shapes a local engine really takes.
        assert_eq!(comfy_window_url(None).unwrap().as_str(), "http://127.0.0.1:8188/");
        assert!(comfy_window_url(Some("http://localhost:8188")).is_ok());
        assert!(comfy_window_url(Some("http://127.0.0.1:8000")).is_ok());
        assert!(comfy_window_url(Some("http://[::1]:8188")).is_ok(), "v6 loopback");
        // TLS on loopback is unusual and legitimate — someone's own reverse
        // proxy — so the scheme check is about http(s), not about http.
        assert!(comfy_window_url(Some("https://127.0.0.1:8188")).is_ok());
        // An empty string is "no opinion", not an error: the caller may hand
        // over whatever a text field contains.
        assert!(comfy_window_url(Some("   ")).is_ok());

        // Anything that is not this machine, and anything that is not a page.
        for bad in ["http://example.com/", "http://192.168.1.10:8188",
                    "http://10.0.0.5:8188", "http://0.0.0.0:8188",
                    "file:///etc/passwd", "javascript:alert(1)",
                    "http://127.0.0.1.evil.com/", "not a url"] {
            assert!(comfy_window_url(Some(bad)).is_err(), "{bad} should be refused");
        }
    }

    /// The bar a linked directory has to clear. Too permissive and a mistyped
    /// path scatters nine model directories through someone's home folder —
    /// visible only as a download ComfyUI will never read.
    #[test]
    fn a_linked_directory_must_look_like_a_comfyui() {
        let tmp = std::env::temp_dir().join(format!("qamba-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(!is_comfy_dir(&tmp), "an empty directory is not a ComfyUI");

        // Either marker is enough: a source checkout has main.py, and a
        // portable build the user has only ever run may show us models/ first.
        std::fs::create_dir_all(tmp.join("models")).unwrap();
        assert!(is_comfy_dir(&tmp));
        std::fs::remove_dir_all(tmp.join("models")).unwrap();
        std::fs::write(tmp.join("main.py"), "").unwrap();
        assert!(is_comfy_dir(&tmp));

        assert!(!is_comfy_dir(Path::new("/nonexistent-comfy")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn model_listing_is_empty_rather_than_erroring_on_a_missing_dir() {
        // The setup screen calls this before anything is installed.
        assert!(list_models(Path::new("/nonexistent-comfy-dir"), "checkpoints").is_empty());
    }

    /// The browser and this file have to agree on the legal set. They did not:
    /// `modelDir()` routed TextualInversion and ControlNet somewhere
    /// `engine_model_path` refused, so the hub offered an enabled button that
    /// failed on press. Parsing the TS is the only way to check it — the two
    /// halves are in different languages and the failure is silent until a
    /// human presses the button.
    #[test]
    fn every_directory_the_browser_can_ask_for_is_one_we_accept() {
        let src = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/civitai.ts"),
        )
        .expect("civitai.ts should be readable from the crate root");
        // Normalised to LF first: git's default on Windows is core.autocrlf.
        let src = src.replace("\r\n", "\n");
        let body = src
            .split_once("export function modelDir(")
            .expect("modelDir is gone — did it move or get renamed?")
            .1;
        let body = body.split_once("\n}").expect("unterminated modelDir").0;

        let mut seen = 0;
        for line in body.lines() {
            // `case "lora": return "loras";` — only the RETURNED string matters.
            let Some(after) = line.split_once("return ") else { continue };
            let Some(dir) = after.1.split('"').nth(1) else { continue };
            seen += 1;
            assert!(
                model_dir_kind(dir).is_ok(),
                "civitai.modelDir() can return {dir:?}, which engine_model_path refuses",
            );
            assert!(
                MODEL_DIRS.contains(&model_dir_kind(dir).unwrap()),
                "{dir:?} is accepted but not in MODEL_DIRS, so a file written there \
                 would never appear in engine_status.files",
            );
        }
        assert!(seen >= 5, "only found {seen} directories — did the parse break?");
    }

    /// GitHub's tarball unpacks as `<repo>-<branch>`, and NEITHER half can be
    /// assumed. The directory we KEEP it under is not always the repo name —
    /// `ComfyUI-LTX2.5-MSR` happens to match and `ComfyUI-GGUF` happens to
    /// match, and neither is guaranteed to keep matching — and the branch is
    /// not always `main`: `ltdrdata/ComfyUI-Impact-Pack` has no such branch at
    /// all, and `heads/main.tar.gz` is a 404 there.
    ///
    /// Getting either wrong leaves the archive sitting beside its own target
    /// under a name nothing reads, which reads as "the pack did not install"
    /// and costs the download again on the next run.
    #[test]
    fn the_unpacked_directory_comes_from_the_repo_and_the_branch() {
        for (dir, url, _, _) in NODE_PACKS {
            assert!(!url_repo(url).is_empty(), "{dir}: cannot read a repo out of {url}");
            assert!(url.starts_with("https://github.com/")
                    && url.contains("/archive/refs/heads/")
                    && url.ends_with(".tar.gz"),
                    "{dir}: not a GitHub branch tarball: {url}");
            assert!(!url_branch(url).is_empty(), "{dir}: cannot read a branch out of {url}");
        }
        assert_eq!(
            url_repo("https://github.com/liconstudio/ComfyUI-LTX2.5-MSR/archive/refs/heads/main.tar.gz"),
            "ComfyUI-LTX2.5-MSR");
        // The case that made this a function rather than a literal, kept as a
        // LITERAL because the pack it belongs to is deliberately not installed
        // (see `the_retired_face_detailer_is_deliberately_not_installed`).
        // Verified against GitHub: `heads/main.tar.gz` on that repo is a 404
        // and `heads/Main.tar.gz` is a 200 — so the trap is real and this is
        // what stops the next pack with an unusual default branch hitting it.
        assert_eq!(
            url_branch("https://github.com/ltdrdata/ComfyUI-Impact-Pack/archive/refs/heads/Main.tar.gz"),
            "Main");
        assert_eq!(url_branch(GGUF_NODE_URL), "main");
    }

    /// The packs the FINISHING CHAIN needs, and that each is a distinct
    /// directory.
    ///
    /// `engine_status.nodes` lists `custom_nodes/*` by directory and
    /// `postLocal.ts` decides whether a pass can run from the CLASSES the
    /// engine reports — but a duplicated or empty directory name here would
    /// have two packs overwrite one another, which is invisible until a render
    /// fails on a node that was installed twice and kept once.
    #[test]
    fn the_finishing_chain_packs_are_present_and_distinct() {
        let dirs: Vec<&str> = NODE_PACKS.iter().map(|(d, ..)| *d).collect();
        for want in ["ComfyUI-KJNodes", "ComfyUI-H3-FaceRefine"] {
            assert!(dirs.contains(&want), "the installer no longer adds {want}");
        }
        let mut seen = dirs.clone();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), dirs.len(), "two packs share a directory");
    }

    /// IMPACT IS ABSENT ON PURPOSE, and this is what keeps that a decision
    /// rather than an omission.
    ///
    /// `FaceDetailer` is the `facefix` pass and `facefix` is RETIRED — the
    /// toggle says so, on a measurement — so these two repos would unlock a
    /// pass the studio recommends against. Re-adding one is fine; doing it
    /// without noticing that the pass is retired is not, and the assertion is
    /// where somebody finds out.
    ///
    /// It costs nothing either way: `postLocal.ts` asks for those classes, so
    /// a chain with Face Detailer on refuses the local plane with the reason.
    #[test]
    fn the_retired_face_detailer_is_deliberately_not_installed() {
        let dirs: Vec<&str> = NODE_PACKS.iter().map(|(d, ..)| *d).collect();
        for gone in ["ComfyUI-Impact-Pack", "ComfyUI-Impact-Subpack"] {
            assert!(!dirs.contains(&gone),
                    "{gone} is back — `facefix` is retired (POST_OP.retired), so if it \
                     is genuinely wanted again, say why here");
        }
    }

    /// WHATEVER IS INSTALLED RIGHT NOW IS THE CONTRACT.
    ///
    /// The probe is one line per package; anything it could not import is
    /// simply absent, and a constraints file with fewer lines is weaker but
    /// never wrong. What must not happen is a malformed line reaching pip,
    /// which would fail every pack install at once.
    #[test]
    fn constraints_are_written_from_what_is_installed_right_now() {
        let out = constraints_text("torch=2.13.0\ntorchvision=0.24.0\nnumpy=2.1.3\n");
        assert_eq!(out, "torch==2.13.0\ntorchvision==0.24.0\nnumpy==2.1.3");
        // A probe that could not import torchaudio yields three lines, not a
        // line with an empty version in it.
        assert_eq!(constraints_text("torch=2.13.0\n\ngarbage\n"), "torch==2.13.0");
        assert_eq!(constraints_text(""), "");
    }

    /// A `git+` requirement is a source BUILD whose own build system resolves
    /// dependencies before our constraints apply — the one line a constraints
    /// file cannot protect. No pack installed here declares one; this is what
    /// keeps that true if one starts.
    #[test]
    fn vcs_lines_are_dropped_from_a_pack_requirements_file() {
        let req = "librosa>=0.10.1\ngit+https://github.com/x/y.git\nopen_clip_torch>=2.29.0\n";
        let out = strip_vcs_lines(req);
        assert!(out.contains("librosa>=0.10.1"));
        assert!(out.contains("open_clip_torch>=2.29.0"));
        assert!(!out.contains("git+"), "a VCS line survived: {out}");
    }

    /// Bare PyPI torch is CPU-ONLY on Windows, which on a machine with an
    /// NVIDIA card is an engine that installs perfectly and renders at a speed
    /// nobody wants. macOS wheels carry MPS from PyPI, so the index is added
    /// only where it changes the answer.
    #[test]
    fn the_cuda_index_is_added_only_on_windows_with_an_nvidia_card() {
        assert_eq!(torch_index_args(true, true),
                   vec!["--index-url", "https://download.pytorch.org/whl/cu128"]);
        assert!(torch_index_args(true, false).is_empty(), "no card, no index");
        assert!(torch_index_args(false, true).is_empty(), "macOS takes MPS from PyPI");
        assert!(torch_index_args(false, false).is_empty());
    }

    /// A pack directory here is a name THREE other places gate on — the two
    /// `localModels` checks and the desktop map generator — so a rename is a
    /// silently withdrawn capability rather than a build error.
    #[test]
    fn every_node_pack_has_a_distinct_directory() {
        let dirs: Vec<&str> = NODE_PACKS.iter().map(|(d, ..)| *d).collect();
        let mut sorted = dirs.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), dirs.len(), "two packs claim one directory");
    }

    /// A PACK WHOSE DEPENDENCIES FAILED IS WORSE THAN AN ABSENT ONE: the
    /// directory is on disk and its `__init__.py` is importable-looking, so
    /// every gate that reads `nodes` goes on offering the capability right up
    /// to the render that dies inside ComfyUI. The marker is what separates
    /// the two, and it must move the name from one list to the other rather
    /// than merely adding it.
    #[test]
    fn a_pack_whose_deps_failed_is_reported_broken_and_not_counted_as_present() {
        let tmp = std::env::temp_dir().join(format!("qamba-packs-{}", std::process::id()));
        let nodes = tmp.join("custom_nodes");
        std::fs::create_dir_all(nodes.join("ComfyUI-GGUF")).unwrap();
        std::fs::create_dir_all(nodes.join("ComfyUI-MMAudio")).unwrap();
        std::fs::write(nodes.join("ComfyUI-MMAudio").join(PACK_FAILED), "boom").unwrap();

        let mut ok: Vec<String> = vec![];
        let mut bad: Vec<String> = vec![];
        for e in std::fs::read_dir(&nodes).unwrap().filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().join(PACK_FAILED).is_file() { bad.push(name) } else { ok.push(name) }
        }
        assert_eq!(ok, vec!["ComfyUI-GGUF".to_string()]);
        assert_eq!(bad, vec!["ComfyUI-MMAudio".to_string()]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The same agreement for the CATALOGUE's own directories, which is where
    /// it was actually broken.
    ///
    /// The test above covers `civitai.modelDir()` — the hub — and nothing
    /// covered `engineCatalog.ModelDir`, which is the union every first-run
    /// download is typed against. So `latent_upscale_models` could sit in
    /// `collect_weights` (planning to find LTX 2.5's x2 upsampler there) while
    /// `MODEL_DIRS` did not scan it and `engine_model_path` refused the write,
    /// and `unet_gguf` could sit in the union naming a directory Rust has
    /// never accepted. Neither shows up in a build: a `dir` typechecks against
    /// the union and is refused three layers later, at the moment somebody
    /// presses Get.
    ///
    /// One direction only. `MODEL_DIRS` legitimately holds `embeddings` and
    /// `controlnet`, which no catalogue entry names — the hub writes those.
    #[test]
    fn every_directory_the_catalogue_names_is_one_we_accept() {
        let src = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/engineCatalog.ts"),
        )
        .expect("engineCatalog.ts should be readable from the crate root");
        let src = src.replace("\r\n", "\n");
        let body = src
            .split_once("export type ModelDir =")
            .expect("ModelDir is gone — did it move or get renamed?")
            .1;
        // The union ends at its semicolon; comments inside it carry quoted
        // directory names of their own, so they are dropped line by line.
        let body = body.split_once(';').expect("unterminated ModelDir union").0;

        let mut seen = 0;
        for line in body.lines() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for dir in line.split('"').skip(1).step_by(2) {
                seen += 1;
                assert!(
                    model_dir_kind(dir).is_ok(),
                    "engineCatalog names dir {dir:?}, which engine_model_path refuses — \
                     the Get button would answer 'unknown model directory'",
                );
                assert!(
                    MODEL_DIRS.contains(&model_dir_kind(dir).unwrap()),
                    "{dir:?} is accepted but not in MODEL_DIRS, so a file downloaded \
                     there would never appear in engine_status.files and the model \
                     would read as permanently uninstalled",
                );
            }
        }
        assert!(seen >= 6, "only found {seen} directories — did the parse break?");
    }

    #[test]
    fn an_unknown_directory_is_still_refused_rather_than_defaulted() {
        assert!(model_dir_kind("../../etc").is_err());
        assert!(model_dir_kind("").is_err());
    }

    #[test]
    fn the_python_path_matches_what_the_standalone_tarball_unpacks() {
        // python-build-standalone puts the interpreter at python/bin/python3
        // on unix; getting this wrong makes a perfectly good install report
        // itself as absent.
        let p = python_bin(Path::new("/root"));
        #[cfg(not(target_os = "windows"))]
        assert!(p.ends_with("python/bin/python3"), "{p:?}");
        #[cfg(target_os = "windows")]
        assert!(p.ends_with("python\\python.exe"), "{p:?}");
    }
    // ── the PATH a child of ours runs with ─────────────────────────────────
    //
    // Every one of these is a silent failure when wrong: the wrong ORDER
    // switches a working render to a different ffmpeg without saying so, and
    // a missing entry is the "install ffmpeg" refusal on a machine that has
    // one.

    #[test]
    fn our_bin_directory_goes_last_so_a_users_own_ffmpeg_still_wins() {
        let out = compose_path("/usr/bin:/bin", &["/opt/homebrew/bin", "/app/bin"], ':');
        assert_eq!(out, "/usr/bin:/bin:/opt/homebrew/bin:/app/bin");
        let parts: Vec<&str> = out.split(':').collect();
        assert_eq!(*parts.last().unwrap(), "/app/bin",
                   "ours must be the FALLBACK — putting it first silently \
                    replaces a working system ffmpeg");
    }

    #[test]
    fn a_directory_already_on_the_path_is_not_added_twice() {
        // A developer's shell already exports /opt/homebrew/bin. Appending it
        // again would not break anything, but the FIRST occurrence is the one
        // that wins, so the dedupe has to keep that one.
        let out = compose_path("/opt/homebrew/bin:/usr/bin", &["/opt/homebrew/bin", "/app/bin"], ':');
        assert_eq!(out, "/opt/homebrew/bin:/usr/bin:/app/bin");
    }

    #[test]
    fn an_empty_inherited_path_is_the_gui_launch_case_and_still_works() {
        // launchctl getenv PATH is EMPTY on a Finder-launched app — measured.
        // Empty segments must not become "" entries, which some shells read
        // as the current directory.
        let out = compose_path("", &["/opt/homebrew/bin", "/app/bin"], ':');
        assert_eq!(out, "/opt/homebrew/bin:/app/bin");
        assert!(!out.split(':').any(|p| p.is_empty()));
    }

    #[test]
    fn the_separator_is_the_platforms_own() {
        assert_eq!(compose_path("C:\\w", &["C:\\app"], ';'), "C:\\w;C:\\app");
    }

    #[test]
    fn this_platform_has_a_prebuilt_ffmpeg_to_offer() {
        // If this ever fails on a target we ship, the utilities install would
        // refuse with "no prebuilt ffmpeg for this platform" — which is the
        // honest answer, but we should know about it at build time.
        assert!(ff_asset_suffix().is_some(),
                "no ffmpeg asset mapped for this target");
    }

    #[test]
    fn on_path_looks_for_the_executable_name_this_platform_uses() {
        let dir = std::env::temp_dir().join("qamba-onpath-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.to_string_lossy().into_owned();
        assert!(!on_path(&p, "ffmpeg"));
        std::fs::write(dir.join(exe_name("ffmpeg")), b"#!/bin/sh\n").unwrap();
        assert!(on_path(&p, "ffmpeg"), "a file named {} was not found", exe_name("ffmpeg"));
        // ffprobe is a SEPARATE download, and half an install is the
        // confusing half — the status must not report ready on one of them.
        assert!(!on_path(&p, "ffprobe"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_ffmpeg_url_is_the_one_that_was_probed() {
        // A typo in the base or the tag is a 404 that surfaces only on a
        // user's machine, mid-install. This is the literal that answered 200
        // for all ten assets on 2026-08-31.
        let sfx = ff_asset_suffix().expect("no asset for this target");
        let url = format!("{FFMPEG_BASE}/{FFMPEG_TAG}/ffmpeg-{sfx}");
        assert!(url.starts_with(
            "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-"),
            "{url}");
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        assert_eq!(url, "https://github.com/eugeneware/ffmpeg-static/releases/\
                         download/b6.1.1/ffmpeg-darwin-arm64");
    }

    #[test]
    fn the_tools_directory_sits_beside_the_engines_python() {
        // Under the engine root, so uninstalling the engine takes ffmpeg with
        // it rather than leaving 90MB behind.
        assert_eq!(tools_dir(Path::new("/root")), Path::new("/root/bin"));
    }
}
