// Which plane a model runs on, and which models this machine actually has.
//
// The trap this file exists for is a NAME: `model_catalog.provider === "local"`
// means the studio's own pod, not the user's laptop, and it has meant that
// since long before there was a desktop app. Every one of these assertions is
// about not letting the two "local"s be confused — in the picker, in the cost
// estimate, or in which queue lane a render lands on.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  engineTree, installedAddons, isLocalId, localBlocked, localId, localModelRows,
  localOfferRows, parseLocalId, resolveLocal, rowBlocked, tierOf, unrunnableHere,
  TIER_META, TIER_ORDER,
} from "./localModels.ts";
import { FAMILIES, variantFiles, variantMb } from "./engineCatalog.ts";
import { NO_RECIPE, localRecipe } from "./localGraphs.ts";
import type { EngineStatus } from "./desktop.ts";
import type { ModelCatalogRow } from "./db/types.ts";

const family = (id: string) => {
  const f = FAMILIES.find((x) => x.id === id);
  assert.ok(f);
  return f;
};

/** An engine holding exactly the files these variants need. */
function status(variants: [string, string][], extra: string[] = []): EngineStatus {
  const files = new Set<string>(extra);
  for (const [f, v] of variants) {
    const fam = family(f);
    const vr = fam.variants.find((x) => x.id === v);
    assert.ok(vr, `no variant ${v}`);
    for (const file of variantFiles(fam, vr)) files.add(file.filename);
  }
  return {
    installed: true, python: "3.12", comfy_dir: "/e/ComfyUI", root: "/e",
    checkpoints: [], loras: [], files: [...files], file_mb: {},
    partial_mb: {}, partial_owner: {}, by_dir: {},
    nodes: ["ComfyUI-GGUF"], running: true, port: 8188,
    models_dir: "/e/ComfyUI", models_linked: false,
  };
}

test("the tier is WHO PAYS: this machine, your key, or the studio", () => {
  // `provider: "local"` is the POD and has been since before the desktop app
  // existed; renaming that column would touch the worker, the model map and
  // every job ever written. The id is what separates this machine.
  assert.equal(tierOf({ id: "h3-local", provider: "local" }), "cloud");
  assert.equal(tierOf({ id: "wan22-local", provider: "local" }), "cloud");
  assert.equal(tierOf({ id: "local:wan22-5b/wan5b-q6", provider: "desktop" }), "local");

  // A VENDOR ROW SPLITS ON THE CREDENTIAL, not on the vendor. The same model
  // is two different bills depending on whose key runs it, and before BYOK
  // both were called "hosted" — which was fine only while the second did not
  // exist.
  assert.equal(tierOf({ id: "gpt-image-2", provider: "openai" }), "cloud",
    "no key of yours: the studio's row, and today an unavailable one");
  assert.equal(
    tierOf({ id: "gpt-image-2", provider: "openai", capabilities: { byok: true } }),
    "byok", "byokRows marks the row it re-enabled");
  assert.equal(tierOf({ id: "byok:fal/fal-ai/flux/dev", provider: "fal" }), "byok",
    "a user-added endpoint is byok by its id alone — it has no catalog row");
});

