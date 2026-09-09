// Per-model prompt guides — what "write a good prompt" means for each family.
//
// The same plain-JS module shape as personas.js, and for the same reason: it is
// imported by the serverless functions (api/director/enhance.js) and by the
// frontend (so the composer can name the guide it is about to apply and say
// when a model has none), while the worker receives the built string inside the
// llm_task payload. One source of truth, no Python twin, no build step.
//
// Keyed by `model_catalog.family`, not by model id: every MiniMax H3 row —
// local checkpoint, hosted API, fal — wants the same prompt, and a new row in
// an existing family inherits its guide for free.
//
// A guide is mostly a POINTER, not prose. `docs` names files in
// director/knowledge/ that are shipped verbatim from the model vendor —
// MiniMax's own VIDEO_PROMPT_WRITING_GUIDE_base_en.md and _ref_en.md — and the
// caller loads them off disk (the worker already does this for pipeline
// grounding; api/director/enhance.js reads the same files). Only `rules` is
// written here, and only for what the doc does not say: which of the model's
// modes this generation is, and what the composer knows that the doc cannot.
//
// It started as a hand distillation of those docs and that was the bug. A
// paraphrase drops exactly the parts that look like formatting and are
// actually the interface: H3's three-field envelope, `[Shot N] At
// HH:MM:SS.mmm`, `(S1) says: <d>[English] …</d>`, the keyframe alignment line.
// The result read like good prose and did not follow the guide the model was
// trained on. Ship the vendor's text; write only the delta.
//
// On invariant #6: the storyboard pipeline still compiles H3 prompts
// deterministically in worker/h3_prompt.py from structured beats, and nothing
// here changes that. The library composer is the one path with no compiler in
// the loop — handle_clip_gen sends payload.prompt to ComfyUI verbatim — so for
// that path the prompt IS the format, and refusing to write it (as this module
// originally did) just guaranteed a prompt H3 was never trained to read.

