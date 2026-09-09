// Which hosted models a stored key turns on, and which of them you want to see.
//
// THESE ARE THE CATALOG'S OWN ROWS, NOT A PARALLEL LIST. Every hosted row in
// `model_catalog` already carries the pricing, the modes, the reference ceiling
// and the caveats — measured, in `scripts/gen_model_catalog.py`, next to the
// note explaining each one. They ship `enabled: false` for exactly one reason:
// nothing could call them. A key is the thing that was missing, so BYOK
// re-enables the row rather than describing the model a second time. Inventing
// a second list here would mean two places to update a price and one of them
// silently wrong.
//
// WHAT THIS FILE ADDS is the one thing the row cannot carry: HOW to call it.
// The endpoint and model strings live in `local_files`, which
// `model_catalog_visible` withholds from non-admins — correctly, since it is
// also where restricted LoRA filenames live. So the client keeps its own copy,
// and `byokCatalog.test.ts` parses `gen_model_catalog.py` and fails if an id
// here stops naming a real row of that provider. Duplication that a test pins
// is duplication that cannot drift.
//
// FAL IS THE OPPOSITE SHAPE, and that is why it gets a different mechanism.
// One key fronts several thousand endpoints and new ones land weekly, so a
// curated list would be stale the week it shipped and a complete one is not
// knowable from here. Fal models are therefore USER-ADDED by endpoint id, and
// the two this repo's own adapters already name are offered as a starting
// point rather than as the set.
import type { ModelCatalogRow } from "./db/types.ts";
import type { FalVideoSpec } from "./falVideo.ts";

/** How to call one hosted row. */
export interface HostedSpec {
  /** which adapter in `byokAdapters/` drives it */
  adapter: "openai-image" | "gemini-image" | "fal-queue"
    | "wan-queue" | "minimax-video" | "gemini-video";
  /** the provider's own name for the model (openai, google) */
  model?: string;
  /** the queue path (fal) — a single-endpoint model, or the fallback for a
   *  `fal` dialect that declares no endpoint for the mode asked for */
  endpoint?: string;
  /** A fal VIDEO model's dialect: which endpoint serves which mode, and what
   *  that endpoint calls each field. Absent on the image rows, whose one
   *  endpoint and `image_urls` need no table. See `falVideo.ts` — and note
   *  this mirrors the `local_files.fal` block on the same catalog row, which
   *  is what the POD reads; `byokCatalog.test.ts` pins the two together. */
  fal?: FalVideoSpec;
}

/**
 * The callable hosted rows, keyed by `model_catalog.id`.
 *
 * A row absent from here has no adapter, so a key for its provider does NOT
 * turn it on — it stays out of the picker rather than appearing and failing.
 * That is the same rule `localRecipe` follows for a downloaded model with no
 * graph: on disk is not the same as runnable.
 */