test("what nothing on this machine can run", () => {
  const row = (r: Record<string, unknown>) => r as never;
  // A hosted row with no key of yours behind it. This is the trap the whole
  // predicate exists for: the BUILT-IN default image model is one of these,
  // so the answer nobody chose is the answer you get.
  assert.equal(unrunnableHere(row({ id: "krea2-local", provider: "local", kind: "image", enabled: true })), true);
  assert.equal(unrunnableHere(row({ id: "h3-turbo-local", provider: "local", kind: "video", enabled: true })), true);
  assert.equal(
    unrunnableHere(row({ id: "gpt-image-2", provider: "openai", kind: "image", enabled: true })),
    true);
  assert.equal(
    unrunnableHere(row({ id: "wan3-video", provider: "alibaba", kind: "video", enabled: true })),
    true);
  // This machine's own engine.
  assert.equal(unrunnableHere(row({ id: "local:wan22-5b/wan5b-q6", provider: "desktop", kind: "video" })), false);
  // Your own key: the render is driven from here.
  assert.equal(
    unrunnableHere(row({ id: "gpt-image-2", provider: "openai", kind: "image", enabled: true, capabilities: { byok: true } })),
    false);
  assert.equal(unrunnableHere(row({ id: "byok:fal/fal-ai/flux/dev", provider: "fal", kind: "image" })), false);
  // An unloaded catalog is not evidence of anything.
  assert.equal(unrunnableHere(null), false);
  assert.equal(unrunnableHere(undefined), false);
});

test("a local id round-trips and cannot collide with a catalog id", () => {
  const id = localId("wan22-5b", "wan5b-q6");
  assert.deepEqual(parseLocalId(id), { familyId: "wan22-5b", variantId: "wan5b-q6" });
  assert.equal(isLocalId("h3-local"), false);
  assert.equal(parseLocalId("h3-local"), null);
  // No catalog id contains a colon, which is what makes the prefix safe.
  assert.ok(!id.slice("local:".length).includes(":"));
});

test("nearest first — and every tier has copy, or a heading renders blank", () => {
  // NEAREST, not cheapest: two of the three cost real money once BYOK exists,
  // in different accounts, so "cheapest" stopped being decidable. Nearest is
  // still true — this machine, then a vendor this machine calls, then a box
  // elsewhere that has to be awake.
  assert.deepEqual(TIER_ORDER, ["local", "byok", "cloud"]);
  for (const t of TIER_ORDER) {
    const m = TIER_META[t];
    assert.ok(m && m.label && m.where && m.blurb && m.cost, `${t} is missing copy`);
  }
});

test("only fully-installed variants are offered", () => {
  const s = status([["wan22-5b", "wan5b-q6"]]);
  const rows = localModelRows(s);
  assert.deepEqual(rows.map((r) => r.id), ["local:wan22-5b/wan5b-q6"]);
  assert.equal(rows[0].kind, "video");
  assert.equal(rows[0].provider, "desktop");
  assert.deepEqual(rows[0].modes, ["t2v", "i2v"]);
  assert.equal(localModelRows(null).length, 0);
});

test("a variant missing ONE shared file is not offered", () => {
  // The exact shape of the shipped bug: the 5B's weights were on disk and its
  // VAE was a different file the row never asked for. "Installed" has to mean
  // every file, or the picker offers a render that cannot resolve its own VAE.
  const s = status([["wan22-5b", "wan5b-q6"]]);
  s.files = (s.files ?? []).filter((f) => f !== "wan2.2_vae.safetensors");
  assert.deepEqual(localModelRows(s).map((r) => r.id), []);
});

test("a GGUF without city96's loader is listed and DISABLED, with the reason", () => {
  // Not hidden: the files are there and the user paid for them in gigabytes.
  // A row that silently vanishes reads as a failed download.
  const s = status([["wan22-5b", "wan5b-q6"]]);
  s.nodes = [];
  const [row] = localModelRows(s);
  assert.equal(row.enabled, false);
  assert.match(String(row.capabilities.blocked), /GGUF loader/);
  // …and an fp16 variant on the same engine is unaffected.
  const s2 = status([["wan22-5b", "wan5b-fp16"]]);
  s2.nodes = [];
  assert.equal(localModelRows(s2)[0].enabled, true);
});

/* ── what a download would add ─────────────────────────────────────────── */
//
// A picker that listed only what had finished downloading answered "what can I
// run right now" and could not answer the question people actually opened it
// with, which is what this machine can do at all. These pin the offer half:
// that it exists, that it can never be mistaken for something runnable, and
// that it can never name a row the installed list is also naming.