/** family -> guide. `kind` disambiguates families that span both (openai). */
export const PROMPT_GUIDES = {
  "minimax-h3": {
    label: "MiniMax H3",
    kind: "video",
    /** the output is the vendor's own envelope, not free prose */
    format: "h3",
    /** vendor guides to load verbatim, by mode; `*` is the default */
    docs: {
      "*": ["h3_official_base_modes.md"],
      r2v: ["h3_official_ref_mode.md", "h3_official_base_modes.md"],
    },
    rules: `Follow the guide above exactly, including its output structure. The
target is a SINGLE generation pass of at most 15 seconds at 24fps with native
synchronized audio — so write the shots that fit inside one pass, not a scene
list. Prefer one shot; add a second only when the prompt genuinely cuts.`,
    modes: {
      t2v: "T2VA. Nothing is supplied — build the timeline from the text alone, and open [Shot 1] by naming the visual style and the initial composition.",
      i2v: "I2VA. <Picture 1> IS the frame at 0.00s and belongs to [Shot 1]. Anchor on it — style, subjects, composition, scene — then develop forward: action onset, continuous development, result. Keep identity, clothing, colours and spatial relationships consistent with it.",
      flf: "FL2VA. Picture 1 opens and Picture 2 closes. Do not describe two static images — supply the motion path between them, and land the final shot on Picture 2's pose, spacing and composition. Favour a single shot so the model can interpolate continuously.",
      r2v: "Full-reference mode: write all six sections. Reference images are numbered <Picture 1>, <Picture 2>… in the order they were attached, and the reusable content abstracted from them gets <Subject N> labels defined in subject_definitions. References carry identity and look; the framing is yours to state.",
      v2v: "A source video is supplied as <Video 1>. Describe the change to apply to it, not the content it already has.",
    },
  },

  "wan2.2": {
    label: "Wan 2.2",
    kind: "video",
    rules: `Wan 2.2 renders a short silent clip (up to ~8s at 16fps). It rewards
short, dense, visual prompts and punishes long ones — the back half of a
paragraph is mostly ignored.

Lead with the subject and what it does, then the setting, then the light, then
one camera move. Keep it under about 60 words. Concrete nouns and materials
beat adjectives. One motion only — the model cannot hold two. No audio cues,
no dialogue, no timestamps: it generates neither sound nor lip sync.`,
    modes: {
      i2v: "The opening frame is supplied. Describe only the motion that starts from it — the subject's movement and one camera move. Do not re-describe the image.",
      t2v: "Establish subject, setting and light in the first clause, then the single motion.",
    },
  },

  "ltx-2.3": {
    label: "LTX 2.3",
    kind: "video",
    rules: `LTX 2.3 renders up to ~10s at 24fps, silent. It follows motion
description closely and drifts when asked for too much at once.

Write one sentence of subject and setting, one of action, one of camera. Name
the light source. Keep the whole prompt under about 80 words. No audio cues, no
dialogue. One camera move, stated plainly ("slow push-in", "static wide").`,
    modes: {
      i2v: "The opening frame is supplied — describe the motion away from it, not the frame itself.",
    },
  },

  "ltx-2.5": {
    label: "LTX 2.5",
    kind: "video",
    rules: `LTX 2.5 renders up to ~10s at 24fps WITH its own audio — describe
the soundscape in the same prose as the picture, never as a separate labelled
section (that is MiniMax H3's format, and LTX was not trained on it).

Write one continuous paragraph in the vendor's own element order: the SHOT
first, then the scene's light and texture, then the action, then who the
people are, then the camera move, then what is heard. Cuts are ordinary
chronology, not timestamps — "then cut to a low wide shot as…" — and each cut
states the new framing. Four to eight sentences (their guidance), under about
120 words.

CARRY THE ACTION TO ITS END, and say how the subjects LOOK once the move is
over — the vendor calls that second part critical for completing a motion, and
it is the one rule whose absence is measurable here. Two shots rendered
without it: an extreme close-up asked for a hand reaching while a second
character dragged her backward, and came back as a perfect close-up of the
first character with the drag never happening; a wide asked for a lateral
track and ended on an unbidden close-up of a bystander whose sheet was
staged. Write "…he drags her out of frame left, leaving her hand alone
against the lattice" and the whole beat arrives.

OPEN WITH THE FRAMING, literally — "The video begins on an extreme close-up
of…". Measured across 13 shots: every stated shot size and camera move came
back correct, so ASK PRECISELY and it obeys. Say how much of the frame the
subject fills on a wide ("occupying about a sixth of the frame height") and it
will hold that. Name one camera move per shot in plain words — push in, truck
alongside, crane up, track backward ahead of them, hold still.

Unlike MiniMax H3 this model WILL do the awkward angles, so do not avoid them:
a canted dutch horizon, a true side profile, and an over-the-shoulder with a
soft foreground shoulder all render correctly.

Name a specific sound SOURCE, not an atmosphere. "Faint room tone" comes back
near-silent; footsteps, a door, rain on metal, a siren all come back present
and correctly balanced.

For speech, put the line in quotes and say the lips move in sync — it is
spoken verbatim and lands lip-synced.`,
    modes: {
      t2v: "Establish subject, setting and light in the first clause; audio rides in the same sentence flow.",
      r2v: "The staged references define the people and the place — do not re-describe their faces or wardrobe, direct what they DO and where the camera is. Identity and art style come from the sheets; you are choosing the camera.",
    },
  },

  seedance: {
    label: "Seedance",
    kind: "video",
    rules: `Seedance renders short 1080p clips without audio. It responds well to
cinematic shorthand: shot size, subject, action, lighting, then one camera move.
Keep it tight — one paragraph, one action, one move. No audio or dialogue cues.`,
    modes: {
      i2v: "The opening frame is supplied — describe what changes from it.",
    },
  },

  krea2: {
    label: "Krea 2 / SDXL",
    kind: "image",
    rules: `This is an SDXL-family still-image model. It reads the front of the
prompt hardest, so the order is: subject, then what the subject is doing and
wearing, then framing and angle, then light, then materials and palette, then
the render style.

Be concrete and physical — named garments with colours, named materials
(wet asphalt, brushed steel, raw silk), a named light source with a direction.
Give the framing in photographic terms (close-up, waist-up, wide, low angle,
overhead). Avoid narrative and camera MOTION language: a still has no push-in
and no "then". Avoid negations — the model cannot subtract; say what IS there.
Keep it under about 70 words; past that, SDXL attention thins out.`,
    modes: {
      edit: "An input image is supplied. Describe only the change you want made to it, and what must stay the same. Do not re-describe the whole picture.",
    },
  },

  sensenova: {
    label: "SenseNova U1.5",
    kind: "image",
    rules: `SenseNova U1.5 is a unified multimodal model: it reads an
instruction the way a language model does, not as a tag stack. Write natural
language, and structure it in three parts.

1. NAME EACH REFERENCE AND ITS ROLE, in the order the images are supplied —
"Image 1 is a location plate of ...", "Image 2 is a character reference sheet
for Mara ...". The model is told nothing about what a picture is FOR unless the
prompt says so, and a plate it mistakes for a subject gets reproduced.
2. STATE THE CHANGE. Say what to make, in full: shot size, camera height and
angle, what fills the frame and roughly how much of it, what the subjects are
doing. It obeys a written camera, so an explicit "reposition the camera, this
is a NEW setup, not the framing of image 1" is worth saying whenever a
reference plate would otherwise be copied.
3. STATE WHAT MUST NOT CHANGE, as its own line — identity and wardrobe from the
character sheet, architecture, materials and palette from the location plate.
This model rewards an explicit preservation list far more than an SDXL-family
model does.

It renders legible text: put any lettering you want in double quotes and say
where it sits. It generates natively at 4K-class sizes (about 4MP), so ask for
composition, not resolution. Long prompts are fine — 150-250 words is normal
and useful here, unlike the ~70-word SDXL budget.`,
    modes: {
      edit: "One or more input images are supplied and the first is the one being edited. Name what changes and then list what is unchanged — camera, framing, everyone's pose and wardrobe, lighting and grade. Do not re-describe the whole picture; the model preserves what it is told to preserve.",
    },
  },

  seedream: {
    label: "Seedream",
    kind: "image",
    rules: `Seedream follows natural-language description closely and handles
long prompts better than SDXL-family models, including text rendering in the
image. Write a clear descriptive sentence or two: subject, action, framing,
light, palette, style. State any lettering you want in quotes. Avoid negations
— say what is there.`,
    modes: {
      edit: "An input image is supplied — describe only the change, and what must be preserved.",
    },
  },

  // --- music. `kind: "music"` is a third value, not a flavour of image: the
  // output has no framing, no light and no materials, so every rule in the
  // image guides above is wrong for it, and the fallback it would otherwise
  // land on would rewrite a genre brief into a description of a picture.
  //
  // Neither of these is a `format: "h3"`-style envelope — both models take
  // free text — but the two want OPPOSITE shapes of it, which is exactly what
  // a per-family guide is for.
  "minimax-music3": {
    label: "MiniMax Music 3",
    kind: "music",
    rules: `This model reads a CAPTION: prose describing the record as a whole,
in three passes, in this order.

1. Global metadata — genre and sub-genre, tempo in BPM, key and scale, the
   emotional arc across the song, the listening scenario, and the production
   profile (which era's mixing and mastering it sounds like).
2. Vocal details — the singer's gender, timbre and register, how they deliver
   the line, and whether there are harmonies, doubles or ad-libs.
3. Arrangement — the actual instruments, how they enter and evolve, the groove,
   and the space (room, plate, tape, width).

Write it as continuous prose, not a tag stack. Name real instruments and real
production techniques rather than mood adjectives — "brushed drums, upright
bass, Rhodes through a tape delay" carries a record where "chill vibes" does
not. Never write the lyrics here: they are a separate field, and a caption that
contains lines of a song makes the model sing its own production notes.`,
    modes: {
      t2m: "The lyrics, if any, are supplied separately. Describe the record; do not write words for the singer.",
    },
  },

  acestep: {
    label: "ACE-Step 1.5",
    kind: "music",
    // Not "prose", so the shared rewrite rules stop demanding a paragraph —
    // "one continuous paragraph" is the exact opposite of what this wants.
    format: "tags",
    rules: `This model reads TAGS, not prose: a comma-separated list, strongest
first. Cover, roughly in this order — genre and sub-genre, then the lead
instruments and the rhythm section, then the vocal (male/female/duet/none and
its character), then the mood, then the production and era.

Keep each tag two or three words. Do not write sentences, do not write a
narrative, and do not repeat a tag in a longer form. Tempo, musical key and
time signature are SEPARATE typed controls on this model — leave them out of
the tags entirely rather than writing "120 BPM" into the list, where it is
just two more tokens competing with the genre.

Lyrics are a separate field and never belong here.`,
    modes: {
      t2m: "Tags only, comma separated. BPM, key and time signature are set elsewhere — do not name them.",
    },
  },

  // --- sfx. A fourth kind for the same reason music was a third: a sound
  // effect has no genre, no arrangement and no vocal, so the music rules
  // above rewrite "steel hatch dragging open" into a description of a track.
  "stable-audio-3": {
    label: "Stable Audio 3",
    kind: "sfx",
    rules: `This model reads ONE SENTENCE of sound design — the caption a
library would file the recording under, not a tag stack and not a story.

Write it in this order: the source (what is making the sound), the material it
is made of, the action being done to it, then the acoustic space it happens in.
"Heavy steel hatch dragging open on dry hinges, pneumatic hiss, long concrete
reverb" is the shape. Name materials and mechanisms — steel, canvas, gravel,
servo, ratchet — because those are what the model was trained on; "epic" and
"cinematic" describe a feeling and carry almost no sound.

End with the length, written as "Length: N seconds". The training captions
state it, and a caption that omits it gets a sound that fills the clip by
accident rather than by design.

One sound per generation. Two events in one caption ("footsteps and a door")
come back muddled — render them separately and layer them on the timeline.
No negations, no camera language, no musical key.`,
    modes: {
      t2sfx: "One sound, described as a recording of a real event, ending with its length in seconds.",
    },
  },

  // --- video -> audio. A FIFTH kind, and coercing it to `sfx` produces
  // advice that is wrong in three specific ways rather than merely generic:
  // that guide says to end with "Length: N seconds" (Stable Audio's own
  // training-caption convention — here the length is a knob and comes from the
  // clip), it says ONE sound per generation (a shot has several sources at
  // once and this model is being asked for all of them), and it says no
  // negations (here the negative prompt is a live control at cfg 4.5, and the
  // vendor's own advice is to use it).
  mmaudio: {
    label: "MMAudio",
    kind: "v2a",
    rules: `This model WATCHES THE CLIP. It already knows what is on screen and
when things happen — your text says which of the sounds it could plausibly make
are the ones you want, so write the SOURCES, not the story and not the picture.

"Boots on wet gravel, a chain-link gate rattling, distant traffic" is the
shape: a short comma-separated list of things making noise, most important
first. Name materials and mechanisms — gravel, canvas, servo, ratchet — because
those carry sound; "epic", "cinematic" and "tense" describe a feeling and carry
almost none. Do not describe the shot, the camera or the characters: it can see
those, and words spent on them are words not spent on the audio.

Several sources at once is CORRECT here, unlike a text-to-sound model — the
whole point is a full soundbed that lines up with the frames.

Use the negative prompt, and be specific with it. It is a real control on this
model. "music, speech, voices" is the standard one for a clean effects bed;
"distorted, harsh, hiss" for something gentler.

Do not write dialogue and do not ask for speech — it produces babble rather
than words. A line belongs to the voice pipeline. Do not state the length: the
clip decides it. No camera language, no musical key, no lyrics.`,
    modes: {
      v2a: "A silent clip is supplied — list the sound sources you want to hear in it, most important first.",
    },
  },

  openai: {
    label: "GPT Image",
    kind: "image",
    rules: `GPT Image follows plain natural language and prefers a described
scene over a keyword stack. Write two or three sentences: what the picture
shows, how it is framed, how it is lit, and the rendering style. Name colours
and materials. Any lettering goes in quotes. Do not use negations or weight
syntax.`,
    modes: {
      edit: "An input image is supplied — describe only the change you want, and what must stay.",
    },
  },
};

