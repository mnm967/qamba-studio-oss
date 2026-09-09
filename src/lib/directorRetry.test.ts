// node --test src/lib/directorRetry.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  exchangeToUndo, firstText, retryPlan, turnFromRow, unansweredTurnId, type TranscriptRow,
} from "./directorRetry.ts";

const user = (id: string, text: string): TranscriptRow =>
  ({ id, role: "user", content: [{ type: "text", text }] });
const reply = (id: string, text: string): TranscriptRow =>
  ({ id, role: "assistant", content: [{ type: "text", text }] });

/** In session: the dock watched this turn fail, so rows after the user's
 *  message are its leavings. From the TRANSCRIPT after a reload it knows
 *  nothing, and the same rows mean the opposite. */
const SEEN = { failed: true };
const RELOADED = { failed: false };

test("the failed reply goes and the turn resumes onto the row already there", () => {
  // Newest first, as the query returns them: the local path's "⚠" reply sits
  // in front of the user message the turn never got answered.
  const rows = [reply("a1", "⚠ rate limited"), user("u1", "regenerate this block"),
                reply("a0", "done"), user("u0", "earlier")];
  const p = retryPlan(rows, "regenerate this block", SEEN);
  assert.deepEqual(p.clear, ["a1"], "only what was written after the last user message");
  assert.equal(p.resume, true);
});

test("a hosted failure leaves no reply, so nothing is deleted", () => {
  const rows = [user("u1", "hello"), reply("a0", "hi"), user("u0", "earlier")];
  const p = retryPlan(rows, "hello", SEEN);
  assert.deepEqual(p.clear, []);
  assert.equal(p.resume, true);
});

test("a failure BEFORE the row was written answers nothing that is already there", () => {
  // A 401 never reaches the insert, so the trailing user message is the
  // PREVIOUS turn — resuming would answer it instead.
  const rows = [reply("a0", "hi"), user("u0", "an earlier question")];
  const p = retryPlan(rows, "the turn that never landed", SEEN);
  assert.equal(p.resume, false);
  assert.deepEqual(p.clear, ["a0"], "the reply to that earlier turn is not this turn's");
});

test("an empty thread posts the turn fresh and touches nothing", () => {
  assert.deepEqual(retryPlan([], "hello", SEEN), { clear: [], resume: false, answered: false });
});

test("with no user message in the window nothing is deleted on a guess", () => {
  // A reply is minutes of somebody's conversation and is recoverable from
  // nowhere; the retry posts fresh rather than clearing rows it cannot
  // attribute to the failure.
  const rows = [reply("a1", "…"), reply("a0", "…")];
  assert.deepEqual(retryPlan(rows, "x", SEEN), { clear: [], resume: false, answered: false });
});

test("whitespace does not decide whether the row is this turn", () => {
  const rows = [user("u1", "  regenerate   this\nblock ")];
  assert.equal(retryPlan(rows, "regenerate this block", SEEN).resume, true);
});

test("a different question is not this turn, however close", () => {
  const rows = [user("u1", "regenerate this block")];
  assert.equal(retryPlan(rows, "regenerate that block", SEEN).resume, false);
});

test("firstText reads the words past whatever else the row carries", () => {
  assert.equal(firstText([{ type: "asset_ref", asset_id: "a" },
                          { type: "text", text: "look at this" }]), "look at this");
  assert.equal(firstText([{ type: "text", text: "   " }]), "");
  assert.equal(firstText(null), "");
});

/* ── the three places the rule has to hold, parsed ───────────────────────
   The handler is a Vercel function and the local runner reaches Supabase at
   import, so neither can be called from here. What these pin is the part
   whose failure is silent: a retry that posts the turn a SECOND time reads
   as the director having been asked twice, and nothing errors. */
import { readFileSync } from "node:fs";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the local runner honours resume from the request as well as from the wizard", () => {
  const src = read("./director.ts");
  const at = src.indexOf("const resume = opts.resume ?? body.resume");
  assert.ok(at > 0, "queueLocalDirectorTurn no longer reads `resume` off the request");
  assert.match(src.slice(at, at + 200), /if \(!resume\) \{/,
    "the user-message insert is what `resume` skips");
});