test("a family with none of its weights on disk is OFFERED, once", () => {
  // ONE ROW PER FAMILY, NOT PER RUNG — Krea 2 has five quantisations and five
  // "download 13GB" rows under one another is the wall the grouping exists to
  // remove. The wizard settled this already (`WizardChoice.rung`).
  const s = status([["wan22-5b", "wan5b-q6"]]);
  const offers = localOfferRows(s);
  const krea = offers.filter((r) => r.capabilities.localFamily === "krea2");
  assert.equal(krea.length, 1, "one offer for Krea 2, not one per rung");
  assert.equal(krea[0].display_name, "Krea 2 Turbo",
    "the family's own name — no rung has been chosen");
  assert.equal(krea[0].kind, "image");
  assert.equal(krea[0].enabled, false);
  // ...and the family that IS installed is not offered at all.
  assert.equal(offers.some((r) => r.capabilities.localFamily === "wan22-5b"), false);
});

test("an offer can never name a row the installed list is also naming", () => {
  // The id is reused deliberately (`local:<family>/<first rung>`), which is
  // only safe because a family with ANY rung on disk is never offered. If that
  // guard ever goes, one model appears twice — once pickable, once greyed.
  for (const fam of FAMILIES) {
    if (!localRecipe(fam.id)) continue;
    for (const v of fam.variants) {
      const s = status([[fam.id, v.id]]);
      const ids = new Set(localModelRows(s).map((r) => r.id));
      for (const o of localOfferRows(s)) {
        assert.ok(!ids.has(o.id), `${o.id} is offered AND installed`);
      }
    }
  }
});

test("an offer is a greyed row whose fix is the Models tab", () => {
  // The whole point of the row: `rowBlocked` has to turn it into a sentence
  // plus a destination, or it is a model listed with no way to get it.
  // `TieredModelMenu` renders `fix: "models"` as the download icon.
  const [offer] = localOfferRows(status([]));
  assert.ok(offer);
  for (const admin of [true, false]) {
    const b = rowBlocked(offer, admin);
    assert.ok(b, "an un-downloaded local model cannot be picked");
    assert.equal(b.fix, "models");
    assert.match(b.why, /engine window/);
  }
  // And it stays local — the machine is where it would run, so filing it under
  // the studio's cloud would offer a fix nobody can perform.
  assert.equal(tierOf(offer), "local");
  // A LOCAL PROJECT changes nothing: this is the one plane it can always reach.
  assert.equal(rowBlocked(offer, false, { localProject: true })?.fix, "models");
});

test("the offer quotes the CHEAPEST rung, not the first one", () => {
  // `variants[0]` is the full-precision checkpoint, and quoting it is how a
  // model somebody could have run at 4.7GB reads as 13GB and never gets
  // fetched. The engine window is where the rung is chosen, hence "from".
  const fam = family("krea2");
  const cheapest = Math.min(...fam.variants.map((v) => variantMb(fam, v))) / 1024;
  const dearest = Math.max(...fam.variants.map((v) => variantMb(fam, v))) / 1024;
  assert.ok(dearest > cheapest, "Krea 2 must have rungs of different sizes");
  const offer = localOfferRows(status([]))
    .find((r) => r.capabilities.localFamily === "krea2")!;
  const why = String((offer.capabilities as { desktopWhy: string }).desktopWhy);
  assert.match(why, new RegExp(`from ${cheapest.toFixed(1)}GB`));
  assert.doesNotMatch(why, new RegExp(`${dearest.toFixed(1)}GB`));
});