/** Used when the model's family has no guide of its own. */
export const FALLBACK_GUIDES = {
  video: {
    label: "generic video",
    kind: "video",
    rules: `Write one continuous shot. Order: subject and setting, then the
action in present tense, then one camera move, then the light. Concrete nouns
and materials over adjectives. One action and one camera idea — no cut lists,
no timestamps.`,
    modes: {},
  },
  image: {
    label: "generic image",
    kind: "image",
    rules: `Write one still image. Order: subject, then framing and angle, then
light with a named source, then materials and palette, then style. Concrete and
physical. No motion language, no negations.`,
    modes: {},
  },
  music: {
    label: "generic music",
    kind: "music",
    rules: `Describe one piece of music. Order: genre and tempo, then the lead
instruments and rhythm section, then the vocal (or state that it is
instrumental), then the mood and the production era. Name real instruments and
real techniques rather than mood adjectives. Never write lyrics — those are a
separate field.`,
    modes: {},
  },
  v2a: {
    label: "generic video-to-audio",
    rules: `A silent clip is supplied and the model can see it. List the sound
SOURCES you want to hear, most important first, as a short comma-separated
phrase — materials and mechanisms rather than moods. Do not describe the
picture, the camera or the story; it has those. Do not state a length; the clip
decides it. Use the negative prompt to keep things out.`,
    kind: "v2a",
    modes: {},
  },
  sfx: {
    label: "generic sound effect",
    kind: "sfx",
    rules: `Describe ONE sound as a recording of a real event: the source, its
material, the action, then the space it happens in. Concrete mechanisms over
adjectives. End with the length in seconds. One event per generation.`,
    modes: {},
  },
};