export const HOSTED_SPECS: Record<string, HostedSpec> = {
  // Model strings are the ones the pod's own rows carry in `local_files`.
  "gpt-image-2": { adapter: "openai-image", model: "gpt-image-2" },
  "gpt-image-1.5": { adapter: "openai-image", model: "gpt-image-1.5" },
  "nano-banana-2": { adapter: "gemini-image", model: "gemini-3.1-flash-image" },
  "nano-banana-2-lite": { adapter: "gemini-image", model: "gemini-3.1-flash-lite-image" },
  "nano-banana-pro": { adapter: "gemini-image", model: "gemini-3-pro-image" },
  // The fal rows this repo's own adapters name. Everything else on fal is
  // user-added below.
  //
  // A VIDEO row carries `fal`, an image row does not: the image endpoints are
  // one url with one reference list, while a video model's modes are separate
  // endpoints that disagree about field names. See `falVideo.ts`.
  "fal-h3-2k": {
    adapter: "fal-queue", endpoint: "fal-ai/minimax/hailuo-3",
    fal: {
      endpoints: { t2v: "fal-ai/minimax/hailuo-3", i2v: "fal-ai/minimax/hailuo-3",
                   r2v: "fal-ai/minimax/hailuo-3" },
      duration: "int", start: "image_url",
      images: "reference_image_urls", maxRefs: 9,
    },
  },
  "seedream-5-pro": { adapter: "fal-queue", endpoint: "fal-ai/bytedance/seedream/v5/pro" },
  "seedream-5-lite": { adapter: "fal-queue", endpoint: "fal-ai/bytedance/seedream/v5/lite" },
  // Seedance 2.5 — the one fal row that can do a CHAIN, because its
  // image-to-video endpoint declares `end_image_url`.
  "seedance-2.5": {
    adapter: "fal-queue",
    fal: {
      endpoints: {
        t2v: "bytedance/seedance-2.5/text-to-video",
        // THE i2v ENDPOINT HAS NO REFERENCE LIST — `image_url` and
        // `end_image_url` and nothing else. A model-level `image_urls` written
        // here is dropped by fal, and the extend silently loses the identity
        // sheets staged for it. Wan 3.0 is the row that does both at once.
        i2v: { id: "bytedance/seedance-2.5/image-to-video",
               images: null, videos: null, audios: null },
        flf: { id: "bytedance/seedance-2.5/image-to-video",
               images: null, videos: null, audios: null },
        r2v: "bytedance/seedance-2.5/reference-to-video",
      },
      duration: "string",
      durations: ["auto", ...Array.from({ length: 27 }, (_, i) => String(i + 4))],
      resolutions: ["480p", "720p"], aspect: true, audioFlag: "generate_audio",
      start: "image_url", end: "end_image_url",
      images: "image_urls", videos: "video_urls", audios: "audio_urls",
      maxRefs: 50,
    },
  },
  "seedance-2-fast": {
    adapter: "fal-queue",
    fal: {
      endpoints: { t2v: "bytedance/seedance-2.0/text-to-video",
                   i2v: "bytedance/seedance-2.0/image-to-video" },
      duration: "string", resolutions: ["480p", "720p", "1080p"],
      aspect: true, start: "image_url", maxRefs: 4,
    },
  },
  // t2v only, and that is a documentation fact rather than a model limit —
  // BFL's own endpoint takes a `mode`, but fal publishes the text-to-video
  // schema alone and the sibling ids are not documented anywhere this could be
  // read from. A guessed endpoint id is a 404 minutes into a render.
  "flux-3-video": {
    adapter: "fal-queue",
    fal: {
      endpoints: { t2v: "blackforestlabs/flux-3/text-to-video" },
      duration: "string",
      durations: ["auto", ...Array.from({ length: 16 }, (_, i) => String(i + 5))],
      resolutions: ["720p", "1080p"], aspect: true, audioFlag: "generate_audio",
    },
  },

  // EVERY REMAINING HOSTED ROW, so nothing in the catalog is pod-only.
  //
  // A row absent from this table is a row a key does NOT turn on — it stays
  // out of the picker rather than appearing and failing — which is correct
  // for a model with no adapter and was quietly wrong for these: they had
  // adapters on the POD and none in the browser, so the desktop could not run
  // them however many keys you pasted.
  "wan3-video": { adapter: "wan-queue", model: "wan3.0-video" },
  "wan3-video-prime": { adapter: "wan-queue", model: "wan3.0-video-prime" },
  "h3-api-768p": { adapter: "minimax-video", model: "MiniMax-H3" },
  "h3-api-2k": { adapter: "minimax-video", model: "MiniMax-H3" },
  "gemini-omni-flash": { adapter: "gemini-video", model: "gemini-omni-1.1-flash" },
  // `h3-api-regen2k` is deliberately ABSENT. It declares `v2v`, which no
  // picker offers and which `minimax_api.py` does not implement either — a
  // spec here would put a row in front of someone whose only outcome is a
  // failure at the provider.
};

/** A fal endpoint the user added by hand. */
export interface CustomModel {
  /** `byok:fal/<endpoint>` — see `parseByokId` */
  id: string;
  endpoint: string;
  label: string;
  kind: "image" | "video";
  modes: string[];
  /** video only; the composer's length control clamps to it */
  maxSeconds?: number;
  /** what the user knows it costs. Absent is honest — the composer prints
   *  nothing rather than a made-up figure. */
  usd?: number;
  unit?: "image" | "second";
}

