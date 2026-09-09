// Every assertion here is a failure that produces a plausible-looking job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replanBrief, replanJob, replanBlocker } from "./replan.ts";

// What `plan_storyboard` writes back onto `storyboards.brief` when it is done:
// its input, plus its own output under keys of the planner's choosing.
const STORED = {
  logline: "Rei crosses into Plant World", notes: "keep it warm",
  medium: "series", duration_target_ms: 175000,
  audio_asset_id: "aud-1", experts: ["cinematographer"],
  structured: { cast: [{ name: "Rei" }] }, thread_id: "thr-1",
  // --- planner OUTPUT from here down ---
  title: "BORROWED SKY", tier: 2, world: { era: "near future" },
  soundscape: "glass and wind", music: "original score for BORROWED SKY",
  editor_notes: [{ note: "raise the stakes" }], treatment: "a long prose treatment",
  bible_near_misses: [{ name: "Rei" }],
};

const OPTS = {
  note: "Cut the training scene", previousStoryboardId: "sb-2",
  withPrevious: true, panels: false,
  stored: STORED, fallbackBrief: {},
  projectId: "p1", episodeId: "e1", threadId: "thr-1",
  imageModel: "krea2", persona: "You are a director.",
};

test("the brief handed back is the planner's INPUT, never its output", () => {
  const b = replanBrief(STORED, {});
  assert.equal(b.logline, "Rei crosses into Plant World");
  assert.equal(b.audio_asset_id, "aud-1", "a music video re-planned without its track is planned against silence");
  for (const k of ["title", "world", "soundscape", "treatment", "editor_notes", "bible_near_misses", "tier"]) {
    assert.equal(k in b, false, `${k} is the planner's own output`);
  }
});

test("music is dropped, whichever source carried it", () => {
  // The landmine: the planner overwrites the `music` INPUT SPEC (an object the
  // worker calls .get("lyrics") on) with its own one-line score DESCRIPTION.
  // Sent back as-is that is `"a string".get(...)` on the pod — an
  // AttributeError minutes into the plan.
  const j = replanJob({ ...OPTS, fallbackBrief: { music: { generate: true } } });
  const brief = j.payload.brief as Record<string, unknown>;
  assert.equal("music" in brief, false);
});

test("a revision never auto-launches the render", () => {
  // `plan_storyboard` launches on `auto_launch or tier == 1`, so a re-plan of
  // a one-shot session would queue the whole episode off a Re-plan button.
  const j = replanJob(OPTS);
  assert.equal(j.payload.tier, 2);
  assert.equal(j.payload.auto_launch, false);
});

test("sheets stay on and panels follow the popup", () => {
  // Sheets are queued for entries the plan just CREATED, so an up-to-date
  // bible costs nothing — and a character invented by this revision with no
  // face plate leaves every panel and block staging it unanchored.
  assert.equal(replanJob(OPTS).payload.plan_refs, true);
  assert.equal(replanJob(OPTS).payload.scene_panels, false);
  assert.equal(replanJob({ ...OPTS, panels: true }).payload.scene_panels, true);
});

test("the previous plan is named, and withholding it still records the lineage", () => {
  const seen = replanJob(OPTS);
  assert.equal(seen.payload.revise_of, "sb-2");
  assert.equal("revise_blind" in seen.payload, false);
  const blind = replanJob({ ...OPTS, withPrevious: false });
  assert.equal(blind.payload.revise_of, "sb-2", "provenance survives writing blind");
  assert.equal(blind.payload.revise_blind, true);
});

test("the draft session rides along", () => {
  // Unstamped entries are canon the moment they are written, and "discard this
  // draft" stops reaching them.
  const brief = replanJob(OPTS).payload.brief as Record<string, unknown>;
  assert.equal(brief.thread_id, "thr-1");
});

test("live state fills what the stored brief is missing", () => {
  const b = replanBrief({ logline: "" }, { logline: "from the interview", medium: "film" });
  assert.equal(b.logline, "from the interview", "an empty string is not a value");
  assert.equal(b.medium, "film");
});

test("a revision sends no block params of its own", () => {
  // `params` is what `launch_render` copies onto every generation_block, so a
  // key written here would silently outlive this revision. A re-plan decides
  // the STORYBOARD; how its blocks render is the wizard's own to send.
  assert.equal("params" in replanJob(OPTS).payload, false);
});

test("the button says why it is off rather than queueing a doomed job", () => {
  assert.equal(replanBlocker({ episodeId: "e1", storyboardId: "sb-2" }), null);
  assert.match(String(replanBlocker({ episodeId: null, storyboardId: "sb-2" })), /episode/);
  assert.match(String(replanBlocker({ episodeId: "e1", storyboardId: null })), /storyboard/);
  assert.match(String(replanBlocker({ episodeId: "e1", storyboardId: "sb-2", inFlight: true })), /already/);
});
