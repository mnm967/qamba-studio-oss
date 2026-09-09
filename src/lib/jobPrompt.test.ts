// node --test src/lib/jobPrompt.test.ts
//
// The split this pins is the whole point of the module: a `master_pass` row
// must never present an editable prompt, because there is no prompt yet — the
// envelope is compiled from the beats when the worker claims the job, so a
// rewrite would be accepted, requeued and rendered unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_OVERRIDES, changedFields, describeJob, editBlocker, factValue,
} from "./jobPrompt.ts";

const job = (o: Record<string, unknown>) =>
  ({ kind: "clip_gen", status: "queued", payload: {}, ...o }) as Parameters<typeof describeJob>[0];

test("a clip_gen's prompt is the payload's, and it is editable", () => {
  const v = describeJob(job({ payload: { prompt: "a wide of the street" } }));
  assert.equal(v.shape, "payload");
  assert.equal(v.fields[0].key, "prompt");
  assert.equal(v.fields[0].value, "a wide of the street");
  assert.equal(editBlocker(job({ payload: { prompt: "x" } })), null);
});

test("a master_pass is COMPILED — no fields, and it says why", () => {
  const j = job({ kind: "master_pass", payload: { block_id: "b-1", label: "b4 re-render" } });
  const v = describeJob(j);
  assert.equal(v.shape, "compiled");
  assert.deepEqual(v.fields, []);
  assert.equal(v.blockId, "b-1");
  assert.match(v.note ?? "", /compiled from the block's beats/);
  // …and the blocker repeats it rather than saying "queued job only", which
  // would be true and useless — this row is queued.
  assert.match(editBlocker(j) ?? "", /compiled from the block's beats/);
});

test("a block re-render reports the overrides it DOES carry, ONCE", () => {
  // `model_key`, `steps` and `loras` are in both tables — they are "sent with
  // it" AND block-shaping flags — so listing them twice under two spellings
  // reads as two settings that happen to agree.
  const v = describeJob(job({
    kind: "master_pass",
    payload: { block_id: "b-1", model_key: "minimax-h3", steps: 20, fight: true,
               loras: [{ key: "combat", strength: 1 }] },
  }));
  const by = new Map(v.facts.map((f) => [f.label, f.value]));
  assert.equal(by.get("Model key"), "minimax-h3");
  assert.equal(by.get("LoRAs"), "combat@1");
  assert.equal(by.get("fight"), "true");        // only BLOCK_OVERRIDES has this
  assert.equal(v.facts.length, new Set(v.facts.map((f) => f.value)).size,
               `duplicated: ${v.facts.map((f) => f.label).join(", ")}`);
  assert.equal(v.facts.filter((f) => f.value === "minimax-h3").length, 1);
});

test("overrides nested under params are found too", () => {
  // handle_master_pass merges `{**block.params, **_block_params(payload)}`, and
  // launch_render sends the whole thing as `payload.params`.
  const v = describeJob(job({
    kind: "master_pass", payload: { block_id: "b", params: { model_key: "ltx-25" } },
  }));
  assert.ok(v.facts.some((f) => f.value === "ltx-25"), "params override not surfaced");
});

test("BLOCK_OVERRIDES mirrors the worker's _BLOCK_FLAGS", async () => {
  const src = await import("node:fs/promises")
    .then((fs) => fs.readFile("worker/handlers/blocks.py", "utf8"));
  const m = src.replace(/\r\n/g, "\n").match(/_BLOCK_FLAGS = \(([\s\S]*?)\)/);
  assert.ok(m, "could not find _BLOCK_FLAGS");
  const flags = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  assert.deepEqual([...BLOCK_OVERRIDES].sort(), flags.sort());
});

test("revise_block's BRIEF is what a block re-render actually reads", () => {
  // The master_pass DEPENDS on this row, so this is the editable text that
  // decides the prompt — one row upstream of the render.
  const v = describeJob(job({
    kind: "llm_task", payload: { task: "revise_block", block_id: "b", brief: "slower push in" },
  }));
  assert.equal(v.shape, "payload");
  assert.equal(v.fields[0].key, "brief");
  assert.equal(v.fields[0].value, "slower push in");
});

test("an llm_task with no editable task is reported, not guessed at", () => {
  const v = describeJob(job({ kind: "llm_task", payload: { task: "plan_storyboard" } }));
  assert.equal(v.shape, "none");
  assert.ok(v.facts.some((f) => f.label === "Task" && f.value === "plan_storyboard"));
});

test("a secondary field appears only where the enqueuer wrote one", () => {
  // The composer omits `negative` on a model that samples no negative branch,
  // so keying off presence is exactly the model gate without a catalog here.
  assert.equal(describeJob(job({ payload: { prompt: "p" } })).fields.length, 1);
  const both = describeJob(job({ payload: { prompt: "p", negative: "blurry" } }));
  assert.deepEqual(both.fields.map((f) => f.key), ["prompt", "negative"]);
});

test("the primary field shows even when it is empty", () => {
  const v = describeJob(job({ kind: "patch_flf", payload: { block_id: "b" } }));
  assert.deepEqual(v.fields.map((f) => f.key), ["prompt"]);
  assert.equal(v.fields[0].value, "");
});

test("tts calls its text `text`, and that is the key that travels", () => {
  const v = describeJob(job({ kind: "tts", payload: { text: "hello", emotion: "pleased" } }));
  assert.deepEqual(v.fields.map((f) => f.key), ["text", "emotion"]);
});

test("only a QUEUED job can be edited — the claim reads the payload once", () => {
  assert.match(editBlocker(job({ status: "running", payload: { prompt: "p" } })) ?? "",
               /already started/);
  assert.match(editBlocker(job({ status: "done", payload: { prompt: "p" } })) ?? "", /done/);
});

test("whitespace alone is not a change", () => {
  const v = describeJob(job({ payload: { prompt: "a wide" } }));
  assert.deepEqual(changedFields(v, { prompt: "  a wide \n" }), {});
  assert.deepEqual(changedFields(v, { prompt: "a close-up" }), { prompt: "a close-up" });
});

test("a LoRA stack prints as picks, not as JSON", () => {
  assert.equal(factValue([{ key: "combat", strength: 1 }, { key: "handheld", strength: 0.6 }]),
               "combat@1, handheld@0.6");
  assert.equal(factValue(["a", "b"]), "2 items");
  assert.equal(factValue(1280), "1280");
});

test("the payload's own value beats the one under params", () => {
  // `handle_master_pass` merges `{**block.params, **_block_params(payload)}`,
  // so a top-level flag is the override and params is the episode's default.
  const v = describeJob(job({
    kind: "master_pass",
    payload: { block_id: "b", model_key: "minimax-h3-turbo", params: { model_key: "ltx-25" } },
  }));
  assert.ok(v.facts.some((f) => f.value === "minimax-h3-turbo"));
  assert.ok(!v.facts.some((f) => f.value === "ltx-25"));
});
