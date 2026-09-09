// node --test director/wizard_session.test.mjs
//
// Restoring a saved draft has to survive rows written by older builds and by
// half-finished sessions, because the alternative — a wizard that throws on
// open — loses the very draft this feature exists to keep.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AUTO_IDS, castWorldContext, pickResumeSession, pickStillRefs, sessionStatus,
  sessionTitle, storyboardContext, wizardStateFrom, wizardStateTo,
} from "./wizard_session.js";

test("a saved session round-trips", () => {
  const state = {
    step: 3, planJobId: "job-1", medium: "film", tier: 1, lengthS: 90,
    experts: ["writing", "vfx"], backend: "openai-compat",
    res: "1080p", post: ["Face detail"], videoModel: "h3-api", videoPlane: "cloud",
    imageModel: "h3-image-turbo-local",
    // False is the only value worth pinning: it is the non-default, and a
    // draft that loses it comes back grading an episode the user opted out of.
    review: false,
    audio: { id: "asset-1", name: "track.mp3" },
  };
  const back = wizardStateFrom({ wizard: wizardStateTo(state) });
  for (const k of Object.keys(state)) {
    assert.deepEqual(back[k], state[k], `${k} did not survive the round trip`);
  }
});

test("an empty or ancient row restores as 'nothing saved', not as garbage", () => {
  // Every field null means "keep your default" — the modal must not be handed
  // a fabricated tier or length that the user never chose.
  const s = wizardStateFrom({ wizard: {} });
  assert.equal(s.step, 1);
  for (const k of ["planJobId", "medium", "tier", "lengthS", "experts", "backend",
                   "res", "post", "review", "videoModel", "videoPlane", "imageModel",
                   "audio", "queuedAt"]) {
    assert.equal(s[k], null, `${k} should be null`);
  }
  assert.deepEqual(wizardStateFrom(undefined), wizardStateFrom({ wizard: {} }));
  assert.deepEqual(wizardStateFrom({ wizard: null }), wizardStateFrom({ wizard: {} }));
});

test("junk in the row cannot break the reopen", () => {
  const s = wizardStateFrom({ wizard: {
    step: 99, tier: 7, length_s: -5, res: "8k", medium: "podcast",
    experts: ["writing", "astrology"],
    post: ["Face detail", 42], audio: { name: "no id" }, plan_job_id: 12,
  } });
  assert.equal(s.step, 4);              // clamped, not out of range
  assert.equal(s.tier, null);
  assert.equal(s.lengthS, null);
  assert.equal(s.res, null);
  assert.deepEqual(s.experts, ["writing"]);
  assert.deepEqual(s.post, ["Face detail"]);
  assert.equal(s.audio, null);
  assert.equal(s.planJobId, null);
  assert.equal(s.medium, null, "an unknown medium falls back to the project's");
});

test("status says where the draft got to", () => {
  const label = (t) => sessionStatus(t).label;
  assert.equal(label({ wizard: {}, brief: {} }), "brief");
  assert.equal(label({ wizard: {}, brief: {
    logline: "l", turn: "t", cast: [{ name: "M", look: "x" }],
    world: [{ name: "W" }], tone: "cold" } }), "ready to draft");
  assert.equal(label({ wizard: { plan_job_id: "j" }, brief: {} }), "drafting");
  assert.equal(label({ wizard: { step: 2, plan_job_id: "j" } }), "cast & world");
  assert.equal(label({ wizard: { step: 3, plan_job_id: "j" } }), "storyboard");
  assert.equal(label({ wizard: { step: 4, queued_at: "2026-08-06T10:00:00Z" } }), "queued");
});

test("the title comes from the story, not the row id", () => {
  assert.equal(sessionTitle({ brief: { logline: "A diver returns to a drowned town." } }),
               "A diver returns to a drowned town.");
  assert.equal(sessionTitle({ brief: {}, preview: "i want to make something exciting" }),
               "i want to make something exciting");
  assert.equal(sessionTitle({}), "Untitled brief");
  assert.ok(sessionTitle({ brief: { logline: "x".repeat(100) } }).length <= 58);
});

