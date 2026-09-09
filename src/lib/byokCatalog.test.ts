import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BYOK_PREFIX, EMPTY_CONFIG, HOSTED_SPECS, OFFER_PREFIX, byokOfferings,
  byokOfferRows, byokRows, customId,
  customRow, endpointAlreadyOffered, endpointError, isByokRow, parseByokId,
  markSpeechRows, readConfig, specFor,
  writeConfig, type ByokConfig, type CustomModel,
} from "./byokCatalog.ts";
import {
  BYOK_PROVIDERS, providersFor, visibleProviders,
} from "./byokProviders.ts";
import type { ModelCatalogRow } from "./db/types.ts";

const row = (id: string, provider: string, extra: Partial<ModelCatalogRow> = {}):
  ModelCatalogRow => ({
  id, family: "f", display_name: id, kind: "image", provider, modes: ["t2i"],
  sizes: null, max_seconds: null, fps: null, frame_base: null, frame_rem: null,
  dim_step: null, pricing: {}, capabilities: {}, enabled: false, sort: 1, ...extra,
});

const CATALOG = [
  row("gpt-image-2", "openai"),
  row("nano-banana-2", "google"),
  row("fal-h3-2k", "fal", { kind: "video" }),
  row("h3-api-2k", "minimax", { kind: "video" }),
  // The one row that still has no adapter in this build, and deliberately: it
  // declares `v2v`, which no picker offers and `minimax_api.py` does not
  // implement either. `h3-api-2k` USED to stand for this and no longer can —
  // every other hosted row is runnable on your own key now.
  row("h3-api-regen2k", "minimax", { kind: "video" }),
  row("krea2-local", "local"),
];

/* ── the pin that stops the duplicated model strings drifting ───────────── */

test("every HOSTED_SPECS id names a real catalog row of a provider we can call", () => {
  // `local_files` is withheld from non-admins, so the endpoint/model strings
  // are duplicated here. This is the thing that makes the duplication safe:
  // rename or drop a row in gen_model_catalog.py and this fails rather than
  // the picker offering a model whose id the worker no longer knows.
  const py = readFileSync(new URL("../../scripts/gen_model_catalog.py", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
  const declared = new Map<string, string>();
  for (const m of py.matchAll(/^row\("([^"]+)",\s*"[^"]*",\s*"[^"]*",\s*"[^"]*",\s*"([^"]+)"/gm)) {
    declared.set(m[1], m[2]);
  }
  assert.ok(declared.size > 20, `parsed only ${declared.size} rows — the scanner is broken`);

  const providers = new Set(BYOK_PROVIDERS.map((p) => p.id));
  for (const id of Object.keys(HOSTED_SPECS)) {
    const provider = declared.get(id);
    assert.ok(provider, `HOSTED_SPECS names '${id}', which is not a row in gen_model_catalog.py`);
    assert.ok(providers.has(provider),
      `'${id}' is provider '${provider}', which has no BYOK provider entry`);
  }
});

test("every spec declares somewhere to send the request", () => {
  // Three shapes now, and the third is what a VIDEO row looks like. An image
  // row is one endpoint (fal) or one model string (openai/google); a fal video
  // model's modes are SEPARATE endpoints with different field names, so it
  // carries a `fal` dialect instead — and may carry a bare `endpoint` too, as
  // the fallback for a mode the dialect does not name.
  for (const [id, s] of Object.entries(HOSTED_SPECS)) {
    const targets = [s.model, s.endpoint, s.fal?.endpoints].filter(Boolean).length;
    assert.ok(targets >= 1, `${id} declares nowhere to send the request`);
    if (s.adapter === "fal-queue") {
      assert.ok(s.endpoint || Object.keys(s.fal?.endpoints ?? {}).length,
        `${id} is a fal row with neither an endpoint nor a dialect`);
      assert.ok(!s.model, `${id} is a fal row carrying a model string`);
    } else {
      assert.ok(s.model, `${id} is a ${s.adapter} row with no model`);
      assert.ok(!s.endpoint && !s.fal, `${id} is a ${s.adapter} row carrying a fal target`);
    }
  }
});

test("a fal VIDEO dialect names an endpoint for every mode its catalog row claims", () => {
  // The picker filters on `modes`, so a row claiming `flf` with no `flf`
  // endpoint offers a chain that degrades to an extend — a bridge that never
  // arrives at block B, chosen by a user who was told it would.
  const src = readFileSync(new URL("../../scripts/gen_model_catalog.py", import.meta.url), "utf8");
  for (const [id, s] of Object.entries(HOSTED_SPECS)) {
    const eps = Object.keys(s.fal?.endpoints ?? {});
    if (!eps.length) continue;
    const m = src.match(new RegExp(`row\\("${id}"[\\s\\S]{0,400}?modes=\\[([^\\]]*)\\]`));
    if (!m) continue;
    for (const mode of m[1].split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean)) {
      assert.ok(eps.includes(mode),
        `${id} claims mode '${mode}' but its fal dialect has no endpoint for it`);
    }
  }
});

