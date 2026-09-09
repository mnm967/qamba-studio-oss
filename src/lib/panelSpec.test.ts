// node --test src/lib/panels.test.ts
//
// The key still's references. It used to pick them with a role-BLIND lookup —
// "lowest slot, first row wins" — over a bible where a character's face,
// full_body and turnaround all sit at slot 0 and a location's master,
// alt_angle, detail and atmosphere do too. So the identity anchor for a person
// was as likely to be her six-view turnaround GRID as her face plate, and a
// location's only reference as likely to be a `detail` close-up as its master:
// exactly the failure blocks.py already documents and fixes with an explicit
// role. Nothing about that was visible in the UI — the still just came back
// wrong-looking.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  PANEL_ALTS, sceneStillSpec, featuredCast, locationLeads, locationPlate, orderAnchors,
  panelSpec, panelCastCap, wideFaceCap, panelChoiceMeta, beatStillMeta, platePlan, seedBase,
  beatImageId, remoteSpeakers,
} from "./panelSpec.ts";
import type { Beat, BibleEntry, Scene } from "./db/types.ts";

const entry = (over: Partial<BibleEntry> & { id: string; name: string }) => ({
  kind: "character", identity_line: null, summary: null, doc: {}, status: "confirmed",
  project_id: "p1", version: 1, created_at: "", updated_at: "", ...over,
}) as unknown as BibleEntry;

const REI = entry({ id: "e-rei", name: "Rei", identity_line: "black bob, turquoise streak" });
const GUIDE = entry({ id: "e-guide", name: "Guide Rei", identity_line: "orange jumpsuit" });
const LOOP = entry({ id: "e-loop", kind: "environment", name: "The Loop",
                     identity_line: "a flooded platform under sodium light" });
const BIBLE = [REI, GUIDE, LOOP];

const scene = (over: Partial<Scene> = {}) => ({
  id: "s1", slug: "THE-LOOP", idx: 0, duration_ms: 12000,
  cast_ids: ["e-rei", "e-guide"], environment_id: "e-loop",
  scene_prompt: "Rei drops the marble and the water answers.",
  meta: {}, ...over,
}) as unknown as Scene;

const CTX = { bible: BIBLE, style: "anime", imageModel: "krea2" };

test("a person is anchored WARDROBE-FIRST and a place on its MASTER", () => {
  // It used to be `["face"]`, and a face plate is head-and-shoulders on grey:
  // it says nothing about what the character is WEARING, so the model dressed
  // them from the prose. Measured on an Astronaut Rei / Villian Rei two-shot —
  // one figure came back in an invented orange spacesuit because the only
  // picture of her was a face. The turnaround is a face plate too (two of its
  // six views are face close-ups) AND carries the costume from six angles.
  const { anchors } = sceneStillSpec(scene(), CTX);
  const byEntry = Object.fromEntries(anchors.map((a) => [a.entry_id, a.roles]));
  assert.equal(byEntry["e-rei"][0], "turnaround");
  assert.equal(byEntry["e-guide"][0], "turnaround");
  assert.deepEqual(byEntry["e-loop"], ["master"]);
  // …and exactly ONE picture per person: _resolve_anchor appends every role it
  // finds, so a bare preference list would stage three sheets of one character.
  for (const a of anchors) {
    if (a.entry_id !== "e-loop") assert.equal(a.first, true, "must resolve to one slot");
  }
});

test("anchors are late-bound entries, never asset ids", () => {
  // An asset id is resolved when the job is QUEUED; an anchor is resolved when
  // it RUNS, so a sheet that lands in between (or a user's own, attached after
  // the fact) is the one that conditions the render.
  const { anchors } = sceneStillSpec(scene(), CTX);
  for (const a of anchors) {
    assert.ok(a.entry_id && Array.isArray(a.roles), JSON.stringify(a));
  }
});

test("the location takes the first slot, because a key still is a wide", () => {
  // image1 carries the high token budget in both reference encoders, and two
  // faces there is what turned "wide establishing" into a medium two-shot with
  // no environment in it. The cast still rides along behind it — a key still is
  // the scene's ensemble frame, unlike a beat panel's single subject.
  const { anchors, spec } = sceneStillSpec(scene(), CTX);
  assert.equal(anchors[0].entry_id, "e-loop");
  assert.deepEqual(anchors.slice(1).map((a) => a.entry_id), ["e-rei", "e-guide"]);
  assert.ok(locationLeads(spec.camera), spec.camera);
});

test("the spec says who is in it, where, and what happens", () => {
  const { spec } = sceneStillSpec(scene(), CTX);
  assert.deepEqual(spec.cast.map((c) => c.name), ["Rei", "Guide Rei"]);
  assert.equal(spec.cast[0].identity, "black bob, turquoise streak");
  assert.equal(spec.location?.name, "The Loop");
  assert.equal(spec.action, "Rei drops the marble and the water answers.");
  // and it renders through the panel branch, which is the one that HAS
  // [LOCKED CHARACTER] / [LOCKED LOCATION] / [REFERENCES]
  assert.equal(spec.kind, "panel");
});

test("with no scene prose it still names the scene rather than sending nothing", () => {
  const { spec } = sceneStillSpec(scene({ scene_prompt: null }), CTX);
  assert.equal(spec.action, "THE-LOOP");
});