test("an offer advertises the FAMILY's modes, so a mode-filtered picker shows it", () => {
  // The timeline's extend and chain modals filter by mode, so a set narrowed
  // to what is on disk (nothing) would hide the very download that unlocks the
  // mode — which is the shape of the report this whole thing answers.
  for (const o of localOfferRows(status([]))) {
    const recipe = localRecipe(String(o.capabilities.localFamily))!;
    assert.deepEqual(o.modes, recipe.modes);
    assert.ok(o.modes.length, `${o.id} advertises no modes`);
  }
  const h3 = localOfferRows(status([]))
    .find((r) => r.capabilities.localFamily === "minimax-h3")!;
  assert.ok(h3.modes.includes("r2v"),
    "the reference checkpoint is part of what a download would buy");
});

test("an offer claims nothing about a rung nobody has picked", () => {
  // No LoRA table, no VRAM figure, no step count: those are facts about a
  // variant, and a row that cannot be selected has no business carrying them.
  for (const o of localOfferRows(status([]))) {
    for (const k of ["styleLoras", "maxLoras", "vramGb", "steps", "negativePrompt"]) {
      assert.equal(o.capabilities[k], undefined, `${o.id} claims ${k}`);
    }
    assert.ok(resolveLocal(o.id), `${o.id} is not a resolvable local id`);
  }
});

test("nothing is offered without a ComfyUI here — the engine is the missing piece", () => {
  // Seventeen download offers over a machine with nothing to run them is not
  // the honest answer; "No local engine installed yet" is, and the pickers
  // print it off an empty list.
  assert.deepEqual(localOfferRows(null), []);
  const bare = status([]);
  bare.installed = false;
  bare.models_linked = false;
  assert.deepEqual(localOfferRows(bare), []);
  // A LINKED ComfyUI is an engine, so it gets the offers.
  bare.models_linked = true;
  assert.ok(localOfferRows(bare).length > 0);
});

/**
 * Families the DESKTOP MODEL MAP renders that `engineCatalog` would still
 * offer, with the reason each is a divergence rather than a duplicate row.
 *
 * The two lists answer the same question off different tables — the map is
 * what `resolve.py` resolves against, the catalogue is what the engine window
 * can fetch — and where they disagree a machine can hold both a catalogue row
 * marked ONTO the local tier (`markDesktopImageRows`) and a download offer for
 * the same model, under one heading, reading as the picker having listed it
 * twice.
 *
 * EMPTY, AND THE ASSERTION BELOW IS WHAT KEEPS IT THAT WAY. It has had an
 * entry before — the map and the catalogue named different text encoders for
 * one family, so a machine could hold both a row marked ONTO the local tier
 * and a download offer for the same model. Add a key here only with the
 * reason, because an unexplained one reads as a bug somebody tolerated.
 */
const MAP_DIVERGENCE: Record<string, string> = {};

test("a family the desktop map can render is not ALSO offered as a download", () => {
  const map = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "infra/model_map.desktop.json"), "utf8"));
  const tier = map.desktop ?? map;
  const weights = (o: unknown, out: string[] = []): string[] => {
    if (typeof o === "string") {
      if (/\.(safetensors|gguf|ckpt|pt|pth|bin)$/i.test(o)) out.push(o.split("/").pop()!);
    } else if (Array.isArray(o)) for (const x of o) weights(x, out);
    else if (o && typeof o === "object") for (const v of Object.values(o)) weights(v, out);
    return out;
  };
  let checked = 0;
  for (const kind of ["models", "image_models"] as const) {
    for (const [key, entry] of Object.entries(tier[kind] ?? {})) {
      const e = entry as { family?: string; from_model?: string };
      const files = [
        ...weights(e),
        ...weights(e.from_model
          ? ((tier[kind] ?? {})[e.from_model] ?? (tier.models ?? {})[e.from_model] ?? {}) : {}),
      ];
      if (!files.length) continue;
      // A machine holding exactly what this entry needs. `markDesktopImageRows`
      // would file its catalogue row under ON THIS MACHINE here, so anything
      // still offered beside it is the same model listed twice.
      const s = status([]);
      s.files = files;
      const offered = new Set(localOfferRows(s).map((r) => String(r.capabilities.localFamily)));
      // MATCHED ON THE CHECKPOINT, never on `entry.family`. Every image entry
      // shares a VAE with two others, so "touches a file of" is far too wide —
      // and `family` is the RENDER architecture rather than a catalogue id
      // (core detects Klein as `flux2`, so the Klein entry says `flux2` and
      // would resolve to the wrong family every time).
      const fam = FAMILIES.find((f) => localRecipe(f.id) && f.variants.some((v) =>
        variantFiles(f, v)
          .filter((x) => x.dir === "unet" || x.dir === "diffusion_models"
            || x.dir === "checkpoints")
          .some((x) => files.includes(x.filename))));
      if (!fam) continue;
      checked++;
      if (MAP_DIVERGENCE[fam.id]) {
        assert.ok(offered.has(fam.id),
          `${kind}/${key}: ${fam.id} no longer diverges — drop it from MAP_DIVERGENCE`);
        continue;
      }
      assert.ok(!offered.has(fam.id),
        `${kind}/${key}: ${fam.id} would be listed as ready AND as a download`);
    }
  }
  assert.ok(checked > 5, `only ${checked} map entries checked — the walk found nothing`);
});