/** The kinds `guideFor` can select. Anything else falls back to image, which
 *  is the historical behaviour and right for an unknown still model. */
const GUIDE_KINDS = new Set(["video", "image", "music", "sfx", "v2a"]);

/**
 * The guide that applies to a generation.
 * @param {{family?: string, kind?: string, mode?: string}} sel
 * @returns {{id: string, label: string, rules: string, note: string,
 *            format: string, docs: string[], exact: boolean}}
 */
export function guideFor(sel = {}) {
  const kind = GUIDE_KINDS.has(sel.kind) ? sel.kind : "image";
  const fam = sel.family ? PROMPT_GUIDES[sel.family] : null;
  const hit = fam && fam.kind === kind ? fam : null;
  const g = hit ?? FALLBACK_GUIDES[kind];
  const docs = g.docs ? (g.docs[sel.mode] ?? g.docs["*"] ?? []) : [];
  return {
    id: hit ? sel.family : `_${kind}`,
    label: g.label,
    rules: g.rules,
    note: (sel.mode && g.modes && g.modes[sel.mode]) || "",
    /** "h3" = the vendor envelope; "prose" = one paragraph of description */
    format: g.format || "prose",
    /** filenames in director/knowledge/ the caller should load and append */
    docs,
    // false means "we are applying general craft, not this model's own guide" —
    // the UI says so rather than implying a guide exists that doesn't.
    exact: !!hit,
  };
}

