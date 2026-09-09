// node --test — the guide resolver and the H3 alignment lines.
//
// These pin the parts that are an interface rather than a preference: which
// vendor doc a mode loads, whether the output is the vendor envelope or prose,
// and the exact wording and two-decimal timestamp of the instruction line an
// H3 keyframe pass must open with.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  guideFor, hasGuide, editSystem, enhanceSystem, h3AlignmentLine, PROMPT_GUIDES,
} from "./prompt_guides.js";

test("H3 loads the vendor doc that matches the mode", () => {
  const base = guideFor({ family: "minimax-h3", kind: "video", mode: "i2v" });
  assert.deepEqual(base.docs, ["h3_official_base_modes.md"]);
  const ref = guideFor({ family: "minimax-h3", kind: "video", mode: "r2v" });
  // full-reference first: it defines the six sections, and defers to the base
  // guide for shots, camera and dialogue rather than repeating them
  assert.deepEqual(ref.docs, ["h3_official_ref_mode.md", "h3_official_base_modes.md"]);
});

test("a named doc is either shipped or one of the two vendor guides", async () => {
  // MINIMAX'S OWN H3 GUIDES ARE NAMED HERE AND NOT SHIPPED. They are several
  // thousand words of theirs and this project has no licence to redistribute
  // them, so `director/knowledge/README.md` says where to put them and every
  // loader degrades to "" without them (`llm._read_knowledge`,
  // `format_reference`). Naming a doc is therefore not a promise that it is
  // on disk — but it must not silently become a THIRD such file: anything
  // this project wrote has to be here, or the guide it belongs to is quietly
  // ungrounded.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const dir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "knowledge");
  const VENDOR = new Set(["h3_official_base_modes.md", "h3_official_ref_mode.md"]);
  for (const g of Object.values(PROMPT_GUIDES)) {
    for (const names of Object.values(g.docs ?? {})) {
      for (const n of names) {
        if (VENDOR.has(n)) continue;
        assert.ok(fs.existsSync(path.join(dir, n)), `${n} is named but not shipped`);
      }
    }
  }
  // ...and the README that explains the gap is itself shipped, since it is the
  // only place the two filenames are written down for a user.
  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  for (const n of VENDOR) assert.ok(readme.includes(n), `README does not name ${n}`);
});

test("only H3 asks for the vendor envelope", () => {
  assert.equal(guideFor({ family: "minimax-h3", kind: "video" }).format, "h3");
  assert.equal(guideFor({ family: "krea2", kind: "image" }).format, "prose");
  assert.equal(guideFor({ family: "wan2.2", kind: "video" }).format, "prose");
});

test("a family with no guide of its own is reported, not faked", () => {
  const g = guideFor({ family: "nothing-here", kind: "image" });
  assert.equal(g.exact, false);
  assert.equal(g.id, "_image");
  assert.ok(g.rules, "the fallback still carries craft rules");
  // family names are per-kind: wan2.2 is a video guide and must not answer for
  // an image generation just because the key matches
  assert.equal(guideFor({ family: "wan2.2", kind: "image" }).exact, false);
  assert.equal(hasGuide("wan2.2", "video"), true);
  assert.equal(hasGuide("wan2.2", "image"), false);
});

test("i2v opens on the fixed first-frame instruction", () => {
  assert.equal(
    h3AlignmentLine("i2v", 5170),
    "For the target video, at 0.00 seconds into the target video, "
    + "<Picture 1> (from [Shot 1]) is fully referenced.");
});

test("flf carries the real duration to exactly two decimals", () => {
  const line = h3AlignmentLine("flf", 8000);
  assert.match(line, /aligns with the 8\.00-second mark/);
  assert.match(h3AlignmentLine("flf", 5170), /the 5\.17-second mark/);
  // trailing zeros are not optional — the guide specifies S.SS
  assert.match(h3AlignmentLine("flf", 12500), /the 12\.50-second mark/);
});