export interface ByokConfig {
  /** ids hidden from every picker. Catalog ids and `byok:` ids alike. */
  hidden: string[];
  custom: CustomModel[];
}

export const EMPTY_CONFIG: ByokConfig = { hidden: [], custom: [] };

export const OFFER_PREFIX = "byok-offer:";
export const BYOK_PREFIX = "byok:";

export const isByokId = (id: string | null | undefined): boolean =>
  !!id && id.startsWith(BYOK_PREFIX);

/** `byok:fal/fal-ai/flux/dev` → `{ provider: "fal", endpoint: "fal-ai/flux/dev" }`.
 *
 *  Split on the FIRST slash only: a fal endpoint has slashes of its own, and
 *  splitting on all of them would truncate every endpoint to its vendor. */
export function parseByokId(id: string): { provider: string; endpoint: string } | null {
  if (!isByokId(id)) return null;
  const rest = id.slice(BYOK_PREFIX.length);
  const cut = rest.indexOf("/");
  if (cut < 1 || cut === rest.length - 1) return null;
  return { provider: rest.slice(0, cut), endpoint: rest.slice(cut + 1) };
}

export const customId = (endpoint: string) => `${BYOK_PREFIX}fal/${endpoint}`;

/**
 * The catalog row that already covers an endpoint, if there is one.
 *
 * There WAS a list of suggested endpoints here, and it was wrong: the only two
 * this repo can name are the two its own pod adapters default to, and both are
 * already `HOSTED_SPECS` entries — so every suggestion added a second row for a
 * model the picker was already offering, with the user's guessed price beside
 * the catalog's measured one. The example in the copy does the teaching; this
 * does the guarding.
 */
export function endpointAlreadyOffered(endpoint: string): string | null {
  const e = endpoint.trim();
  return Object.entries(HOSTED_SPECS).find(([, s]) => s.endpoint === e)?.[0] ?? null;
}

/** An endpoint id the queue path can be built from.
 *
 *  Bounded rather than permissive: this string becomes a URL path on a host
 *  that carries the user's key, so it may not escape the path it is given
 *  (`..`, a query, a scheme, a host of its own). */
export function endpointError(ep: string): string | null {
  const e = ep.trim();
  if (!e) return "Paste the endpoint id from the model's page on fal.ai.";
  if (/^https?:/i.test(e)) return "Just the endpoint id, not the whole URL — e.g. fal-ai/flux/dev";
  if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/i.test(e))
    return "That does not look like an endpoint id. They look like fal-ai/flux/dev.";
  if (e.includes("..")) return "An endpoint id cannot contain '..'.";
  return null;
}

/** A catalog-shaped row for a user-added endpoint. */
export function customRow(m: CustomModel): ModelCatalogRow {
  return {
    id: m.id,
    family: "custom",
    display_name: m.label || m.endpoint,
    kind: m.kind,
    provider: "fal",
    modes: m.modes,
    sizes: null,
    max_seconds: m.kind === "video" ? (m.maxSeconds ?? 8) : null,
    fps: m.kind === "video" ? 24 : null,
    // A user-added endpoint's frame grid is not knowable from here, so it is
    // declared ABSENT rather than guessed at — `videoGrid` reads a null base
    // as "the provider will round it" and says so, which is true.
    frame_base: null, frame_rem: null, dim_step: null,
    pricing: m.usd != null && m.unit
      ? { unit: m.unit, usd: m.usd, estimate: true, note: "the figure you entered" }
      : {},
    capabilities: { byok: true, custom: true, endpoint: m.endpoint },
    enabled: true,
    sort: 900,
  };
}

/**
 * Every hosted row a set of stored keys makes usable, minus what is hidden.
 *
 * `enabled` is forced true: the stored row says false because the studio has
 * no key for it, which is exactly the fact a BYOK key changes. Nothing is
 * written back — the catalog row is the studio's, the key is yours.
 */