test("resume skips finished and never-started drafts", () => {
  const queued = { id: "a", wizard: { queued_at: "2026-08-06T10:00:00Z" }, brief: { logline: "done" }, turns: 4 };
  const empty = { id: "b", wizard: {}, brief: {}, turns: 0 };
  const live = { id: "c", wizard: { step: 2 }, brief: { logline: "in progress" }, turns: 3 };

  assert.equal(pickResumeSession([queued, empty, live])?.id, "c");
  assert.equal(pickResumeSession([queued, empty]), null, "nothing worth reopening");
  assert.equal(pickResumeSession([]), null);
  assert.equal(pickResumeSession(undefined), null);
  // A draft with turns but no brief yet is still worth reopening.
  assert.equal(pickResumeSession([{ id: "d", wizard: {}, brief: {}, turns: 1 }])?.id, "d");
});


test("the side chat is told what the planner already wrote into the bible", () => {
  // The thread carries the interview, so the director remembers the story; what
  // it cannot see is the cast the planner drafted afterwards — and without it,
  // "add a mentor" invents a second version of someone already on screen.
  const ctx = castWorldContext({
    brief: { logline: "A diver returns.", turn: "he is alive", tone: "elegiac" },
    cast: [{ name: "Mara", identity_line: "shaved head, burn scar", status: "draft", refs: 0 },
           { name: "Rei", identity_line: "wavy black hair", status: "confirmed", refs: 2 }],
    world: [{ name: "Dusk rooftop", status: "draft", refs: 1 }],
    props: [{ name: "Brass diving bell", identity_line: "dented, verdigris", status: "draft", refs: 1 }],
    medium: "film", lengthS: 48,
  });
  assert.match(ctx, /Mara \(draft, no refs yet\): shaved head, burn scar/);
  assert.match(ctx, /Rei \(confirmed, 2 refs\)/);
  assert.match(ctx, /Dusk rooftop \(draft, 1 ref\)/);
  // Props are on the same screen, and a director that cannot see one writes it
  // down a second time under a new name.
  assert.match(ctx, /Props currently in the bible:\n- Brass diving bell \(draft, 1 ref\): dented, verdigris/);
  assert.match(ctx, /A diver returns\..*Turn: he is alive.*Tone: elegiac/);
  assert.match(ctx, /film of about 48s/);
  // The instructions that keep it from duplicating or writing mood words.
  assert.match(ctx, /Never invent a second\s+version of someone already listed/);
  assert.match(ctx, /update_bible_entry/);
  assert.match(ctx, /6-8 concrete visual attributes/);
});

test("an empty bible reads as empty, not as a missing section", () => {
  const ctx = castWorldContext({});
  assert.match(ctx, /Cast currently in the bible:\n- \(none yet\)/);
  assert.match(ctx, /Locations currently in the bible:\n- \(none yet\)/);
  assert.match(ctx, /Props currently in the bible:\n- \(none yet\)/);
  assert.match(ctx, /\(thin — ask before inventing\)/);
});


test("the storyboard chat is given the ids its tools need", () => {
  // update_scene takes a scene_id. A model asked to change "S3" without being
  // told which row that is either guesses or asks — both useless.
  const ctx = storyboardContext({
    blocks: 5, totalS: 64,
    scenes: [{
      id: "scene-1", idx: 0, slug: "DETECTIVE_IN_BAR", duration_ms: 6500,
      scene_prompt: "Leon reflects on his past.", cast: ["Leon"], environment: "The bar",
      beats: [{ id: "beat-1", idx: 0, action: "Leon lowers the glass", camera: "slow push-in",
                duration_ms: 6500, dialogue: [{ speaker: "Leon", line: "The truth lurks." }] }],
    }],
  });
  assert.match(ctx, /S1 DETECTIVE_IN_BAR — 6\.5s · scene_id scene-1/);
  assert.match(ctx, /at The bar, with Leon/);
  assert.match(ctx, /b1 \(6\.5s, beat_id beat-1\): Leon lowers the glass \[slow push-in\] Leon: "The truth lurks\."/);
  assert.match(ctx, /5 generation blocks, 64\.0s total/);
  // The rules that keep an edit from becoming a rewrite.
  assert.match(ctx, /Change what was asked and\s+nothing else/);
  assert.match(ctx, /stale/);
  assert.match(ctx, /never write\s+the compiled H3 prompt format/);
});