test("an outfit variant is anchored on its OWN wardrobe sheet", () => {
  // This used to redirect to the parent's face on the grounds that "the variant
  // sheet is wardrobe, not identity" — which gets it exactly backwards for a
  // panel. The costume is the entire reason the variant exists, and the parent's
  // face is the one picture that cannot show it.
  const variant = entry({ id: "e-var", name: "Rei — soaked coat", doc: { variant_of: "e-rei" } });
  const { anchors } = sceneStillSpec(
    scene({ cast_ids: ["e-var"] }), { ...CTX, bible: [...BIBLE, variant] });
  const mine = anchors.find((a) => a.entry_id === "e-var");
  assert.ok(mine, "the variant's own sheet must be staged");
  assert.equal(mine!.roles[0], "full_body");
  // A variant never gets a turnaround of its own, so face remains the last
  // resort rather than being absent.
  assert.ok(mine!.roles.includes("face"));
});

test("a crowded scene stops at two faces plus the place", () => {
  // Three references is the Krea2EditRebalance ceiling minus one; past two
  // faces the encoder composes a line-up rather than a frame.
  const extra = entry({ id: "e-miko", name: "Miko" });
  const { anchors } = sceneStillSpec(
    scene({ cast_ids: ["e-rei", "e-guide", "e-miko"] }), { ...CTX, bible: [...BIBLE, extra] });
  assert.equal(anchors.length, 3);
  assert.ok(!anchors.some((a) => a.entry_id === "e-miko"));
});

test("a scene with no location still anchors its people", () => {
  const { anchors, spec } = sceneStillSpec(scene({ environment_id: null }), CTX);
  assert.equal(spec.location, null);
  assert.deepEqual(anchors.map((a) => a.entry_id), ["e-rei", "e-guide"]);
});

test("a scene with nobody cast produces no anchors rather than a wrong one", () => {
  const { anchors } = sceneStillSpec(scene({ cast_ids: [], environment_id: null }), CTX);
  assert.deepEqual(anchors, []);
});

test("orderAnchors keeps each picture paired with the sentence describing it", () => {
  const [ordered, wide] = orderAnchors("wide establishing", ["faceA", "faceB"], "env");
  assert.equal(wide, true);
  assert.deepEqual(ordered, ["env", "faceA"]);
  const [close] = orderAnchors("close-up", ["faceA"], "env");
  assert.deepEqual(close, ["faceA", "env"]);
});

// ------------------------------------------------------------ location plates
//
// Every panel of a scene staged the same MASTER plate, so every panel of a
// scene came back on the same camera. The pure decision is twinned in
// worker/image_prompt.py; test_image_prompt pins the ring against this file.

test("a surface shot takes the detail plate and a reverse takes the alt angle", () => {
  assert.equal(locationPlate("an insert at high angle")[0][0], "detail");
  assert.equal(locationPlate("an extreme close-up on the reverse")[0][0], "detail");
  assert.equal(locationPlate("an over-the-shoulder close-up behind Rei")[0][0], "alt_angle");
  // a fixed pick must not consume a rotation turn
  assert.equal(locationPlate("an insert at high angle")[1], false);
  // …and never leaves a one-plate location unresolvable
  assert.equal(locationPlate("an insert at high angle")[0].at(-1), "master");
});

test("the turn counter skips the shots that did not rotate", () => {
  // Twin of test_the_turn_counter_skips_the_shots_that_did_not_rotate. Rotating
  // on the raw beat index would put this scene's two wides back on one plate.
  assert.deepEqual(platePlan([
    "a wide establishing shot at eye level",
    "a medium close-up at eye level toward Rei's hands",
    "an insert at high angle as the photograph falls",
    "a medium shot at eye level beside the creature",
    "a low-angle medium shot behind Rei's thrust",
    "an extreme close-up at high angle on the reverse",
    "a wide shot at eye level with Guide Rei's throw",
  ]).map((p) => p[0]),
  ["master", "alt_angle", "detail", "atmosphere", "alt_angle", "detail", "master"]);
});

const beat = (over: Partial<Beat> & { id: string; idx: number }) => ({
  scene_id: "s1", action: "they talk", camera: "a medium shot at eye level",
  duration_ms: 3000, meta: {}, ...over,
}) as unknown as Beat;

test("a beat panel stages the plate its POSITION IN THE SCENE earns", () => {
  // The rotation is a per-scene decision, which is why panelSpec takes the
  // scene's beats: redrawing beat 3 on its own must pick the plate the batch
  // picked for it, or one panel of a scene comes back on a different camera
  // with nothing to say why.
  const beats = [
    beat({ id: "b0", idx: 0, camera: "a wide establishing shot at eye level" }),
    beat({ id: "b1", idx: 1, camera: "a medium shot at eye level" }),
    beat({ id: "b2", idx: 2, camera: "an insert at high angle on the marble" }),
    beat({ id: "b3", idx: 3, camera: "a wide shot of the whole aisle" }),
  ];
  const picked = beats.map((b) => panelSpec(scene(), b, CTX, beats));
  assert.deepEqual(picked.map((p) => p.spec.plate),
                   ["master", "alt_angle", "detail", "atmosphere"]);
  // the anchor asks for that plate FIRST and falls back rather than staging none
  const env = picked[3].anchors.find((a) => a.entry_id === "e-loop")!;
  assert.equal(env.roles[0], "atmosphere");
  assert.ok(env.roles.includes("master"));
  // …and one picture, not three
  assert.equal(env.first, true);
});