test("modes with no supplied keyframe get no instruction line", () => {
  assert.equal(h3AlignmentLine("t2v", 5000), "");
  assert.equal(h3AlignmentLine("r2v", 5000), "");
  assert.equal(h3AlignmentLine(undefined, 5000), "");
});

test("the H3 system prompt keeps the format rules and drops the word budget", () => {
  const guide = guideFor({ family: "minimax-h3", kind: "video", mode: "flf" });
  const s = enhanceSystem({
    guide, kind: "video", mode: "flf", docText: "VENDOR TEXT HERE",
    alignment: h3AlignmentLine("flf", 8000), durationMs: 8000,
  });
  assert.ok(s.includes("VENDOR TEXT HERE"), "the vendor doc is in the prompt");
  assert.ok(s.includes("OUTPUT FORMAT"), "the format is not optional for H3");
  assert.ok(s.includes("8.00-second mark"), "the alignment line is handed over verbatim");
  assert.ok(!/Target length: about/.test(s), "a word budget would fight the envelope");
});

test("a prose model is told to stay a paragraph", () => {
  const s = enhanceSystem({ guide: guideFor({ family: "krea2", kind: "image" }), kind: "image" });
  assert.ok(/one continuous paragraph/i.test(s));
  assert.ok(/Target length: about \d+ words/.test(s));
  assert.ok(!s.includes("OUTPUT FORMAT"));
});

// ---------------------------------------------------------------- music ---
// `music` is a THIRD kind, not a flavour of image. The tests below exist
// because the failure mode is quiet: a music prompt that falls through to the
// image ruleset comes back rewritten as a description of a picture — framing,
// light, materials — which is a perfectly well-formed prompt for the wrong
// model, and the render succeeds.

test("a music model gets its own guide, not the image fallback", () => {
  for (const fam of ["minimax-music3", "acestep"]) {
    const g = guideFor({ family: fam, kind: "music" });
    assert.equal(g.exact, true, `${fam} should resolve to its own guide`);
    assert.ok(hasGuide(fam, "music"));
  }
});

test("an unknown music family falls back to music craft, not image craft", () => {
  const g = guideFor({ family: "riffusion", kind: "music" });
  assert.equal(g.exact, false);
  assert.equal(g.label, "generic music");
  assert.ok(!/framing/i.test(g.rules), "a track has no framing");
});

test("ACE-Step is told to write tags and Music 3 to write prose", () => {
  const ace = enhanceSystem({ guide: guideFor({ family: "acestep", kind: "music" }), kind: "music" });
  assert.ok(/comma-separated tags/i.test(ace));
  assert.ok(!/one continuous paragraph/i.test(ace),
    "a paragraph is the opposite of what the tag encoder reads best");

  const m3 = enhanceSystem({ guide: guideFor({ family: "minimax-music3", kind: "music" }), kind: "music" });
  assert.ok(/one continuous paragraph/i.test(m3));
  assert.ok(!/comma-separated tags/i.test(m3));
});

test("ACE-Step's typed controls are kept OUT of its tags", () => {
  // bpm / key / time signature are real encoder inputs on this model. Writing
  // them into the tag list spends tokens on something the tags cannot set.
  const g = guideFor({ family: "acestep", kind: "music", mode: "t2m" });
  assert.ok(/SEPARATE typed controls/.test(g.rules));
  assert.ok(/do not name them/i.test(g.note));
});

test("neither music guide lets the rewriter invent lyrics", () => {
  for (const fam of ["minimax-music3", "acestep"]) {
    const g = guideFor({ family: fam, kind: "music" });
    assert.ok(/lyrics/i.test(g.rules) && /separate field|never (write|belong)/i.test(g.rules),
      `${fam} must send lyrics to their own field`);
  }
});

test("tags get a much shorter budget than a caption", () => {
  const words = (s) => Number(/Target length: about (\d+) words/.exec(s)?.[1]);
  const ace = words(enhanceSystem({ guide: guideFor({ family: "acestep", kind: "music" }), kind: "music" }));
  const m3 = words(enhanceSystem({ guide: guideFor({ family: "minimax-music3", kind: "music" }), kind: "music" }));
  assert.ok(ace < m3, `tags (${ace}) should be terser than a caption (${m3})`);
});

