// The quality control only exists where it can change the render — the same
// rule GenComposer's negative prompt follows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { qualityTiers, QUALITY_TIERS } from "./localModels.ts";

const row = (o: Record<string, unknown>) => ({
  id: "x", provider: "local", enabled: true, sort: 1, kind: "image",
  display_name: "X", modes: [], capabilities: {}, pricing: {}, ...o,
} as never);

test("openai hosted rows expose all three tiers", () => {
  assert.deepEqual(qualityTiers(row({ id: "gpt-image-2", provider: "openai" })),
                   QUALITY_TIERS);
});

test("gemini rows do NOT — imageSize is a per-model ceiling, not a per-render choice", () => {
  // Lite serves 1K only; offering low/medium/high there is a knob that
  // provably cannot change the render.
  assert.deepEqual(qualityTiers(row({ id: "nano-banana-2", provider: "google" })), []);
  assert.deepEqual(qualityTiers(row({ id: "nano-banana-2-lite", provider: "google" })), []);
});

test("pod and desktop rows never show it", () => {
  assert.deepEqual(qualityTiers(row({ id: "krea2", provider: "local" })), []);
  assert.deepEqual(qualityTiers(row({ id: "local:wan22-5b/q6", provider: "local" })), []);
});

test("no model, no control", () => {
  assert.deepEqual(qualityTiers(null), []);
  assert.deepEqual(qualityTiers(undefined), []);
});

// --- every surface that renders the menu must wire the knob ------------------
// The failure this catches is the one that actually happened: TieredModelMenu
// was adopted by five surfaces and only two passed `onQuality`, so the control
// existed in the library and nowhere else. A missing prop renders nothing and
// throws nothing — there is no way to notice except by opening each menu.
import { readFileSync } from "node:fs";

const SURFACES = [
  "src/components/shell/GenComposer.tsx",
  "src/components/shell/ContextPanel.tsx",
  "src/components/shell/DirectorDock.tsx",
  "src/components/modals/ProjectSettingsModal.tsx",
  "src/components/modals/PromptRefsModal.tsx",
  "src/components/modals/PanelRegenModal.tsx",
];

// The desktop plane is not in the CATALOG — `loadCatalog()` reads a Supabase
// view and this machine's downloads are a filesystem walk in Rust — so every
// surface that offers the grouped menu has to add `useLocalEngine().rows`
// itself. Miss it and the menu renders correctly with one group silently
// absent, which reads as "the download failed" rather than as a bug here.
// The three that write `settings.image_model` / `video_model` are held to it
// together: a plane one of them can SET is a plane the others must be able to
// NAME, or the picker shows a raw `local:…` id back.
const ENGINE_SURFACES = [
  "src/components/shell/GenComposer.tsx",
  "src/components/shell/ContextPanel.tsx",
  "src/components/shell/DirectorDock.tsx",
  "src/components/modals/ProjectSettingsModal.tsx",
];

test("every surface that writes a project default offers the desktop plane", () => {
  for (const f of ENGINE_SURFACES) {
    const src = readFileSync(f, "utf8");
    assert.ok(/useLocalEngine\(\)/.test(src),
      `${f} renders the grouped menu without useLocalEngine() — the "on this `
      + 'machine" group will be missing there, silently');
    assert.ok(/engine\.rows/.test(src),
      `${f} calls useLocalEngine() but never spreads engine.rows into the list`);
  }
});

test("every TieredModelMenu caller passes onQuality", () => {
  for (const f of SURFACES) {
    const src = readFileSync(f, "utf8");
    assert.ok(src.includes("<TieredModelMenu"), `${f} no longer renders the menu`);
    assert.ok(/onQuality=\{/.test(src),
      `${f} renders the menu without wiring onQuality — the quality control `
      + "will be invisible there, silently");
  }
});

test("no surface keeps a private copy of the tier icon", () => {
  // TierIcon moved into the menu so the header icon is the DEFAULT rather than
  // something four of five callers forgot to pass.
  for (const f of SURFACES) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/^function TierIcon/m.test(src), `${f} redefines TierIcon`);
  }
});