test("NOTHING HOSTED IS POD-ONLY — every provider row has a browser adapter", () => {
  // The standing promise of the desktop build: a key of your own runs the
  // model on your own machine, with no pod. A hosted row with no entry in
  // `HOSTED_SPECS` breaks it silently — the row stays disabled in the picker
  // and reads as "the studio has no key", when the truth is that this build
  // cannot call it however many keys you paste. That is exactly what
  // `wan3-video`, both `h3-api-*` rows and `gemini-omni-flash` were.
  //
  // The exceptions are listed BY ID with a reason, so adding a hosted row and
  // forgetting its adapter fails here rather than shipping.
  const EXCEPT: Record<string, string> = {
    // v2v: no picker offers the mode and `minimax_api.py` does not implement
    // it either, so a spec would put a row in front of someone whose only
    // outcome is a failure at the provider.
    "h3-api-regen2k": "v2v is not wired on either plane",
    // Not a KEY — a self-hosted base url (`VOXTRAL_BASE_URL`). There is
    // nothing for a keychain to hold.
    "voxtral-4b-tts": "self-hosted endpoint, not a pasted key",
    // Speech runs through the desktop's own bundled Python (`plan_cli.KINDS`
    // carries `tts`), with the key handed to the child by Rust — a different
    // mechanism from `byok_gen`, and one that already works pod-free.
    "openai-tts": "runs via the desktop planner, not byok_gen",
    "elevenlabs-v3": "runs via the desktop planner, not byok_gen",
    "fish-s2": "runs via the desktop planner, not byok_gen",
  };
  const src = readFileSync(new URL("../../scripts/gen_model_catalog.py", import.meta.url), "utf8");
  // Every row(...) whose provider is neither the pod's own weights nor a
  // director backend. `kind` is the fourth positional argument.
  const rows = [...src.matchAll(/^row\("([^"]+)",\s*"[^"]*",\s*"[^"]*",\s*"([^"]+)",\s*"([^"]+)"/gm)];
  assert.ok(rows.length > 30, `only parsed ${rows.length} rows — did row() change shape?`);
  const missing: string[] = [];
  for (const [, id, kind, provider] of rows) {
    if (provider === "local" || kind === "llm" || kind === "embed" || kind === "post") continue;
    if (EXCEPT[id] || HOSTED_SPECS[id]) continue;
    missing.push(`${id} (${provider}, ${kind})`);
  }
  assert.deepEqual(missing, [],
    `these hosted rows can only run on the pod: ${missing.join(", ")}`);
});

/* ── row synthesis ──────────────────────────────────────────────────────── */

test("a key turns on exactly its own provider's adapted rows", () => {
  assert.deepEqual(byokRows(CATALOG, ["openai"]).map((r) => r.id), ["gpt-image-2"]);
  assert.deepEqual(byokRows(CATALOG, ["openai", "google"]).map((r) => r.id),
    ["gpt-image-2", "nano-banana-2"]);
  assert.deepEqual(byokRows(CATALOG, []).map((r) => r.id), []);
});

test("a hosted row with no adapter stays out even when its key is present", () => {
  // `h3-api-regen2k` is a real, priced MiniMax row that this build cannot
  // call — it is `v2v`, which no picker offers and the pod adapter does not
  // implement. Offering it would queue a job that fails at the provider.
  //
  // Its SIBLINGS are the point of the assertion: a MiniMax key now turns on
  // the two H3 rows that DO have an adapter, so this is no longer "minimax
  // gets nothing" — it is "the row without an adapter is the only one left
  // out".
  assert.deepEqual(byokRows(CATALOG, ["minimax"]).map((r) => r.id), ["h3-api-2k"]);
});

test("the row comes back enabled and marked, without mutating the catalog", () => {
  const [r] = byokRows(CATALOG, ["openai"]);
  assert.equal(r.enabled, true);
  assert.equal((r.capabilities as { byok?: boolean }).byok, true);
  assert.equal(isByokRow(r), true);
  // The catalog is shared and cached module-level in catalog.ts — writing
  // `enabled` back onto it would enable the row for every surface, key or no.
  assert.equal(CATALOG[0].enabled, false);
  assert.deepEqual(CATALOG[0].capabilities, {});
});

test("hiding a model removes it from the picker and keeps it in the keys tab", () => {
  const cfg: ByokConfig = { hidden: ["gpt-image-2"], custom: [] };
  assert.deepEqual(byokRows(CATALOG, ["openai"], cfg).map((r) => r.id), []);
  const offered = byokOfferings(CATALOG, ["openai"], cfg);
  assert.deepEqual(offered.map((o) => [o.row.id, o.hidden]), [["gpt-image-2", true]]);
});

/* ── custom fal endpoints ───────────────────────────────────────────────── */

const CUSTOM: CustomModel = {
  id: customId("fal-ai/flux/dev"), endpoint: "fal-ai/flux/dev",
  label: "Flux dev", kind: "image", modes: ["t2i"],
};

test("custom endpoints need the fal key, not just the config entry", () => {
  const cfg: ByokConfig = { hidden: [], custom: [CUSTOM] };
  assert.deepEqual(byokRows(CATALOG, ["openai"], cfg).map((r) => r.id), ["gpt-image-2"]);
  assert.ok(byokRows(CATALOG, ["fal"], cfg).map((r) => r.id).includes(CUSTOM.id));
});

test("a custom id round-trips through the first slash only", () => {
  // The endpoint has slashes of its own; splitting on all of them truncates
  // every fal model to its vendor and every call 404s.
  assert.deepEqual(parseByokId(customId("fal-ai/flux/dev")),
    { provider: "fal", endpoint: "fal-ai/flux/dev" });
  assert.equal(parseByokId("gpt-image-2"), null);
  assert.equal(parseByokId(`${BYOK_PREFIX}fal`), null);
  assert.equal(parseByokId(`${BYOK_PREFIX}fal/`), null);
});

test("specFor resolves both shapes and refuses an unknown row", () => {
  assert.deepEqual(specFor({ id: "gpt-image-2" }), HOSTED_SPECS["gpt-image-2"]);
  assert.deepEqual(specFor({ id: customId("fal-ai/flux/dev") }),
    { adapter: "fal-queue", endpoint: "fal-ai/flux/dev" });
  assert.equal(specFor({ id: "h3-api-regen2k" }), null);
});

test("an unpriced custom row prices as nothing rather than as free", () => {
  // `{}` is absent, `{usd: 0}` is a CLAIM that it is free. Nothing renders a
  // price any more (the app shows none outside the admin Costs page), but the
  // ledger still books what a BYOK render cost, and a fabricated 0 there would
  // report someone's paid render as having been free.
  assert.deepEqual(customRow(CUSTOM).pricing, {});
  const priced = customRow({ ...CUSTOM, usd: 0.03, unit: "image" });
  assert.equal(priced.pricing.usd, 0.03);
  assert.equal(priced.pricing.estimate, true);
});

test("a custom video row declares no frame grid rather than guessing one", () => {
  const v = customRow({ ...CUSTOM, kind: "video", modes: ["t2v"], maxSeconds: 6 });
  assert.equal(v.frame_base, null);
  assert.equal(v.max_seconds, 6);
  assert.equal(v.fps, 24);
});

test("an endpoint a catalog row already covers is reported, not silently doubled", () => {
  // The two fal endpoints this repo can name are the two its own pod adapters
  // default to, and both are HOSTED_SPECS entries — so "add" on either would
  // put a second row in the picker for a model already there, with a guessed
  // price beside the catalog's measured one.
  assert.equal(endpointAlreadyOffered("fal-ai/bytedance/seedream/v5/pro"), "seedream-5-pro");
  assert.equal(endpointAlreadyOffered("fal-ai/minimax/hailuo-3"), "fal-h3-2k");
  assert.equal(endpointAlreadyOffered("  fal-ai/minimax/hailuo-3  "), "fal-h3-2k");
  assert.equal(endpointAlreadyOffered("fal-ai/flux/dev"), null);
});

test("endpointError takes an id and refuses a url, a traversal or junk", () => {
  assert.equal(endpointError("fal-ai/flux/dev"), null);
  assert.equal(endpointError("fal-ai/bytedance/seedream/v5/pro"), null);
  assert.match(endpointError("https://fal.run/fal-ai/flux") ?? "", /not the whole URL/);
  assert.match(endpointError("fal-ai") ?? "", /endpoint id/);
  assert.match(endpointError("fal-ai/../../etc") ?? "", /endpoint id|'\.\.'/);
  assert.match(endpointError("  ") ?? "", /Paste the endpoint/);
  assert.match(endpointError("fal ai/flux") ?? "", /endpoint id/);
});

/* ── config ─────────────────────────────────────────────────────────────── */

test("a corrupt or absent config reads as empty rather than throwing", () => {
  const store = {
    getItem: (k: string) => (k ? "{{{not json" : null),
    setItem: () => {},
  };
  assert.deepEqual(readConfig(store), EMPTY_CONFIG);
  assert.deepEqual(readConfig({ getItem: () => null }), EMPTY_CONFIG);
});

test("config round-trips and drops entries that are not shaped like models", () => {
  let held = "";
  const store = { getItem: () => held, setItem: (_k: string, v: string) => { held = v; } };
  writeConfig({ hidden: ["a"], custom: [CUSTOM] }, store);
  assert.deepEqual(readConfig(store), { hidden: ["a"], custom: [CUSTOM] });
  held = JSON.stringify({ hidden: [1, "b"], custom: [{ nope: true }, CUSTOM] });
  assert.deepEqual(readConfig(store), { hidden: ["b"], custom: [CUSTOM] });
});

/* ── speech rows ─────────────────────────────────────────────────────────── */

const ttsRow = (id: string, provider: string): ModelCatalogRow =>
  row(id, provider, { kind: "audio", modes: ["tts"], enabled: true });

test("a speech key MARKS a catalog row rather than adding a second one", () => {
  // `elevenlabs-v3` is already in the catalog and already enabled, because the
  // STUDIO holds a key and the pod spends it. What a key of your own changes
  // is whose card is billed and which machine speaks. Appending would list
  // ElevenLabs twice, once per tier, with nothing to tell them apart.
  const rows = [ttsRow("elevenlabs-v3", "elevenlabs"), ttsRow("openai-tts", "openai")];
  const out = markSpeechRows(rows, ["elevenlabs"], true);
  assert.equal(out.length, 2, "marked in place, never appended");
  assert.ok(isByokRow(out[0]));
  assert.ok(!isByokRow(out[1]), "no key for openai, so that row is still the studio's");
});

test("with nowhere to spend it, a speech key changes nothing", () => {
  // On the web build, or on a desktop with no engine Python, `handlers/tts`
  // cannot run here at all — so a tier mark would be a control that changes
  // nothing, which is the failure the whole BYOK registry is written against.
  const rows = [ttsRow("elevenlabs-v3", "elevenlabs")];
  assert.equal(markSpeechRows(rows, ["elevenlabs"], false), rows, "the same array back");
  assert.ok(!isByokRow(markSpeechRows(rows, ["elevenlabs"], false)[0]));
});

test("only a tts row is marked — a key is not a licence over the whole vendor", () => {
  const music = { ...ttsRow("acestep", "elevenlabs"), modes: ["t2m"] };
  assert.ok(!isByokRow(markSpeechRows([music], ["elevenlabs"], true)[0]));
});

test("a machine with NO key still gets a hosted section, listing the MODELS", () => {
  // A picker with no hosted section reads as a build that cannot do hosted work
  // at all, when it is one paste away — and the rows are the only place that
  // name WHICH key to add. One row per MODEL, like every other section: a
  // provider name among model names reads as a different kind of thing, and
  // collapsing to it left the one section that could not answer "which models
  // would this key buy me".
  const catalog = Object.keys(HOSTED_SPECS).map((id) => ({
    id, provider: id.startsWith("gpt") ? "openai" : "google",
    display_name: id.toUpperCase(), kind: "image", enabled: false,
    capabilities: {}, modes: [], sizes: [], pricing: {}, sort: 1,
  })) as never[];

  const offers = byokOfferRows(catalog, []);
  assert.equal(offers.length, Object.keys(HOSTED_SPECS).length,
    "the offer section is not one row per model");
  for (const r of offers) {
    assert.equal(r.enabled, false);
    assert.ok((r.capabilities as { byok?: boolean }).byok, "an offer row is not on the byok tier");
    assert.ok((r.capabilities as { needsKey?: string }).needsKey, "no provider to point the fix at");
    // The MODEL's own name, so the row says what the key would buy.
    assert.equal(r.display_name, r.display_name.toUpperCase());
    assert.ok(r.id.startsWith("byok-offer:"), "an offer id could collide with the real row");
  }

  // NOTHING CARRIES THE WEB MARK BY DEFAULT, or every picker in the desktop
  // app would tell you to go and open the desktop app.
  for (const r of offers) {
    assert.equal((r.capabilities as { needsDesktop?: boolean }).needsDesktop, undefined);
  }

  // …and in a tab the same rows are LISTED and say where the key goes. Hiding
  // them there would say the account cannot do hosted work at all, which is
  // false — it is the tab that cannot, and the row is the only thing that can
  // name the difference. `rowBlocked` turns the mark into the sentence and
  // drops the button; see `localModels.test.ts`.
  const web = byokOfferRows(catalog, [], { desktop: false });
  assert.equal(web.length, offers.length, "the hosted section vanished off the web");
  for (const r of web) {
    assert.equal((r.capabilities as { needsDesktop?: boolean }).needsDesktop, true);
    assert.ok((r.capabilities as { needsKey?: string }).needsKey,
      "the web row stopped naming WHICH key, which is the one thing it is for");
  }

  // ONE CALLER, and it has to be the one that names the build — the rows are
  // built identically either way and only this argument tells them apart, so
  // an omission here is the whole fix silently gone.
  const hook = readFileSync(new URL("../hooks/useByok.ts", import.meta.url), "utf8");
  assert.match(hook, /byokOfferRows\(catalog, keyed, \{ desktop: isDesktop\(\) \}\)/);

  // A provider whose key IS stored is not offered again — it has real rows.
  const withKey = byokOfferRows(catalog, ["openai"]);
  assert.ok(!withKey.some((r) => (r.capabilities as { needsKey?: string }).needsKey === "openai"),
    "a keyed provider is still being offered as an empty prompt");
  assert.ok(withKey.some((r) => (r.capabilities as { needsKey?: string }).needsKey === "google"));
});

/* ── the provider registry ─────────────────────────────────────────────── */

test("every provider is offered, and each says what a key there buys", () => {
  // THE HOLD IS GONE and this is what replaced it: the studio this was forked
  // from withheld three video providers from beta accounts, which took a role
  // through five call sites to express. Here every key is the user's own,
  // spent on their own machine, and there is nobody to withhold one from — so
  // `visibleProviders` takes no arguments and the caveat about the unverified
  // hosted-video adapters lives on the catalogue rows that carry it.
  const all = visibleProviders();
  assert.equal(all.length, BYOK_PROVIDERS.length);
  for (const p of all) {
    assert.ok(p.unlocks.length, `${p.id} unlocks nothing — the card would say why not`);
    assert.ok(p.keysUrl.startsWith("https://"), `${p.id} has nowhere to get a key`);
  }
});

test("chat and speech reach every provider that declares them", () => {
  // These do NOT come through the row list at all — `director.ts` builds its
  // own backend list and `markSpeechRows` marks the audio rows in place — so
  // a change to the model side must not quietly narrow either.
  assert.ok(providersFor("chat").length >= 3, "the director lost a backend");
  assert.ok(providersFor("speak").length >= 2, "speech lost a provider");
});