test("the reference label names the PLACE, never the plate", () => {
  // The plate can still fall back — a location with no reverse angle resolves
  // to its master — and a label naming a picture that was not staged is worse
  // than none. The plate wording is composed on the pod from `spec.plate`,
  // which handle_image_gen corrects to whatever actually resolved.
  const beats = [beat({ id: "b0", idx: 0, camera: "an over-the-shoulder close-up behind Rei" })];
  const { spec } = panelSpec(scene(), beats[0], CTX, beats);
  assert.equal(spec.plate, "alt_angle");
  // "The Loop" already starts with an article, so none is prepended
  assert.ok(spec.refs.includes("The Loop location"), spec.refs.join(" | "));
  assert.ok(!spec.refs.some((r) => /plate/.test(r)), spec.refs.join(" | "));
});

test("a scene with no location carries no plate at all", () => {
  // `plate` is what switches the framing from a description into a camera-move
  // imperative. With nothing staged there is nothing to move away from.
  const beats = [beat({ id: "b0", idx: 0 })];
  const { spec } = panelSpec(scene({ environment_id: null }), beats[0], CTX, beats);
  assert.equal(spec.plate, undefined);
});

// ------------------------------------------------------- alternate takes --
// Five takes of one shot, to choose between. The whole feature turns on two
// things the type system cannot see: the seeds must DIFFER (every panel job
// renders at `payload.seed or 0`, so identical jobs return identical
// pictures), and promoting one must not disturb the slot a human owns.

test("a round of alternates gets distinct seeds", () => {
  const b = beat({ id: "b-seed", idx: 0 });
  const base = seedBase(b);
  const seeds = new Set(Array.from({ length: PANEL_ALTS }, (_, i) => base + i));
  assert.equal(seeds.size, PANEL_ALTS);
  assert.ok(base > 0, "seeds stay positive — samplers reject negatives");
});

test("re-rolling the same shot walks to fresh seeds", () => {
  // Without this a second click re-renders the identical five and looks broken.
  const first = seedBase(beat({ id: "b-seed", idx: 0 }));
  const after = seedBase(beat({ id: "b-seed", idx: 0,
                               meta: { panel_alts: ["a", "b", "c", "d", "e"] } }));
  const firstRound = new Set(Array.from({ length: PANEL_ALTS }, (_, i) => first + i));
  for (let i = 0; i < PANEL_ALTS; i++) {
    assert.ok(!firstRound.has(after + i), `seed ${after + i} was already used`);
  }
});

test("two different beats do not share a seed run", () => {
  const a = seedBase(beat({ id: "b-one", idx: 0 }));
  const b = seedBase(beat({ id: "b-two", idx: 1 }));
  assert.notEqual(a, b);
});

test("promoting an alternate writes the AUTO slot and keeps the list", () => {
  const b = beat({ id: "b1", idx: 0,
                   meta: { panel_alts: ["x", "y", "z"], panel_asset_id: "x" } });
  const meta = panelChoiceMeta(b, "y");
  assert.equal(meta.panel_asset_id, "y");
  // the others stay on offer — picking again must not need a re-render
  assert.deepEqual(meta.panel_alts, ["x", "y", "z"]);
});

test("promoting never touches a still the user designated", () => {
  // A promoted alternate is still auto material: it has to keep losing to the
  // deliberate pick, or "choose a take" would silently discard an upload.
  const b = beat({ id: "b1", idx: 0,
                   meta: { still_asset_id: "mine", panel_alts: ["x"] } });
  const meta = panelChoiceMeta(b, "x");
  assert.equal(meta.still_asset_id, "mine");
  assert.equal(beatImageId({ ...b, meta } as Beat).id, "mine");
});

/* ── a picture of your OWN on a shot ───────────────────────────────────────
 *
 * The other slot. `beatStillMeta` is what the scene editor's upload AND its
 * library pick both write, and the two rules it carries are the ones that are
 * silent when they are wrong: which slot (get it wrong and "Re-draw panels"
 * destroys a chosen picture), and the start frame left behind (get it wrong
 * and the block opens on a picture no surface is showing). */

test("a picture you choose goes in the DELIBERATE slot, not the auto one", () => {
  // The auto slot is rewritten for a whole scene by one button. A library
  // pick landing there would be destroyed by "Re-draw panels" two rows up.
  const b = beat({ id: "b1", idx: 0, meta: { panel_asset_id: "drawn" } });
  const meta = beatStillMeta(b, "mine");
  assert.equal(meta.still_asset_id, "mine");
  assert.equal(meta.panel_asset_id, "drawn", "the drawn panel was overwritten");
  assert.equal(beatImageId({ ...b, meta } as Beat).id, "mine");
  assert.equal(beatImageId({ ...b, meta } as Beat).kind, "still");
});