test("a turn that reported an error keeps its words and its pictures", () => {
  const src = read("../components/shell/DirectorDock.tsx");
  // The hosted handler has its headers out before a backend chain can be
  // exhausted, so a rate limit arrives as an EVENT and the promise resolves.
  assert.match(src, /ev\.t === "error"\) \{ failed = true;/,
    "an error event has to mark the turn failed, or the success path runs");
  assert.match(src, /if \(!failed\) \{\s*\n\s*setAttachments\(\[\]\);/,
    "clearing the composer is conditional on the turn having succeeded");
  assert.match(src, /pendingRef\.current = \{ text, attachments: sending, context, pick \}/,
    "the whole turn is held, not just its text — a retry re-sends the pictures");
  assert.match(src, /const context = held\?\.context \?\? situation\(\)/,
    "a retry keeps the screen it was asked against, or 'this block' moves");
});

test("the client tells an exhausted balance apart from a rate limit too", () => {
  // The twin of `explainError`'s rule (api/director/_backends.js): both
  // arrive as 429, one clears in a moment and the other never does, and the
  // Retry button beside the message is only honest if the message is.
  const src = read("./director.ts");
  const at = src.indexOf("export function describeDirectorError");
  const body = src.slice(at, src.indexOf("\n}", at));
  const credit = body.indexOf("credit_balance_exhausted");
  const rate = body.indexOf("rate limited");
  assert.ok(credit > 0, "describeDirectorError no longer names an exhausted balance");
  assert.ok(credit < rate, "the credit test has to run FIRST — a 429 matches both");
  assert.match(body, /switch the model below/,
    "it names the control that fixes it, since a retry cannot");
});

/* ── the retry a reload survives ─────────────────────────────────────── */

test("A REPLY THAT ARRIVED IS NEVER DELETED BY A RETRY THAT DID NOT SEE THE FAILURE", () => {
  // The turn failed, the tab was reloaded, and the answer landed while the
  // user was away. In session those rows are a failure marker and clearing
  // them is right; here the same rows are minutes of somebody's conversation.
  const rows = [reply("a1", "here is the new sequence"), user("u1", "regenerate this block")];
  const p = retryPlan(rows, "regenerate this block", RELOADED);
  assert.equal(p.answered, true);
  assert.deepEqual(p.clear, [], "nothing is deleted — the turn was answered after all");
  assert.equal(p.resume, false);
  // …and the in-session reading of the very same rows still clears.
  assert.deepEqual(retryPlan(rows, "regenerate this block", SEEN).clear, ["a1"]);
});

test("a reloaded retry of a genuinely unanswered turn resumes onto its row", () => {
  const rows = [user("u1", "regenerate this block"), reply("a0", "earlier")];
  const p = retryPlan(rows, "regenerate this block", RELOADED);
  assert.equal(p.answered, false);
  assert.equal(p.resume, true);
  assert.deepEqual(p.clear, []);
});

test("the turn is read back off the row, pictures and all", () => {
  // The persisted shape both transports write: the words, then one content
  // block per attachment. This is what makes a retry survive a reload — the
  // row is still there, which is why its thumbnails still render.
  const t = turnFromRow([
    { type: "text", text: "regenerate this block" },
    { type: "asset_ref", asset_id: "as-1", b2_key: "k/1.png", media: "image",
      label: "portal", width: 1280, height: 720, duration_ms: null },
    { type: "block_ref", block_id: "blk-9", label: "Block 20", idx: 19 },
  ]);
  assert.equal(t.text, "regenerate this block");
  assert.deepEqual(t.attachments, [
    { kind: "asset", id: "as-1", b2_key: "k/1.png", media: "image", label: "portal",
      width: 1280, height: 720 },
    { kind: "block", id: "blk-9", label: "Block 20", idx: 19 },
  ]);
});

test("a row with nothing on it yields an empty turn rather than a half one", () => {
  assert.deepEqual(turnFromRow(null), { text: "", attachments: [] });
  assert.deepEqual(turnFromRow([{ type: "asset_ref" }]), { text: "", attachments: [] },
                   "an asset_ref with no id is not an attachment");
});

test("only a TRAILING user message is unanswered", () => {
  const u = { id: "u1", role: "user" };
  const a = { id: "a1", role: "assistant" };
  assert.equal(unansweredTurnId([a, u]), "u1");
  assert.equal(unansweredTurnId([u, a]), null, "a reply follows it — it was answered");
  assert.equal(unansweredTurnId([]), null);
  assert.equal(unansweredTurnId([u, { id: "u2", role: "user" }]), "u2",
               "the LAST one, not the first unanswered one");
});

/* ── what a revert takes back ────────────────────────────────────────── */

test("the exchange is the reply and the message that asked for it, and no further", () => {
  // Newest first. Reverting a1 must not reach past u1 into the turn before —
  // that is somebody else's question and the answer later turns were written
  // against.
  const rows = [reply("a1", "done"), user("u1", "regenerate this block"),
                reply("a0", "earlier"), user("u0", "earlier question")];
  const p = exchangeToUndo(rows, "a1");
  assert.deepEqual(p?.ids, ["a1", "u1"]);
  assert.equal(p?.asked?.id, "u1");
});

test("everything the turn left goes with it", () => {
  // A turn can leave more than one row: a partial, a tool-only message.
  const rows = [reply("a2", "…"), reply("a1", "done"), user("u1", "ask"), reply("a0", "old")];
  assert.deepEqual(exchangeToUndo(rows, "a1")?.ids, ["a1", "u1"]);
  assert.deepEqual(exchangeToUndo(rows, "a2")?.ids, ["a2", "a1", "u1"]);
});

test("with no question in the window the reply goes alone", () => {
  // Guessing further back is how a revert eats the turn before it.
  const rows = [reply("a1", "done"), reply("a0", "also a reply")];
  assert.deepEqual(exchangeToUndo(rows, "a1"), { ids: ["a1"], asked: null });
});

test("a reply that is not in the window is refused, not approximated", () => {
  assert.equal(exchangeToUndo([reply("a1", "x")], "a-gone"), null);
});

test("the picker's live value rides the turn rather than waiting on the project row", () => {
  // Picking a checkpoint writes `projects.settings` AND sends the id with the
  // turn. Without the second, a pick and a send in the same breath read the
  // row as it was — which is the picker deciding nothing, one round trip wide.
  const dock = read("../components/shell/DirectorDock.tsx");
  assert.match(dock, /video_model: activeVideoModel/,
    "the dock no longer sends what the VIDEO chip says");
  assert.match(read("./director.ts"), /body\.video_model \? \{ video_model: body\.video_model \}/,
    "the turn runner no longer lets the sent value override the project row");
});

test("a revert of the last exchange hands the message back to the composer", () => {
  const dock = read("../components/shell/DirectorDock.tsx");
  assert.match(dock, /const restoreTurn = /,
    "nothing puts a reverted turn back in the composer");
  assert.match(dock, /setAttachments\(turn\.attachments as ChatAttachment\[\]\)/,
    "the pictures come back too, or the turn cannot be sent again as it was");
  assert.match(dock, /isLast: m\.id === lastId/,
    "the conversation is only taken back when the reply IS the last thing said");
  // …and the writes go back BEFORE the transcript does: a revert that cleared
  // the conversation and then failed would leave no record of what was done.
  const dlg = read("../components/modals/RevertTurnDialog.tsx");
  // Scoped to the handler, not the file: the import line names it too.
  const run = dlg.slice(dlg.indexOf("const run = async"));
  assert.ok(run.indexOf("await revertTurn(ops)") < run.indexOf("undoTurnMessages"),
            "the transcript is cleared before the writes are put back");
});