test("an unplanned storyboard says so instead of pretending", () => {
  assert.match(storyboardContext({}), /- \(no scenes yet\)/);
});


test("a key still carries the cast first and the location last", () => {
  // The still exists to show the people the blocks will render, so identity
  // wins the slots; the location rides along if there is room.
  const sheets = { mara: "a-mara", rei: "a-rei", bay: "a-bay" };
  const refs = pickStillRefs({
    castIds: ["mara", "rei"], environmentId: "bay",
    firstRefOf: (id) => sheets[id],
  });
  assert.deepEqual(refs, ["a-mara", "a-rei", "a-bay"]);
});

test("four references is the ceiling, and the location still gets in", () => {
  // Krea2EditRebalance takes four; a fifth would be dropped by the node rather
  // than by us, and it would be the location that vanished silently.
  const refs = pickStillRefs({
    castIds: ["c1", "c2", "c3", "c4", "c5"], environmentId: "env",
    firstRefOf: (id) => `a-${id}`,
  });
  assert.equal(refs.length, 4);
  assert.deepEqual(refs, ["a-c1", "a-c2", "a-c3", "a-env"]);
});

test("cast without sheets simply contributes nothing", () => {
  const refs = pickStillRefs({
    castIds: ["known", "unshot"], environmentId: "nowhere",
    firstRefOf: (id) => (id === "known" ? "a-known" : undefined),
  });
  assert.deepEqual(refs, ["a-known"]);
  assert.deepEqual(pickStillRefs({ firstRefOf: () => undefined }), []);
});

test("the same sheet is never sent twice", () => {
  // A character standing in as their own location, or two ids resolving to one
  // sheet, would otherwise spend two of the four slots on one image.
  const refs = pickStillRefs({
    castIds: ["a", "b"], environmentId: "a", firstRefOf: () => "same-asset",
  });
  assert.deepEqual(refs, ["same-asset"]);
});

test("AUTO_IDS is planAuto.ts's own list, in its order", () => {
  // Two copies because this module is plain JS the serverless functions share
  // and `planAuto.ts` is TypeScript they do not bundle. The drift is silent in
  // the worse direction: an id here that TypeScript has dropped is a saved
  // draft that restores a switch nothing reads, and one MISSING here is a
  // switch the user set that never survives closing the modal — so the plan
  // spends what they turned off.
  const ts = fs.readFileSync(
    new URL("../src/lib/planAuto.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const block = ts.slice(ts.indexOf("export const AUTO_STEPS"));
  const ids = [...block.slice(0, block.indexOf("];")).matchAll(/\bid:\s*"([a-z]+)"/g)]
    .map((m) => m[1]);
  assert.ok(ids.length >= 3, `the AUTO_STEPS scanner found ${ids.length} — it is broken`);
  assert.deepEqual(AUTO_IDS, ids);
});

test("the voice pick survives a draft, both halves of it", () => {
  // A CAST IS NOT RE-CASTABLE WITHOUT A RE-PLAN, and the two local engines
  // differ by LICENCE — so a draft reopened silently back on the default would
  // cast a whole episode on terms the user deliberately chose against. Saved
  // for `videoPlane`'s reason, with a sharper edge.
  const round = (w) => wizardStateFrom({ wizard: wizardStateTo(w) });

  const q = round({ dialogueProvider: "qwen", voicePlane: "local" });
  assert.equal(q.dialogueProvider, "qwen");
  assert.equal(q.voicePlane, "local");

  // A key of your own is its own plane, and it is neither of the other two.
  assert.equal(round({ voicePlane: "byok" }).voicePlane, "byok");
  assert.equal(round({ dialogueProvider: "elevenlabs" }).dialogueProvider, "elevenlabs");

  // NOTHING SAVED IS NULL, not a default — the modal only restores a truthy
  // value, so null is "this draft never chose" and the picker's own default
  // stands. Writing "breeze" here would make an unmade choice indistinguishable
  // from a deliberate one.
  const empty = round({});
  assert.equal(empty.dialogueProvider, null);
  assert.equal(empty.voicePlane, null);
  // A plane that is not one of the three is refused rather than carried.
  assert.equal(round({ voicePlane: "somewhere" }).voicePlane, null);
});