test("what runs sorts above what would have to be fetched", () => {
  // Two mechanisms, because the pickers split on it: the ones that sort read
  // `enabled` and then `sort`, and the ones that do not (project settings, the
  // context panel, the new-project form) render the array `useLocalEngine`
  // builds. Both have to put the installed rows first.
  const s = status([["wan22-5b", "wan5b-q6"]]);
  const installed = localModelRows(s);
  const offers = localOfferRows(s);
  assert.ok(installed.length && offers.length);
  const worst = Math.max(...installed.map((r) => r.sort));
  for (const o of offers) assert.ok(o.sort > worst, `${o.id} sorts above an installed row`);
  // A family with no recipe is `localBlocked`'s to explain, not this one's to
  // offer — the app cannot drive it however much of it is downloaded.
  for (const o of offers) assert.ok(localRecipe(String(o.capabilities.localFamily)));
  for (const id of Object.keys(NO_RECIPE)) {
    assert.equal(offers.some((o) => o.capabilities.localFamily === id), false,
      `${id} has no recipe and must not be offered`);
  }
});

test("a downloaded family with no local recipe is named, not silently dropped", () => {
  // Asserted as an INVARIANT rather than against a named family, because the
  // named one keeps changing as recipes get written — this test used to pin
  // Krea 2, then H3, and both now render. What must stay true is that every
  // family is either renderable or explained: silence is the failure mode,
  // since someone who fetched 30GB cannot otherwise tell a failed download
  // from a model the app cannot drive.
  for (const fam of FAMILIES) {
    if (localRecipe(fam.id)) continue;
    assert.ok(NO_RECIPE[fam.id],
      `${fam.id} has no recipe and no NO_RECIPE entry — it would vanish silently`);
    const s = status([[fam.id, fam.variants[0].id]]);
    assert.deepEqual(localModelRows(s), []);
    assert.equal(localBlocked(s)[0]?.name, fam.name);
  }
  // And the reverse: an entry for a family that DOES render would print a
  // "on disk but…" line under a model sitting in the same menu.
  for (const id of Object.keys(NO_RECIPE)) {
    assert.equal(localRecipe(id), null, `${id} renders, so NO_RECIPE should not name it`);
  }
});

test("MiniMax H3 renders locally now — the studio's own video model", () => {
  const s = status([["minimax-h3", "h3-q3"]]);
  const [row] = localModelRows(s);
  assert.ok(row, "a downloaded H3 should be offered");
  assert.equal(row.frame_base, 17);
  assert.equal(row.frame_rem, 5);
  assert.equal(row.fps, 24);
  assert.deepEqual(localBlocked(s), []);
  assert.equal(row.capabilities.note, undefined, "nothing left to caveat");
});