test("every music guide is reachable from a catalog family", async () => {
  // The guide is keyed by `model_catalog.family`, so a guide whose key is not
  // a family any row declares is dead code that reads like a feature.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
  // A Windows checkout is CRLF, and a regex dot will not cross the \r — so the
  // row matcher below silently matches nothing and the row list reads as empty.
  const sync = fs.readFileSync(path.join(root, "scripts", "gen_model_catalog.py"), "utf8")
    .replace(/\r\n/g, "\n");
  for (const [key, g] of Object.entries(PROMPT_GUIDES)) {
    if (g.kind !== "music") continue;
    assert.ok(sync.includes(`"${key}"`), `no catalog row declares family ${key}`);
  }
});

/* ─────────────────────────────────────────────────────────────── sfx ─── */

test("sfx is its own kind, not a flavour of music", () => {
  // Coerced to music, "steel hatch dragging open" comes back rewritten as a
  // description of a TRACK — genre, arrangement, production era — which is a
  // well-formed prompt for the wrong model. Same failure music had when it
  // was coerced to image.
  const g = guideFor({ family: "stable-audio-3", kind: "sfx", mode: "t2sfx" });
  assert.equal(g.id, "stable-audio-3");
  assert.ok(g.exact);
  assert.ok(/source/i.test(g.rules) && /material/i.test(g.rules));
  assert.ok(!/genre/i.test(g.rules), "a sound effect has no genre");
});

test("an unknown sfx family still gets sound-design craft, not image craft", () => {
  const g = guideFor({ family: "nope", kind: "sfx" });
  assert.equal(g.exact, false);
  assert.ok(/ONE sound/i.test(g.rules));
  assert.ok(!/framing|light/i.test(g.rules));
});

test("the sfx guide asks for the length, which the training captions state", () => {
  const g = guideFor({ family: "stable-audio-3", kind: "sfx" });
  assert.ok(/Length: N seconds/.test(g.rules));
});

test("the sfx guide refuses to bundle two events into one caption", () => {
  const g = guideFor({ family: "stable-audio-3", kind: "sfx" });
  assert.ok(/One sound per generation/i.test(g.rules));
});

test("an sfx caption gets the shortest budget of any kind", () => {
  const words = (kind, family) => Number(/Target length: about (\d+) words/
    .exec(enhanceSystem({ guide: guideFor({ family, kind }), kind }))?.[1]);
  const sfx = words("sfx", "stable-audio-3");
  assert.ok(sfx < words("music", "acestep"), `sfx (${sfx}) must be terser than tags`);
  assert.ok(sfx < words("image"), `sfx (${sfx}) must be terser than an image prompt`);
});

test("every sfx guide is reachable from a catalog family", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
  // A Windows checkout is CRLF, and a regex dot will not cross the \r — so the
  // row matcher below silently matches nothing and the row list reads as empty.
  const sync = fs.readFileSync(path.join(root, "scripts", "gen_model_catalog.py"), "utf8")
    .replace(/\r\n/g, "\n");
  for (const [key, g] of Object.entries(PROMPT_GUIDES)) {
    if (g.kind !== "sfx") continue;
    assert.ok(sync.includes(`"${key}"`), `no catalog row declares family ${key}`);
  }
});

test("every sfx catalog row is a t2sfx row, and every music row is not", async () => {
  // `model_catalog.kind` is "audio" for both — the column's check constraint
  // allows no third value — so the MODE is the only thing separating a song
  // from a sound effect. A Stable Audio row that forgot `t2sfx` shows up in
  // the music picker and renders six seconds where a song was asked for.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
  // A Windows checkout is CRLF, and a regex dot will not cross the \r — so the
  // row matcher below silently matches nothing and the row list reads as empty.
  const sync = fs.readFileSync(path.join(root, "scripts", "gen_model_catalog.py"), "utf8")
    .replace(/\r\n/g, "\n");
  const rows = [...sync.matchAll(/^row\((.*?)\n(?:.*?\n)*?.*?sort=\d+\)/gm)]
    .map((m) => m[0]);
  const audio = rows.filter((r) => /"audio"/.test(r));
  assert.ok(audio.length >= 7, `expected the audio rows, found ${audio.length}`);
  for (const r of audio) {
    const id = /^row\("([^"]+)"/.exec(r)[1];
    const sfx = /stable-audio/.test(id);
    assert.equal(/modes=\["t2sfx"\]/.test(r), sfx, `${id} has the wrong mode`);
  }
});

