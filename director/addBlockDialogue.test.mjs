/**
 * A shot added by the director can carry the lines spoken in it.
 *
 * `add_block` had no `dialogue` argument at all, so "add a shot where Rei says
 * X" had two outcomes and both were wrong. The model wrote the line into
 * `action` — where it reaches H3 as description rather than through the
 * compiler's vocal grammar, so nothing is recorded, nothing is bound to a
 * mouth and nothing measures whether it fits the shot — or it followed up with
 * `update_beat`, which lands AFTER this tool has already queued the render and
 * only marks the block `stale`, a status nothing in the worker reads.
 *
 * Twin of the same cases in worker/tests/test_director_editing.py. The numbers
 * are shared on purpose: the duration floor is computed by `dialogueMs` here
 * and by storyplan.dialogue_ms there, and a disagreement means the two
 * directors write different-length shots for the same line.
 *
 * Driven through `runTool` rather than the un-exported `addBlock`, so the
 * dispatch and the anchor resolution are exercised too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { configureTools, runTool } from "./tools.js";

const CHARS = { "astronaut rei": ["ch-rei", "Astronaut Rei"], miko: ["ch-miko", "Miko"] };
const CTX = { projectId: "proj1", episodeId: "ep1", settings: {} };
const MAX_CONTENT_MS = 14292;          // h3_timing's ceiling for one block

/** A stub Supabase over one empty storyboard, recording every write in order. */
function stub() {
  const writes = [];
  const db = {
    async get(q) {
      if (q.startsWith("episodes?")) return [{ id: "ep1" }];
      if (q.startsWith("storyboards?")) return [{ id: "sb1" }];
      if (q.includes("kind=eq.character")) {
        const nm = decodeURIComponent(q.split("name=ilike.")[1].split("&")[0]).toLowerCase();
        const hit = CHARS[nm];
        return hit ? [{ id: hit[0], name: hit[1] }] : [];
      }
      if (q.startsWith("bible_entries?id=in.")) {
        const back = Object.fromEntries(Object.values(CHARS));
        return q.split("in.(")[1].split(")")[0].split(",")
          .filter((i) => back[i]).map((i) => ({ name: back[i] }));
      }
      if (q.startsWith("projects?")) return [{ settings: {} }];
      return [];                       // no blocks, scenes, beats or assets
    },
    async ins(table, row) { writes.push([table, row]); return { ...row, id: `${table}-1` }; },
    async upd() { return []; },
    async updRows() { return []; },
    async del() { return []; },
  };
  configureTools({ db, lore: {} });
  return {
    writes,
    beat: () => writes.find(([t]) => t === "beats")[1],
    block: () => writes.find(([t]) => t === "generation_blocks")[1],
    tables: () => writes.map(([t]) => t),
  };
}

const add = (input) => runTool("add_block", { render: false, ...input }, CTX);

test("a new shot carries the line that is spoken in it", async () => {
  // The line lands on the BEAT, which is what the H3 compiler reads — and with
  // its speaker resolved to a bible row, so dialogue_synth can cast a voice for
  // it rather than guessing from a name.
  const db = stub();
  const out = await add({
    action: "Rei turns from the ledge.", cast: ["Astronaut Rei"],
    dialogue: [{ speaker: "Astronaut Rei", line: "We have to go, now.", delivery: "urgent" }],
  });
  assert.deepEqual(db.beat().dialogue, [{
    speaker_id: "ch-rei", speaker: "Astronaut Rei",
    line: "We have to go, now.", delivery: "urgent" }]);
  assert.deepEqual(out.dialogue, [{ speaker: "Astronaut Rei", line: "We have to go, now." }]);
});