/**
 * The instruction line an H3 keyframe mode must open with, verbatim, before a
 * blank line and the fields. Deterministic on purpose: the wording is fixed by
 * the vendor guide and the timestamp has to match the real render duration,
 * which is the caller's arithmetic, not something to ask a model to recall.
 * (worker/h3_prompt.py has the storyboard pipeline's own copy for the compiled
 * path; this one serves the composer, which never reaches that compiler.)
 * @returns {string} empty when the mode supplies no keyframe
 */
export function h3AlignmentLine(mode, durationMs, lastShot = 1) {
  const sec = (Math.max(0, durationMs || 0) / 1000).toFixed(2);
  if (mode === "i2v") {
    return "For the target video, at 0.00 seconds into the target video, "
      + "<Picture 1> (from [Shot 1]) is fully referenced.";
  }
  if (mode === "flf") {
    return "How the reference pictures align with the target video — Picture 1 "
      + `(from Shot 1) aligns with the 0.00-second mark of the target video; `
      + `Picture 2 (from Shot ${lastShot}) aligns with the ${sec}-second mark `
      + "of the target video.";
  }
  return "";
}

/** Does this family ship a guide of its own? (UI copy, not a gate.) */
export const hasGuide = (family, kind) => {
  const g = family ? PROMPT_GUIDES[family] : null;
  return !!g && g.kind === (GUIDE_KINDS.has(kind) ? kind : "image");
};

