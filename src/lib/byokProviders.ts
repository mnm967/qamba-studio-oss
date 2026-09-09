// BYOK: which providers this build can call, and what a key for each unlocks.
//
// PURE ON PURPOSE — no `desktop.ts`, no fetch, no storage. The registry is the
// thing every other BYOK module reads, and the surfaces that consume it (the
// keys tab, the model pickers, the director backend list) all need to reason
// about it under `node --test`.
//
// THE IDS MATCH `secrets.rs::allowed_hosts` AND `model_catalog.provider`, and
// both of those are load-bearing. The first is what lets Rust decide where a
// key may be sent; the second is what lets a stored key light up the hosted
// rows that already exist in the catalog rather than a parallel list of models
// invented here. A provider id that matches neither is a card that stores a key
// nothing can spend.
//
// WHAT A KEY UNLOCKS IS DECLARED, NOT INFERRED. An Anthropic key drives the
// director and nothing else — there is no Anthropic image model — and a fal key
// is the opposite. Inferring it from "does the catalog have rows for this
// provider" would make the Anthropic card claim a generation capability it has
// never had, which is the picker-that-changes-nothing this codebase keeps
// naming.

/** What a stored key makes possible. Every value here has a real consumer. */
export type ByokUnlock =
  /** hosted rows in the image/video/audio pickers, rendered on the local lane */
  | "generate"
  /** the director dock, the one-shot interview, and the enhance button */
  | "chat"
  /** the staged planner — and, on the pod, only with sharing on (byokShare.ts) */
  | "planner"
  /** VOICE on this machine: `tts` jobs, and the planner's own line
   *  measurement. `dialogue_synth` synthesizes every line at plan time to
   *  floor its shot's duration — that is what replaced the words-per-second
   *  guess behind DIALOGUE_CUTOFF — so a speech key changes the STORYBOARD,
   *  not only what a preview sounds like. */
  | "speak";