test("r2v is withheld until the REFERENCE checkpoint is on disk", () => {
  // MiniMax trains `fl2va` and `ref2va` separately and `fl2va` cannot read
  // reference images at all. Offering r2v on the base download gets a clip
  // that renders beautifully and ignores every character sheet staged into it
  // — which is the silent downgrade, not the safe default. Withheld, exactly
  // as a GGUF row is withheld without city96's loader.
  const h3 = family("minimax-h3");
  const q3 = h3.variants.find((v) => v.id === "h3-q3")!;
  assert.ok(q3.refCheckpoint, "the Q3 rung must name a reference checkpoint");

  const without = localModelRows(status([["minimax-h3", "h3-q3"]]))[0];
  assert.deepEqual(without.modes, ["t2v", "i2v"], "no r2v without the weights");

  const withRef = localModelRows(
    status([["minimax-h3", "h3-q3"]], [q3.refCheckpoint!.filename]))[0];
  assert.deepEqual(withRef.modes, ["t2v", "i2v", "r2v"]);
});

test("each H3 rung names the reference checkpoint of its OWN precision", () => {
  // A `.gguf` will not load in the stock `UNETLoader` and a safetensors file
  // will not load in `UnetLoaderGGUF`, so a rung paired with the wrong
  // reference file is a 20GB download that cannot render. DaSiWa deliberately
  // names none — its reference mode was never verified with references staged.
  const h3 = family("minimax-h3");
  for (const v of h3.variants) {
    if (v.id === "h3-dasiwa") {
      assert.equal(v.refCheckpoint, undefined, "DaSiWa's r2v is unverified");
      continue;
    }
    assert.ok(v.refCheckpoint, `${v.id} names no reference checkpoint`);
    assert.equal(v.refCheckpoint!.filename.endsWith(".gguf"), v.precision === "gguf", v.id);
    // …and exactly one add-on fetches it, so the graph cannot name a file the
    // downloader never offers.
    const fetchers = (h3.addons ?? []).filter((a) =>
      a.files.some((f) => f.filename === v.refCheckpoint!.filename));
    assert.equal(fetchers.length, 1, `${v.id}: ${fetchers.length} add-ons fetch its reference`);
    assert.deepEqual(fetchers[0].forVariants, [v.id]);
  }
});

test("an adapter needing a node pack this engine lacks is not offered at all", () => {
  // Applied through a plain LoraLoaderModelOnly, H3's turbo v4 rounds its own
  // delta away — so the pack's absence must HIDE the pick, not degrade it.
  const s = status([["minimax-h3", "h3-q3"]]);
  s.files = [...(s.files ?? []), "minimax_h3_turbo_v4_step600_ema.safetensors",
             "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"];
  const keys = (localModelRows(s)[0].capabilities.styleLoras as { key: string }[])
    .map((l) => l.key);
  assert.ok(keys.includes("h3-lightx2v-8"), "the plain-LoRA distillation is fine");
  assert.ok(!keys.includes("h3-turbo-v4"), "the bypass one needs a pack that is not here");
  // …and with the pack present it comes back.
  s.nodes = [...(s.nodes ?? []), "ComfyUI-MiniMax-H3-Turbo"];
  const withPack = (localModelRows(s)[0].capabilities.styleLoras as { key: string }[])
    .map((l) => l.key);
  assert.ok(withPack.includes("h3-turbo-v4"));
});

test("Krea 2 renders locally now, and says which half of it does not", () => {
  // It sat in the download list unrenderable because `NO_RECIPE` claimed the
  // whole family needed `Krea2EditRebalance`. That is true of the REFERENCE
  // path only; `krea2_graph` on the pod is entirely stock nodes.
  const [row] = localModelRows(status([["krea2", "krea2-q4"]]));
  assert.ok(row, "a downloaded Krea 2 should be offered");
  assert.deepEqual(row.modes, ["t2i"]);
  assert.deepEqual(localBlocked(status([["krea2", "krea2-q4"]])), []);
  assert.match(String(row.capabilities.note), /Krea2EditRebalance/);
});