/** True for every guide: what a rewrite is and is not allowed to do. */
const SHARED_RULES = `You rewrite one generation prompt. Rules:
- Return ONLY the rewritten prompt. No preamble, no explanation, no commentary,
  no markdown fences, no surrounding quotes.
- Keep the user's intent, subjects, named characters, locations and story
  beats. You are sharpening what they asked for, not replacing it.
- Add the concrete detail the model needs — framing, light, materials, motion —
  and cut vagueness, meta-instructions and adjectives that carry no image.
- Invent nothing that contradicts the prompt. Where the prompt is silent on
  something the model needs, choose the reading that best serves what is there.
- Never write dialogue that was not asked for. Reproduce dialogue that WAS
  asked for verbatim, punctuation included.`;

/** Models whose prompt is a paragraph of description, not a vendor envelope. */
const PROSE_RULES = `- Output one continuous paragraph. No shot lists, no scene
  headings, no timestamps: this model reads a description, not a script.`;

/** Models whose prompt is a keyword list (ACE-Step). PROSE_RULES is not merely
 *  unhelpful here, it is the opposite instruction — a rewrite told to produce
 *  "one continuous paragraph" produces exactly the thing the tag encoder reads
 *  worst. */
const TAG_RULES = `- Output ONE line: comma-separated tags, strongest first. No
  sentences, no paragraph, no bullet list, no trailing full stop.`;

/** Models whose vendor guide defines the output structure (H3). */
const FORMAT_RULES = `- The guide above defines the OUTPUT FORMAT, not just the
  writing style. Reproduce its section names, labels and syntax exactly as it
  specifies them — the field names and their order, the shot markers and cut
  timestamps, the speaker IDs and dialogue tags, the reference labels, the
  quoting of on-screen text. This model was trained on that structure; prose
  that ignores it is a worse prompt no matter how well written.
- Emit the sections as plain text in the guide's order. Do not wrap them in
  JSON, YAML or markdown.`;

/**
 * The system prompt for one enhance turn.
 *
 * `docText` is the vendor guide, loaded from director/knowledge/ by whoever is
 * running the turn — the serverless function off its bundled copy, the worker
 * off the pod's. It is deliberately not bundled into the browser: these files
 * run to 39KB and the browser only ever needs the label.
 *
 * @param {{guide: object, kind: string, mode?: string, modeLabel?: string,
 *          docText?: string, alignment?: string, durationMs?: number,
 *          style?: string, refs?: number, hasStart?: boolean, words?: number}} o
 */