test("a speaker the cast leaves out is staged anyway", async () => {
  // ref_plan_for builds the reference set from the cast, so a character who
  // speaks and is not cast is drawn from prose as a stranger — the failure
  // `cast` itself exists to prevent, arriving through the dialogue instead.
  const db = stub();
  const out = await add({
    action: "The door opens.", cast: ["Miko"],
    dialogue: [{ speaker: "Astronaut Rei", line: "You're late." }],
  });
  assert.deepEqual(db.beat().meta.cast, ["Miko", "Astronaut Rei"]);
  assert.deepEqual(out.cast_added, ["Astronaut Rei"]);
  assert.ok(out.warnings.some((w) => w.includes("added Astronaut Rei")));
});

test("an offscreen line does not stage its speaker", async () => {
  // That flag means the camera is elsewhere. Staging them would put a body on
  // screen the shot says is not there.
  const db = stub();
  await add({
    action: "The empty corridor.", cast: ["Miko"],
    dialogue: [{ speaker: "Astronaut Rei", line: "Where are you?", offscreen: true }],
  });
  assert.deepEqual(db.beat().meta.cast, ["Miko"], "a voice-over is not in the frame");
  assert.equal(db.beat().dialogue[0].offscreen, true);
});

test("the shot is lengthened to fit its lines", async () => {
  // storyplan.shot_floor_ms's rule, which the planner applies to every dialogue
  // shot it writes and nothing applied to one added by hand: the 6s default
  // takes a twenty-word line and delivers DIALOGUE_CUTOFF. The floor RAISES an
  // explicit duration_ms rather than yielding to it.
  const db = stub();
  const out = await add({
    action: "Rei explains.", cast: ["Astronaut Rei"], duration_ms: 3000,
    dialogue: [{ speaker: "Astronaut Rei", line: Array(20).fill("word").join(" ") }],
  });
  assert.equal(db.beat().duration_ms, 11200);        // 20/2.0s + 1200ms pad
  assert.equal(db.block().t_end_ms - db.block().t_start_ms, 11200, "the block moved with it");
  assert.ok(out.warnings.some((w) => w.includes("lengthened the shot to 11.2s")));
});

test("lines too long for any block are reported, not silently cut", async () => {
  // A block has a ceiling, so past it the line is cut off however long the shot
  // is asked to be. Saying so here beats finding it as DIALOGUE_CUTOFF in a
  // review two renders later.
  const db = stub();
  const out = await add({
    action: "Rei explains at length.", cast: ["Astronaut Rei"],
    dialogue: [{ speaker: "Astronaut Rei", line: Array(30).fill("word").join(" ") }],
  });
  assert.equal(db.beat().duration_ms, MAX_CONTENT_MS);
  assert.ok(out.warnings.some((w) => w.includes("cut off") && w.includes("two shots")));
});

test("an unknown speaker is reported rather than dropped", async () => {
  // The line is still written — losing it would be worse — but the name is
  // named, the way an uncastable `cast` entry is.
  const db = stub();
  const out = await add({
    action: "Someone shouts.", cast: ["Miko"],
    dialogue: [{ speaker: "Nobody", line: "Hey!" }],
  });
  assert.equal(db.beat().dialogue[0].speaker_id, null);
  assert.ok(out.not_in_bible.includes("Nobody"));
});

test("the render is queued after the lines are written", async () => {
  // The whole reason the argument belongs on THIS tool rather than in a
  // follow-up update_beat: that call lands after the job is queued, and whether
  // it beats the worker to the row is a race.
  const db = stub();
  await runTool("add_block", {
    action: "Rei turns.", cast: ["Astronaut Rei"],
    dialogue: [{ speaker: "Astronaut Rei", line: "Now." }],
  }, CTX);
  const tables = db.tables();
  assert.ok(tables.indexOf("beats") < tables.indexOf("jobs"));
  assert.equal(db.writes.find(([t]) => t === "jobs")[1].kind, "master_pass");
});

test("a shot with no lines writes the row it always wrote", async () => {
  // The dialogue key is written only when there is dialogue, so nothing about a
  // shot added without any changed.
  const db = stub();
  await add({ action: "A wide of the city." });
  assert.deepEqual(Object.keys(db.beat()).sort(),
    ["action", "camera", "duration_ms", "idx", "meta", "scene_id"]);
});