export function byokRows(
  catalog: ModelCatalogRow[],
  keyed: Iterable<string>,
  config: ByokConfig = EMPTY_CONFIG,
): ModelCatalogRow[] {
  const have = new Set(keyed);
  const hidden = new Set(config.hidden);
  const rows = catalog
    .filter((m) => HOSTED_SPECS[m.id] && have.has(m.provider) && !hidden.has(m.id))
    .map((m) => ({
      ...m,
      enabled: true,
      capabilities: { ...m.capabilities, byok: true },
    }));
  const custom = have.has("fal")
    ? config.custom.filter((c) => !hidden.has(c.id)).map(customRow)
    : [];
  return [...rows, ...custom];
}

/**
 * The hosted rows this build could run IF a key existed.
 *
 * A picker with no BYOK section reads as a build that cannot do hosted work at
 * all, which is the opposite of true: it is one paste away. Hiding the rows
 * also hides the only place that names WHICH key to add. So the section is
 * always present, and every row carries `capabilities.needsKey`, which the
 * picker turns into a button onto the keys screen.
 *
 * ONE ROW PER MODEL, exactly like every other section. The first cut collapsed
 * these to one row per PROVIDER — "OpenAI", "Google" — on the reasoning that
 * the only decision is whether to add the key. That was wrong twice over: this
 * is the one section that then did not answer the question a picker exists to
 * answer (WHICH MODELS), so a user could not tell what a key would buy them
 * without adding it first; and a provider name in a list of model names reads
 * as a different KIND of thing, which is exactly the inconsistency that made it
 * look broken. The models are what the key unlocks, so the models are what it
 * lists.
 *
 * A BROWSER TAB CANNOT TAKE THE OFFER, so it must not be worded as one it can.
 * A key lives in this machine's OS KEYCHAIN and every touch of it is a Rust
 * command — `byok_status` to list, `byok_fetch` to spend — so the keys screen
 * is a desktop window and `byokRender` cannot run in a tab however much is
 * pasted into it. This function had no such test, which is how the web build
 * came to render "add your openai key" beside a model it can never call: a
 * control that cannot reach the render, which is the failure `rowBlocked`'s
 * whole design exists to end. The row is still LISTED there — a section that
 * vanished off the web would say the ACCOUNT cannot do hosted work at all,
 * which is the opposite of true, and it is the only place naming which key —
 * and it says WHERE the key goes instead, carrying no `fix`, which is what
 * renders it disabled rather than a button onto a screen that is not there.
 * `desktop` defaults to the desktop because that is where every one of these
 * can be taken; the web caller is the one that has to say otherwise.
 */
export function byokOfferRows(
  catalog: ModelCatalogRow[],
  keyed: Iterable<string>,
  opts: { kind?: string; desktop?: boolean } = {},
): ModelCatalogRow[] {
  const { kind, desktop = true } = opts;
  const have = new Set(keyed);
  return catalog
    .filter((m) => HOSTED_SPECS[m.id] && !have.has(m.provider) && (!kind || m.kind === kind))
    .map((m) => ({
      ...m,
      // The id is namespaced so it can never collide with the real row this
      // borrows from — the moment a key is stored, `byokRows` emits that row
      // under its own id and this one stops being generated at all.
      id: `${OFFER_PREFIX}${m.id}`,
      enabled: false,
      capabilities: {
        ...m.capabilities, byok: true, needsKey: m.provider,
        ...(desktop ? {} : { needsDesktop: true }),
      },
    }));
}

/**
 * Mark the rows a stored SPEECH key makes yours rather than the studio's.
 *
 * DIFFERENT SHAPE FROM `byokRows`, and the difference is worth stating. Those
 * rows exist in the catalog `enabled: false` because nothing could call them,
 * and a key is what was missing. A TTS row is the opposite: `elevenlabs-v3`
 * and `fish-s2` are enabled already, because the STUDIO has a key and the pod
 * spends it. What a key of your own changes is whose card is billed and which
 * machine speaks — the desktop's Python runs `handlers/tts` here with it — so
 * the row is marked IN PLACE. Appending would list ElevenLabs twice, once per
 * tier, with nothing to tell them apart.
 *
 * `here` is what keeps it honest: on the web build, or on a desktop with no
 * engine Python, the key cannot be spent locally at all and the row is still
 * the studio's. A tier mark for a machine that cannot run it is the
 * control-that-changes-nothing this file exists to avoid.
 */