test("Krea 2 offers no negative prompt, because it samples no negative branch", () => {
  // cfg 1.0 into a ConditioningZeroOut. A field here would be a control that
  // provably cannot change the picture.
  const [krea] = localModelRows(status([["krea2", "krea2-q4"]]));
  assert.equal(krea.capabilities.negativePrompt, false);
  assert.equal(krea.capabilities.defaultNegative, undefined);
  // …and a family that DOES evaluate one still gets it.
  const [wan] = localModelRows(status([["wan22-5b", "wan5b-q6"]]));
  assert.equal(wan.capabilities.negativePrompt, true);
  assert.ok(wan.capabilities.defaultNegative);
});

test("a local row carries the frame grid and size ladder the recipe declares", () => {
  const [row] = localModelRows(status([["wan22-5b", "wan5b-q6"]]));
  assert.equal(row.fps, 24);
  assert.equal(row.frame_base, 4);
  assert.equal(row.frame_rem, 1);
  assert.equal(row.dim_step, 32);
  assert.ok(row.sizes?.length);
  // Every declared size must be on the dim step, or the engine silently
  // rescales and the file comes back a different shape than the dock promised.
  for (const s of row.sizes ?? []) {
    for (const [w, h] of Object.values(s.dims)) {
      assert.equal(w % 32, 0, `${s.id} width ${w}`);
      assert.equal(h % 32, 0, `${s.id} height ${h}`);
    }
  }
});

test("a local row is free, and says so as a number rather than as silence", () => {
  const [row] = localModelRows(status([["wan22-5b", "wan5b-q6"]]));
  assert.deepEqual(row.pricing, {});
});

test("only INSTALLED add-ons become LoRA picks", () => {
  const fam = family("wan22-14b");
  const lx = (fam.addons ?? [])[0];
  assert.ok(lx);
  assert.deepEqual(installedAddons(fam, new Set()), []);
  assert.deepEqual(
    installedAddons(fam, new Set(lx.files.map((f) => f.filename))).map((a) => a.id),
    [lx.id]);
  const rows = localModelRows(status([["wan22-14b", "wan14b-q4"]],
                                      lx.files.map((f) => f.filename)));
  const keys = (rows[0].capabilities.styleLoras as { key: string }[]).map((l) => l.key);
  assert.deepEqual(keys, ["wan-lightx2v"]);
});

test("resolveLocal refuses an id whose family this app cannot render", () => {
  assert.ok(resolveLocal(localId("wan22-5b", "wan5b-q6")));
  // Every family in the catalogue renders now, so the "unknown family" case is
  // the one that has to be refused.
  assert.equal(resolveLocal(localId("no-such-family", "x")), null);
  assert.equal(resolveLocal(localId("wan22-5b", "nope")), null);
  assert.equal(resolveLocal("h3-local"), null);
});

test("a LINKED ComfyUI's weights are rows, with no engine of ours installed", () => {
  // The gate used to be `installed` alone, and the symptom was every picker
  // reading "No local engine installed yet" over a full model tree — the
  // linked directory's files were already in `status.files`, and this single
  // predicate was what threw them away.
  const s = { ...status([["wan22-5b", "wan5b-q6"]]), installed: false,
              python: null, comfy_dir: null,
              models_dir: "/them/ComfyUI", models_linked: true };
  assert.ok(engineTree(s));
  const rows = localModelRows(s);
  assert.ok(rows.some((r) => r.id.includes("wan22-5b")),
    `linked weights should be offered, got: ${rows.map((r) => r.id).join(", ")}`);
  // and with NEITHER ours nor a link, nothing is — the original behaviour
  const bare = { ...s, models_linked: false };
  assert.ok(!engineTree(bare));
  assert.equal(localModelRows(bare).length, 0);
  assert.equal(localBlocked(bare).length, 0);
});