export function enhanceSystem(o = {}) {
  const g = o.guide ?? guideFor(o);
  const strict = g.format === "h3";
  const lines = [
    `You are a prompt engineer for ${g.label}.`,
    "",
    SHARED_RULES,
    strict ? FORMAT_RULES : g.format === "tags" ? TAG_RULES : PROSE_RULES,
  ];
  if (o.docText) {
    lines.push("", `--- ${g.label} prompt writing guide (vendor documentation) ---`,
      o.docText, `--- end of guide ---`);
  }
  if (g.rules) lines.push("", g.rules);
  if (g.note) lines.push("", `This generation is ${o.modeLabel || o.mode}: ${g.note}`);
  if (o.durationMs) {
    lines.push("", `The pass is ${(o.durationMs / 1000).toFixed(2)} seconds long. `
      + "Every cut timestamp must fall inside it and increase strictly.");
  }
  if (o.alignment) {
    lines.push("", "Begin the output with this line verbatim, then one blank line, "
      + `then the fields:\n${o.alignment}`);
  }
  if (o.refs) {
    lines.push("", `${o.refs} reference image${o.refs === 1 ? " is" : "s are"} attached, `
      + `numbered Picture 1${o.refs > 1 ? `..${o.refs}` : ""} in that order. `
      + "They carry identity and look; the text still has to say who is in frame "
      + "and how the shot is framed.");
  }
  // Only when the mode note hasn't already said it — i2v/flf guides do.
  if (o.hasStart && !g.note) {
    lines.push("", "The opening frame is supplied and fixed — write the change away from it, "
      + "not a description of it.");
  }
  // NO SCORE ON A VIDEO REWRITE, and it goes AFTER the vendor guide because
  // the guide is what argues for one: five of the six worked examples in
  // MiniMax's own documentation carry a `non_diegetic_music` cue, so a
  // rewriter following it faithfully invents a soundtrack every time.
  //
  // A video enhance feeds exactly one path — `handle_clip_gen`, which sends
  // `payload.prompt` to ComfyUI VERBATIM — and that path's own audio default
  // is `non_diegetic_music: N/A`, written by `h3_prompt.with_audio_defaults`
  // ONLY when the prompt does not already carry the field. So an invented cue
  // does not add music to a shot; it OVERRIDES the studio's decision not to
  // bake one. A per-block score cannot be episode-consistent, it fights the
  // real one `score_mix` lays under the whole cut at assembly, and on an
  // extend or a chain it changes at the join — the same reasoning that makes
  // the ref-dialogue path compile music as a bare N/A.
  //
  // INVENTING is what is forbidden, not carrying: a prompt that asks for a
  // score keeps it, which is SHARED_RULES' own "invent nothing" read the
  // right way round. Diegetic sound is untouched — a radio in the shot is
  // something the scene contains, not something scored over it.
  if (o.kind === "video") {
    lines.push("", strict
      ? "DO NOT INVENT A MUSICAL SCORE. Unless the prompt you are given "
        + "already asks for background music, emit the music field exactly as "
        + "`non_diegetic_music: N/A` — whatever the guide's examples show. The "
        + "studio scores the finished cut, so a cue baked into one shot fights "
        + "it and changes at every join. Sound made by something in the shot "
        + "(a radio, an instrument, a speaker) is diegetic: describe it in the "
        + "soundscape field as usual."
      : "DO NOT INVENT A MUSICAL SCORE, soundtrack or background music. Unless "
        + "the prompt you are given already asks for one, write none — the "
        + "studio scores the finished cut, so a cue baked into one shot fights "
        + "it and changes at every join. Sound made by something in the shot "
        + "(a radio, an instrument, a speaker) is diegetic and may be "
        + "described as usual.");
  }
  if (o.style) {
    lines.push("", `The project's style guide, which the result must stay inside:\n${o.style}`);
  }
  if (!strict) {
    // ACE-Step's tags are the short case by a wide margin — a 130-word tag
    // stack is a paragraph wearing commas, and the guide above says so. Music 3
    // wants the fullest of the three: three described passes over one record.
    const words = o.words
      || (o.kind === "music" ? (g.id === "acestep" ? 35 : 110)
        // An SFX caption is the shortest thing here by design: one source, one
        // action, one space, and the length. Give it a paragraph's budget and
        // the rewrite pads it into a scene, which is the ONE failure mode this
        // model has (two events in a caption come back muddled).
        : o.kind === "sfx" ? 30
          : o.kind === "video" ? 130 : 80);
    lines.push("", `Target length: about ${words} words. Shorter is better than padded.`);
  }
  return lines.join("\n");
}


