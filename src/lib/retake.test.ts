// Every case here is a failure that produces a plausible-looking render rather
// than an error, which is why the logic lives outside the component at all.
import assert from "node:assert/strict";
import test from "node:test";

import {
  COPY, defaultMode, defaultSeedMode, editBlocker, editPayload, footerSummary,
  danglingPictureRefs, isUsableAnchor, queueBlocker, readsAsRemoval, resolveAnchor,
  rollSeed, splitRefs,
  type TakeRef,
} from "./retake.ts";

const H3 = { multiRef: 9, refVideos: 3, refAudios: 3, audio: true };
const H3_MODES = ["t2v", "i2v", "flf", "r2v"];
const LTX = { multiRef: 4, audio: true };
const LTX_MODES = ["t2v", "r2v"];         // r2v here is LTX's MSR guide — images only
const take = (id: string, o: Partial<TakeRef> = {}): TakeRef =>
  ({ id, asset_id: `a-${id}`, state: "pending", ...o });

// ── Edit availability ───────────────────────────────────────────────────────

test("edit needs something to hold", () => {
  assert.match(editBlocker([], H3, "MiniMax H3", H3_MODES), /Nothing rendered yet/);
  assert.equal(editBlocker([take("t1")], H3, "MiniMax H3", H3_MODES), "");
});

test("a rejected take is not an anchor", () => {
  assert.match(editBlocker([take("t1", { state: "rejected" })], H3, "H3", H3_MODES),
    /Nothing rendered/);
  assert.equal(isUsableAnchor(take("t1", { state: "rejected" })), false);
  assert.equal(isUsableAnchor({ id: "t2", asset_id: "" }), false);
});

