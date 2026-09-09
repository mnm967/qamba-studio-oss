// The wizard's interview, wherever it runs — pinned by parsing the source.
//
// `localBrief.ts` and `director.ts` both reach `lib/supabase`, whose
// extensionless `.js` specifier `node --test` cannot resolve, so this is the
// same corner `directorBackends.test.ts` and `scoreTrack.test.ts` are in. It
// is worth the parse: every failure below is SILENT. An interview with the
// wrong toolset still talks, a turn routed to the studio for a project the
// studio cannot see still renders a chat box, and a tool that reaches past
// `planeRouter` still returns rows — just not this project's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f: string) =>
  readFileSync(new URL(f, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const brief = read("./localBrief.ts");
const director = read("./director.ts");

/** A named function or arrow's body, from its declaration to the next one. */
function block(src: string, start: string): string {
  const i = src.indexOf(start);
  assert.ok(i > 0, `${start} not found — the scanner is broken`);
  return src.slice(i, i + 4000);
}

test("the interview reaches the database through planeRouter, never past it", () => {
  // THE WHOLE REASON THIS TOOLSET CAN RUN ON A LOCAL PROJECT. `localDirector`'s
  // forty tools fetch PostgREST directly, which is why they are refused there
  // (`LOCAL_PROJECT_REFUSAL`); every call here goes through `supabase.from`, so
  // it lands on whichever plane the project is on. A raw fetch smuggled in
  // later would read the studio's copy of a project that is on this disk and
  // report success.
  assert.match(brief, /import \{ supabase \} from "\.\/supabase"/);
  assert.ok(!/\bfetch\(/.test(brief), "localBrief fetches directly — that bypasses planeRouter");
  assert.ok(!/rest\/v1/.test(brief), "localBrief builds a PostgREST URL itself");
});

test("note_brief writes the row the wizard renders, and says so when it cannot", () => {
  const fn = block(brief, 'if (name === "note_brief")');
  // The merge is the SHARED one, so the three runners cannot disagree about
  // what a patch means.
  assert.match(fn, /mergeBrief\(ctx\.brief, input\)/);
  assert.match(fn, /from\("chat_threads"\)[\s\S]*?\.update\(\{ brief: ctx\.brief \}\)/);
  // A failed write is not a detail: an interview that believes it wrote
  // something down asks about it once and never again.
  assert.match(fn, /if \(error\) return \{ error:/);
  // The PATCH goes back with the merged brief, or an entry the merge dropped
  // (a named list sent as bare strings) is answered with `noted: true` over a
  // list that lost it — silence being the worst version of that failure.
  assert.match(fn, /noteBriefResult\(ctx\.brief, input\)/);
});

test("the interview's tools are the interview's, not the director's", () => {
  // The bug this pins: `queueLocalDirectorTurn` hands out the DIRECTOR's forty
  // by default, so a turn answered on this machine was offered `add_scene` and
  // `plan_storyboard` — which the interview's own contract forbids — and NOT
  // `note_brief`, the one tool it exists to call. It talked, and the brief
  // panel beside it stayed empty for the whole conversation.
  const fn = block(director, "export async function queueLocalBriefTurn");
  // `\b` matters: without it `_toolset:` — or any other rename — still
  // matches as a substring, and the test passes over the exact edit it is
  // here to catch. Caught by mutating it.
  assert.match(fn, /\btoolset: \(info\) => \(\{/, "queueLocalBriefTurn no longer passes a toolset");
  assert.match(fn, /tools: BRIEF_TOOLS/);
  assert.match(fn, /run: \(name, input, ctx\) => runBriefTool\(/);
});

test("the director's own toolset runs there too, through the plane", () => {
  // It used to be refused, and the refusal was correct while the toolset
  // fetched PostgREST directly. `localDirector`'s db goes through `localRest`
  // now — the same translator the studio's pipeline Python already uses for a
  // local project — so the forty tools read and write the rows that are on
  // screen, and the side chat works on either plane.
  const ld = read("./localDirector.ts");
  assert.match(ld, /localRest\(planesFor\(store\)/,
    "localDirector no longer routes its db through the local plane");
  assert.ok(!/planeIsLocal\(\)/.test(ld),
    "localDirector still refuses a plane its db can now answer");
  // And the turn runner no longer refuses one.
  const fn = block(director, "export async function queueLocalDirectorTurn");
  assert.ok(!/LOCAL_PROJECT_REFUSAL/.test(fn), "the turn runner still refuses a local project");
});

test("a job is the one thing that still names a queue, so it goes through enqueueJob", () => {
  // Fifteen tools write `lane: "gpu"` outright. On a local project those
  // queues belong to a pod that cannot see the rows, so the job is not slow —
  // it is unclaimable, and nothing says so. `enqueueJob` corrects the kinds
  // this build serves and refuses the rest BY NAME.
  const ld = read("./localDirector.ts");
  const ins = ld.slice(ld.indexOf("  ins: async (table: string"), ld.indexOf("  upd: async"));
  assert.match(ins, /table === "jobs"/);
  assert.match(ins, /enqueueJob\(/);
});


test("the refusal survives the banner that shows it", () => {
  // `describeDirectorError` elides anything over 160 characters, and this is
  // shown through it. Over the cap, the half that falls off is the END — which
  // is where the way out is written, so the user is left with the diagnosis
  // and none of the remedy. Measured in the running app before it was
  // shortened: "…— open a cloud…".
  const CAP = 160;
  const at = director.indexOf(`"No model on this machine can answer that yet`);
  assert.ok(at > 0, "the no-model refusal moved — this scanner is stale");
  const lit = director.slice(at, director.indexOf(");", at));
  // The source spells it as adjacent "…" + "…" chunks; the string is what
  // those chunks say, so read the quoted parts and join them.
  const text = [...lit.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
  assert.ok(text.length <= CAP, `the no-model refusal is ${text.length} chars and will be elided`);
  // And it still names what to do, which is what the cap was eating.
  assert.match(text, /engine window/);
});
