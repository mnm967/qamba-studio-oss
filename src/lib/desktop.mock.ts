// A fake `window.__TAURI__`, for testing the desktop UI in a browser.
//
// WHY THIS EXISTS. Tauri's own WebDriver harness (`tauri-driver`) does not
// support macOS — its README lists macOS as "[Todo] … (probably)", because
// nothing can attach a WebDriver to an arbitrary app's WKWebView. So the
// native window cannot be automated here at all, and screenshot-plus-click
// needs assistive access and fights the user for the pointer.
//
// The way out is that the desktop app IS the web app: the same React tree,
// behind one global object. Fake the global and every desktop-only screen
// becomes testable in an ordinary browser tab — with a real DOM, real devtools
// and Playwright — in milliseconds instead of a two-minute Rust build.
//
// WHAT THIS IS NOT. It is not a substitute for running the real thing. The
// bridge itself (IPC, the CORS-free fetch, the capability allow-list) can only
// be proven in the real window, and was. This mocks the FAR SIDE of that
// bridge so the UI in front of it can be exercised: hardware that this machine
// does not have, an engine mid-install, a download at 40%.
//
// It is dev-only twice over: the module is imported behind `import.meta.env.DEV`
// and it refuses to install without an explicit `?desktop=` in the URL. A
// production bundle must never be able to pretend it is the desktop app.

import type { HardwareProfile } from "./desktop.ts";

/** Machines worth testing the recommender against, including this one. */
export const MOCK_MACHINES: Record<string, HardwareProfile> = {
  m3air: {
    os: "Darwin 26.5.1", arch: "aarch64", cpu: "Apple M3", cores: 8,
    ram_mb: 16_384, free_disk_mb: 118_591,
    gpus: [{ name: "Apple M3", vendor: "apple", vram_mb: 16_384, unified: true }],
    comfy_paths: [],
  },
  m3max: {
    os: "Darwin 26.5.1", arch: "aarch64", cpu: "Apple M3 Max", cores: 16,
    ram_mb: 131_072, free_disk_mb: 900_000,
    gpus: [{ name: "Apple M3 Max", vendor: "apple", vram_mb: 131_072, unified: true }],
    comfy_paths: ["/Users/you/ComfyUI"],
  },
  rtx4090: {
    os: "Windows 11", arch: "x86_64", cpu: "AMD Ryzen 9 7950X", cores: 32,
    ram_mb: 65_536, free_disk_mb: 1_400_000,
    gpus: [{ name: "NVIDIA GeForce RTX 4090", vendor: "nvidia", vram_mb: 24_564, unified: false }],
    comfy_paths: ["C:\\ComfyUI"],
  },
  rtx4070ti: {
    os: "Windows 11", arch: "x86_64", cpu: "Intel Core i7-13700K", cores: 24,
    ram_mb: 32_768, free_disk_mb: 400_000,
    gpus: [{ name: "NVIDIA GeForce RTX 4070 Ti", vendor: "nvidia", vram_mb: 12_282, unified: false }],
    comfy_paths: [],
  },
  headless: {
    os: "Ubuntu 24.04", arch: "x86_64", cpu: "Intel Xeon", cores: 4,
    ram_mb: 8_192, free_disk_mb: 20_000, gpus: [], comfy_paths: [],
  },
};

export type EngineState = "absent" | "installed" | "running";

interface MockOpts {
  /** "", "free", "pro", "studio", or "grace"/"expired"/"invalid" for the
   *  states the copy has to distinguish. */
  plan?: string;
  machine: keyof typeof MOCK_MACHINES;
  engine: EngineState;
  /** how long a mocked install step takes, ms — 0 makes install instant */
  stepMs: number;
  checkpoints: string[];
  loras: string[];
  /** `?breeze=` — absent | half | installed | starting | running | foreign.
   *  `foreign` is the one worth reaching for: something else is already on
   *  :7860, which is the state where the card must offer NOTHING and say
   *  whose server it is. `half` is an interrupted install. */
  breeze: string;
  /** `?qwen=` — absent | half | installed | starting | running | foreign.
   *  The SECOND local voice engine and the states are Breeze's, because the
   *  Speech tab shows the two side by side and a reviewer has to be able to
   *  put them in different states at once. */
  qwen: string;
  /** `?mmaudio=1` — the four MMAudio files on disk and both of its node
   *  packs installed, i.e. the state where the row renders HERE. `broken`
   *  puts the MMAudio pack in `nodes_broken` instead, which is the state
   *  pinning creates and the one whose sentence differs. */
  mmaudio: "" | "1" | "broken";
  /** `?ollama=` — absent | installed | running | old | oldfixed | ready.
   *  `old` is the one worth reaching for: the user's OWN daemon answering,
   *  too old for the qwen3.8 renderer — the state whose failure is silent on
   *  a real machine, and the one measured on this developer's Mac (0.23.2).
   *  `oldfixed` is the step after pressing Update: a current binary on disk
   *  with theirs still holding the port. */
  ollama: "absent" | "installed" | "running" | "old" | "oldfixed" | "ready";
  /** `?byok=openai,fal` — which providers already have a key stored. The
   *  interesting states are none (the empty tab), one (a model list that is
   *  only that provider's) and fal (the only provider whose list is
   *  user-added, so its "add a model" path is reachable). */
  byokKeys: string[];
  /** `?byokreject=openai` — a stored key the provider refuses. The state a
   *  rotated or revoked key is in, and the one whose copy has to distinguish
   *  "saved" from "working". */
  byokReject: string | null;
  /** `?byokorphan=fal` — the index has a key and the keychain does not, which
   *  is what deleting it in Keychain Access leaves behind. */
  byokOrphan: string | null;
  /** `?sheets=ready|missing|unknown|none` — what `desktop_render_models`
   *  answers for the IMAGE table, i.e. whether this machine can draw a
   *  reference sheet. `unknown` is the vacuous state: not ready and nothing to
   *  name, which must read as the studio's rather than as a download. */
  sheets: "ready" | "missing" | "unknown" | "none";
  /** `?planner=1` — this machine can run the staged planner itself (the engine
   *  Python is installed and the pipeline source is bundled). What it changes
   *  is where the wizard QUEUES the plan, and what step 4 says still needs the
   *  pod. */
  planner: boolean;
  /** "" (none), "system" (theirs, already on PATH) or "ours" (we installed it) */
  ffmpeg: string;
  /** `?comfy=/path/to/ComfyUI` — the weight catalogue pointed at the user's
   *  OWN ComfyUI. The state worth reviewing: `installed: false` (we did not
   *  build it, so Start/Stop and the install steps stay off) beside a full
   *  model tree and WORKING Get buttons. Those two used to be one flag, so
   *  this machine's tab was entirely dead. */
  comfy: string | null;
  /** `?pickdir=/some/path` — what the native folder picker hands back. Unset
   *  is a CANCEL, the outcome that has to leave everything as it was. */
  pickDir: string | null;
  /** `?comfysaved=Name` — a workflow already sitting in ComfyUI's folder that
   *  this app did NOT stage, i.e. one the user made there. */
  comfySaved: string | null;
}