test("replacing the picture drops a start frame that named the old one", () => {
  // `start_frame_asset_id` is a second id the worker reads on its own, and
  // the role segment only ever points it at whatever is in the slot. Left
  // behind, the block OPENS on the old picture while every surface shows the
  // new one — and the segment, comparing the two, quietly reads "look".
  const b = beat({ id: "b1", idx: 0,
                   meta: { still_asset_id: "old", start_frame_asset_id: "old" } });
  const meta = beatStillMeta(b, "new");
  assert.equal(meta.still_asset_id, "new");
  assert.equal(meta.start_frame_asset_id, null);
});

test("a start frame naming something else is left alone", () => {
  // Only the OUTGOING picture's own claim is dropped — the same test
  // `clearBeatStill` applies. Clearing more would throw away a frame nothing
  // in this edit touched.
  const b = beat({ id: "b1", idx: 0,
                   meta: { still_asset_id: "old", start_frame_asset_id: "elsewhere" } });
  assert.equal(beatStillMeta(b, "new").start_frame_asset_id, "elsewhere");
});

test("the FIRST picture on a shot has no start frame to drop", () => {
  const b = beat({ id: "b1", idx: 0, meta: { panel_alts: ["x"] } });
  const meta = beatStillMeta(b, "mine");
  assert.ok(!("start_frame_asset_id" in meta),
            "a key nobody set is written as null, which reads as an edit that happened");
  assert.deepEqual(meta.panel_alts, ["x"], "the rest of the beat's meta was dropped");
});

// --------------------------------------------------------- cast cap by family
// Twin of the worker's tests: the flat two-face cap put invented extras into
// finished panels (the third cast member stayed in the prose with no sheet).

test("an H3 panel stages every cast member up to four", () => {
  const MIKO = entry({ id: "e-miko", name: "Miko", identity_line: "white kimono" });
  const beats = [beat({ id: "b0", idx: 0, camera: "an overhead close-up",
                        action: "Miko kneels beside Rei as Guide Rei watches.",
                        meta: { cast: ["Miko", "Rei", "Guide Rei"] } })];
  const { spec, anchors } = panelSpec(
    scene(), beats[0], { ...CTX, bible: [...BIBLE, MIKO], imageModel: "h3-image-turbo-local" },
    beats);
  const faces = anchors.filter((a) => a.entry_id !== "e-loop");
  assert.equal(faces.length, 3);
  assert.equal((spec as Record<string, unknown>).cast_complete, true);
});

test("narrow families keep the two-face cap and do not claim completeness", () => {
  const MIKO = entry({ id: "e-miko", name: "Miko", identity_line: "white kimono" });
  const beats = [beat({ id: "b0", idx: 0, camera: "an overhead close-up",
                        action: "Miko kneels beside Rei as Guide Rei watches.",
                        meta: { cast: ["Miko", "Rei", "Guide Rei"] } })];
  const { spec, anchors } = panelSpec(
    scene(), beats[0], { ...CTX, bible: [...BIBLE, MIKO], imageModel: "krea2" }, beats);
  assert.equal(anchors.filter((a) => a.entry_id !== "e-loop").length, 2);
  assert.ok(!("cast_complete" in (spec as Record<string, unknown>)));
});

test("panelCastCap matches the worker on both spellings", () => {
  assert.equal(panelCastCap("h3-image-turbo-local"), 4);
  assert.equal(panelCastCap("minimax-h3"), 4);
  assert.equal(panelCastCap("qwen-edit"), 2);
  assert.equal(panelCastCap(null), 2);
  // SenseNova takes ten references; the flat two-face cap was sized for
  // Krea 2's four and Qwen's three and is the invented-extra bug for it too.
  assert.equal(panelCastCap("sensenova-u1"), 4);
});

const WIDE_BEATS = () => {
  const MIKO = entry({ id: "e-miko", name: "Miko", identity_line: "white kimono" });
  return { MIKO, beats: [beat({ id: "b0", idx: 0,
                                camera: "a wide establishing shot at eye level",
                                action: "Miko, Rei and Guide Rei cross the aisle.",
                                meta: { cast: ["Miko", "Rei", "Guide Rei"] } })] };
};

test("a narrow family's wide drops faces and never claims the set is closed", () => {
  // Krea 2 takes four images and Qwen three, so on a wide the plate and the
  // cast genuinely compete: ordering keeps ONE face, the others stay in the
  // prose, and "no other people" would contradict them.
  const { MIKO, beats } = WIDE_BEATS();
  const { spec, anchors } = panelSpec(
    scene(), beats[0], { ...CTX, bible: [...BIBLE, MIKO], imageModel: "krea2" },
    beats);
  assert.equal(anchors.filter((a) => a.entry_id !== "e-loop").length, 1);
  assert.ok(!("cast_complete" in (spec as Record<string, unknown>)));
});