/**
 * The system prompt for sharpening a VIDEO EDIT BRIEF.
 *
 * NOT `enhanceSystem`, and the difference is structural rather than one of
 * tone. That one rewrites a PROMPT: on an H3 family it is handed the vendor
 * documentation and told the guide defines the output FORMAT, so it correctly
 * returns the six-section envelope. An edit brief is not a prompt — the studio
 * compiles the envelope itself (`h3_prompt.compile_video_edit`) and
 * interpolates these words into two of its own sentences, "The one change: X."
 * and "Exactly one change is applied: X." So an envelope returned here would
 * be nested inside another envelope, and the render would read as garbage.
 * What this asks for is the CLAUSE that completes those two sentences.
 *
 * The second rule is the one that is easy to get backwards: a rewrite must NOT
 * describe the source shot. The envelope already declares `<Video 1>` fully
 * preserved "except where the requested change applies", so restating the
 * framing, the camera or the subjects re-specifies exactly what is being held
 * — and this file's own record of H3 obeying a picture over a sentence says
 * where that ends up.
 *
 * @param {{refs?: number}} o
 */
export function editSystem(o = {}) {
  const refs = Math.max(0, Number(o.refs) || 0);
  return [
    "You sharpen one VIDEO EDIT INSTRUCTION.",
    "",
    "The studio is holding a finished shot and will re-render it with the one "
    + "change the writer asks for. Your output is the words that NAME that "
    + "change: they are dropped verbatim into sentences that already read "
    + "\"The one change: …\" and \"Exactly one change is applied: …\", so write "
    + "the clause that completes them.",
    "",
    "- Return that clause and NOTHING else: no preamble, no surrounding "
    + "quotes, no note about what you changed, no trailing full stop.",
    "- Emit NO prompt structure. No field labels (subject_definitions, "
    + "summary, detailed_description, overall_soundscape), no `[video "
    + "editing]` marker, no <Video 1> or <Audio 1> tags, no [Shot N] markers "
    + "and no timestamps. The studio writes all of that around your words.",
    "- Do NOT describe the shot as it already is. Its framing, camera "
    + "movement, subjects, action, timing, lighting and sound are declared "
    + "preserved elsewhere; restating them invites the model to re-decide "
    + "them, which is the one thing an edit must not do. Write only the "
    + "difference.",
    "- Say what the change is TO, concretely — a colour, a garment, an object, "
    + "a position, a speed, a time of day — never that something should be "
    + "\"better\", \"more cinematic\" or \"different\".",
    "- NEVER LEAVE IT AS A REMOVAL, and this is the rule that earns this whole "
    + "turn. The model ADDS what it is told and cannot subtract: \"remove the "
    + "helmet from the floor\", \"no glove\", \"she should not be holding it\" "
    + "and \"only one person in the room\" each put the helmet, the glove, the "
    + "object and the second person into the description the render reads, and "
    + "it draws them. Measured, repeatedly, on this exact path. So write what "
    + "OCCUPIES THE SPACE instead: \"replace the helmet on the floor with the "
    + "same bare floor and scattered dust\", \"her bare hand\", \"her hands "
    + "empty at her sides\", \"the doorway behind her empty\". Name the "
    + "plainest thing the shot would already have there — the surface, the "
    + "wall, the floor, bare skin — and invent no new object to fill the gap. "
    + "That is the SAME request in words the model can perform, so it does not "
    + "count against the rule below about keeping the writer's meaning.",
    "- Do not ADD a change. If the brief names more than one, keep them all: "
    + "dropping what the writer asked for is not yours to do. Invent no third "
    + "— no mood, no camera move, no score, no extra person or object.",
    "- Keep the writer's meaning exactly. Fix spelling and grammar.",
    "- About 30 words. Shorter is better than padded.",
    "",
    refs
      ? `${refs} reference image${refs === 1 ? " is" : "s are"} attached, `
        + `numbered Picture 1${refs > 1 ? `..${refs}` : ""} in that order. Where `
        + "the change means one of them, name it as \"Picture 1\" — that label "
        + "is what binds the instruction to the picture, and a change that "
        + "means a staged reference and never names it is a picture the render "
        + "ignores. Refer to what a picture SHOWS, never to how it is framed."
      : "No reference images are attached, so refer to no picture.",
  ].join("\n");
}