export interface ByokProvider {
  id: string;
  label: string;
  /** one line, shown under the label on the card */
  blurb: string;
  /** where the user goes to mint one */
  keysUrl: string;
  unlocks: ByokUnlock[];
  /** The shape a key of this provider USUALLY has.
   *
   *  A WARNING, never a refusal. Providers change their prefixes (OpenAI has
   *  shipped `sk-`, `sk-proj-` and `sk-svcacct-`), and refusing a key because
   *  it does not look familiar is a support ticket for a key that works. What
   *  it catches is the real mistake: pasting the OpenAI key into the Anthropic
   *  box. */
  looksLike?: { prefix: string[]; note: string };
  /** A cheap authenticated request that proves the key works.
   *
   *  Never a generation — verification must not cost the user money. */
  verify: {
    path: string;
    /** Statuses that prove the credential is GOOD even though the request
     *  failed. fal has no free "who am I" endpoint, so it is verified by
     *  asking after a request id that cannot exist: a bad key answers 401,
     *  a good one gets far enough to answer 404/422. Treating that as failure
     *  would make a working fal key unverifiable. */
     okStatuses?: number[];
    /** Pull an account/organisation label out of the reply, when there is one.
     *  Purely so a person can tell two of their own keys apart. */
    account?: (body: unknown) => string | null;
  };
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

export const BYOK_PROVIDERS: ByokProvider[] = [
  {
    id: "openai",
    label: "OpenAI",
    blurb: "GPT Image for stills and edits, gpt-4o-mini-tts for narration, and GPT as a director backend.",
    keysUrl: "https://platform.openai.com/api-keys",
    // `speak` too: `openai-tts` is a real row and gpt-4o-mini-tts is what
    // `handle_tts` reaches for by default. It does NOT enable the planner's
    // line measurement, which `dialogue_synth.enabled()` gates on an
    // ElevenLabs key specifically — a distinction the card's own blurb makes.
    unlocks: ["generate", "chat", "planner", "speak"],
    looksLike: { prefix: ["sk-"], note: "OpenAI keys start with sk-" },
    verify: { path: "/v1/models" },
  },
  {
    id: "anthropic",
    label: "Anthropic",
    blurb: "Claude as the director, the one-shot interview and the planner. No image models.",
    keysUrl: "https://console.anthropic.com/settings/keys",
    unlocks: ["chat", "planner"],
    looksLike: { prefix: ["sk-ant-"], note: "Anthropic keys start with sk-ant-" },
    verify: { path: "/v1/models" },
  },
  {
    id: "google",
    label: "Google Gemini",
    blurb: "Nano Banana image models, and Gemini as a director backend.",
    keysUrl: "https://aistudio.google.com/apikey",
    unlocks: ["generate", "chat", "planner"],
    looksLike: { prefix: ["AIza"], note: "AI Studio keys start with AIza" },
    verify: {
      path: "/v1beta/models",
      account: (b) => {
        const models = (b as { models?: unknown[] })?.models;
        return Array.isArray(models) ? `${models.length} models` : null;
      },
    },
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    blurb: "The voices the pipeline casts characters into — and the only clone that can be cast onto one.",
    keysUrl: "https://elevenlabs.io/app/settings/api-keys",
    unlocks: ["speak"],
    // No `looksLike`: ElevenLabs keys have shipped with and without an
    // `sk_` prefix, and refusing one that works is a support ticket.
    verify: {
      path: "/v1/user/subscription",
      account: (b) => {
        const t = (b as { tier?: unknown })?.tier;
        return typeof t === "string" && t ? t : null;
      },
    },
  },
  {
    id: "fish",
    label: "Fish Audio",
    blurb: "Hosted S2 — speaks as a voice you cloned once and cite by id.",
    keysUrl: "https://fish.audio/go-api/",
    unlocks: ["speak"],
    verify: { path: "/model?page_size=1" },
  },
  {
    id: "minimax",
    label: "MiniMax",
    blurb: "H3 on MiniMax's own API — cheaper per second than the same model through fal, and 2K.",
    keysUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    unlocks: ["generate"],
    verify: {
      // NEVER A GENERATION. A "check" that renders bills you for pressing a
      // button labelled check — fal's own rule here, and MiniMax has no free
      // identity endpoint either. Asking after a task id that cannot exist
      // gets a 401 on a bad key and something else on a good one.
      path: "/v1/query/video_generation?task_id=byok-verify-does-not-exist",
      okStatuses: [400, 404, 422],
    },
  },
  {
    id: "alibaba",
    label: "Alibaba Model Studio",
    blurb: "Wan 3.0 — the one hosted video model that does an extend, a chain AND a reference shot.",
    keysUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key",
    unlocks: ["generate"],
    looksLike: { prefix: ["sk-"], note: "Model Studio keys start with sk-" },
    verify: {
      // Same rule as MiniMax and fal: ask after a task that cannot exist.
      path: "/api/v1/tasks/byok-verify-does-not-exist",
      okStatuses: [400, 404, 422],
    },
  },
  {
    id: "fal",
    label: "fal.ai",
    blurb: "One key for hundreds of hosted endpoints — Seedream, Seedance, H3, Flux, Wan.",
    keysUrl: "https://fal.ai/dashboard/keys",
    unlocks: ["generate"],
    looksLike: {
      prefix: [],
      note: "fal keys are usually `<uuid>:<hex>` — paste the whole thing including the colon",
    },
    verify: {
      // See `okStatuses` above: this asks after a request id that cannot
      // exist. It costs nothing and never queues work.
      path: "/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status",
      okStatuses: [400, 404, 422],
    },
  },
];

export const providerById = (id: string | null | undefined): ByokProvider | undefined =>
  BYOK_PROVIDERS.find((p) => p.id === id);

/** The provider cards this build offers — all of them.
 *
 *  A parameterless list today. The studio this was forked from held three
 *  video providers back from beta accounts, so this took a role and a `stored`
 *  escape hatch; here every key is the user's own, spent on their own machine,
 *  and there is nobody to withhold a provider from. Kept as a function rather
 *  than exporting the array directly, so a fork that wants a hold has one
 *  place to put it.
 *
 *  WHAT THAT HOLD WAS ABOUT IS STILL TRUE and is worth knowing before pasting
 *  a key in: the hosted VIDEO adapters (`falVideo`, `wanVideo`,
 *  `minimaxVideo` and their Python twins) are written from each vendor's own
 *  published schema and unit-pinned against a fixture, and have never been run
 *  against a live key. Two of the three poll an async task and one walks an
 *  undocumented response shape, so expect the first real run of each to need a
 *  correction. Each of those catalogue rows says so in its own note. */
export function visibleProviders(): ByokProvider[] {
  return [...BYOK_PROVIDERS];
}

/** The base URL each provider's `verify.path` and adapters hang off.
 *
 *  Kept beside the registry rather than in the adapters because
 *  `secrets.rs::allowed_hosts` is the thing it has to agree with, and one
 *  place to compare is the only way that comparison gets made. */
export const BYOK_BASE: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  fal: "https://queue.fal.run",
  elevenlabs: "https://api.elevenlabs.io",
  fish: "https://api.fish.audio",
  minimax: "https://api.minimax.io",
  // Alibaba Model Studio IS DashScope's API. The international host is the
  // default; Model Studio also serves regional and workspace-scoped hosts
  // (`{WorkspaceId}.{region}.maas.aliyuncs.com`), which the desktop cannot
  // reach — `secrets.rs::allowed_hosts` is exact and a wildcard there would be
  // a key sent to any subdomain of aliyuncs.com. The POD is where a workspace
  // host is reachable, via `WAN_BASE_URL`.
  alibaba: "https://dashscope-intl.aliyuncs.com",
};

