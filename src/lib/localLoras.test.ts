/**
 * The registry that makes a downloaded LoRA reachable.
 *
 * The bug it replaces was total and silent: the file landed in
 * `models/loras/`, `engine_status.files` listed it, and no picker on either
 * plane ever mentioned it — `capabilities.styleLoras` was built from the
 * hardcoded `fam.addons` alone, and `localRender` dropped an unknown key with
 * a `.filter()`. So the checks here are mostly about the two ways that can
 * come back: a key nothing resolves, and a row for a file that is gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  familyForBaseModel, hintFor, loraDefs, loraKey, lorasForFamily,
  orphanedLoras, sanitise, type LocalLora, type LocalLoraMap,
} from "./localLoras.ts";

const lora = (p: Partial<LocalLora> = {}): LocalLora => ({
  filename: "thing.safetensors", family: "sdxl", name: "Thing", ...p,
});
const map = (...ls: LocalLora[]): LocalLoraMap =>
  Object.fromEntries(ls.map((l) => [l.filename, l]));

test("the Civitai tags that actually occur map to a family", () => {
  // Counted off the live API, so these are the strings that matter.
  assert.equal(familyForBaseModel("SD 1.5"), "sd15");
  assert.equal(familyForBaseModel("SDXL 1.0"), "sdxl");
  assert.equal(familyForBaseModel("Krea 2"), "krea2");
  assert.equal(familyForBaseModel("MiniMax H3"), "minimax-h3");
  assert.equal(familyForBaseModel("Wan Video 2.2 I2V-A14B"), "wan22-14b");
  assert.equal(familyForBaseModel("Wan Video 1.3B t2v"), "wan21-1.3b");
});

test("the SDXL finetunes are one family, because an adapter crosses them", () => {
  for (const b of ["Pony", "Illustrious", "NoobAI", "SDXL Turbo"]) {
    assert.equal(familyForBaseModel(b), "sdxl", b);
  }
});

test("matching is case- and spacing-insensitive", () => {
  assert.equal(familyForBaseModel("  krea   2 "), "krea2");
  assert.equal(familyForBaseModel("SDXL 1.0"), familyForBaseModel("sdxl 1.0"));
});

test("an ambiguous or absent tag is a MISS, never a guess", () => {
  // Bare "Wan Video" names neither a generation nor a size.
  assert.equal(familyForBaseModel("Wan Video"), null);
  // Wan 2.1 14B: a real tag for a family this catalogue does not carry. Mapping
  // it onto the 2.2 A14B row would load an adapter trained on other weights.
  assert.equal(familyForBaseModel("Wan Video 14B t2v"), null);
  assert.equal(familyForBaseModel("Wan Video 14B i2v 720p"), null);
  assert.equal(familyForBaseModel("Flux.1 D"), null);
  assert.equal(familyForBaseModel("Other"), null);
  assert.equal(familyForBaseModel(""), null);
  assert.equal(familyForBaseModel(null), null);
});

test("existence is the DISK, so a deleted file leaves the picker by itself", () => {
  const all = map(lora({ filename: "a.safetensors" }), lora({ filename: "b.safetensors" }));
  const have = new Set(["a.safetensors"]);
  assert.deepEqual(lorasForFamily("sdxl", have, all).map((l) => l.filename), ["a.safetensors"]);
  assert.deepEqual(orphanedLoras(have, all).map((l) => l.filename), ["b.safetensors"]);
});

test("a LoRA is only ever offered on its own family", () => {
  const all = map(
    lora({ filename: "x.safetensors", family: "sd15" }),
    lora({ filename: "y.safetensors", family: "wan22-5b" }),
  );
  const have = new Set(["x.safetensors", "y.safetensors"]);
  assert.deepEqual(lorasForFamily("sd15", have, all).map((l) => l.filename), ["x.safetensors"]);
  assert.deepEqual(lorasForFamily("sdxl", have, all), []);
});

test("the order is stable, so the picker does not reshuffle between renders", () => {
  const all = map(
    lora({ filename: "z.safetensors", name: "Zebra" }),
    lora({ filename: "a.safetensors", name: "Aardvark" }),
  );
  const have = new Set(["z.safetensors", "a.safetensors"]);
  assert.deepEqual(lorasForFamily("sdxl", have, all).map((l) => l.name), ["Aardvark", "Zebra"]);
});

test("the pick key is the filename, which is what LoraLoaderModelOnly needs", () => {
  assert.equal(loraKey(lora({ filename: "detail.safetensors" })), "detail.safetensors");
  // …and it cannot collide with an engineCatalog addon id, none of which is a
  // filename. This is the property `localRender`'s resolution order rests on.
  assert.match(loraKey(lora()), /\.safetensors$/);
});

test("the trigger is SHOWN, since nothing prepends it", () => {
  const h = hintFor(lora({ trigger: "gritmotion", baseModel: "MiniMax H3" }));
  assert.match(h, /gritmotion/);
  assert.match(h, /MiniMax H3/);
});

test("a def carries the author's own strength, so the slider starts there", () => {
  const [d] = loraDefs([lora({ strength: 0.6 })]);
  assert.equal(d.strength, 0.6);
  const [plain] = loraDefs([lora()]);
  assert.equal(plain.strength, undefined);
});

test("the stored JSON is untrusted input, not a type", () => {
  assert.deepEqual(sanitise(null), {});
  assert.deepEqual(sanitise("nonsense"), {});
  assert.deepEqual(sanitise({ a: 1, b: null }), {});
  // A record with no family cannot be offered anywhere — dropped, not defaulted.
  assert.deepEqual(sanitise({ a: { filename: "a.safetensors" } }), {});
  assert.deepEqual(sanitise({ a: { family: "sd15" } }), {});
  // A record with no name falls back to the filename rather than rendering blank.
  const ok = sanitise({ a: { filename: "a.safetensors", family: "sd15" } });
  assert.equal(ok["a"].name, "a.safetensors");
});

/* ── resolution: the half that used to drop a pick on the floor ─────────── */

