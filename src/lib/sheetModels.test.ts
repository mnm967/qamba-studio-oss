// Every surface that writes `image_model`, pinned by parsing their source.
//
// `useSheetModels` reaches React and through it `lib/supabase`, whose
// extensionless specifier `node --test` cannot resolve — the corner
// `directorBackends.test.ts` is in. What is checked here is worth the parse:
// the failure it guards is one picker offering a plane the others cannot name,
// which is silent and which these files' own comments already record happening
// once (project settings had no byok rows while the composer rendered on one).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (f: string) =>
  readFileSync(new URL(f, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// THE LIST WAS THREE AND THE FIELD HAS FIVE WRITERS. The director's header
// chips and the settings rail save `settings.image_model` / `video_model` the
// moment you pick one — the same field, on the same project — and both built
// their list as `[...catalog, ...engine.rows]`, i.e. with no byok plane at
// all. So a model chosen on your own key in project settings came back in
// those two under STUDIO CLOUD, which a member reads as "coming soon" and
// cannot pick: the picker calling your own working model unavailable. Named
// here so a sixth writer has somewhere to be added rather than somewhere to
// be forgotten.
const SURFACES = [
  "../components/modals/WizardModal.tsx",
  "../components/modals/ProjectSettingsModal.tsx",
  "../components/modals/NewProjectModal.tsx",
  "../components/shell/ContextPanel.tsx",
  "../components/shell/DirectorDock.tsx",
];

test("every surface that writes image_model builds its list from ONE place", () => {
  for (const f of SURFACES) {
    const body = src(f);
    assert.match(body, /use(Marked|Sheet)(Catalog|Models)\(/,
      `${f} does not use the shared list`);
    // The composition it replaces. A surface that re-derives it is the second
    // copy, and the second copy is the one that goes stale.
    assert.ok(!/!byok\.some\(\(b\) => b\.id === m\.id\)/.test(body),
      `${f} still composes the byok rows itself`);
  }
});

test("only the wizard drops the `local:` rows, and it keeps the one in use", () => {
  // THE DIFFERENCE IS THE POINT. `local:` ids render through `localGraphs` in
  // TypeScript, which renders a PROMPT — right for the composer's one-off
  // still, wrong for a sheet composed for the family finally chosen and hung
  // on late-bound anchors. The other two surfaces set a project DEFAULT, which
  // is for those stills as much as for a sheet, so they keep them.
  const wiz = src("../components/modals/WizardModal.tsx");
  assert.match(wiz, /useSheetModels\(catalogRows, imageModel, engine\.rows\)/,
    "the wizard must pass its current value, or a `local:` default renders as a raw id");
  for (const f of SURFACES.slice(1)) {
    assert.match(src(f), /engine\.rows/, `${f} must keep the local: rows`);
  }
});

test("the shared hook marks from the MODEL MAP, not from the catalogue", () => {
  // `engine.rows` answers "what has downloaded"; `engine.imageModels` answers
  // "what does `model_map.desktop.json` carry, with its files present". They
  // DISAGREE — the map's generator drops an entry whose files the engine
  // window cannot fetch — and marking from the first would be a sheet that
  // dies inside `resolve()` naming a file nobody can download.
  const hook = src("../hooks/useSheetModels.ts");
  assert.match(hook, /markDesktopImageRows\(/);
  assert.match(hook, /engine\.imageModels/);
  assert.ok(!/engine\.rows/.test(hook),
    "the mark must come from the model map, not from what has downloaded");
});