// ------------------------------------------------------------- no score ---
// A video enhance feeds ONE path — `handle_clip_gen`, which sends the prompt
// to ComfyUI verbatim — and that path's audio default is
// `non_diegetic_music: N/A`, written by `h3_prompt.with_audio_defaults` only
// when the prompt does not already carry the field. So an invented cue does
// not add music to a shot, it overrides the studio's decision not to bake one:
// a per-block score cannot be episode-consistent, it fights the real one
// `score_mix` lays under the cut at assembly, and on an extend or a chain it
// changes at the join. Reported from a real chain retake whose rewrite came
// back with "Fast pulsing electronic percussion".

test("a video rewrite is told not to invent a score, in the vendor's own token", () => {
  const guide = guideFor({ family: "minimax-h3", kind: "video", mode: "flf" });
  const s = enhanceSystem({ guide, kind: "video", mode: "flf" });
  assert.ok(/DO NOT INVENT A MUSICAL SCORE/.test(s));
  // `N/A` is MiniMax's own value for the field and `h3_prompt._NA` writes the
  // same string — a paraphrase here would be a field H3 reads as a cue.
  assert.ok(s.includes("`non_diegetic_music: N/A`"));
});

test("the rule comes AFTER the vendor guide, which is what argues for a score", () => {
  // Five of the six worked examples in MiniMax's documentation carry a music
  // cue, so a rewriter following the doc faithfully invents one. Placed above
  // it, this rule is the thing being overridden rather than the override.
  const guide = guideFor({ family: "minimax-h3", kind: "video", mode: "flf" });
  const s = enhanceSystem({ guide, kind: "video", docText: "VENDOR TEXT HERE" });
  assert.ok(s.indexOf("DO NOT INVENT") > s.indexOf("end of guide"));
});

test("a PROSE video family gets the same rule in its own terms", () => {
  // LTX generates its audio natively too, so "pulsing synth" in prose bakes a
  // score exactly as an H3 field does — it just has no field to name.
  const guide = guideFor({ family: "ltx-2.5", kind: "video" });
  assert.equal(guide.format, "prose");
  const s = enhanceSystem({ guide, kind: "video" });
  assert.ok(/DO NOT INVENT A MUSICAL SCORE/.test(s));
  assert.ok(!s.includes("non_diegetic_music"), "a prose family has no such field");
});

test("diegetic sound is explicitly spared, and a prompt that ASKS for a score keeps it", () => {
  const s = enhanceSystem({ guide: guideFor({ family: "minimax-h3", kind: "video" }), kind: "video" });
  assert.ok(/diegetic/.test(s), "a radio in the shot is not a score");
  assert.ok(/already asks for/.test(s), "carrying is allowed; inventing is not");
});

test("no other kind is told anything about music", () => {
  // The rule is about the CLIP path. An image prompt has no audio at all, and
  // telling a MUSIC rewrite not to write music would be absurd.
  for (const [family, kind] of [["krea2", "image"], ["acestep", "music"],
                                ["stable-audio-3", "sfx"], ["mmaudio", "v2a"]]) {
    const s = enhanceSystem({ guide: guideFor({ family, kind }), kind });
    assert.ok(!/MUSICAL SCORE/.test(s), `${kind} should not carry the video rule`);
  }
});


// ── the edit brief ────────────────────────────────────────────────────────
// A video EDIT INSTRUCTION is not a prompt. `h3_prompt.compile_video_edit`
// builds the six-section envelope deterministically and drops these words
// inside two of its sentences, so the failure this pins is an envelope
// returned here and nested inside that one — which renders as garbage and
// looks, from the outside, like the model ignoring the edit.