test("a ten-slot family's wide keeps its cast and may close the set", () => {
  // `facesWhenWide` was a SLOT BUDGET, not a composition rule. Measured on
  // THE LATE SHIFT TRUMPET_INTAKE b1 (SenseNova U1.5): a beat casting Dennis
  // and Priya, an action reading "Priya crosses ... opposite Dennis", ONE
  // face staged — and the panel came back with Priya plus TWO invented
  // strangers and no Dennis. With the slots to spare there is nothing to buy
  // by dropping him.
  const { MIKO, beats } = WIDE_BEATS();
  const { spec, anchors } = panelSpec(
    scene(), beats[0],
    { ...CTX, bible: [...BIBLE, MIKO], imageModel: "sensenova-u1-local" }, beats);
  assert.equal(anchors.filter((a) => a.entry_id !== "e-loop").length, 3);
  // the LOCATION still leads — that is the composition rule, and it was never
  // the thing that was wrong.
  assert.equal(anchors[0].entry_id, "e-loop");
  // nobody was dropped, so the envelope may close the cast — the strongest
  // anti-invented-extra signal there is, and previously unreachable on a wide.
  assert.equal((spec as Record<string, unknown>).cast_complete, true);
});

test("wideFaceCap matches the worker on both spellings", () => {
  assert.equal(wideFaceCap("sensenova-u1"), 4);
  assert.equal(wideFaceCap("h3-image-turbo-local"), 4);
  assert.equal(wideFaceCap("krea2"), 1);
  assert.equal(wideFaceCap(null), 1);
});

test("platePlan picks up where the previous scene left the ring", () => {
  // Twelve scenes in one room opened on twelve master plates; the ring
  // restarted at 0 per scene. Measured mean 0.809 luma correlation between
  // scene-opening panels, against 0.040 after the rotation shipped.
  const cams = ["a wide establishing shot", "a medium two-shot", "a close-up"];
  assert.equal(platePlan(cams)[0][0], "master");
  assert.equal(platePlan(cams, 1)[0][0], "alt_angle");
  assert.equal(platePlan(cams, 2)[0][0], "atmosphere");
  // a board planned before the stamp has no plate_turn and must be unchanged
  assert.deepEqual(platePlan(cams, 0), platePlan(cams));
});

// ------------------------------------------------- featured-cast staging ----
// Twin of the worker's rule: `meta.cast` is the cinematographer's roster
// (ASTRONAUT_CAPTURE wrote all five names on every beat), staging follows the
// shot's own text, and the roster survives only as the pronoun fallback.

test("featuredCast does not credit Rei with Astronaut Rei's mentions", () => {
  const got = featuredCast(
    "Astronaut Rei snaps both gloved hands sideways toward Villian Rei.",
    ["Miko", "Astronaut Rei", "Villian Rei", "Guide Rei", "Knight Rei", "Rei"]);
  assert.deepEqual(got, ["Astronaut Rei", "Villian Rei"]);
});

test("featuredCast orders by mention and reads possessives", () => {
  const got = featuredCast(
    "a close-up; the camera pushes in on Villian Rei's tightening face as Astronaut Rei watches",
    ["Astronaut Rei", "Villian Rei"]);
  assert.deepEqual(got, ["Villian Rei", "Astronaut Rei"]);
});

test("featuredCast is empty when the text casts by pronoun", () => {
  assert.deepEqual(featuredCast("the two stand in silence", ["Rei", "Miko"]), []);
});

test("a roster beat stages only who the shot names", () => {
  const MIKO = entry({ id: "e-miko", name: "Miko", identity_line: "white kimono" });
  const beats = [beat({ id: "b0", idx: 0, camera: "a tracking shot at low angle",
                        action: "Guide Rei catches Rei.",
                        meta: { cast: ["Miko", "Rei", "Guide Rei"] } })];
  const { spec, anchors } = panelSpec(
    scene(), beats[0], { ...CTX, bible: [...BIBLE, MIKO], imageModel: "h3-image-turbo-local" },
    beats);
  const faces = anchors.filter((a) => a.entry_id !== "e-loop");
  // mention order, and plain Rei matched by the standalone word — not the
  // "Rei" inside "Guide Rei"
  assert.deepEqual(faces.map((a) => a.entry_id), ["e-guide", "e-rei"]);
  // the featured pair IS the claim, so the set closes even though the roster
  // lists a third name the shot never says
  assert.equal((spec as Record<string, unknown>).cast_complete, true);
});

test("a close-up keeps its action-named cast and leads with its subject", () => {
  // A close-up-stages-one rule was tried and lost the same day: withholding
  // the second character's sheet re-invited the invented-extra artifact.
  // The camera's subject still takes image1 via mention order.
  const MIKO = entry({ id: "e-miko", name: "Miko", identity_line: "white kimono" });
  const beats = [beat({ id: "b0", idx: 0,
                        camera: "a close-up at dutch angle; the camera pushes in on Rei's tightening face",
                        action: "Guide Rei watches Rei brace against the glass.",
                        meta: { cast: ["Miko", "Rei", "Guide Rei"] } })];
  const { spec, anchors } = panelSpec(
    scene(), beats[0], { ...CTX, bible: [...BIBLE, MIKO], imageModel: "h3-image-turbo-local" },
    beats);
  assert.deepEqual(anchors.filter((a) => a.entry_id !== "e-loop").map((a) => a.entry_id),
                   ["e-rei", "e-guide"]);
  // both featured members staged, so the set closes
  assert.equal((spec as Record<string, unknown>).cast_complete, true);
});