export function markSpeechRows(
  rows: ModelCatalogRow[], keyed: Iterable<string>, here: boolean,
): ModelCatalogRow[] {
  if (!here) return rows;
  const have = new Set(keyed);
  return rows.map((m) => (
    m.modes?.includes("tts") && have.has(m.provider)
      ? { ...m, capabilities: { ...m.capabilities, byok: true } }
      : m));
}

/** Everything a key COULD turn on, hidden or not — what the keys tab lists so
 *  a model can be switched back on after it has been hidden. */
export function byokOfferings(
  catalog: ModelCatalogRow[],
  keyed: Iterable<string>,
  config: ByokConfig = EMPTY_CONFIG,
): { row: ModelCatalogRow; hidden: boolean; custom: boolean }[] {
  const have = new Set(keyed);
  const hidden = new Set(config.hidden);
  const rows = catalog
    .filter((m) => HOSTED_SPECS[m.id] && have.has(m.provider))
    .map((row) => ({ row, hidden: hidden.has(row.id), custom: false }));
  const custom = have.has("fal")
    ? config.custom.map((c) => ({ row: customRow(c), hidden: hidden.has(c.id), custom: true }))
    : [];
  return [...rows, ...custom];
}

/** How to call a row — a catalog row via HOSTED_SPECS, a custom one from its
 *  own id. Null when neither, which is what keeps an un-adapted hosted row out
 *  of the picker. */
export function specFor(row: Pick<ModelCatalogRow, "id">): HostedSpec | null {
  const known = HOSTED_SPECS[row.id];
  if (known) return known;
  const parsed = parseByokId(row.id);
  if (parsed?.provider === "fal") return { adapter: "fal-queue", endpoint: parsed.endpoint };
  return null;
}

/** True when this row is only renderable because the user has a key. */
export const isByokRow = (row: Pick<ModelCatalogRow, "id" | "capabilities">): boolean =>
  isByokId(row.id) || !!(row.capabilities as { byok?: boolean })?.byok;

/* ── config persistence ───────────────────────────────────────────────────
 *
 * localStorage, under the `qamba.` prefix `storageMigrate.ts` already sweeps
 * old names onto. NOT the database, and not because it would be hard: which
 * models you want in your own picker is a property of this machine's key set,
 * and a project shared with a collaborator who has no fal key must not carry a
 * list of fal models into their picker. */
export const CONFIG_KEY = "qamba.byok.models";

export function readConfig(store?: Pick<Storage, "getItem">): ByokConfig {
  try {
    const s = store ?? (typeof localStorage === "undefined" ? null : localStorage);
    const raw = s?.getItem(CONFIG_KEY);
    if (!raw) return EMPTY_CONFIG;
    const p = JSON.parse(raw) as Partial<ByokConfig>;
    return {
      hidden: Array.isArray(p.hidden) ? p.hidden.filter((x) => typeof x === "string") : [],
      custom: Array.isArray(p.custom)
        ? p.custom.filter((c): c is CustomModel =>
            !!c && typeof c.endpoint === "string" && typeof c.id === "string")
        : [],
    };
  } catch {
    // A corrupt config must not take the picker down with it: an empty one
    // means "no custom models and nothing hidden", which is the state a new
    // install is in anyway.
    return EMPTY_CONFIG;
  }
}

export function writeConfig(cfg: ByokConfig, store?: Pick<Storage, "setItem">) {
  try {
    const s = store ?? (typeof localStorage === "undefined" ? null : localStorage);
    s?.setItem(CONFIG_KEY, JSON.stringify(cfg));
  } catch { /* quota or a private window — the picker still works this session */ }
}