import { LoraResolveError, resolveLoraPicks } from "./localLoras.ts";
import type { FamilyAddon } from "./engineCatalog.ts";

const FAM = { id: "sdxl", name: "SDXL" };
const noAddons = () => undefined;
const addon = (id: string, files: string[], sampling?: FamilyAddon["sampling"]): FamilyAddon => ({
  id, name: id, kind: "speed", blurb: "",
  files: files.map((filename) => ({ url: "", filename, dir: "loras" as const, size_mb: 1 })),
  ...(sampling ? { sampling } : {}),
});

test("a hub LoRA resolves to its file — the case that used to vanish", () => {
  const all = map(lora({ filename: "grain.safetensors" }));
  const out = resolveLoraPicks(FAM, [{ key: "grain.safetensors", strength: 0.7 }],
    { addon: noAddons, registry: all });
  assert.deepEqual(out, [{ files: ["grain.safetensors"], strength: 0.7 }]);
});

test("a catalogue add-on still resolves, and carries its sampling override", () => {
  const a = addon("lcm-sdxl", ["lcm.safetensors"], { steps: 4, cfg: 1.5 });
  const out = resolveLoraPicks(FAM, [{ key: "lcm-sdxl" }],
    { addon: (k) => (k === "lcm-sdxl" ? a : undefined), registry: {} });
  assert.deepEqual(out, [{ files: ["lcm.safetensors"], strength: 1, sampling: { steps: 4, cfg: 1.5 } }]);
});

test("an add-on wins over a same-named registry entry, so nothing shadows the catalogue", () => {
  const a = addon("x", ["catalogue.safetensors"]);
  const all = map(lora({ filename: "x" }));
  const out = resolveLoraPicks(FAM, [{ key: "x" }], { addon: () => a, registry: all });
  assert.deepEqual(out[0].files, ["catalogue.safetensors"]);
});

test("an unresolvable pick RAISES rather than rendering without it", () => {
  assert.throws(
    () => resolveLoraPicks(FAM, [{ key: "ghost.safetensors" }], { addon: noAddons, registry: {} }),
    (e: Error) => e instanceof LoraResolveError && /ghost/.test(e.message));
});

test("a LoRA for another family raises instead of loading nothing", () => {
  const all = map(lora({ filename: "wan.safetensors", family: "wan22-5b", name: "Wan thing" }));
  assert.throws(
    () => resolveLoraPicks(FAM, [{ key: "wan.safetensors" }], { addon: noAddons, registry: all }),
    (e: Error) => e instanceof LoraResolveError && /wan22-5b/.test(e.message));
});

test("a registered file that is no longer on disk raises, and says which", () => {
  const all = map(lora({ filename: "gone.safetensors" }));
  assert.throws(
    () => resolveLoraPicks(FAM, [{ key: "gone.safetensors" }],
      { addon: noAddons, registry: all, onDisk: new Set<string>() }),
    (e: Error) => /not on disk/.test(e.message));
  // …and with no disk list at all it is trusted, which is what lets the graph
  // builders be unit-tested without an engine behind them.
  assert.equal(
    resolveLoraPicks(FAM, [{ key: "gone.safetensors" }],
      { addon: noAddons, registry: all, onDisk: null }).length, 1);
});

test("pick ORDER is preserved — a LoRA chain is not commutative", () => {
  const all = map(lora({ filename: "a.safetensors" }), lora({ filename: "b.safetensors" }));
  const out = resolveLoraPicks(FAM, [{ key: "b.safetensors" }, { key: "a.safetensors" }],
    { addon: noAddons, registry: all });
  assert.deepEqual(out.map((o) => o.files[0]), ["b.safetensors", "a.safetensors"]);
});