test("a medium close-up keeps its pair", () => {
  const beats = [beat({ id: "b0", idx: 0,
                        camera: "a medium close-up at high angle; the camera arcs around Rei and Guide Rei",
                        action: "the gravity transfer reverses the space.",
                        meta: { cast: ["Rei", "Guide Rei"] } })];
  const { anchors } = panelSpec(
    scene(), beats[0], { ...CTX, imageModel: "h3-image-turbo-local" }, beats);
  assert.equal(anchors.filter((a) => a.entry_id !== "e-loop").length, 2);
});

test("a breath beat stages the place alone", () => {
  const beats = [beat({ id: "b0", idx: 0,
                        camera: "the camera holds a static shot on the space just left",
                        action: "A held, wordless beat: no one speaks and nothing new enters the frame.",
                        meta: { cast: ["Rei", "Guide Rei"], breath: true } })];
  const { spec, anchors } = panelSpec(
    scene(), beats[0], { ...CTX, imageModel: "h3-image-turbo-local" }, beats);
  assert.deepEqual(anchors.map((a) => a.entry_id), ["e-loop"]);
  assert.deepEqual((spec as { cast: unknown[] }).cast, []);
  assert.ok(!("cast_complete" in (spec as Record<string, unknown>)));
});

// ---- head matching: the browser twin of worker/tests/test_featured_cast_head.py
// Same cases, same expectations. Two implementations of one staging decision
// is a divergence waiting to happen, and the failure is invisible: the planner
// queues the first forty panels and the browser redraws one.
const CAST = ["Mara Vale", "Osei Kofi"];
const ACTION =
  "Mara stands at the front edge of the walnut repair bench with the turned " +
  "tool tray between her and Osei. Osei remains seated beneath the wall of " +
  "stopped clocks.";

test("a person is found by the name the prose uses", () => {
  assert.deepEqual(featuredCast(ACTION, CAST), ["Mara Vale", "Osei Kofi"]);
});

test("mention order still decides slot one", () => {
  assert.equal(featuredCast("Osei looks up. Mara does not move.", CAST)[0], "Osei Kofi");
});

test("a bare first name never swallows a variant", () => {
  const cast = ["Rei", "Guide Rei", "Astronaut Rei"];
  assert.deepEqual(featuredCast("Rei turns away", cast), ["Rei"]);
  assert.deepEqual(featuredCast("Guide Rei steps in", cast), ["Guide Rei"]);
});

test("an ambiguous first name is a miss, not a guess", () => {
  assert.deepEqual(featuredCast("Osei crosses the room", ["Osei Kofi", "Osei Mensah"]), []);
});

test("the tail rule still finds a creature", () => {
  assert.deepEqual(
    featuredCast("the creature lunges through the reflection",
                 ["Fractured Reflection Creature", "Rei"]),
    ["Fractured Reflection Creature"]);
});

test("a possessive over an object leaves the person out of frame", () => {
  assert.deepEqual(featuredCast("Osei's watch sits open on the bench", CAST), []);
  assert.deepEqual(featuredCast("Osei's hands sit open on the bench", CAST), ["Osei Kofi"]);
});

// This test was NAMED "a short first name is not matched" and asserted only
// the negative half — the contract of a `>= 4 characters` floor that
// `worker/image_prompt.py` replaced with the function-word and determiner
// guards. It went on PASSING against this twin's stale floor, for the wrong
// reason ("tam" is three letters, so the floor refused it and the assertion
// was satisfied without the guard existing). That is how the drift survived:
// a test frozen at the old contract reads like coverage of the new one.
//
// MEASURED cost on SPINE_RUN (2026-09-07): the planner staged Lucy AND Kai on
// the same beat this staged Lucy alone; 11 of 59 panels diverged; H3 drew the
// missing character from the prose that still names him.
test("a short name is told from a common noun by its determiner", () => {
  assert.deepEqual(featuredCast("she saw the tam on the hook", ["Tam Reed"]), []);
  assert.deepEqual(featuredCast("Tam crosses the shop toward the bench", ["Tam Reed"]),
                   ["Tam Reed"]);
  // The three-letter given name this actually shipped wrong.
  assert.deepEqual(
    featuredCast("Kai closes his burned knuckles around it", ["Kai Renn", "Lucy Voss"]),
    ["Kai Renn"]);
});

test("a person filed with a title is found by the MIDDLE of their name", () => {
  // A head/tail pair reads "Osei Kofi" and reads NEITHER end of "Captain Rhea
  // Dorne", whom the prose calls Rhea — so before the middle rule she was
  // staged only in the beats where she happens to have a LINE, the speaker
  // string carrying her full name into the haystack.
  const cast = ["Captain Rhea Dorne", "Dr. Sato Ibarra", "Lucy Voss"];
  assert.deepEqual(featuredCast("Rhea enters from the lower right", cast),
                   ["Captain Rhea Dorne"]);
  assert.deepEqual(featuredCast("the pulse reaches the gantry; Sato grips its rail", cast),
                   ["Dr. Sato Ibarra"]);
  // …and a middle carries the determiner test at EVERY width, because it is
  // the position where a common noun is likeliest to sit. Two marbles make
  // the tail ambiguous, so the interior words are all that is left.
  const marbles = ["Contained Black Hole Marble", "Cloudy Glass Marble"];
  assert.deepEqual(
    featuredCast("she sets it down on the glass beside the marble", marbles), []);
  assert.deepEqual(
    featuredCast("cloudy glass catches the light", marbles), ["Cloudy Glass Marble"]);
});