/** Extra headers a provider requires on every call, key aside. */
export const BYOK_HEADERS: Record<string, Record<string, string>> = {
  // Anthropic 400s a request with no version header, and the message names the
  // header rather than the key — which reads as a bad key.
  anthropic: { "anthropic-version": "2023-06-01" },
};

/**
 * A warning about a pasted key's shape, or null when there is nothing to say.
 *
 * Deliberately returns prose rather than a boolean: the only useful version of
 * this is the one that says which provider the key looks like it belongs to.
 */
export function keyShapeWarning(providerId: string, key: string): string | null {
  const k = key.trim();
  if (!k) return null;
  const mine = providerById(providerId);
  if (!mine) return null;

  // The mis-paste, first and by name — it is the mistake that actually
  // happens, and "this does not look like a fal key" is much less useful than
  // "this looks like an Anthropic key".
  const looksLikeAnother = BYOK_PROVIDERS.find(
    (p) => p.id !== providerId
      && p.looksLike?.prefix.length
      && p.looksLike.prefix.some((pre) => k.startsWith(pre)));
  if (looksLikeAnother) {
    // `sk-ant-` also starts with `sk-`, so a genuine Anthropic key would
    // otherwise be reported as an OpenAI key in the OpenAI box. Longest
    // prefix wins.
    const mineHit = mine.looksLike?.prefix.some((pre) => k.startsWith(pre));
    const otherLen = Math.max(...(looksLikeAnother.looksLike?.prefix ?? [""]).map((p) => p.length));
    const mineLen = Math.max(...(mine.looksLike?.prefix ?? [""]).map((p) => p.length));
    if (!mineHit || otherLen > mineLen) {
      return `That looks like a ${looksLikeAnother.label} key, not a ${mine.label} one.`;
    }
  }
  if (mine.looksLike?.prefix.length
      && !mine.looksLike.prefix.some((pre) => k.startsWith(pre))) {
    return `${mine.looksLike.note} — this one does not, so check it is the right key. It will still be saved.`;
  }
  if (/\s/.test(k)) return "That key has a space in it — check nothing was cut off in the copy.";
  return null;
}

/** Providers whose key unlocks a given capability. */
export const providersFor = (u: ByokUnlock): ByokProvider[] =>
  BYOK_PROVIDERS.filter((p) => p.unlocks.includes(u));
