// node --test director/brief.test.mjs
//
// The merge is the load-bearing part: the model streams only what it just
// learned, so a patch that drops earlier facts silently ruins the brief the
// planner receives. Mirrored by worker/tests/test_brief_merge.py for the
// Python twin.
import test from "node:test";
import assert from "node:assert/strict";
import {
  answeredQuestions, briefDigest, briefIsEmpty, briefPatchProblems, briefReadiness, briefToPlan,
  duplicateGroups, interviewSystem, mergeBrief, noteBriefResult,
} from "./brief.js";

test("a patch adds without erasing what came before", () => {
  const a = mergeBrief({}, { logline: "A diver returns to a drowned town.", tone: "elegiac" });
  const b = mergeBrief(a, { turn: "the town is inhabited" });
  assert.equal(b.logline, "A diver returns to a drowned town.");
  assert.equal(b.tone, "elegiac");
  assert.equal(b.turn, "the town is inhabited");
});

test("empty strings never overwrite a captured field", () => {
  const b = mergeBrief({ logline: "kept" }, { logline: "   ", tone: "cold" });
  assert.equal(b.logline, "kept");
  assert.equal(b.tone, "cold");
});

test("cast merges per name instead of appending duplicates", () => {
  const a = mergeBrief({}, { cast: [{ name: "Mara", role: "the diver" }] });
  const b = mergeBrief(a, { cast: [{ name: "mara", look: "shaved head, burn scar on the jaw" },
                                   { name: "Ivo", role: "harbourmaster" }] });
  assert.equal(b.cast.length, 2);
  assert.equal(b.cast[0].name, "Mara");        // a case-variant reference must not recase it
  assert.equal(b.cast[0].role, "the diver");
  assert.equal(b.cast[0].look, "shaved head, burn scar on the jaw");
  assert.equal(b.cast[1].name, "Ivo");
});

test("previous_name renames in place instead of duplicating", () => {
  const a = mergeBrief({}, { cast: [{ name: "Diver", role: "protagonist", look: "wetsuit, dive knife" }] });
  const b = mergeBrief(a, { cast: [{ name: "Mara", previous_name: "Diver",
                                     look: "shaved head, burn scar on the jaw" }] });
  assert.equal(b.cast.length, 1);
  assert.equal(b.cast[0].name, "Mara");
  assert.equal(b.cast[0].role, "protagonist");
  assert.equal(b.cast[0].look, "shaved head, burn scar on the jaw");
});

test("remove drops what the user vetoed, named or plain", () => {
  const a = mergeBrief({}, {
    cast: [{ name: "Mara" }, { name: "Ivo" }],
    references: ["Stalker", "Jaws"],
  });
  const b = mergeBrief(a, { remove: { cast: ["ivo"], references: ["Jaws"] } });
  assert.deepEqual(b.cast.map((c) => c.name), ["Mara"]);
  assert.deepEqual(b.references, ["Stalker"]);
});

test("lists union case-insensitively", () => {
  const b = mergeBrief({ references: ["Stalker"] }, { references: ["stalker", "Jaws"] });
  assert.deepEqual(b.references, ["Stalker", "Jaws"]);
});

test("answering a question takes it off the open list", () => {
  const a = mergeBrief({}, { open_questions: ["who owns the boat?", "what season?"] });
  const b = mergeBrief(a, { resolved_questions: ["Who owns the boat?"] });
  assert.deepEqual(b.open_questions, ["what season?"]);
});

test("open questions are gaps, not the question the model just asked", () => {
  const b = mergeBrief({}, { open_questions: [
    "tone: action or dread",                      // a stub — keep
    "what season",                                // a stub — keep
    "does the brother speak?",                    // still a stub — keep
    "What kind of excitement are you thinking about? Do you want it to feel like high-paced " +
    "action, a suspenseful moment, or something emotionally intense?",   // the transcript
    "Who is this story really about, and what do they stand to lose?",   // one sentence, still spoken
  ] });
  assert.deepEqual(b.open_questions,
                   ["tone: action or dread", "what season", "does the brother speak?"]);
});