/* ── why a row cannot be picked ─────────────────────────────────────────── */

const row = (over: Partial<ModelCatalogRow> = {}): ModelCatalogRow => ({
  id: "qwen-edit-local", display_name: "Qwen-Image-Edit 2511", kind: "image",
  provider: "local", enabled: true, modes: ["t2i"], capabilities: {},
  ...over,
} as unknown as ModelCatalogRow);

const withMark = (mark: string, why: string, over: Partial<ModelCatalogRow> = {}) =>
  row({ capabilities: { desktop: mark, desktopWhy: why, desktopFix: "models" }, ...over });

test("an OFFER IS a refusal here, because there is nowhere else to run it", () => {
  // AND IT WAS NOT ONE IN THE CLOUD BUILD. There, an un-downloaded bundled row
  // still rendered on the studio's pod, so blocking it put "download it in the
  // engine window — 3 file(s) missing" over the capability line of rows that
  // worked perfectly well. That pod is not part of this build: a row this
  // machine has not downloaded runs NOWHERE, so the offer is the only sentence
  // there is — and it names a fix the reader can perform, which is the whole
  // point. Silence here is a picker letting you choose a model that cannot
  // render, which is the failure this function exists to end.
  const m = withMark("offer", "download it in the engine window");
  assert.equal(rowBlocked(m)?.why, "download it in the engine window");
  assert.equal(rowBlocked(m)?.fix, "models");
  // ...and it does not MOVE the row: the mark says what could be true after a
  // download, not what is true now.
  assert.equal(tierOf(m), "cloud");
});

test("…and a row with no key of your own says that instead", () => {
  // Two different absences with two different fixes. `blocked` and `offer`
  // are about WEIGHTS; this one is about a credential, and it is a button onto
  // the keys screen rather than a sentence.
  const keyless = row({ enabled: false, provider: "openai" });
  assert.match(rowBlocked(keyless).why, /openai key/);
  assert.equal(rowBlocked(keyless).fix, "keys");
});

test("BLOCKED refuses wherever the row sits — the machine owns it and cannot run it", () => {
  const m = row({ capabilities: { desktop: "blocked", desktopWhy: "start the engine to run it here",
                                  desktopFix: "engine" } });
  assert.deepEqual(rowBlocked(m), { why: "start the engine to run it here", fix: "engine" });
  // …and it is LOCAL, because the weights are on this disk.
  assert.equal(tierOf(m), "local");
});

test("a ready row is pickable and says nothing", () => {
  const m = row({ capabilities: { desktop: "ready" } });
  assert.equal(rowBlocked(m), null);
  assert.equal(tierOf(m), "local");
});

test("a key offered in a browser tab names the desktop and gets no button", () => {
  // A KEY LIVES IN THIS MACHINE'S KEYCHAIN, behind Rust — so the web build was
  // rendering "add your openai key" for a model it can never call and pointing
  // at a keys screen a tab does not have. Two halves, and the second is the
  // one only a test can see: the sentence changes, and `fix` is ABSENT, which
  // is what `TieredModelMenu` reads to render the row disabled rather than as
  // a button onto nothing.
  const web = rowBlocked(row({ capabilities: { needsKey: "openai", needsDesktop: true } }));
  assert.deepEqual(web, { why: "add your openai key in the desktop app" });
  assert.equal(web!.fix, undefined, "a web offer must not open a screen this build has not got");
});

test("the older refusals are unchanged", () => {
  assert.deepEqual(rowBlocked(row({ capabilities: { needsKey: "openai" } })),
                   { why: "add your openai key", fix: "keys" });
  assert.match(rowBlocked(row({ enabled: false, provider: "openai" }))!.why, /openai key/);
  assert.equal(rowBlocked(row()), null);
});