test("a middle binds possessives like a head, not like a tail", () => {
  // It is a person's given name: "Rhea's helmet" puts the HELMET in frame.
  const cast = ["Captain Rhea Dorne", "Lucy Voss"];
  assert.deepEqual(featuredCast("Rhea's helmet rests on the plinth", cast), []);
  assert.deepEqual(featuredCast("Rhea's scorched shoulder stays low", cast),
                   ["Captain Rhea Dorne"]);
});

test("the fight body-part list is the worker's, not the short one", () => {
  // `BODY_TERMS` was the pre-choreography list here long after the Python
  // grew it — a divergence with no symptom until a fight, where "into Osei's
  // ribs" reads as a detachable object in one twin and as the man in the
  // other.
  for (const part of ["ribs", "torso", "knuckles", "forearm", "temple", "shin"]) {
    assert.deepEqual(featuredCast(`she drives the staff into Osei's ${part}`, CAST),
                     ["Osei Kofi"], part);
  }
  // …and a possessive over your own MOTION is you.
  for (const noun of ["lunge", "momentum", "guard", "reach"]) {
    assert.deepEqual(featuredCast(`Osei's ${noun} meets nothing`, CAST),
                     ["Osei Kofi"], noun);
  }
});

test("a voice on a phone is not staged in the panel", () => {
  // `remoteSpeakers` was absent from this twin ENTIRELY, so a caller was
  // staged as `<Picture N>` here and dropped by the planner.
  assert.deepEqual(
    remoteSpeakers("Mara Vale holds the phone to her ear at the counter",
                   ["Mara Vale", "Tam Reed"], ["Tam Reed"]),
    ["Tam Reed"]);
  // …but a hand ON the phone is a body, and deleting someone who is standing
  // in the room is the worse error — so no device word means nobody is remote.
  assert.deepEqual(
    remoteSpeakers("Tam's hand closes over the phone on the counter",
                   ["Mara Vale", "Tam Reed"], ["Tam Reed"]), []);
  assert.deepEqual(
    remoteSpeakers("Mara Vale and Tam Reed stand either side of the bench",
                   ["Mara Vale", "Tam Reed"], ["Tam Reed"]), []);
  // A title-first name in frame is seen by `appearsInFrame` only because it
  // tries EVERY part, not just the ends.
  assert.deepEqual(
    remoteSpeakers("Rhea leans over the intercom, one boot on the rail",
                   ["Captain Rhea Dorne"], ["Captain Rhea Dorne"]), []);
});

// ── the GOLDEN, which is what hand-written parity kept failing to be ───────
//
// Every case is emitted by the REAL Python (`scripts/gen_panel_golden.py`), so
// this is not two hand-written opinions agreeing with each other. A change to
// `worker/image_prompt.py` fails `test_panel_golden.py` until the fixture is
// regenerated, and the regenerated fixture then fails THIS until the twin is
// brought along. Neither side can move alone — which is exactly what the
// staging decision lacked while the prompt beside it had it.
const STAGING = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)),
                    "__fixtures__", "panel_prompts.json"), "utf8"),
) as {
  featured_cast: Array<{ name: string; text: string; names: string[];
                         possessive_excludes: boolean; out: string[] }>;
  remote_speakers: Array<{ name: string; text: string; cast_names: string[];
                           speakers: string[]; out: string[] }>;
};

test("the staging fixture is not empty — a silent read failure passes everything", () => {
  assert.ok(STAGING.featured_cast.length > 15, `only ${STAGING.featured_cast.length}`);
  assert.ok(STAGING.remote_speakers.length > 2, `only ${STAGING.remote_speakers.length}`);
});

for (const c of STAGING.featured_cast) {
  test(`golden · featuredCast · ${c.name}`, () => {
    assert.deepEqual(featuredCast(c.text, c.names, c.possessive_excludes), c.out);
  });
}

for (const c of STAGING.remote_speakers) {
  test(`golden · remoteSpeakers · ${c.name}`, () => {
    assert.deepEqual(remoteSpeakers(c.text, c.cast_names, c.speakers), c.out);
  });
}

test("a V.O. line does not put its speaker on the cutaway's panel", () => {
  // Twin of test_a_panel_for_a_cutaway_does_not_stage_the_speaker: a speaker
  // counts as featured by their line — except one marked `offscreen`, the
  // DP's cutaway, whose whole point is that the camera is on someone else.
  const dlg = (offscreen: boolean) => [{
    speaker_id: "e-guide", speaker: "Guide Rei", line: "Listen closely.",
    ...(offscreen ? { offscreen: true } : {}),
  }];
  const b = beat({
    id: "b0", idx: 0, camera: "a close-up on Rei",
    action: "Rei listens, jaw tight.",
    meta: { cast: ["Rei", "Guide Rei"] },
    dialogue: dlg(true),
  } as never);
  const { anchors } = panelSpec(scene(), b, CTX, [b]);
  assert.ok(!anchors.some((a) => a.entry_id === "e-guide"));
  const b2 = beat({
    id: "b0", idx: 0, camera: "a close-up on Rei",
    action: "Rei listens, jaw tight.",
    meta: { cast: ["Rei", "Guide Rei"] },
    dialogue: dlg(false),
  } as never);
  const { anchors: a2 } = panelSpec(scene(), b2, CTX, [b2]);
  assert.ok(a2.some((a) => a.entry_id === "e-guide"));
});