test("a model with no video-reference CAPACITY cannot anchor an edit", () => {
  // A hypothetical model whose modes list r2v but whose capabilities declare
  // no video-reference budget at all — the budget check has to fire on its
  // own, independent of the mode check below.
  const why = editBlocker([take("t1")], {}, "Some Model", ["t2v", "r2v"]);
  assert.match(why, /Some Model/);
  assert.match(why, /doesn't render r2v/);
});

test("a model whose modes don't list r2v cannot anchor an edit either", () => {
  // `handle_video_edit` renders on a HARDCODED "r2v" — it never reads
  // `block.mode` and has no v2v path — so a model that declares refVideos
  // without listing r2v among its modes would pass the budget check, queue
  // clean, and die server-side on `mode 'r2v' not available for <model>`.
  // Catching it here turns that into a disabled tab instead of a failed job.
  const why = editBlocker([take("t1")], H3, "Some Model", ["t2v", "i2v", "flf"]);
  assert.match(why, /Some Model/);
  assert.match(why, /doesn't render r2v/);
});

test("LTX cannot anchor an edit — no video-reference capacity, whatever its modes say", () => {
  // LTX 2.5's MSR guide is four subject slots plus a background — images only.
  // Offering Edit there would stage nothing and render a plain regenerate.
  const why = editBlocker([take("t1")], LTX, "LTX 2.5", LTX_MODES);
  assert.match(why, /LTX 2\.5/);
  assert.match(why, /doesn't render r2v/);
  assert.equal(defaultMode([take("t1")], LTX, "LTX 2.5", LTX_MODES), "regenerate");
});

test("default intent follows what exists, on a model that CAN anchor an edit", () => {
  assert.equal(defaultMode([], H3, "H3", H3_MODES), "regenerate");
  assert.equal(defaultMode([take("t1")], H3, "H3", H3_MODES), "edit");
});

test("a model with no modes declared at all defaults to regenerate", () => {
  // The `modes` param defaults to [] — an omitted call site (a model row with
  // no `modes` array yet) must fail closed, not open.
  assert.equal(defaultMode([take("t1")], H3, "H3"), "regenerate");
});

// ── Anchor resolution ───────────────────────────────────────────────────────

test("the anchor falls back to the active take when its own take is gone", () => {
  const takes = [take("t1"), take("t2")];
  const r = resolveAnchor(takes, "deleted", "t2");
  assert.equal(r.take?.id, "t2");
  assert.equal(r.fellBack, true, "the fallback has to be reportable, not silent");
  assert.equal(r.index, 2);
});

test("a rejected anchor falls back too", () => {
  const takes = [take("t1"), take("t2", { state: "rejected" })];
  assert.equal(resolveAnchor(takes, "t2", "t1").take?.id, "t1");
});

test("no fallback flag when the asked-for take is there", () => {
  const takes = [take("t1"), take("t2")];
  const r = resolveAnchor(takes, "t1", "t2");
  assert.equal(r.take?.id, "t1");
  assert.equal(r.fellBack, false);
  assert.equal(r.index, 1);
});

test("the anchor's number counts every take, not the usable ones", () => {
  // The number has to match the takes strip the user is reading. Numbering
  // over the filtered list would call take 3 "take 2" the moment take 2 was
  // rejected — and then "anchor take 2" in the footer names the wrong footage.
  const takes = [take("t1"), take("t2", { state: "rejected" }), take("t3")];
  assert.equal(resolveAnchor(takes, "t3", null).index, 3);
});

test("nothing usable resolves to nothing rather than to a dead id", () => {
  const r = resolveAnchor([take("t1", { state: "rejected" })], "t1", "t1");
  assert.equal(r.take, null);
  assert.equal(r.index, 0);
});

// ── Copy ────────────────────────────────────────────────────────────────────

test("the edit tab's second line is live state", () => {
  assert.equal(COPY.edit.tabSub(1, true), "holding take 1 · change one thing");
  assert.equal(COPY.edit.tabSub(1, false), "hold take 1 · change one thing");
  assert.equal(COPY.edit.tabSub(0, false), "change one thing");
});

test("each mode names its own take number on the primary", () => {
  assert.equal(COPY.regenerate.primary(4), "Regenerate as take 4");
  assert.equal(COPY.edit.primary(4), "Edit into take 4");
});

// ── Seed ────────────────────────────────────────────────────────────────────

test("regenerate rolls, edit holds", () => {
  assert.equal(defaultSeedMode("regenerate"), "roll");
  assert.equal(defaultSeedMode("edit"), "hold");
});

test("a rolled seed is in range and not the sentinel 42", () => {
  assert.equal(rollSeed(() => 0), 1000);
  assert.equal(rollSeed(() => 0.9999), 9999);
});

// ── Reference accounting ────────────────────────────────────────────────────

test("voice references are audio and never counted as pictures", () => {
  const plan = [
    { purpose: "character", asset_id: "a" },
    { purpose: "voice", asset_id: "v1" },
    { purpose: "look", asset_id: "b" },
    { purpose: "voice", asset_id: "v2" },
  ];
  const { pictures, voices } = splitRefs(plan);
  assert.equal(pictures.length, 2, "8 pictures + 2 voices must not read as 10/9");
  assert.equal(voices.length, 2);
  assert.deepEqual(voices.map((v) => v.asset_id), ["v1", "v2"]);
});

// ── Footer ──────────────────────────────────────────────────────────────────

test("the footer says which intent is loaded", () => {
  const base = { refCount: 3, seed: 42, width: 1280, height: 736 } as const;
  assert.equal(
    footerSummary({ ...base, mode: "regenerate", anchorNo: 0, seedMode: "roll" }),
    "3 refs · new seed · 1280×736");
  assert.equal(
    footerSummary({ ...base, mode: "edit", anchorNo: 1, seedMode: "hold" }),
    "anchor take 1 · 3 refs · seed 42 locked · 1280×736");
});

test("one reference is singular", () => {
  assert.match(
    footerSummary({ mode: "regenerate", anchorNo: 0, refCount: 1, seedMode: "roll",
                    seed: null, width: 1280, height: 736 }),
    /^1 ref · /);
});

// ── Queue gate ──────────────────────────────────────────────────────────────

test("regenerate queues with an empty brief", () => {
  assert.equal(
    queueBlocker({ mode: "regenerate", brief: "", anchor: null, editWhy: "", refs: 0 }), "");
});

test("an edit with no instruction is refused", () => {
  // It would re-render the take as it is, at full cost, and the result would
  // look like the edit silently did nothing.
  assert.match(
    queueBlocker({ mode: "edit", brief: "   ", anchor: take("t1"), editWhy: "", refs: 0 }),
    /Say what the edit changes/);
});

test("the edit gate reports the capability reason first", () => {
  assert.match(
    queueBlocker({ mode: "edit", brief: "make it night", anchor: take("t1"),
                   editWhy: "LTX 2.5 takes no video reference", refs: 0 }),
    /LTX 2\.5/);
});

// ── A named picture with nothing staged ─────────────────────────────────────
//
// The twin of worker/h3_prompt.py's `dangling_picture_refs`, whose docstring
// carries the measurement. Naming a picture is what binds the change to it;
// a name with no picture behind it is an instruction pointing at nothing, and
// the render comes back unchanged with nothing saying why. Easy to hit HERE
// specifically, because the edit grid starts empty and never inherits the
// block's staged set.

test("a brief naming a picture nothing staged is refused", () => {
  const why = queueBlocker({ mode: "edit", refs: 0, anchor: take("t1"), editWhy: "",
                             brief: "she should be holding the photo in Picture 1" });
  assert.match(why, /Picture 1/);
  assert.match(why, /start empty/);
});

test("a brief naming a picture that IS staged queues", () => {
  assert.equal(
    queueBlocker({ mode: "edit", refs: 1, anchor: take("t1"), editWhy: "",
                   brief: "she holds the photograph from Picture 1" }), "");
});

test("the label check is off on regenerate", () => {
  // That brief goes to the reviser, which rewrites beats — there is no
  // <Picture N> numbering on that path for a label to dangle against.
  assert.equal(
    queueBlocker({ mode: "regenerate", refs: 0, anchor: null, editWhy: "",
                   brief: "put Picture 1 in her hands" }), "");
});

test("a dangling label is named, and a legal one is not", () => {
  assert.deepEqual(danglingPictureRefs("use Picture 1", 0), [1]);
  assert.deepEqual(danglingPictureRefs("use <Picture 3> and Picture 1", 2), [3]);
  assert.deepEqual(danglingPictureRefs("use Picture 1 and Picture 2", 2), []);
  assert.deepEqual(danglingPictureRefs("Picture 0", 2), [0]);
});

test("prose about the shot is not a label", () => {
  // A FALSE POSITIVE REFUSES AN EDIT THAT WOULD HAVE WORKED, so only the word
  // the envelope emits counts, and only with a number after it.
  for (const prose of ["the picture she is holding", "make the image warmer",
                       "replace the photograph in her hands with the astronaut sheet",
                       "reference 2 of her coat"]) {
    assert.deepEqual(danglingPictureRefs(prose, 0), [], prose);
  }
});

test("the detector holds no state between calls", () => {
  // A hoisted /g regex carries lastIndex, and the second call would then start
  // mid-string and report a legal brief as clean or a dangling one as fine.
  const b = "use Picture 4";
  assert.deepEqual(danglingPictureRefs(b, 0), danglingPictureRefs(b, 0));
});

// ── A brief that asks for a subtraction ─────────────────────────────────────
//
// Both real cases below were typed into this box and rendered the thing they
// asked to be rid of. The model adds what it is told and cannot remove, and
// the brief reaches the render verbatim, so nothing downstream repairs it.

test("a bare removal is spotted", () => {
  for (const b of ["remove the helmet from the floor",
                   "she should not be wearing glove",
                   "get rid of the second person",
                   "take the hat off",
                   "without the glasses",
                   "she should be only person in the room",
                   "no other people in the room",
                   "delete the sign"]) {
    assert.equal(readsAsRemoval(b), true, b);
  }
});

test("a brief that names what takes its place is left alone", () => {
  // Already the correct shape — the sharpen turn would change nothing, so
  // advising it would be noise on the one brief that got it right.
  for (const b of ["replace the helmet on the floor with bare floor and dust",
                   "her bare hand instead of the glove",
                   "swap the coat for a red one",
                   "in place of the sign, blank brick"]) {
    assert.equal(readsAsRemoval(b), false, b);
  }
});

test("an ordinary edit raises nothing", () => {
  for (const b of ["make it night",
                   "her coat is red",
                   "she turns her head more slowly",
                   "the photograph from Picture 1 in her hands",
                   ""]) {
    assert.equal(readsAsRemoval(b), false, b);
  }
});

// ── Payload ─────────────────────────────────────────────────────────────────

test("the edit payload names the model it was queued from", () => {
  const p = editPayload({
    anchor: take("t1"), anchorNo: 1, blockIdx: 9, brief: "  make it night  ",
    refAssetIds: ["r1", "r2"], seed: 42, modelKey: "minimax-h3-turbo",
    width: 1280, height: 736,
  });
  assert.equal(p.source_asset_id, "a-t1");
  assert.equal(p.prompt, "make it night");
  assert.equal(p.model_key, "minimax-h3-turbo",
    "the handler defaulted to plain H3, so an unnamed model is a silent downgrade");
  assert.deepEqual(p.ref_asset_ids, ["r1", "r2"]);
  assert.equal(p.activate, "review", "an edit is a proposal, not a replacement");
  // idx 9 is the TENTH block: refs count from one everywhere (director/refs.js).
  // This pinned "b9" — the 0-indexed label the shared helper replaced.
  assert.equal(p.label, "b10 edit of take 1");
});

test("a hosted model contributes no model_key", () => {
  // A key the worker cannot resolve fails the render — same rule as the
  // wizard's `*-local` gate.
  const p = editPayload({
    anchor: take("t1"), anchorNo: 1, blockIdx: 1, brief: "x",
    refAssetIds: [], seed: 1, modelKey: null,
  });
  assert.equal("model_key" in p, false);
  assert.equal("width" in p, false);
});

test("activate defaults to review and follows the caller when one was given", () => {
  // The default is the protection: an edit is a proposal, and PromptRefsModal
  // offers no other choice so it never passes one. The CLIP-BORN retake does
  // — "land beside the other takes" / "replace on the lane" is the first thing
  // on that screen — and a control that silently meant nothing would be worse
  // than no control.
  const base = {
    anchor: take("t1"), anchorNo: 1, blockIdx: 0, brief: "swap her coat",
    refAssetIds: [], seed: 7,
  };
  assert.equal(editPayload(base).activate, "review");
  assert.equal(editPayload({ ...base, activate: "review" }).activate, "review");
  assert.equal(editPayload({ ...base, activate: "replace" }).activate, "replace");
});