test("questions stored before the rule existed clear on the next merge", () => {
  const stale = { open_questions: ["What kind of excitement are you thinking about? Do you want " +
                                   "high-paced action, or something emotionally intense?"] };
  assert.deepEqual(mergeBrief(stale, { open_questions: ["what season"] }).open_questions,
                   ["what season"]);
});

test("shape and expert notes merge field-wise, unknown experts dropped", () => {
  const a = mergeBrief({}, { shape: { length_s: 64 }, expert_notes: { vfx: "practical smoke" } });
  const b = mergeBrief(a, { shape: { structure: "cold open / turn / tag" },
                            expert_notes: { costume: "salt-bleached oilskin", astrology: "no" } });
  assert.equal(b.shape.length_s, 64);
  assert.equal(b.shape.structure, "cold open / turn / tag");
  assert.deepEqual(b.expert_notes, { vfx: "practical smoke", costume: "salt-bleached oilskin" });
});

test("readiness names what is missing and flips when it is all there", () => {
  assert.equal(briefIsEmpty({}), true);
  const thin = briefReadiness({ logline: "x" });
  assert.equal(thin.ready, false);
  assert.ok(thin.missing.includes("the turn"));

  const full = briefReadiness({
    logline: "A diver returns to a drowned town.", turn: "the town is inhabited",
    cast: [{ name: "Mara", look: "shaved head, burn scar" }],
    world: [{ name: "Halvard Bay" }], tone: "elegiac",
  });
  assert.equal(full.ready, true);
  assert.deepEqual(full.missing, []);
});

test("the model can withdraw ready even when the floor is met", () => {
  const b = { logline: "l", turn: "t", cast: [{ name: "M", look: "x" }],
              world: [{ name: "W" }], tone: "cold", ready: false };
  const r = briefReadiness(b);
  assert.equal(r.enough, true);
  assert.equal(r.ready, false);
});

test("the tool result mirrors the merged state back, with self-correction hints", () => {
  const quiet = noteBriefResult({ cast: [{ name: "Mara" }] });
  assert.deepEqual(quiet.cast, ["Mara"]);
  assert.equal(quiet.hint, undefined);        // one name, nothing open: no nagging

  // Two DIFFERENT people are not a problem and must not be reported as one:
  // the old rule nagged on any second cast name, i.e. on almost every turn,
  // which is how a hint stops being read.
  const two = noteBriefResult({ cast: [{ name: "the diver" }, { name: "Mara" }] });
  assert.equal(two.hint, undefined);

  const noisy = noteBriefResult({
    cast: [{ name: "the diver" }, { name: "The Divers" }],
    open_questions: ["what season?"],
  });
  assert.match(noisy.hint, /previous_name/);
  assert.match(noisy.hint, /resolved_questions/);
  assert.ok(noisy.still_missing.length);
});

test("briefToPlan carries every established fact into the planner notes", () => {
  const brief = {
    logline: "A diver returns to a drowned town.",
    turn: "the town is inhabited", tone: "elegiac", palette: "sodium orange on black water",
    cast: [{ name: "Mara", role: "the diver", look: "shaved head, burn scar", want: "her brother's body" }],
    world: [{ name: "Halvard Bay", when: "night", look: "flooded rooftops" }],
    props: [{ name: "brass lamp", why: "the only light" }],
    references: ["Stalker"], constraints: ["no dialogue underwater"],
    motifs: ["rising water"], open_questions: ["what season?"],
    shape: { length_s: 64, structure: "cold open / turn / tag" },
    expert_notes: { vfx: "practical smoke, no CG water" },
  };
  const { logline, notes } = briefToPlan(brief, { lengthS: 64, experts: ["vfx"], medium: "film" });
  assert.equal(logline, "A diver returns to a drowned town.");
  for (const bit of ["The turn: the town is inhabited",
                     "Cast · Mara: the diver — shaved head, burn scar — wants her brother's body",
                     "Location · Halvard Bay: night — flooded rooftops",
                     "Prop · brass lamp",
                     "References: Stalker",
                     "Constraints: no dialogue underwater",
                     "VFX note: practical smoke, no CG water",
                     "Left open", "Target length: 64s"]) {
    assert.ok(notes.includes(bit), `notes missing: ${bit}\n---\n${notes}`);
  }
});