// ---- a beat may spell a cast name EITHER WAY -----------------------------
// The cinematographer writes a character as the bible files them ("Villian Rei
// — Glitching capture coat") on one beat and by base name ("Villian Rei") on
// the next, in one scene. The lookup was base-keyed and read with the raw
// name, so the full form matched nobody, `featuredCast` was handed an empty
// roster, and the panel fell through to the scene's FIRST cast member.
//
// Measured on Rei EP04 CITY_CAPTURE_2 b1/b2 (2026-08-31): both beats cast
// Villian Rei and Astronaut Rei, both staged GUIDE REI's turnaround, and both
// rendered her brown jacket while Villian Rei — staged nowhere — was drawn
// from prose. Nothing errored; the fallback is a legal path.
const V_BASE = entry({ id: "e-v", name: "Villian Rei", identity_line: "black bob, blue streak" });
const V_COAT = entry({ id: "e-v-coat", name: "Villian Rei — Glitching capture coat",
                       identity_line: "black layered coat, glitching seams",
                       doc: { variant_of: "e-v" } });
const A_BASE = entry({ id: "e-a", name: "Astronaut Rei", identity_line: "orange flight suit" });
const CITY = entry({ id: "e-city", kind: "environment", name: "Alternate City",
                     identity_line: "flooded neon street" });
const CAPTURE_BIBLE = [GUIDE, V_BASE, V_COAT, A_BASE, CITY];
// Guide Rei FIRST, exactly as the live scene rows have it — she is what the
// fallback reached for.
const CAPTURE_SCENE = () => scene({
  id: "s-cap", slug: "CITY_CAPTURE_2", cast_ids: ["e-guide", "e-v-coat", "e-a"],
  environment_id: "e-city",
}) as Scene;
const CAPTURE_CTX = { bible: CAPTURE_BIBLE, style: "anime", imageModel: "gpt-image-2" };
const CAPTURE_BEAT = (cast: string[]) => beat({
  id: "b-cap", idx: 0,
  camera: "A wide lateral tracking shot at low angle; the camera follows the "
        + "car's spin, then holds as Villian Rei becomes translucent",
  action: "Villian Rei phases through the spinning car, and she solidifies "
        + "behind it, already facing Astronaut Rei.",
  meta: { cast },
} as never);

test("a beat that spells a cast name IN FULL stages that character", () => {
  const b = CAPTURE_BEAT(["Villian Rei — Glitching capture coat",
                          "Astronaut Rei — Astronaut capture suit"]);
  const { spec, anchors } = panelSpec(CAPTURE_SCENE(), b, CAPTURE_CTX, [b]);
  // the scene's first cast member is NOT in this shot and must not be staged
  assert.ok(!anchors.some((a) => a.entry_id === "e-guide"),
            `staged Guide Rei: ${JSON.stringify(anchors)}`);
  // a wide leads on the plate and carries ONE face on a four-image family —
  // whoever the camera names first, which is the mention-order slot-1 rule
  assert.deepEqual(anchors.map((a) => a.entry_id), ["e-city", "e-v-coat"]);
  // …and the spec DESCRIBES only who was staged. Naming Astronaut Rei here
  // over a reference set that holds no picture of her is the MEMORY_RETURN b1
  // failure — the worker twin fixed it and the browser had not.
  assert.deepEqual((spec as { cast: { name: string }[] }).cast.map((c) => c.name),
                   ["Villian Rei"]);
});

test("…and the scene's VARIANT still wins for a base-name beat", () => {
  // The control for the fix: resolving a base name against the whole bible
  // would find the PARENT ("Villian Rei") and stage the wrong wardrobe for a
  // scene that deliberately cast the glitching coat. Scene cast outranks the
  // project — blocks.py::_cast_entry_id's rule.
  const b = CAPTURE_BEAT(["Villian Rei", "Astronaut Rei"]);
  const { anchors } = panelSpec(CAPTURE_SCENE(), b, CAPTURE_CTX, [b]);
  assert.deepEqual(anchors.map((a) => a.entry_id), ["e-city", "e-v-coat"]);
  assert.ok(!anchors.some((a) => a.entry_id === "e-v"));
});

test("a beat naming nobody in its text still falls back to its roster", () => {
  // The fallback the bug was hiding behind is correct and must survive: a beat
  // that casts by pronoun contributes its whole roster rather than nobody.
  const b = beat({
    id: "b-pro", idx: 0, camera: "a medium two-shot at eye level",
    action: "The two stand in silence as the rain thickens.",
    meta: { cast: ["Villian Rei — Glitching capture coat"] },
  } as never);
  const { anchors } = panelSpec(CAPTURE_SCENE(), b, CAPTURE_CTX, [b]);
  assert.ok(anchors.some((a) => a.entry_id === "e-v-coat"),
            `roster fallback lost the cast: ${JSON.stringify(anchors)}`);
  assert.ok(!anchors.some((a) => a.entry_id === "e-guide"));
});