type Handler = (payload: unknown) => void;

/**
 * Install the fake bridge. Returns false when it declines (production, or no
 * `?desktop=` asked for it), so a caller can log the reason.
 */
export function installDesktopMock(search = window.location.search): boolean {
  if (!import.meta.env.DEV) return false;
  const q = new URLSearchParams(search);
  const machine = q.get("desktop");
  if (!machine) return false;
  if (window.__TAURI__) return false;          // never shadow the real thing

  const opts: MockOpts = {
    machine: (machine in MOCK_MACHINES ? machine : "m3air") as keyof typeof MOCK_MACHINES,
    engine: (q.get("engine") as EngineState) || "absent",
    mmaudio: (q.get("mmaudio") as "" | "1" | "broken") ?? "",
    breeze: q.get("breeze") ?? "absent",
    qwen: q.get("qwen") ?? "absent",
    stepMs: Number(q.get("stepms") ?? 700),
    // A LINKED ComfyUI has weights while our engine is absent — the whole
    // point of the state — so `comfy` overrides the "absent means empty" rule.
    checkpoints: q.get("engine") === "absent" && !q.get("comfy") ? []
      : (q.get("checkpoints") ?? "v1-5-pruned-emaonly.safetensors").split(",").filter(Boolean),
    loras: (q.get("loras") ?? "").split(",").filter(Boolean),
    ollama: (q.get("ollama") as MockOpts["ollama"]) || "absent",
    byokKeys: (q.get("byok") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    byokReject: q.get("byokreject"),
    byokOrphan: q.get("byokorphan"),
    sheets: (q.get("sheets") as MockOpts["sheets"]) ?? "ready",
    planner: q.get("planner") === "1",
    // `?ffmpeg=system` is the case worth reviewing: a machine that HAS one, so
    // the utilities install skips a 90MB download and the copy has to say so
    // rather than claiming it installed something.
    ffmpeg: q.get("ffmpeg") ?? "",
    comfy: q.get("comfy"),
    pickDir: q.get("pickdir"),
    comfySaved: q.get("comfysaved"),
  };

  const listeners = new Map<string, Set<Handler>>();
  const emit = (event: string, payload: unknown) =>
    listeners.get(event)?.forEach((h) => h(payload));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let engine = opts.engine;
  let linkedComfy = opts.comfy;
  /** Every ComfyUI window the app asked for. A window is the one thing a
   *  browser harness genuinely cannot show, so the review has to be able to
   *  ask what was REQUESTED — mirrored onto `window.__qambaComfyWindows`. */
  const comfyWindows: string[] = [];
  /** Workflows staged for ComfyUI's browser — `{file, json}`, mirrored onto
   *  `window.__qambaStagedWorkflows` so a harness can read what was written. */
  const staged: { file: string; json: string; at: number }[] = [];
  // `?comfysaved=Name` seeds a workflow as though the user had built and saved
  // it in ComfyUI — the state the import offer exists for, and the one this
  // session cannot reach by staging (which only ever writes "Qamba - " files).
  if (opts.comfySaved) {
    staged.push({
      file: `${opts.comfySaved}.json`, at: Date.now() - 60000,
      json: JSON.stringify({
        nodes: [{ id: 1, type: "CheckpointLoaderSimple", pos: [0, 0],
                  widgets_values: ["v1-5-pruned-emaonly.safetensors"],
                  outputs: [{ name: "MODEL", type: "MODEL", links: [] }] }],
        links: [], groups: [], extra: {},
      }),
    });
  }
  const checkpoints = [...opts.checkpoints];
  const loras = [...opts.loras];
  /** half-finished downloads on "disk", by final filename — what makes the
   *  Resume affordance reviewable without a real interrupted 6GB fetch.
   *  `?partial=<file>:<mb>` seeds one. */
  const partials: Record<string, number> = Object.fromEntries(
    (q.get("partial") ?? "").split(",").filter(Boolean).map((p) => {
      const [name, mb] = p.split(":");
      return [name, Number(mb) || 512];
    }));
  /** the `.owner` sidecar Rust writes beside a `.part` — `?partialowner=file:key` */
  const partialOwners: Record<string, string> = Object.fromEntries(
    (q.get("partialowner") ?? "").split(",").filter(Boolean).map((p) => {
      const i = p.indexOf(":");
      return [p.slice(0, i), p.slice(i + 1)];
    }));
  /** in-flight downloads, keyed by filename — mirrors Rust's `Downloads` */
  const active = new Map<string, {
    id: string; received: number; total: number; dest: string; owner: string | null;
  }>();

  // Plausible sizes for the mocked files, because the compatibility check is
  // arithmetic on bytes and a mock that reports none exercises only the
  // "unknown size" path — i.e. exactly the branch that hides a bug.
  const MOCK_MB: Record<string, number> = {
    "v1-5-pruned-emaonly.safetensors": 4_060,
    "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors": 14_900,
    "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors": 14_900,
    "umt5_xxl_fp8_e4m3fn_scaled.safetensors": 6_400,
    "wan_2.1_vae.safetensors": 254,
    "wan2.2_vae.safetensors": 1344,
  };

  let ffmpeg = opts.ffmpeg !== "";
  let ffmpegOurs = opts.ffmpeg === "ours";
  const planner = opts.planner;

  const status = () => {
    // MMAudio's four, in the one directory its pack registers. Named here
    // rather than passed through `?checkpoints=` because they are a SET —
    // "installed" is a question about all four, and a URL listing them is
    // unreadable.
    const MMAUDIO_FILES = opts.mmaudio ? [
      "mmaudio_large_44k_v2_fp16.safetensors",
      "apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors",
      "mmaudio_vae_44k_fp16.safetensors",
      "mmaudio_synchformer_fp16.safetensors",
    ] : [];
    const files = [...checkpoints, ...loras, ...MMAUDIO_FILES];
    return {
      installed: engine !== "absent",
      python: engine !== "absent" ? "/mock/engine/python/bin/python3" : null,
      comfy_dir: engine !== "absent" ? "/mock/engine/ComfyUI" : null,
      root: "/mock/engine",
      checkpoints: [...checkpoints],
      loras: [...loras],
      files,
      by_dir: {
        checkpoints: checkpoints.filter((f) => !/lora/i.test(f)),
        diffusion_models: checkpoints.filter((f) => /\.gguf$/i.test(f)),
        loras: [...loras],
        mmaudio: [...MMAUDIO_FILES],
      },
      file_mb: Object.fromEntries(files.map((f) => [f, MOCK_MB[f] ?? 2_048])),
      partial_mb: { ...partials },
      partial_owner: { ...partialOwners },
      nodes: engine === "absent" && !linkedComfy ? []
        : ["ComfyUI-GGUF",
           // Both MMAudio packs, unless the harness is showing the
           // dependencies-refused state — where the directory is on disk and
           // excluded from `nodes`, which is what `nodes_broken` reports.
           ...(opts.mmaudio === "1" ? ["ComfyUI-MMAudio", "ComfyUI-VideoHelperSuite"]
             : opts.mmaudio === "broken" ? ["ComfyUI-VideoHelperSuite"] : [])],
      nodes_broken: opts.mmaudio === "broken" ? ["ComfyUI-MMAudio"] : [],
      running: engine === "running",
      port: 8188,
      models_dir: linkedComfy ?? "/mock/engine/ComfyUI",
      models_linked: !!linkedComfy,
      planner: engine !== "absent" || planner,
      ffmpeg,
      ffmpeg_ours: ffmpegOurs,
    };
  };

  /**
   * A LOCAL PROJECT'S DISK, in `sessionStorage`.
   *
   * The local plane is the one desktop feature whose interesting behaviour is
   * NOT about hardware: a project's rows survive a reload, the media resolves
   * to a URL, and the projects list shows both planes at once. All three are
   * reviewable in a browser tab if the far side of `local_store_*` keeps
   * something between calls — so it does, per tab, and `?desktop=…` is still
   * what turns any of it on. Media bytes are held as data URLs, which is also
   * what `convertFileSrc` returns here: the real asset protocol streams from
   * disk and a browser tab has no disk to stream from.
   */
  const LS_ROWS = "qamba.mock.local.rows";
  const LS_MEDIA = "qamba.mock.local.media";
  const readMap = (k: string): Record<string, string> => {
    try { return JSON.parse(sessionStorage.getItem(k) ?? "{}"); } catch { return {}; }
  };
  const writeMap = (k: string, v: Record<string, string>) =>
    sessionStorage.setItem(k, JSON.stringify(v));
  const mediaKey = (p: unknown, k: unknown) => `${String(p)}/${String(k)}`;

  /* ── the local LLM daemon ──────────────────────────────────────────────
     Mirrors src-tauri/src/ollama.rs closely enough that the section's states
     are reviewable in a browser: the real thing cannot be driven from one,
     and "an old daemon blocks every row" is a claim about a screen. */
  let ollamaState = opts.ollama;
  /** In-flight installs and pulls, keyed like the Rust registry: "" is the
   *  daemon, a tag is a pull. Lives OUTSIDE the React tree on purpose — the
   *  bug this reproduces is a screen unmounting while the work continues. */
  const ollamaJobs = new Map<string, { label: string; pct: number; detail: string; model: string }>();
  const ollamaModels: { name: string; size_mb: number }[] =
    opts.ollama === "ready" ? [{ name: "huihui_ai/qwen3-abliterated:8b", size_mb: 5000 }] : [];
  const ollamaStatusOf = () => {
    const foreign = ollamaState === "old" || ollamaState === "oldfixed";
    const reachable = foreign || ollamaState === "running" || ollamaState === "ready";
    // A foreign daemon is the USER's, at their version; ours is the pinned one.
    const version = foreign ? "0.23.2" : ollamaState === "absent" ? null : "0.32.15";
    const bundled = ollamaState !== "absent" && ollamaState !== "old";
    return {
      bundled,
      bundled_version: bundled ? "0.32.15" : null,
      bundled_version_ok: bundled,
      bin: bundled ? "/mock/appdata/engine/ollama/bin/ollama" : null,
      reachable, ours: reachable && !foreign, foreign,
      version, version_ok: version === "0.32.15",
      min_version: "0.32.12",
      models: [...ollamaModels],
      port: 11434, root: "/mock/appdata/engine/ollama",
    };
  };

  /** Fixed so a screenshot of this screen is the same screenshot tomorrow —
   *  `new Date()` in a fixture is a diff on every run. 2026-08-01. */
  const BYOK_SET_AT = 1785542400;
  const byokKeys = new Map<string, string>(
    (opts.byokKeys ?? []).map((p) => [p, `sk-mock-${p}-0000${p.slice(0, 4)}`]));
  const byokAccount = new Map<string, string>();

  const commands: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    detect_hardware: async () => MOCK_MACHINES[opts.machine],

    /* ── BYOK ──────────────────────────────────────────────────────────
     *
     * The mock holds VALUES, which the real bridge deliberately cannot — see
     * `secrets.rs`. That is safe here and nowhere else: this store is a
     * module-level Map in a dev-only file, it never touches a keychain, and
     * `byok_fetch` below refuses to make a real request at all. Faking the
     * transport is the point: the keys tab's own failure modes are a wrong
     * tail, a stale "verify" state and a model list that does not follow the
     * key set, and none of those needs a provider to reproduce. */
    byok_status: async () => [...byokKeys.entries()].map(([provider, v]) => ({
      provider, present: true, tail: v.slice(-4), set_at: BYOK_SET_AT,
      account: byokAccount.get(provider) ?? null,
      orphaned: provider === opts.byokOrphan,
    })),
    byok_set: async (a) => {
      const provider = String(a.provider);
      const value = String(a.value ?? "").trim();
      if (!value) throw new Error("that key is empty");
      byokKeys.set(provider, value);
      return { provider, present: true, tail: value.slice(-4), set_at: BYOK_SET_AT,
               account: null, orphaned: false };
    },
    byok_delete: async (a) => {
      byokKeys.delete(String(a.provider));
      byokAccount.delete(String(a.provider));
      return null;
    },
    byok_note_account: async (a) => {
      const provider = String(a.provider);
      if (a.account) byokAccount.set(provider, String(a.account));
      else byokAccount.delete(provider);
      return null;
    },
    byok_fetch: async (a) => {
      // NEVER a real request. A harness that could spend a real key would make
      // opening a review screen cost money — the same rule `/ui/blockaudio`
      // follows by refusing to queue.
      await sleep(opts.stepMs / 2);
      const provider = String(a.provider);
      if (!byokKeys.has(provider)) throw new Error(`no ${provider} key is stored on this machine`);
      if (opts.byokReject === provider) {
        return { ok: false, status: 401, headers: {},
                 body: JSON.stringify({ error: { message: "Incorrect API key provided." } }) };
      }
      return { ok: true, status: 200, headers: {},
               body: JSON.stringify({ data: [], models: [{ name: "a" }, { name: "b" }] }) };
    },

    /* ── the desktop planner ───────────────────────────────────────────
     * `?planner=1` says this machine could run a plan. It never RUNS one:
     * `plan_run` spawns real Python against real Supabase and writes a real
     * storyboard, which a review screen must not be able to do by being
     * opened — the same rule `byok_fetch` and `/ui/blockaudio` follow. */
    // AGREES WITH `engine_status.planner`, which it did not: an installed
    // engine reported `planner: true` on the status and `false` here, so
    // anything gated on the pipeline (a bundled-pipeline model row) read as
    // blocked on a machine the same status said was ready. The real pair are
    // both true on an installed build — `planner_ready` merely asks the
    // stricter question (the Python AND the bundled source).
    /* ── Breeze TTS 2, the second daemon ─────────────────────────────── */
    breeze_status: async () => {
      const b = opts.breeze;
      const total = 7328;   // MiB, the hub's own figure
      const half = b === "half";
      const installed = ["installed", "starting", "running"].includes(b);
      return {
        installed, code: installed || half, venv: installed || half,
        weights_mb: installed ? total : half ? 6000 : 0,
        weights_total_mb: total,
        // Named, never counted: "download it again" is not actionable when
        // eleven of twelve already landed. `absent` is all twelve.
        weights_missing: installed ? []
          : half ? ["model-00002-of-00002.safetensors"]
          : ["config.json", "generation_config.json", "model.safetensors.index.json",
             "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json",
             "model-00001-of-00002.safetensors", "model-00002-of-00002.safetensors",
             "audio_tokenizer/config.json", "audio_tokenizer/configuration.json",
             "audio_tokenizer/preprocessor_config.json",
             "audio_tokenizer/model.safetensors"],
        reachable: b === "running" || b === "foreign",
        ours: b === "running",
        starting: b === "starting",
        foreign: b === "foreign",
        device: installed ? "mps" : null,
        rev: "d76819fa9c04", port: 7860, root: "/mock/engine/breeze",
        license: "BreezeBlue Research — non-commercial, weights and outputs",
      };
    },
    breeze_active: async () => [],
    install_breeze: async () => {
      for (const [label, detail] of [
        ["Downloading Breeze TTS 2", "the inference server"],
        ["Creating the Breeze environment", ""],
        ["Installing Breeze dependencies", "a few minutes"],
        ["Downloading the voice weights", "7.7GB"],
        ["Breeze TTS 2 ready", "mps"],
      ] as const) {
        emit("breeze://progress", { label, pct: -1, detail, key: "" });
        await sleep(opts.stepMs);
      }
      opts.breeze = "installed";
    },
    start_breeze: async () => { opts.breeze = "running"; },
    stop_breeze: async () => { opts.breeze = "installed"; },
    breeze_park: async () => { opts.breeze = "installed"; return true; },
    breeze_ensure_up: async () => { opts.breeze = "running"; return true; },
    /* ── Qwen3-TTS, the second voice engine ──────────────────────────── */
    qwen_status: async () => {
      const b = opts.qwen;
      // Both checkpoints: 4419 + 4452 MiB, the hub's own figures.
      const total = 8871;
      const half = b === "half";
      const installed = ["installed", "starting", "running"].includes(b);
      return {
        installed, venv: installed || half,
        // HALF is the ONE checkpoint state, which is this engine's own
        // failure mode: a build that stopped after VoiceDesign can design a
        // voice and cannot speak a second line in it.
        weights_mb: installed ? total : half ? 4419 : 0,
        weights_total_mb: total,
        weights_missing: installed ? []
          : half ? ["qwen3-tts-base/model.safetensors",
                    "qwen3-tts-base/speech_tokenizer/model.safetensors"]
          : Array.from({ length: 22 }, (_, i) =>
              `${i < 11 ? "qwen3-tts-voicedesign" : "qwen3-tts-base"}/file${i}`),
        reachable: b === "running" || b === "foreign",
        ours: b === "running",
        starting: b === "starting",
        foreign: b === "foreign",
        device: installed ? "mps" : null,
        port: 7870, root: "/mock/engine/qwen-tts",
        license: "Apache 2.0 — weights and code, no usage restriction",
        supports_direction: false,
      };
    },
    qwen_active: async () => [],
    install_qwen: async () => {
      for (const [label, detail] of [
        ["Creating the Qwen3-TTS environment", ""],
        ["Installing Qwen3-TTS dependencies", "a few minutes"],
        ["Downloading the voice weights", "4.3 GiB from the studio's mirror"],
        ["Downloading the voice weights", "4.3 GiB from the studio's mirror"],
        ["Qwen3-TTS ready", "mps"],
      ] as const) {
        emit("qwen://progress", { label, pct: -1, detail, key: "" });
        await sleep(opts.stepMs);
      }
      opts.qwen = "installed";
    },
    start_qwen: async () => { opts.qwen = "running"; },
    stop_qwen: async () => { opts.qwen = "installed"; },
    qwen_park: async () => { opts.qwen = "installed"; return true; },
    qwen_ensure_up: async () => { opts.qwen = "running"; return true; },
    planner_ready: async () => opts.engine !== "absent" || opts.planner,
    // The MODEL MAP's view, which is a different question from `engine_status`
    // and the one the sheet pickers ask: which entries this build carries and
    // whether their weights are down. `?sheets=ready|missing|none` — `none` is
    // the web build and a map with the section pruned away, which are the same
    // answer from a picker's point of view (no local tier at all).
    desktop_render_models: async () => {
      if (opts.sheets === "none") return [];
      // `unknown` is the VACUOUS state — not ready and nothing to name, i.e.
      // an entry whose weights the file scan cannot see at all. It has to read
      // as the studio's rather than as a download, and it is how SenseNova
      // came to be offered under "on this machine" on a laptop with none of
      // it. `missing` decides: empty means "cannot be judged".
      const ready = opts.sheets === "ready";
      const missing = (key: string) =>
        ready || opts.sheets === "unknown" ? [] : [`${key}.safetensors`];
      // Real keys off `model_map.desktop.json`, so the harness cannot suggest
      // a local option the shipped map does not carry.
      return [
        { key: "minimax-h3", kind: "video", modes: ["i2v", "r2v"],
          ready, missing: missing("minimax-h3") },
        ...["qwen-edit", "anima-29b", "h3-image"].map((key) => ({
          key, kind: "image", modes: ["t2i"], ready, missing: missing(key),
        })),
      ];
    },

    ollama_status: async () => ollamaStatusOf(),
    ollama_active: async () => [...ollamaJobs.values()],
    install_ollama: async () => {
      if (ollamaJobs.has("")) throw new Error("Ollama is already being installed");
      for (let i = 1; i <= 4 && opts.stepMs; i++) {
        const p = { label: "Downloading Ollama", pct: i / 4, detail: `${i * 40} MB`, model: "" };
        ollamaJobs.set("", p);
        emit("ollama://progress", p);
        await sleep(opts.stepMs / 2);
      }
      ollamaJobs.delete("");
      // Installing ours does NOT evict a daemon the user is running — that is
      // the whole point of `oldfixed`, and mocking it as a clean win would
      // hide the one thing the screen has to explain.
      ollamaState = ollamaState === "old" ? "oldfixed" : "installed";
      return ollamaStatusOf();
    },
    start_ollama: async () => { await sleep(opts.stepMs); ollamaState = "running"; return ollamaStatusOf(); },
    stop_ollama: async () => { ollamaState = "installed"; return ollamaStatusOf(); },
    ollama_pull: async (a) => {
      const model = String(a.model);
      if (ollamaJobs.has(model)) throw new Error(`${model} is already downloading`);
      for (let i = 1; i <= 5 && opts.stepMs; i++) {
        const p = { label: "pulling", pct: i / 5, detail: `${(i * 3.5).toFixed(1)} / 17.7 GB`, model };
        ollamaJobs.set(model, p);
        emit("ollama://progress", p);
        await sleep(opts.stepMs / 2);
      }
      ollamaJobs.delete(model);
      ollamaModels.push({ name: model, size_mb: 17_700 });
      emit("ollama://progress", { label: "ready", pct: 1, detail: "", model });
      return null;
    },
    ollama_remove: async (a) => {
      const i = ollamaModels.findIndex((m) => m.name === String(a.model));
      if (i >= 0) ollamaModels.splice(i, 1);
      return null;
    },
    // No model to run, so it says what it is rather than inventing a rewrite —
    // a mock that fakes model OUTPUT is a mock that can hide a broken prompt.
    ollama_chat: async () => "[mock desktop] no local model — this is the bridge, not a rewrite",

    app_data_dir: async () => "/mock/appdata",

    local_store_root: async () => "/mock/appdata/local",
    local_store_list: async () => Object.entries(readMap(LS_ROWS)).map(([id, json]) => ({
      id, json, media_bytes: Object.entries(readMap(LS_MEDIA))
        .filter(([k]) => k.startsWith(`${id}/`))
        .reduce((n, [, v]) => n + Math.round((v.length * 3) / 4), 0),
    })),
    local_store_save: async (a) => {
      // Sent as a RAW BODY with its project id in a header (see `invokeBytes`),
      // which the dispatch below flattens back into these two names.
      const all = readMap(LS_ROWS);
      all[String(a["qamba-project"])] = String(a.body);
      writeMap(LS_ROWS, all);
    },

    // No loopback server in a browser tab, and NULL is the honest answer
    // rather than an invented origin: `localMediaUrl` falls back to
    // `convertFileSrc`, which this bridge answers with the data URL it is
    // holding — so the harness keeps rendering local media.
    local_media_origin: async () => null,
    local_store_delete: async (a) => {
      const all = readMap(LS_ROWS);
      delete all[String(a.projectId)];
      writeMap(LS_ROWS, all);
      const media = readMap(LS_MEDIA);
      for (const k of Object.keys(media)) {
        if (k.startsWith(`${String(a.projectId)}/`)) delete media[k];
      }
      writeMap(LS_MEDIA, media);
    },
    local_media_write: async (a) => {
      const media = readMap(LS_MEDIA);
      const k = mediaKey(a.projectId, a.key);
      media[k] = a.append ? (media[k] ?? "") + String(a.data) : String(a.data);
      writeMap(LS_MEDIA, media);
      return Math.round((media[k].length * 3) / 4);
    },
    local_media_delete: async (a) => {
      const media = readMap(LS_MEDIA);
      let gone = 0;
      for (const key of (a.keys as string[]) ?? []) {
        if (media[mediaKey(a.projectId, key)]) { delete media[mediaKey(a.projectId, key)]; gone++; }
      }
      writeMap(LS_MEDIA, media);
      return gone;
    },
    local_media_exists: async (a) => !!readMap(LS_MEDIA)[mediaKey(a.projectId, a.key)],
    // What the plane's present-set is seeded from. Relative keys, exactly as
    // the Rust walk returns them — a key here and absent from this list is
    // the CDN-fallthrough state /ui/local reviews.
    local_media_list: async (a) =>
      Object.keys(readMap(LS_MEDIA))
        .filter((k) => k.startsWith(`${String(a.projectId)}/`))
        .map((k) => k.slice(String(a.projectId).length + 1)),
    local_media_usage: async (a) => {
      const files = Object.entries(readMap(LS_MEDIA)).filter(([k]) => k.startsWith(`${String(a.projectId)}/`));
      return { files: files.length, bytes: files.reduce((n, [, v]) => n + Math.round((v.length * 3) / 4), 0) };
    },
    // The two transfers are Rust-side streams with no browser equivalent. They
    // REFUSE rather than pretending: a mocked "upload" that reported success
    // would make a sync look verified when nothing left the machine.
    local_media_upload: async () => {
      throw new Error("mock: media upload needs the real desktop build");
    },
    local_media_download: async () => {
      throw new Error("mock: media download needs the real desktop build");
    },
    engine_status: async () => status(),
    engine_log: async () =>
      engine === "running"
        ? ["[INFO] Total VRAM 16384 MB, total RAM 16384 MB",
           "[INFO] pytorch version: 2.13.0", "[INFO] Device: mps",
           "[INFO] Starting server", "To see the GUI go to: http://127.0.0.1:8188"].join("\n")
        : "(engine not started)",
    engine_model_path: async (a) => `/mock/engine/ComfyUI/models/${a.kind}/${a.filename}`,

    // The light path: one step, and the harness has to show it landing on a
    // ready planner rather than a ready ENGINE — they are different states and
    // the wizard reads the first one.
    install_utilities: async () => {
      for (const label of ["Downloading Python", "Installing the planner's one dependency"]) {
        emit("engine://progress", { step: 1, label, pct: -1, detail: "" });
        await sleep(opts.stepMs);
      }
      // The ffmpeg step is a no-op on a machine that has one, and the harness
      // has to be able to show BOTH — a step that silently did nothing reads
      // as a broken button.
      const had = ffmpeg;
      emit("engine://progress", {
        step: 1, label: "Checking for ffmpeg", pct: -1,
        detail: had ? "already on this machine" : "fetching a static build",
      });
      await sleep(opts.stepMs);
      if (!had) { ffmpeg = true; ffmpegOurs = true; }
      emit("engine://progress", {
        step: 1, label: "Utilities ready", pct: 1,
        detail: `Python 3.12.14 · ffmpeg ${had ? "already installed" : "installed"}`,
      });
      return status();
    },

    install_engine: async () => {
      // The point of mocking this is the SHAPE of the progress, not its
      // duration: four steps, two of which have a measurable size and two of
      // which do not. That is what the UI has to render correctly.
      const steps: [number, string, boolean][] = [
        [1, "Downloading Python", true], [1, "Unpacking Python", false],
        [2, "Downloading ComfyUI", true], [2, "Unpacking ComfyUI", false],
        [3, "Installing PyTorch", false], [3, "Installing ComfyUI dependencies", false],
        [3, "Installing the GGUF loader", false],
      ];
      for (const [step, label, sized] of steps) {
        if (sized) {
          for (let p = 0; p <= 1.0001; p += 0.25) {
            emit("engine://progress", { step, label, pct: p, detail: `${Math.round(p * 120)} MB` });
            await sleep(opts.stepMs / 4);
          }
        } else {
          emit("engine://progress", { step, label, pct: -1, detail: "" });
          await sleep(opts.stepMs);
        }
      }
      emit("engine://progress",
        { step: 3, label: "Dependencies ready", pct: 1, detail: "2.13.0 True False" });
      engine = "installed";
      return status();
    },

    // `?pickdir=` is what the picker "returns"; unset means the user
    // CANCELLED, which is the outcome worth being able to review — it must
    // leave the current directory alone rather than clearing it.
    pick_comfy_dir: async () => opts.pickDir,
    // The real command opens a Tauri window at the engine. A mock cannot —
    // and MUST not reach the network either — so it records the call and
    // enforces the one rule that matters (loopback only), which is what a
    // review of the button is actually checking.
    // Records what WOULD be written, with the real command's name rule, so a
    // review can check the graph that was staged without a ComfyUI on the box.
    stage_comfy_workflow: async (args: Record<string, unknown>) => {
      const name = String(args.name ?? "").replace(/[^A-Za-z0-9 ._-]/g, "-").trim();
      if (!/[A-Za-z0-9]/.test(name)) throw new Error(`${args.name} is not a usable workflow name`);
      const file = `${name.replace(/\.json$/, "")}.json`;
      const json = String(args.json ?? "");
      // The rule that matters: an edited copy is KEPT, never overwritten.
      const had = staged.find((x) => x.file === file);
      if (had && had.json !== json && args.overwrite !== true) return { file, kept: true };
      if (had) { had.json = json; } else { staged.unshift({ file, json, at: Date.now() }); }
      (window as unknown as Record<string, unknown>).__qambaStagedWorkflows = staged;
      return { file, kept: false };
    },
    // The round trip's read side. `?comfysaved=name` seeds one as though
    // ComfyUI had written it, which is the state worth reviewing — the import
    // offer has to appear for a file this session never staged.
    list_staged_workflows: async () => staged.map((x) => ({
      file: x.file, modified_ms: x.at, bytes: x.json.length,
      ours: x.file.startsWith("Qamba - "),
    })),
    read_staged_workflow: async (args: Record<string, unknown>) => {
      const f = String(args.file ?? "");
      const hit = staged.find((x) => x.file === f);
      if (!hit) throw new Error(`could not read ${f}: no such file`);
      return hit.json;
    },
    open_comfy_window: async (args: Record<string, unknown>) => {
      const url = String(args.url ?? "http://127.0.0.1:8188");
      if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)) {
        throw new Error(`${url} is not this machine — only a local engine opens in a window`);
      }
      comfyWindows.push(args.workflow ? `${url}#${args.workflow}` : url);
      (window as unknown as Record<string, unknown>).__qambaComfyWindows = comfyWindows;
      return null;
    },
    set_linked_comfy: async (args: Record<string, unknown>) => {
      // The real command REFUSES a path that is not a ComfyUI, and the copy
      // around the control promises that — a mock that always accepts makes
      // the error state unreviewable.
      const d = String(args.dir ?? "").trim();
      if (d && !/comfy/i.test(d)) {
        throw new Error(`${d} does not look like a ComfyUI — expected main.py or a `
          + "models/ folder in it. Point at the ComfyUI directory itself, not at models/.");
      }
      linkedComfy = d || null;
      return linkedComfy ?? "/mock/engine/ComfyUI";
    },
    start_engine: async () => { await sleep(opts.stepMs); engine = "running"; return status(); },
    stop_engine: async () => { engine = "installed"; return status(); },

    // The registry the real Rust side keeps, so the harness can exercise
    // "reopen the modal mid-download" — the case the UI used to get wrong.
    active_downloads: async () => [...active.values()],

    download_model_file: async (a) => {
      const id = String(a.id ?? "dl");
      if (active.has(id)) throw new Error(`${id} is already downloading`);
      const total = 4_000_000_000;
      const owner = a.owner == null ? null : String(a.owner);
      active.set(id, { id, received: 0, total, dest: String(a.dest ?? ""), owner });
      try {
        for (let i = 0; i <= 10; i++) {
          const received = (total / 10) * i;
          active.set(id, { id, received, total, dest: String(a.dest ?? ""), owner });
          emit("download://progress", { id, received, total, done: i === 10 });
          await sleep(opts.stepMs / 3);
        }
      } finally {
        active.delete(id);
      }
      const name = String(a.dest ?? "").split("/").pop() ?? "model.safetensors";
      delete partials[name];
      (String(a.dest).includes("/loras/") ? loras : checkpoints).push(name);
      return a.dest;
    },
  };

  /** A stand-in ComfyUI, so the engine screen and the top-bar chip have
   *  something to talk to. Only answers when the mocked engine is running —
   *  "offline" is a state worth being able to see. */
  const comfy = (url: string): Response | null => {
    if (!url.includes(":8188")) return null;
    if (engine !== "running") throw new Error("mock: connection refused");
    // A REAL engine reports ~851 classes; a three-class stub is not a small
    // engine, it is a broken response, and the compatibility check now refuses
    // to trust one (MIN_PLAUSIBLE_CLASSES). Pad with core names so the mock
    // exercises the believable path — and so the harness stops accusing
    // CLIPTextEncode of being uninstalled.
    const core: Record<string, unknown> = {
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } },
      KSampler: { input: { required: {
        seed: ["INT", { control_after_generate: true }], steps: ["INT", {}] } } },
      SaveImage: { input: { required: { filename_prefix: ["STRING", {}] } } },
      UNETLoader: { input: { required: { unet_name: [checkpoints] } } },
      CLIPLoader: { input: { required: { clip_name: [checkpoints] } } },
      VAELoader: { input: { required: { vae_name: [checkpoints] } } },
      LoraLoaderModelOnly: { input: { required: { lora_name: [loras] } } },
    };
    for (const n of ["CLIPTextEncode", "EmptyLatentImage", "EmptyHunyuanLatentVideo",
                     "VAEDecode", "VAEEncode", "LoadImage", "PreviewImage", "ImageScale",
                     "ConditioningZeroOut", "KSamplerSelect", "BasicScheduler", "BasicGuider",
                     "SamplerCustomAdvanced", "ModelSamplingSD3", "CLIPSetLastLayer"]) {
      core[n] = { input: { required: {} } };
    }
    for (let i = 0; core.length === undefined && i < 60; i++) core[`CoreNode${i}`] = { input: {} };
    const body = url.includes("/object_info")
      ? core
      : { system: { comfyui_version: "0.33.0-mock", python_version: "3.12.14 (main)" },
          devices: [{ name: "mps", vram_total: 16 * 1024 ** 3, vram_free: 11 * 1024 ** 3 }] };
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };

  window.__TAURI__ = {
    // A FAKE BRIDGE MUST SAY SO. `http` below delegates to the browser, which
    // is subject to CORS where Rust is not — so anything reasoning about the
    // TRANSPORT rather than about "am I desktop" has to be able to tell the
    // difference. See `hasRustHttp` in desktop.ts.
    mock: true,
    core: {
      /** Tauri's own returns an `asset://` URL the webview can load; a browser
       *  tab has no such protocol, so the mocked "disk" hands back the data
       *  URL it is holding. Same contract — a string an `<img>` can use. */
      convertFileSrc: (path: string) => {
        const m = /\/mock\/appdata\/local\/([^/]+)\/media\/(.+)$/.exec(path);
        const data = m ? readMap(LS_MEDIA)[mediaKey(m[1], m[2])] : null;
        return data ? `data:application/octet-stream;base64,${data}` : path;
      },
      invoke: async (
        cmd: string,
        args?: Record<string, unknown> | Uint8Array,
        opts?: { headers?: Record<string, string> },
      ) => {
        const fn = commands[cmd];
        if (!fn) throw new Error(`mock: no such command '${cmd}'`);
        // A raw body arrives as bytes with its named values in headers. The
        // two are reassembled into the ONE argument shape every handler here
        // already takes, so a command that moved to bytes needs no second
        // implementation in the mock — and `body` names the bytes.
        if (ArrayBuffer.isView(args)) {
          return fn({
            ...(opts?.headers ?? {}),
            body: new TextDecoder().decode(args as Uint8Array),
          });
        }
        return fn(args ?? {});
      },
    },
    event: {
      listen: async (event: string, cb: (e: { payload: unknown }) => void) => {
        const set = listeners.get(event) ?? new Set<Handler>();
        const h: Handler = (p) => cb({ payload: p });
        set.add(h);
        listeners.set(event, set);
        return () => set.delete(h);
      },
    },
    http: {
      fetch: async (url: string, init?: RequestInit) => {
        const stub = comfy(url);
        if (stub) return stub;
        // Real request. Civitai's CORS allows an ANONYMOUS GET and refuses one
        // carrying `Authorization` — measured: 200 against "Failed to fetch"
        // on the same URL. Rust does not care, the browser does, so this is
        // one of the things a mock cannot fake. Callers avoid it by asking
        // `hasRustHttp()`; the header is dropped here as well so a stray one
        // costs a degraded answer rather than the whole screen.
        const h = new Headers(init?.headers as HeadersInit | undefined);
        h.delete("authorization");
        return fetch(url, { ...init, headers: h });
      },
    },
    opener: { openUrl: async (url: string) => { window.open(url, "_blank", "noopener"); } },
  } as unknown as NonNullable<typeof window.__TAURI__>;

  const banner = document.createElement("div");
  banner.textContent = `MOCK DESKTOP · ${opts.machine} · engine ${opts.engine}`
    + ` · ollama ${opts.ollama}`;
  banner.style.cssText =
    "position:fixed;bottom:0;left:0;z-index:99999;background:#e8a13a;color:#0b0d12;"
    + "font:700 10px ui-monospace,monospace;padding:3px 8px;border-radius:0 6px 0 0;"
    + "letter-spacing:.06em;pointer-events:none";
  // A fake bridge that looks real is a way to ship a lie, so it labels itself.
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(banner));
  if (document.body) document.body.appendChild(banner);

  console.info(`[desktop.mock] installed — machine=${opts.machine} engine=${opts.engine}`);
  return true;
}