test("briefToPlan falls back to the premise when there is no logline yet", () => {
  assert.equal(briefToPlan({ premise: "Two brothers, one boat." }).logline, "Two brothers, one boat.");
  assert.equal(briefToPlan({}).logline, "");
});

test("the interview prompt states what is still missing and the current brief", () => {
  const sys = interviewSystem({
    project: { title: "Halvard", medium: "film", style: "cinematic" },
    experts: ["vfx", "costume"], lengthS: 64,
    brief: { logline: "A diver returns." },
  });
  assert.ok(sys.includes("Halvard"));
  assert.ok(sys.includes("VFX"));
  assert.ok(sys.includes("Costume & continuity"));
  assert.ok(sys.includes("Still missing:"));
  assert.ok(sys.includes("the turn"));
  assert.ok(sys.includes("A diver returns."));
});

// ------------------------------------------------- user-supplied ref sheets ---
// A picture the user drags into the interview is the strongest thing they can
// say about a character, and the brief is where it stops being a thumbnail in a
// transcript and becomes something the planner can stage. Everything here
// guards one failure: an id that goes in and does not come out is a sheet
// silently redrawn from a paraphrase of itself.
const A1 = "11111111-2222-3333-4444-555555555555";
const A2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("a reference picture attaches to the cast member it shows", () => {
  const b = mergeBrief({}, { cast: [{ name: "Guide Rei", look: "silver undercut", ref_asset_ids: [A1] }] });
  assert.deepEqual(b.cast[0].ref_asset_ids, [A1]);
});

test("a second picture on a later turn is another sheet, not a correction", () => {
  const a = mergeBrief({}, { cast: [{ name: "Rei", ref_asset_ids: [A1] }] });
  const b = mergeBrief(a, { cast: [{ name: "Rei", ref_asset_ids: [A2] }] });
  assert.deepEqual(b.cast[0].ref_asset_ids, [A1, A2]);
  // ...and the same one twice is still one sheet.
  const c = mergeBrief(b, { cast: [{ name: "Rei", ref_asset_ids: [A1] }] });
  assert.deepEqual(c.cast[0].ref_asset_ids, [A1, A2]);
});

test("a patch that mentions someone without a picture keeps the pictures", () => {
  const a = mergeBrief({}, { cast: [{ name: "Rei", ref_asset_ids: [A1] }] });
  const b = mergeBrief(a, { cast: [{ name: "Rei", want: "to get out" }] });
  assert.deepEqual(b.cast[0].ref_asset_ids, [A1]);
  assert.equal(b.cast[0].want, "to get out");
});

test("a rename carries the pictures with it", () => {
  const a = mergeBrief({}, { cast: [{ name: "the guide", ref_asset_ids: [A1] }] });
  const b = mergeBrief(a, { cast: [{ name: "Rei", previous_name: "the guide" }] });
  assert.equal(b.cast.length, 1);
  assert.equal(b.cast[0].name, "Rei");
  assert.deepEqual(b.cast[0].ref_asset_ids, [A1]);
});

// A label reaching the planner as an id does not fail — it stages nothing and
// says nothing, which is the same silence as no sheet at all. So only ids get
// through, whatever wrapping the model puts round them.
test("only real asset ids get through", () => {
  const b = mergeBrief({}, {
    cast: [{ name: "Rei", ref_asset_ids: ["rei-sheet.png", "", `asset:${A1}`, `<${A2}>`] }],
  });
  assert.deepEqual(b.cast[0].ref_asset_ids, [A1, A2]);
});

test("a bare string is taken as one id, since models send one", () => {
  const b = mergeBrief({}, { world: [{ name: "The Loop", ref_asset_ids: A1 }] });
  assert.deepEqual(b.world[0].ref_asset_ids, [A1]);
});

test("locations and props carry pictures too", () => {
  const b = mergeBrief({}, {
    world: [{ name: "The Loop", ref_asset_ids: [A1] }],
    props: [{ name: "the polaroid", ref_asset_ids: [A2] }],
  });
  assert.deepEqual(b.world[0].ref_asset_ids, [A1]);
  assert.deepEqual(b.props[0].ref_asset_ids, [A2]);
});