test("an edit brief is NOT asked for the envelope", () => {
  const s = editSystem({ refs: 1 });
  // enhanceSystem's H3 branch says exactly the opposite of each of these.
  assert.ok(!/OUTPUT FORMAT/.test(s), "that is the prompt rewrite's rule, not this one");
  assert.ok(!/section names/.test(s));
  assert.ok(!/Target length: about \d+ words/.test(s), "the prompt budget is a prompt's");
  // and it says so itself, since a model reading only the positive half of a
  // system prompt is the case this is written against
  assert.ok(/Emit NO prompt structure/.test(s));
  for (const label of ["subject_definitions", "detailed_description", "<Video 1>", "[Shot N]"]) {
    assert.ok(s.includes(label), `${label} must be named as forbidden`);
  }
});

test("an edit brief is told not to describe the shot it is preserving", () => {
  // The envelope declares <Video 1> fully preserved "except where the
  // requested change applies". Restating the framing re-specifies the very
  // thing being held, and H3 obeys a description over a declaration.
  assert.ok(/Do NOT describe the shot as it already is/.test(editSystem()));
});

test("the slot sentence the clause completes is the compiler's own", async () => {
  // A twin, in two languages: reword one and the rewrite stops fitting the
  // sentence it is dropped into, with nothing failing anywhere.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
  const py = fs.readFileSync(path.join(root, "worker", "h3_prompt.py"), "utf8");
  for (const slot of ["The one change: ", "Exactly one change is applied: "]) {
    assert.ok(py.includes(slot), `compile_video_edit no longer writes "${slot}"`);
    assert.ok(editSystem().includes(slot.trimEnd()),
      `the brief rewriter no longer names "${slot.trimEnd()}"`);
  }
});

test("an edit brief is told to turn a removal into a replacement", () => {
  // THE RULE THAT MADE SHARPEN WORTH PRESSING. Without it, "remove the helmet
  // from the floor" comes back essentially unchanged — it is already one
  // concrete change in seven words, so every other rule here is satisfied —
  // and then renders with the helmet still on the floor, because the model
  // adds what it is told and cannot subtract. Measured against the director
  // chat, which was given the same rule and turned the same request into
  // "replace the helmet on the observatory floor with the same bare
  // observatory floor surface and scattered dust", and it worked.
  const s = editSystem();
  assert.ok(/NEVER LEAVE IT AS A REMOVAL/.test(s));
  assert.ok(/cannot subtract/.test(s), "the mechanism, not just the prohibition");
  assert.ok(/OCCUPIES THE SPACE/.test(s), "and what to write instead");
  // The rewrite must not read as a licence to change what was asked for — the
  // rule below it says to keep the writer's meaning exactly, and a model
  // obeying that one literally would leave the removal alone.
  assert.ok(/SAME request/.test(s));
  // Named cases rather than an abstraction: each of these was typed by a real
  // user into a real edit brief and rendered the thing it asked to be rid of.
  for (const phrasing of ["no glove", "only one person in the room"]) {
    assert.ok(s.includes(phrasing), `${phrasing} is worth naming outright`);
  }
});

test("the removal rule does not contradict the one-change rule", () => {
  // Turning "remove X" into "replace X with the bare surface" must not read as
  // ADDING a second change (scattered dust, bare floor), or a careful model
  // refuses to do it.
  const s = editSystem();
  assert.ok(/invent no new object/.test(s),
    "the guard that keeps a replacement from becoming an invention");
});

test("references are named only when some are staged", () => {
  assert.ok(/No reference images are attached/.test(editSystem({ refs: 0 })));
  assert.ok(!/Picture 1/.test(editSystem({ refs: 0 })), "nothing to point at");
  assert.ok(/1 reference image is attached, numbered Picture 1 /.test(editSystem({ refs: 1 })));
  assert.ok(/3 reference images are attached, numbered Picture 1\.\.3 /.test(editSystem({ refs: 3 })));
});