test("a supplied sheet counts as a look — it is more than one", () => {
  const b = { logline: "x", turn: "y", tone: "cold",
              cast: [{ name: "Rei", ref_asset_ids: [A1] }], world: [{ name: "The Loop" }] };
  assert.ok(briefReadiness(b).enough, briefReadiness(b).missing.join(", "));
});

test("the planner is told the look is fixed, so the writer describes rather than redesigns", () => {
  const { notes } = briefToPlan({
    cast: [{ name: "Rei", look: "silver undercut", ref_asset_ids: [A1] },
           { name: "Miko", look: "an astronaut" }],
    world: [{ name: "The Loop", ref_asset_ids: [A1, A2] }],
  });
  assert.match(notes, /Cast · Rei:.*\[the user supplied a reference sheet for this one/);
  assert.match(notes, /Location · The Loop.*\[the user supplied 2 reference sheets/);
  // Nobody else gets the marker — it would read as a sheet that isn't there.
  assert.ok(!/Miko.*user supplied/.test(notes));
});

test("the interview is told what an attached picture is for", () => {
  const sys = interviewSystem({ project: { title: "x" }, brief: {} });
  assert.ok(sys.includes("ref_asset_ids"));
  assert.ok(sys.includes("[image asset <id>]"));
});

// -------------------------------------------------- one thing, one entry ---
// Measured on a real thread: a single marble came back as "Cloudy Glass
// Marbles", "Contained Black Hole Marble" and "Guide Rei's Cloudy Marble", and
// the planner would have rendered three reference sheets for it. Two separate
// blindnesses caused it — the model's view of its own brief was
// `JSON.stringify(brief).slice(0, 4000)` on a 14,670-character brief whose
// "props" key began at 3,960, and note_brief's mirror never returned props at
// all. It was being asked not to repeat itself about a list it could not see.
const MARBLE = "A small cloudy glass marble that unfolds into a thumb-sized perfectly black sphere";

test("a plural, a possessive or an article is the same entry, with no model involved", () => {
  const a = mergeBrief({}, { props: [{ name: "Cloudy Glass Marble", look: "small, cloudy" }] });
  const b = mergeBrief(a, { props: [{ name: "Cloudy Glass Marbles", why: "her countermeasure" }] });
  assert.equal(b.props.length, 1);
  assert.equal(b.props[0].look, "small, cloudy");
  assert.equal(b.props[0].why, "her countermeasure");

  const c = mergeBrief(b, { props: [{ name: "The Cloudy Glass Marble" }] });
  assert.equal(c.props.length, 1);
});

test("two genuinely different things stay two things", () => {
  const b = mergeBrief({}, { props: [{ name: "Portal Machine" }, { name: "Glass house reflection" }] });
  assert.equal(b.props.length, 2);
  assert.deepEqual(duplicateGroups(b.props), []);
});

test("names sharing no words are still caught when they describe one object", () => {
  const groups = duplicateGroups([
    { name: "Contained Black Hole Marble", look: `${MARBLE} edged by a thin ring.` },
    { name: "Guide Rei’s Cloudy Marble", look: `${MARBLE} edged by a thin ring of light.` },
    { name: "Portal Machine", look: "A tall brass frame that hums." },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], ["Contained Black Hole Marble", "Guide Rei’s Cloudy Marble"]);
});

test("entries with no description yet are not assumed to be the same", () => {
  assert.deepEqual(duplicateGroups([{ name: "a knife" }, { name: "a letter" }]), []);
});

test("note_brief reports the group and says what a duplicate actually costs", () => {
  const r = noteBriefResult({
    props: [{ name: "Cloudy Glass Marbles", look: `${MARBLE}.` },
            { name: "Contained Black Hole Marble", look: `${MARBLE}.` }],
  });
  // props are in the mirror at all — they never used to be
  assert.deepEqual(r.props, ["Cloudy Glass Marbles", "Contained Black Hole Marble"]);
  assert.match(r.hint, /Cloudy Glass Marbles/);
  assert.match(r.hint, /Contained Black Hole Marble/);
  assert.match(r.hint, /separate sheet/);
});

test("the roster the model sees is complete, and only the prose is clipped", () => {
  // The shape that broke it: lots of long-winded entries, props last.
  const brief = {
    logline: "x".repeat(400), premise: "y".repeat(400), turn: "z".repeat(400),
    tone: "t".repeat(400), palette: "p".repeat(400),
    cast: Array.from({ length: 6 }, (_, i) => ({ name: `Character ${i}`, look: "l".repeat(400) })),
    world: Array.from({ length: 7 }, (_, i) => ({ name: `Place ${i}`, look: "w".repeat(400) })),
    props: Array.from({ length: 7 }, (_, i) => ({ name: `Prop ${i}`, look: "q".repeat(400) })),
  };
  // The property that broke it, stated directly: under the old
  // `JSON.stringify(brief).slice(0, 4000)` the props list began well past the
  // cut, so the model's view of its own state ended before the list it was
  // being told not to duplicate. (Real thread: 14,670 chars, props at 3,960.)
  const raw = JSON.stringify(brief);
  assert.ok(raw.indexOf('"props"') > 4000, "fixture must reproduce the truncation");
  const digest = briefDigest(brief);
  for (let i = 0; i < 7; i++) {
    assert.ok(digest.includes(`Prop ${i}`), `roster lost Prop ${i}`);
    assert.ok(digest.includes(`Place ${i}`), `roster lost Place ${i}`);
  }
  for (let i = 0; i < 6; i++) assert.ok(digest.includes(`Character ${i}`));
  assert.ok(!digest.includes("q".repeat(200)), "prose should be clipped, not carried whole");
});

test("the roster says a sheet is attached, so the model stops offering to design one", () => {
  const digest = briefDigest({ cast: [{ name: "Rei", ref_asset_ids: [A1] }] });
  assert.match(digest, /Rei.*user sheet attached/);
});

test("the interview is told to check the roster before adding anything", () => {
  const sys = interviewSystem({ project: { title: "x" }, brief: { props: [{ name: "a marble" }] } });
  assert.match(sys, /check the roster/i);
  assert.ok(sys.includes("a marble"));
});

test("open questions are a working set, not a log", () => {
  // The real interview reached seventy, every one of them since answered, and
  // briefToPlan hands the list to the planner as "decide these yourself".
  const many = Array.from({ length: 70 }, (_, i) => `gap ${i}`);
  const b = mergeBrief({}, { open_questions: many });
  assert.equal(b.open_questions.length, 12);
  assert.equal(b.open_questions.at(-1), "gap 69", "newest is the live one");
  assert.ok(!b.open_questions.includes("gap 0"));
});

test("a reworded question replaces its earlier phrasing rather than joining it", () => {
  const b = mergeBrief({}, { open_questions: ["Rei's visual identity", "Rei visual identity"] });
  assert.deepEqual(b.open_questions, ["Rei visual identity"]);
});

test("a long-standing list is trimmed on the next merge, not just on the way in", () => {
  const stale = { open_questions: Array.from({ length: 40 }, (_, i) => `gap ${i}`) };
  assert.equal(mergeBrief(stale, { open_questions: ["one more"] }).open_questions.length, 12);
});

// ---------------------------------------------------------------- the song ---
// The interview is TOLD to ask about the track on a music video, and until
// `song` existed there was nowhere to put the answer: mergeBrief is a
// whitelist, so a lyric sheet the director wrote down was dropped on the floor
// while the tool call ticked green beside it. Then the wizard read the score
// card and not the brief, so an agreed song produced no track either.

test("a song written down in the interview is actually kept", () => {
  const b = mergeBrief({ logline: "x" }, {
    song: { lyrics: "[Verse]\nrain on the window", style: "dream pop, 76 BPM",
            length_s: 218, bpm: 76 },
  });
  assert.equal(b.song.lyrics, "[Verse]\nrain on the window");
  assert.equal(b.song.style, "dream pop, 76 BPM");
  assert.equal(b.song.length_s, 218);
  assert.equal(b.song.bpm, 76);
  assert.equal(b.logline, "x", "the rest of the brief survives");
});

test("a later turn refines the song without wiping the words", () => {
  const one = mergeBrief({}, { song: { lyrics: "[Verse]\nfirst", style: "folk" } });
  const two = mergeBrief(one, { song: { bpm: 90 } });
  assert.equal(two.song.lyrics, "[Verse]\nfirst");
  assert.equal(two.song.style, "folk");
  assert.equal(two.song.bpm, 90);
});

test("a rewritten lyric REPLACES rather than accumulating two drafts", () => {
  const one = mergeBrief({}, { song: { lyrics: "old chorus" } });
  const two = mergeBrief(one, { song: { lyrics: "new chorus" } });
  assert.equal(two.song.lyrics, "new chorus");
});

test("instrumental:false is honoured, not read as absent", () => {
  const b = mergeBrief({ song: { instrumental: true } },
                       { song: { instrumental: false } });
  assert.equal(b.song.instrumental, false);
});

test("an empty song patch does not create the field", () => {
  assert.equal(mergeBrief({}, { song: {} }).song, undefined);
});

test("briefToPlan hands the song to the writer", () => {
  // Two different jobs: this is what the WRITER reads so the video is built
  // around the words. What actually queues the render is `brief.music`, which
  // the wizard fills from the same object.
  const out = briefToPlan({
    logline: "a girl and a rooftop",
    song: { style: "dream pop, reverbed guitar", lyrics: "[Chorus]\nthe neon runs" },
  }, {});
  assert.match(out.notes, /Track: dream pop, reverbed guitar/);
  assert.match(out.notes, /Lyrics:/);
  assert.match(out.notes, /the neon runs/);
});

test("the interview is told the studio can make the track", () => {
  // The failure this replaces: asked to "generate it", the director answered
  // "I can't render the audio directly here" and wrote a note nothing read.
  const p = interviewSystem({ project: { medium: "music_video" }, brief: {} });
  assert.match(p, /studio generates music/i);
  assert.match(p, /never that you cannot make audio/i);
});

// The tuning, pinned against the real brief it was measured on. Two mechanisms
// keep deliberate near-twins apart, and they cover different cases.
const REI = "Reference authority: short black bob with one turquoise front streak, pale gray eyes, black";
const CAPTURE = "A fractured capture environment where crystallization spreads through the space";

test("a stock opener across the cast is not evidence of anything", () => {
  // Models write one description template and fill in the wardrobe. On raw
  // text these three score 1.0 against each other — every word compared comes
  // from the boilerplate.
  const cast = [
    { name: "Rei", look: `${REI} zip hoodie, dark T-shirt, cuffed dark shorts.` },
    { name: "Villian Rei", look: `${REI} high-collar layered coat with draped panels.` },
    { name: "Knight Rei", look: `${REI} armor, shield and long sword.` },
  ];
  assert.deepEqual(duplicateGroups(cast, "cast"), []);
  assert.deepEqual(duplicateGroups(cast, "world"), []);
});

test("the boilerplate filter never eats the signal it is looking for", () => {
  // Two of three ARE the same place. Their shared words appear in 2 of 3 —
  // which is why "common" needs three entries, not half of them.
  const world = [
    { name: "Astronaut Capture Site", look: `${CAPTURE} as the villain drains the power.` },
    { name: "Astronaut Capture Environment", look: `${CAPTURE} and the power is torn away.` },
    { name: "Plant World", look: "Luminous old-growth forest, towering silver-barked trees, teal foliage." },
  ];
  assert.deepEqual(duplicateGroups(world, "world"),
                   [["Astronaut Capture Site", "Astronaut Capture Environment"]]);
});

test("the cast rule trades a missed duplicate for never merging two people", () => {
  // The same person under a descriptive and a proper name — name overlap 0.5,
  // look overlap 0.64. Reported as a location, deliberately NOT as cast: at two
  // entries the boilerplate filter cannot engage, so this rule is all that
  // stands between a pair of similar characters and a hint telling the model
  // they are one. A missed duplicate costs a reference sheet; a false one costs
  // a character.
  const pair = [
    { name: "The Diver", look: "A tall diver in a patched wetsuit, shaved head, burn scar on the jaw." },
    { name: "Diver Mara", look: "A tall diver in a patched wetsuit, shaved head, rope burns on both hands." },
  ];
  assert.deepEqual(duplicateGroups(pair, "cast"), []);
  assert.equal(duplicateGroups(pair, "world").length, 1);
});

test("a location written down twice under two names is reported", () => {
  const world = [
    { name: "Astronaut Capture Site", look: `${CAPTURE} as the villain drains the power.` },
    { name: "Astronaut Capture Environment", look: `${CAPTURE} and the power is torn away.` },
    { name: "Plant World", look: "Luminous old-growth forest, towering silver-barked trees, glowing teal foliage." },
  ];
  assert.deepEqual(duplicateGroups(world, "world"),
                   [["Astronaut Capture Site", "Astronaut Capture Environment"]]);
});

test("a verbatim duplicate is still caught in the cast, since that is not a variant", () => {
  const look = "A worn orange astronaut jumpsuit with mission patches and a black neck seal.";
  assert.equal(duplicateGroups([{ name: "Astronaut", look }, { name: "Astro Rei", look }],
                               "cast").length, 1);
});

// ------------------------------------------- gaps the brief already answers ---
// `resolved_questions` was the only way an open question ever closed and the
// model sends it almost never, so the list only grew — and briefToPlan hands it
// to the planner as "decide these yourself, consistently". Measured on a real
// interview: twelve open, EIGHT of them answered in the same document.

const STATION = {
  logline: "A salvage pilot wakes a mecha to save her sibling.",
  turn: "the core holds her brother", tone: "dark cinematic dread",
  palette: "near-black space, sickly cyan, emergency crimson",
  cast: [{ name: "Lucy", look: "blonde with colourful highlights, signature jacket" },
         { name: "Alien Threat", look: "tall asymmetrical insectoid silhouette, obsidian armour" }],
  world: [{ name: "Command Deck", look: "scratched consoles, cyan glow" },
          { name: "Salvage Bay", look: "cathedral-scale bay, magnetic cradle arms" }],
  props: [{ name: "Awakening Mecha", look: "scarred salvage plating, cyan diagnostic seams" }],
  shape: { length_s: 240, sections: ["awakening", "pursuit", "escalation", "turn", "confrontation"] },
};

test("a question the brief answers retires itself, and a real gap does not", () => {
  const b = mergeBrief(STATION, { open_questions: [
    "primary location",             // world is filled
    "tone and palette",             // both are filled
    "protagonist name and look",    // a cast member has a look
    "mecha design",                 // the named prop has a look
    "alien design",                 // the named cast member has a look
    "ending",                       // NOT answered — no `ending` field
    "alien hierarchy: one entity or swarm",   // no look word, no field word
  ] });
  assert.deepEqual(b.open_questions, ["ending", "alien hierarchy: one entity or swarm"]);
});

test("a look question about something with no look yet stays open", () => {
  const b = mergeBrief({ world: [{ name: "the hideout" }], tone: "elegiac" },
                       { open_questions: ["hideout look"] });
  assert.deepEqual(b.open_questions, ["hideout look"],
                   "`tone` being set must not answer a question about the hideout");
});

test("a question naming nobody on the roster is not answered by the roster", () => {
  const b = mergeBrief({ cast: [{ name: "Mara", look: "shaved head" }] },
                       { open_questions: ["who owns the boat?"] });
  assert.deepEqual(b.open_questions, ["who owns the boat?"]);
});

test("retirement runs on a patch that never mentions open_questions", () => {
  // The old code did this inside the LIST_FIELDS loop, which `continue`s when
  // the patch carries none — so a stored list survived every turn that did not
  // happen to mention it, which is how one reached seventy.
  const stale = { ...STATION, open_questions: ["primary location", "tone and palette", "ending"] };
  assert.deepEqual(mergeBrief(stale, { title: "NIGHT SHIFT" }).open_questions, ["ending"]);
});

test("a stored list is capped and retired even by an unrelated patch", () => {
  const stale = { open_questions: Array.from({ length: 70 }, (_, i) => `gap ${i}`) };
  assert.equal(mergeBrief(stale, { tone: "elegiac" }).open_questions.length, 12);
});

test("resolved_questions matches a paraphrase, not just the exact text", () => {
  // The schema asks for exact text and models send what they remember: measured,
  // "tone & palette" left "tone and palette" open for the rest of the interview.
  const b = mergeBrief({ open_questions: ["tone and palette", "what season"] },
                       { resolved_questions: ["tone & palette"] });
  assert.deepEqual(b.open_questions, ["what season"]);
});

test("resolved_questions does not retire an unrelated gap", () => {
  const b = mergeBrief({ open_questions: ["what season"] },
                       { resolved_questions: ["who owns the boat"] });
  assert.deepEqual(b.open_questions, ["what season"]);
});

test("answeredQuestions is pure and reports nothing on an empty brief", () => {
  assert.deepEqual(answeredQuestions({}), []);
  assert.deepEqual(answeredQuestions({ open_questions: ["primary location"] }), []);
});

// ------------------------------------- several things written down as one ---
// Asked for a station with a docking ring, a command deck, a maintenance spine,
// an observation gallery and a salvage bay, the model wrote all five into ONE
// entry's `look` and reported them as added — truthfully, and uselessly: the
// planner draws one master plate, so five sets become one camera position.

test("one location for a multi-section piece is reported", () => {
  const nested = { ...STATION, world: [{ name: "Orbital Space Station",
    look: "docking rings, a command deck, a maintenance spine and a salvage bay" }] };
  assert.match(noteBriefResult(nested).hint, /ONE location for a 5-section piece/);
});

test("the report goes quiet once the places are their own entries", () => {
  assert.ok(!/ONE location/.test(noteBriefResult(STATION).hint ?? ""));
});

test("a bottle episode says so in constraints instead of being nagged", () => {
  const bottle = { ...STATION, world: [{ name: "The Late Shift counter", look: "one room" }],
                   constraints: ["a single location, the whole piece"] };
  assert.ok(!/ONE location/.test(noteBriefResult(bottle).hint ?? ""));
});

test("a short piece with one location is left alone", () => {
  const short = { world: [{ name: "Halvard Bay", look: "flooded rooftops" }],
                  shape: { length_s: 64 } };
  assert.ok(!/ONE location/.test(noteBriefResult(short).hint ?? ""));
});

test("the interview is told a place the camera cuts to is its own entry", () => {
  const sys = interviewSystem({ project: { title: "x" } });
  assert.match(sys, /camera CUTS TO is\s+its own world entry/);
});

// --------------------------------------------- a patch that lost its entries ---
// `mergeNamed` skips anything without a `name`, and note_brief answered
// `{noted: true}` over a list that lost every entry: a patch of
// world: ["Docking Ring", "Command Deck"] merges to [] and reports success.

test("a named list sent as bare strings is reported, not silently dropped", () => {
  const patch = { world: ["Docking Ring", "Command Deck"] };
  assert.deepEqual(mergeBrief({}, patch).world, [], "the merge still refuses them");
  const r = noteBriefResult(mergeBrief({}, patch), patch);
  assert.equal(r.dropped.length, 1);
  assert.match(r.dropped[0], /2 "world" entries had no "name"/);
  assert.match(r.dropped[0], /Docking Ring/);
  assert.match(r.hint, /resend them/);
});

test("a named list sent as one object rather than an array is reported", () => {
  assert.match(briefPatchProblems({ cast: { name: "Lucy" } })[0], /must be an ARRAY/);
});

test("the entries that DID have a name still land, and only the rest are reported", () => {
  const patch = { world: [{ name: "Command Deck", look: "cyan glow" }, "Salvage Bay"] };
  assert.deepEqual(mergeBrief({}, patch).world, [{ name: "Command Deck", look: "cyan glow" }]);
  assert.match(briefPatchProblems(patch)[0], /1 "world" entry had no "name" and was dropped/);
});

test("a well-formed patch reports nothing", () => {
  assert.deepEqual(briefPatchProblems({ cast: [{ name: "Lucy" }], tone: "dread" }), []);
  assert.deepEqual(briefPatchProblems(undefined), []);
});
