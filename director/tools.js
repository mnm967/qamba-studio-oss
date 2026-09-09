// The director's toolset — the ~40 things a director turn can DO, and the one
// function that does them.
//
// WHY IT LIVES HERE RATHER THAN IN `api/director/chat.js`, where it grew up:
// three directors now run this toolset and they run in three PLACES. The
// hosted dock is a Vercel function with a service key; the pod's is
// `worker/director_tools.py`; and the desktop's runs IN THE BROWSER against a
// local Ollama, where `@anthropic-ai/sdk`, `requireUser` and a service key all
// fail at import. Everything below is portable — the only thing that is not is
// how it reaches the database, so that is INJECTED.
//
// THE DB LAYER SPEAKS POSTGREST PATHS, which is what makes this work at all:
// `sbGet('scenes?select=*&id=eq.X')` is a URL, not a client API, so the same
// call is a service-key fetch on the server and an anon-key fetch (with RLS
// doing the scoping) in the browser. Nothing in the body below changed when it
// moved — the names are the same, only their bindings are.
//
// `tool_parity.test.mjs` reads THIS file for the hosted tool names and pins
// them against the Python twin. Adding a tool here without adding it there is
// the drift that test exists to catch.

import {
  blockRef, sceneRef, shotRef, blockRefToIdx, sceneRefToIdx, shotRefToIdx,
} from "./refs.js";
import { guideFor } from "./prompt_guides.js";
import { catalogIdOf, modelKeyOf } from "./model_keys.js";
import { blockKindOf, isClipBornBlock, kindLabel } from "./block_kind.js";
import { journalOpen, noteChange, selectPath, tableOf, withJournal } from "./changes.js";
import VOICE_DOC from "./voices.json" with { type: "json" };
import {
  SEARCH_LORE_DESC, SEARCH_LORE_SCHEMA, SET_LORE_TIMING_DESC, SET_LORE_TIMING_SCHEMA,
} from "./lore_schema.js";

/* ── the injected halves ───────────────────────────────────────────────── */

let DB = null;
let LORE = null;

/**
 * Hand the toolset a database and a lore implementation.
 *
 * Called once per process by whoever owns the credentials: `api/director/
 * chat.js` with the service-key fetches, the browser with anon-key ones. It is
 * module-level rather than a factory so the 2,000 lines below could move
 * UNCHANGED — a closure wrap would have re-indented every one of them and made
 * the diff impossible to read against the original.
 */
export function configureTools({ db, lore }) {
  DB = db;
  LORE = lore;
}

const needDb = () => {
  if (!DB) throw new Error("director/tools.js: configureTools() was never called");
  return DB;
};
const needLore = () => {
  if (!LORE) throw new Error("director/tools.js: configureTools() was never called");
  return LORE;
};

// Same names the body already used, so nothing below had to change.
//
// EVERY WRITE IS JOURNALED while a journal is open (director/changes.js): the
// runner opens one per tool call, persists the ops onto the assistant message
// as a `changes` block, and the dock's Revert replays them backwards. An
// update reads the rows it is about to touch FIRST and keeps only the columns
// the patch names — so a revert puts back exactly what this turn changed and
// leaves alone whatever the worker wrote afterwards. Reads are never
// journaled. A write whose path carries no filter cannot be journaled without
// reading a whole table, and is recorded as unbounded so the revert says which
// part it could not undo rather than being silently partial.
const sbGet = (...a) => needDb().get(...a);
const sbIns = async (table, body) => {
  const row = await needDb().ins(table, body);
  if (journalOpen()) {
    const rows = Array.isArray(row) ? row : [row];
    for (const r of rows) noteChange({ op: "insert", table, id: r?.id ?? null });
  }
  return row;
};
const journalUpdate = async (path, body) => {
  if (!journalOpen()) return;
  const keys = Object.keys(body ?? {});
  const sel = selectPath(path, ["id", "entry_id", "asset_id", "collection_id", ...keys].join(","));
  if (!sel) { noteChange({ op: "update", table: tableOf(path), unbounded: true }); return; }
  let before = [];
  try { before = await needDb().get(sel); } catch { /* the write still happens */ }
  noteChange({ op: "update", table: tableOf(path), keys, before: Array.isArray(before) ? before : [] });
};
const sbUpd = async (path, body) => {
  await journalUpdate(path, body);
  return needDb().upd(path, body);
};
const sbUpdRows = async (path, body) => {
  await journalUpdate(path, body);
  return needDb().updRows(path, body);
};
const sbDel = async (path) => {
  if (journalOpen()) {
    const sel = selectPath(path, "*");
    if (!sel) noteChange({ op: "delete", table: tableOf(path), unbounded: true });
    else {
      let rows = [];
      try { rows = await needDb().get(sel); } catch { /* the delete still happens */ }
      noteChange({ op: "delete", table: tableOf(path), rows: Array.isArray(rows) ? rows : [] });
    }
  }
  return needDb().del(path);
};
const loreDocList = (...a) => needLore().loreDocList(...a);
const searchLore = (...a) => needLore().searchLore(...a);
const setLoreTiming = (...a) => needLore().setLoreTiming(...a);

/* ── constants the toolset owns ────────────────────────────────────────── */

// 6 was written when a turn was "read something, queue one thing". An editing
// turn chains: resolve the block, read it, change the beat, re-render, report —
// and running out of rounds mid-chain leaves the plan edited and unrendered,
// which is the exact half-finished state these tools exist to prevent.
export const MAX_ROUNDS = 12;

// Anything a human asked for outruns the machine's own queue: the wizard's
// masters run at 50 and the reviewer's auto-retakes at 8. Same constant as
// src/lib/db/jobs.ts and worker/director_tools.py.
const USER_PRIORITY = 5;

const VOICES = VOICE_DOC.voices;

/** Payload keys with no value are dropped rather than sent as null — the
 *  worker's handlers read `payload.get(k)` and a present null is not the same
 *  as an absent key for `model_key` or `mode`. */
const dropNulls = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));

// ------------------------------------------------------------------ tools ---
const TOOLS = [
  {
    name: "get_project_state",
    description: "Current project snapshot: episodes, bible entries, lore documents, latest storyboard + block statuses, recent jobs, studio cloud state. Call before acting on project structure.",
    input_schema: { type: "object", properties: {} },
  },
  { name: "search_lore", description: SEARCH_LORE_DESC, input_schema: SEARCH_LORE_SCHEMA },
  { name: "set_lore_timing", description: SET_LORE_TIMING_DESC, input_schema: SET_LORE_TIMING_SCHEMA },
  {
    name: "list_storyboard",
    description: "Scenes and beats of a storyboard (latest for the episode when no id given). "
      + "Pass scene_id to read ONE scene — a whole board is tens of kilobytes of beat prose, "
      + "and re-reading it costs a round you could have spent editing.",
    input_schema: {
      type: "object",
      properties: {
        storyboard_id: { type: "string", description: "storyboard uuid" },
        scene_id: { type: "string",
                    description: "one scene only — its id, an \"S3\" ref or its slug" },
      },
    },
  },
  {
    name: "update_bible_entry",
    description: "Create a bible entry (character/environment/prop/style/lore) or propose a revision to an existing one. Revisions are drafts until the user confirms them in the Bible page — say so.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["character", "environment", "prop", "style", "lore"] },
        name: { type: "string" },
        summary: { type: "string" },
        identity_line: { type: "string", description: "one sentence, 6-8 concrete visual attributes, repeatable verbatim" },
        doc: { type: "object", description: "character/environment: appearance, personality, arc, wardrobe, voice, palette, layout. LORE: put the prose in `body` — that is the field the planner reads and the one the Lore tab edits. Merged over the existing doc, so omit what you are not changing. Use set_lore_timing for when a lore fact is true; do not hand-write `when` here." },
        change_note: { type: "string" },
      },
      required: ["kind", "name"],
    },
  },
  {
    name: "search_assets",
    description: "Find media in the library by kind/tag/name fragment.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["image", "video", "audio", "frame", "render", "file"] },
        tag: { type: "string" },
        text: { type: "string", description: "filename fragment" },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "plan_storyboard",
    description:
      "Plan a storyboard FROM SCRATCH: brief -> scenes/beats + draft bible entries. This is " +
      "an LLM job queued in the studio cloud, so it waits for the worker, and it REPLACES any plan " +
      "that exists along with every edit made to it. When a storyboard is already on screen " +
      "and the user wants it different — even very different — change it here with " +
      "add_scene / update_scene / delete_scene instead; you have the whole thing in context. " +
      "tier 1 = full auto (ref sheets + render); tier 2 = stops for review. Confirm before tier 1.",
    input_schema: {
      type: "object",
      properties: {
        logline: { type: "string" },
        notes: { type: "string", description: "directing notes, constraints, references" },
        duration_target_ms: { type: "integer" },
        tier: { type: "integer", enum: [1, 2] },
        episode_id: { type: "string" },
        audio_asset_id: { type: "string", description: "master track asset (music videos)" },
      },
      required: ["logline", "duration_target_ms", "tier"],
    },
  },
  {
    name: "launch_render",
    description: "Plan generation blocks for an approved storyboard and queue the full render DAG in the studio cloud. Spends real GPU time — confirm with the user first.",
    input_schema: {
      type: "object",
      properties: {
        storyboard_id: { type: "string" },
        width: { type: "integer" }, height: { type: "integer" },
      },
      required: ["storyboard_id"],
    },
  },
  {
    name: "retake_block",
    description: "Re-render one generation block as a new take (does not auto-replace; the user keeps it from the takes browser).",
    input_schema: {
      type: "object",
      properties: {
        block_id: { type: "string" },
        seed: { type: "integer", description: "omit for a fresh seed" },
      },
      required: ["block_id"],
    },
  },
  {
    name: "generate_image",
    // The rules come from the model's own guide rather than being restated
    // here, so the tool cannot drift from what the composer and the worker use.
    description:
      "Queue an image generation: bible ref sheet (bible_entry_id), scene still (scene_id), " +
      "or free-form. ref_asset_ids anchor identity/style.\n\nWrite `prompt` to this guide:\n" +
      guideFor({ kind: "image" }).rules,
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        bible_entry_id: { type: "string" },
        scene_id: { type: "string" },
        // The sheet slot. These are the values the column accepts, and a place
        // has angles where a person has views — asking for a location's "face"
        // is not a thing.
        role: { type: "string",
                enum: ["face", "full_body", "side", "outfit",
                       "master", "alt_angle", "detail", "atmosphere", "ref"],
                description: "character: face/full_body/side/outfit; " +
                             "location: master/alt_angle/detail/atmosphere" },
        ref_asset_ids: { type: "array", items: { type: "string" } },
        width: { type: "integer" }, height: { type: "integer" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "update_scene",
    description:
      "Change one scene of the current storyboard: its slug, its prose, how long it runs, " +
      "which bible characters are in it, or where it happens. Durations are milliseconds. " +
      "Editing a scene makes its generation blocks stale — say so if any have rendered.",
    input_schema: {
      type: "object",
      properties: {
        scene_id: { type: "string",
                    description: "the scene_id from the listing, or how it is labelled on " +
                                 "screen: \"S3\" or its slug" },
        slug: { type: "string", description: "SHOUTY_SNAKE label, e.g. FIGHT_IN_ALLEY" },
        scene_prompt: { type: "string", description: "what happens, in prose" },
        duration_ms: { type: "integer" },
        cast_names: { type: "array", items: { type: "string" },
                      description: "bible character names in this scene; replaces the cast" },
        environment_name: { type: "string", description: "bible location name" },
      },
      required: ["scene_id"],
    },
  },
  {
    name: "update_beat",
    description:
      "Change one beat inside a scene: its action, camera, dialogue, sfx or duration. " +
      "Beats are the units the H3 prompt compiler reads — keep action concrete and physical. " +
      "You never write the compiled prompt format yourself.",
    input_schema: {
      type: "object",
      properties: {
        beat_id: { type: "string",
                   description: "the beat_id from the listing, or \"b2\" with scene_id set" },
        scene_id: { type: "string",
                    description: "which scene the beat is in — only needed when beat_id is a label" },
        action: { type: "string" },
        camera: { type: "string", description: "type + amplitude + speed, in prose" },
        duration_ms: { type: "integer" },
        sfx: { type: "string" },
        cast: {
          type: "array",
          items: { type: "string" },
          description:
            "who is VISIBLE in this shot, by name. This is what decides whose " +
            "character sheets are staged as references, so it is how you take " +
            "someone OUT of a shot — rewriting the action alone leaves their " +
            "reference pictures in, and the render follows the pictures. Pass [] " +
            "for a shot with nobody in it.",
        },
        dialogue: {
          type: "array",
          description: "replaces the beat's dialogue; a line may carry offscreen: true — it plays as voice-over while the camera is elsewhere (a listener reaction, an insert) and its speaker stays out of frame",
          items: {
            type: "object",
            properties: {
              speaker: { type: "string", description: "bible character name" },
              line: { type: "string" },
              delivery: { type: "string" },
            },
            required: ["speaker", "line"],
          },
        },
      },
      required: ["beat_id"],
    },
  },
  {
    name: "add_scene",
    description:
      "Insert a new scene into the current storyboard, with its beats. Use this (with " +
      "update_scene / delete_scene) to change the shape of a storyboard that already " +
      "exists — it happens here, in this conversation. plan_storyboard is a different " +
      "thing: it throws this plan away and queues a worker job in the studio cloud.",
    input_schema: {
      type: "object",
      properties: {
        after_scene_id: { type: "string",
                          description: "insert after this scene (id, \"S3\" or slug); omit to append" },
        slug: { type: "string" },
        scene_prompt: { type: "string" },
        duration_ms: { type: "integer" },
        cast_names: { type: "array", items: { type: "string" } },
        environment_name: { type: "string" },
        beats: {
          type: "array",
          description: "at least one; each 2-12s of concrete physical action",
          items: {
            type: "object",
            properties: {
              action: { type: "string" },
              camera: { type: "string" },
              duration_ms: { type: "integer" },
              sfx: { type: "string" },
              dialogue: {
                type: "array",
                items: {
                  type: "object",
                  properties: { speaker: { type: "string" }, line: { type: "string" },
                                delivery: { type: "string" } },
                  required: ["speaker", "line"],
                },
              },
            },
            required: ["action"],
          },
        },
      },
      required: ["slug", "beats"],
    },
  },
  {
    name: "delete_scene",
    description: "Remove a scene and its beats from the storyboard. The scenes after it close up.",
    input_schema: {
      type: "object",
      properties: { scene_id: { type: "string", description: "id, \"S3\", or the slug" } },
      required: ["scene_id"],
    },
  },
  {
    name: "add_beat",
    description: "Add a beat to an existing scene (2-12s of concrete physical action).",
    input_schema: {
      type: "object",
      properties: {
        scene_id: { type: "string" },
        after_beat_id: { type: "string", description: "insert after this beat; omit to append" },
        action: { type: "string" },
        camera: { type: "string" },
        duration_ms: { type: "integer" },
        sfx: { type: "string" },
        dialogue: {
          type: "array",
          items: {
            type: "object",
            properties: { speaker: { type: "string" }, line: { type: "string" },
                          delivery: { type: "string" } },
            required: ["speaker", "line"],
          },
        },
      },
      required: ["scene_id", "action"],
    },
  },
  {
    name: "delete_beat",
    description: "Remove a beat from its scene. The beats after it close up.",
    input_schema: {
      type: "object",
      properties: {
        beat_id: { type: "string", description: "id, or \"b2\" with scene_id set" },
        scene_id: { type: "string" },
      },
      required: ["beat_id"],
    },
  },
  {
    name: "redraw_panels",
    // NOTHING MARKS A PANEL STALE, which is why this description has to say so
    // outright. Editing a beat marks the covering BLOCK stale and `update_beat`
    // returns a note about it; the panel drawn from that beat keeps showing the
    // shot the scene used to have, with nothing on screen to say it is out of
    // date. A model that cannot see the staleness will not think to redraw.
    description:
      "Re-draw the storyboard panels — the pictures on the scene card — from the beats as " +
      "they stand NOW. Call this after you change a scene's shots: panels are drawn once " +
      "and nothing marks them stale, so until you redraw them they still show the shots " +
      "the scene used to have. One scene by default. Omit scene_id to redraw the whole " +
      "board, which needs confirm:true because it is one render per shot.",
    input_schema: {
      type: "object",
      properties: {
        scene_id: { type: "string",
                    description: "the scene_id from the listing, or how it is labelled on " +
                                 "screen: \"S3\" or its slug. Omit for the whole board." },
        beat_ids: { type: "array", items: { type: "string" },
                    description: "redraw only these shots — beat_ids, or \"b2\" labels when " +
                                 "scene_id is set. Omit for every shot in the scene." },
        model_key: { type: "string",
                     description: "override the image model; defaults to the one the " +
                                  "project's reference sheets were drawn with" },
        confirm: { type: "boolean",
                   description: "required to redraw the WHOLE board — call once without it " +
                                "to see how many panels that is" },
      },
      required: [],
    },
  },
  {
    name: "list_timelines",
    description:
      "The CUTS of an episode — an episode holds several timelines of the same " +
      "blocks at different lengths. Returns each one's id, name, clip count and " +
      "length. The cut on the user's screen is named in the context block; use " +
      "this to see the others, or to get an id for render_timeline.",
    input_schema: {
      type: "object",
      properties: { episode_id: { type: "string", description: "defaults to the open episode" } },
      required: [],
    },
  },
  {
    name: "render_timeline",
    description:
      "Queue the ffmpeg render of one CUT into a final video. `timeline_id` is a " +
      "specific cut, not 'the episode's timeline' — take it from the context " +
      "block (the cut on screen) or from list_timelines. Rendering the wrong cut " +
      "spends the same time on a film nobody is looking at.",
    input_schema: {
      type: "object",
      properties: { timeline_id: { type: "string" } },
      required: ["timeline_id"],
    },
  },
  {
    name: "add_outfit_variant",
    description:
      "Create an outfit variant of an existing character: the SAME face and body " +
      "(the parent's face sheet stays the identity anchor), new wardrobe. Optionally " +
      "recast scenes to wear it. Use for 'her in the gala dress for scene 4' instead " +
      "of inventing a second character.",
    input_schema: {
      type: "object",
      properties: {
        character: { type: "string", description: "existing bible character name" },
        outfit_name: { type: "string", description: "e.g. 'Gala Dress'" },
        outfit_look: { type: "string", description: "exact pieces with colors and materials" },
        scenes: { type: "array", items: { type: "string" },
                  description: "scene refs (id / S3 / slug) that should cast this outfit" },
      },
      required: ["character", "outfit_name", "outfit_look"],
    },
  },

  // ---------------------------------------------------------- editing ----
  // Everything below exists so an episode can be finished in conversation.
  // Before them the chat could rewrite a scene and then only mark the block
  // `stale` — a status nothing in the worker reads — so every edit ended by
  // telling the user to go and click something.
  {
    name: "list_blocks",
    description:
      "List the render blocks of a storyboard: index, scenes covered, time " +
      "range, status, mode, whether a take is active, and the latest review " +
      "verdict. Use this to find which block covers the moment being talked " +
      "about. Blocks are addressed as 'b3' (their index) or by id.",
    input_schema: {
      type: "object",
      properties: { storyboard_id: { type: "string" } },
    },
  },
  {
    name: "get_block",
    description:
      "Everything about one block: its beats with action, camera and " +
      "dialogue, the model and LoRAs it renders on, what references are " +
      "staged, and its takes with review scores. Read this before changing a " +
      "block so you know what is already there.",
    input_schema: {
      type: "object",
      properties: { block: { type: "string", description: "'b3', or a block id" } },
      required: ["block"],
    },
  },
  {
    name: "list_takes",
    description:
      "The takes of one block — which is active, when each was made, and how " +
      "its review scored.",
    input_schema: {
      type: "object",
      properties: { block: { type: "string" } },
      required: ["block"],
    },
  },
  {
    name: "rerender_block",
    description:
      "Re-render one block and, by default, make the result the version that " +
      "plays. This is the tool for 'do that shot again', and for making an " +
      "edit visible after update_beat / update_scene / a costume change — " +
      "those change the plan, this changes the picture.\n" +
      "activate: 'replace' (default) swaps the new take in, keeping the old " +
      "ones in history; 'review' leaves it side by side for the user to pick.\n" +
      "notes is a free-text director's adjustment ('more urgency', 'hold the " +
      "camera still') appended to the compiled prompt — never write H3 prompt " +
      "format yourself.\n" +
      "recompute_refs (default true) restages the character, location and " +
      "prop sheets. Leave it on after any casting, costume or artwork change, " +
      "or the render still uses the old pictures.\n" +
      "ref_asset_ids: pictures the user handed you for THIS shot (the ids in " +
      "the [image asset …] lines of their message). They are staged as look " +
      "references — the render follows their rendering, not their framing. " +
      "start_frame_asset_id makes the shot OPEN on that exact picture instead. " +
      "A picture the user attached and you did not pass here is a picture the " +
      "render never sees.",
    input_schema: {
      type: "object",
      properties: {
        block: { type: "string" },
        notes: { type: "string" },
        model_key: { type: "string",
                     description: "render this block on a different checkpoint, e.g. " +
                                  "'minimax-h3-turbo'. Omit to keep the episode's." },
        loras: { type: "array", description: "LoRA picks, e.g. [{key, strength}]",
                 items: { type: "object" } },
        mode: { type: "string", enum: ["r2v", "i2v", "flf", "t2v"] },
        seed: { type: "integer" },
        recompute_refs: { type: "boolean" },
        activate: { type: "string", enum: ["replace", "review"] },
        ref_asset_ids: { type: "array", items: { type: "string" },
                         description: "asset ids to stage as look references for this shot" },
        start_frame_asset_id: { type: "string",
                                description: "asset id the shot opens on exactly" },
      },
      required: ["block"],
    },
  },
  {
    name: "rerender_stale",
    description:
      "Re-render every block marked stale — the ones whose plan changed since " +
      "they were last rendered. Returns the list and the cost WITHOUT queuing " +
      "anything unless confirm is true. Always show the user that list and " +
      "get a yes before confirming, because this spends GPU time per block.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string",
                 description: "'all', or a scene ref like 'S2' to limit it to that scene" },
        confirm: { type: "boolean", description: "false/absent = dry run" },
        model_key: { type: "string" },
        notes: { type: "string" },
      },
    },
  },
  {
    name: "activate_take",
    description:
      "Make one take the version that plays. Use after list_takes when the " +
      "user picks ('use take 2').",
    input_schema: {
      type: "object",
      properties: {
        block: { type: "string" },
        take_id: { type: "string" },
        index: { type: "integer", description: "1-based, as list_takes numbers them" },
      },
    },
  },
  {
    name: "add_block",
    description:
      "Add a new shot at the end of the storyboard, or after a given block. " +
      "Use for 'add a shot where…' and for continuing a scene. When chain is " +
      "true the new block opens on the previous block's last frame, so the " +
      "action continues instead of restarting — that needs the previous block " +
      "to have rendered.\n" +
      "The shot is added INTO the scene of the block it follows (as that " +
      "scene's next shot) unless new_scene is true or environment names a " +
      "different location. Name EVERY character in the shot in cast — the " +
      "render stages the sheets of the people named, and a character left " +
      "out is drawn from prose as a stranger. What anyone SAYS goes in " +
      "dialogue, in this same call — the shot is lengthened to fit the lines " +
      "and the render is queued after they are written, so they reach the " +
      "first take. ref_asset_ids stages pictures " +
      "the user handed you as look references; start_frame_asset_id makes the " +
      "shot open on one exactly.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "what happens in the shot, in prose" },
        after_block: { type: "string", description: "'b6', or a block id. Default: the end." },
        before_block: { type: "string",
          description: "'b1', or a block id — insert IN FRONT of it. Use this for "
            + "'add a shot before block 1' / 'a new opening'; after_block cannot "
            + "express position 0." },
        camera: { type: "string" },
        duration_ms: { type: "integer", description: "default 6000; snapped to H3's frame grid" },
        chain: { type: "boolean", description: "default true" },
        cast: { type: "array", items: { type: "string" },
                description: "bible character names in this shot. Defaults to the "
                  + "neighbouring shot's cast." },
        // A LINE IS NOT PROSE. Before this existed the only way to give a new
        // shot dialogue was to write it into `action` — which reaches H3 as
        // description rather than through the compiler's vocal grammar, so no
        // recording is staged, no line is bound to a mouth, and nothing
        // measures whether it fits the shot. The two-step (add_block, then
        // update_beat) was worse than it looked: this tool queues the render
        // before the second call can land, and update_beat only marks the
        // block `stale`, which nothing in the worker reads.
        dialogue: {
          type: "array",
          description: "what is SPOKEN in this shot, in order. The shot is "
            + "lengthened if the lines need longer than it, and each speaker is "
            + "added to the cast so their sheet is staged. A line may carry "
            + "offscreen: true — it plays as voice-over while the camera is "
            + "elsewhere, and its speaker is NOT staged.",
          items: {
            type: "object",
            properties: { speaker: { type: "string" }, line: { type: "string" },
                          delivery: { type: "string" } },
            required: ["speaker", "line"],
          },
        },
        environment: { type: "string",
                       description: "bible location name. Defaults to the neighbouring "
                         + "shot's location." },
        ref_asset_ids: { type: "array", items: { type: "string" },
                         description: "asset ids to stage as look references for this shot" },
        start_frame_asset_id: { type: "string",
                                description: "asset id the shot opens on exactly" },
        new_scene: { type: "boolean",
                     description: "start a new scene for this shot instead of adding it "
                       + "to the neighbouring one (default false)" },
        slug: { type: "string", description: "the new scene's name, when new_scene is true" },
        mode: { type: "string", enum: ["r2v", "i2v", "flf", "t2v"] },
        model_key: { type: "string" },
        render: { type: "boolean", description: "queue the render now (default true)" },
      },
      required: ["action"],
    },
  },
  {
    name: "generate_clip",
    description:
      "Render a standalone clip that is not part of the storyboard — an idea, " +
      "an insert, something to look at. Does not touch the episode.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        mode: { type: "string", enum: ["t2v", "i2v", "flf", "r2v"] },
        ref_asset_ids: { type: "array", items: { type: "string" } },
        start_asset_id: { type: "string" },
        end_asset_id: { type: "string" },
        model_key: { type: "string" },
        loras: { type: "array", items: { type: "object" } },
        duration_ms: { type: "integer" },
        seed: { type: "integer" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_music",
    // Same reasoning as generate_image: the writing rules come from the model's
    // own guide rather than being restated here, so the tool cannot drift from
    // what the composer and the worker use. Both music guides are keyed by
    // catalog family, and the two want opposite shapes — a caption for Music 3,
    // tags for ACE-Step — so the tool names both rather than picking one.
    description:
      "Generate a music track: a song with sung lyrics, or an instrumental bed. " +
      "Set `attach` to make it the episode's MASTER TRACK — on a music video that " +
      "is what the whole render locks to (blocks get cut to its beats and each " +
      "block is given its slice of the audio), so a track that replaces one the " +
      "blocks were already cut against marks them stale.\n\n" +
      "Two models, two prompt shapes:\n" +
      "- minimax-music3 (default) sings written lyrics almost verbatim. " +
      "`prompt` is a CAPTION: " + guideFor({ family: "minimax-music3", kind: "music" }).rules +
      "\n- acestep-1.5 is ~4x faster and better for beds. `prompt` is TAGS: " +
      guideFor({ family: "acestep", kind: "music" }).rules,
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "caption (music3) or tags (acestep)" },
        lyrics: { type: "string",
                  description: "what the voice sings, with [Verse]/[Chorus] section tags. " +
                               "Leave empty for an instrumental." },
        instrumental: { type: "boolean", description: "no vocals" },
        duration_ms: { type: "integer", description: "up to 360000 on music3, 300000 on acestep" },
        model_key: { type: "string",
                     enum: ["minimax-music3", "acestep-1.5", "acestep-1.5-xl",
                            "acestep-1.5-xl-sft"] },
        // ACE-Step only: real typed encoder inputs there, and nothing at all on
        // Music 3 — where tempo and key belong in the caption prose instead.
        bpm: { type: "integer", description: "acestep only; also becomes the beat grid when attached" },
        key_scale: { type: "string", description: "acestep only, e.g. 'A minor'" },
        time_signature: { type: "string", enum: ["2", "3", "4", "6"], description: "acestep only" },
        attach: { type: "boolean",
                  description: "make it this episode's master track (music videos lock to it)" },
        seed: { type: "integer" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_video",
    description:
      "Change ONE thing about a take that already exists and keep everything " +
      "else. The clip becomes the model's video reference and the render is " +
      "told its framing, camera, timing, subjects and sound are preserved " +
      "except where the instruction applies — so this is the tool for " +
      "'replace the photo she is holding', 'make her coat red', 'same shot " +
      "but at night'. Reach for it INSTEAD OF rerender_block whenever the " +
      "user is pointing at footage that exists and asking for a difference: a " +
      "re-render composes the shot again from its plan and moves everything.\n" +
      "source_asset_id is the take's own asset id — `get_block` returns one " +
      "per take; use the active one unless they named another. Pass `block` " +
      "too or the result lands only in the library.\n" +
      "prompt is the CHANGE and nothing else: one difference, stated " +
      "positively and concretely. Do not describe what stays — the envelope " +
      "has already declared it held, and restating it invites the model to " +
      "decide it again. Do not write what to REMOVE either; the model adds " +
      "what it is told and cannot subtract, so 'no glove' renders a glove. " +
      "Name what takes its place.\n" +
      "ref_asset_ids become Picture 1, Picture 2 in the order you pass them, " +
      "and the prompt must name the one it means or the render ignores it. A " +
      "`Picture N` with no picture behind it is refused before it renders.",
    input_schema: {
      type: "object",
      properties: {
        source_asset_id: { type: "string" },
        prompt: { type: "string" },
        ref_asset_ids: { type: "array", items: { type: "string" } },
        block: { type: "string", description: "attach the result to this block as a take" },
        seed: { type: "integer" },
      },
      required: ["source_asset_id", "prompt"],
    },
  },
  {
    name: "add_take",
    description:
      "Attach an existing video asset to a block as a take — for a clip the " +
      "user uploaded or generated separately.",
    input_schema: {
      type: "object",
      properties: {
        block: { type: "string" },
        asset_id: { type: "string" },
        activate: { type: "boolean" },
      },
      required: ["block", "asset_id"],
    },
  },
  {
    name: "set_block_params",
    description:
      "Change how a block renders WITHOUT rendering it: model, LoRA stack, " +
      "mode or seed. Follow with rerender_block to see it.",
    input_schema: {
      type: "object",
      properties: {
        block: { type: "string" },
        model_key: { type: "string" },
        loras: { type: "array", items: { type: "object" } },
        mode: { type: "string", enum: ["r2v", "i2v", "flf", "t2v"] },
        seed: { type: "integer" },
        steps: { type: "integer" },
      },
      required: ["block"],
    },
  },
  {
    name: "set_beat_image",
    description:
      "Pin a picture to a shot. purpose 'start_frame' means the shot OPENS on " +
      "this exact image (only the first shot of a block can); 'look' means " +
      "follow its rendering but not its framing. Use this when the user hands " +
      "you an image and says where it goes.",
    input_schema: {
      type: "object",
      properties: {
        beat_id: { type: "string" },
        scene_id: { type: "string", description: "needed when beat_id is a 'b2' style ref" },
        asset_id: { type: "string" },
        purpose: { type: "string", enum: ["start_frame", "look"] },
      },
      required: ["beat_id", "asset_id"],
    },
  },
  {
    name: "list_voices",
    description:
      "The speaking voices available for casting, with the qualities each one " +
      "reads as. Use before recast_voice so you can name a real one.",
    input_schema: {
      type: "object",
      properties: { gender: { type: "string", enum: ["f", "m"] } },
    },
  },
  {
    name: "recast_voice",
    description:
      "Give a character a different speaking voice. Pass voice_id from " +
      "list_voices, or describe what you want and the nearest is cast. Their " +
      "existing recordings are dropped and re-made on the next render.",
    input_schema: {
      type: "object",
      properties: {
        character: { type: "string" },
        voice_id: { type: "string" },
        requirements: { type: "string",
                        description: "e.g. 'deeper, older, unhurried' — used when no voice_id" },
      },
      required: ["character"],
    },
  },
  {
    name: "redraw_sheets",
    description:
      "Redraw a character's or location's reference sheets as ONE H3 take, so " +
      "every view is the same shot and cannot disagree with itself. Use for " +
      "'redraw Eli's sheets', 'his turnaround is off', 'the four plates of the " +
      "shop are all the same angle'. It BUILDS ON the plates already on file " +
      "and replaces them when it lands, so it needs at least one to exist. " +
      "Characters get 6 views plus a contact sheet; locations get 8 views " +
      "filling master, alt_angle, atmosphere and detail in one pass.",
    input_schema: {
      type: "object",
      properties: {
        entry: { type: "string", description: "character or location name" },
        model_key: { type: "string",
                     description: "video model, default minimax-h3-pdd" },
      },
      required: ["entry"],
    },
  },
  {
    name: "inspect_take",
    description:
      "Ask a question about what is really ON SCREEN in a rendered clip — " +
      "'is she wearing the hat?', 'do they touch?'. Frames are sampled and " +
      "looked at. Use it to CHECK an edit landed instead of assuming. The " +
      "answer arrives on a job: call get_job with the id it returns.",
    input_schema: {
      type: "object",
      properties: {
        block: { type: "string", description: "inspects the block's active take" },
        take_id: { type: "string" },
        asset_id: { type: "string" },
        question: { type: "string" },
      },
      required: ["question"],
    },
  },
  {
    name: "get_job",
    description:
      "Status and result of a queued job — progress, failure reason, or the " +
      "answer from inspect_take.",
    input_schema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "delete_bible_entry",
    description:
      "Delete a DRAFT bible entry. Confirmed canon is referenced by scenes " +
      "and cannot be deleted here.",
    input_schema: {
      type: "object",
      properties: { entry_id: { type: "string" }, name: { type: "string" } },
    },
  },
  {
    name: "propose_options",
    description:
      "Offer the user two or three choices to pick between, as buttons. Use " +
      "when a request has real alternatives — two costume directions, two " +
      "voices — instead of choosing for them. Each option names a tool to run " +
      "when picked. This queues nothing by itself.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array",
                   description: "2-3 of {label, detail?, tool, args, preview_asset_id?}",
                   items: { type: "object" } },
      },
      required: ["question", "options"],
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Find a scene from whatever the model called it.
 *
 * It reads "S3" and "FIGHT_IN_ALLEY" off the same screen the user is looking at,
 * so those are what it passes — and a label sent as a uuid made PostgREST answer
 * `22P02 invalid input syntax for type uuid`, which surfaced as a raw DB error,
 * three retries, and an offer to queue a re-plan instead. Accept the labels, and
 * when there is genuinely no match, hand back the list so the next call is right.
 */
// A scene's length IS the sum of its shots — `planner.plan_blocks` reads beat
// durations only and never looks at the scene row, so a scene duration edited
// on its own changes a number nothing in the render path reads while every
// surface that reports length starts quoting it. Twin of `refit_beats` /
// `_sync_scene_duration` in worker/director_tools.py; see the comment there
// for the measurement that produced it.
const BEAT_MIN_MS = 1500;

/** Make the scene row agree with the beats under it. The other direction of
 *  the same invariant as refitBeats: lengthen a shot and the scene got longer,
 *  whatever its row still said. Twin of `_sync_scene_duration`. */
async function syncSceneDuration(sceneId) {
  const rows = await sbGet(`beats?scene_id=eq.${sceneId}&order=idx&select=id,duration_ms`);
  const total = rows.reduce((a, r) => a + Math.round(Number(r.duration_ms) || 0), 0);
  if (total) await sbUpd(`scenes?id=eq.${sceneId}`, { duration_ms: total });
  return total;
}

export function refitBeats(durations, targetMs, minMs = BEAT_MIN_MS) {
  const old = durations.map((d) => Math.max(0, Math.round(Number(d) || 0)));
  const n = old.length;
  if (!n) return [];
  const target = Math.max(Math.round(Number(targetMs) || 0), minMs * n);
  const total = old.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    const base = new Array(n).fill(Math.floor(target / n));
    base[0] += target - base.reduce((a, b) => a + b, 0);
    return base;
  }
  const out = old.map((d) => Math.max(minMs, Math.round((d * target) / total)));
  let drift = target - out.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (drift && guard++ < 10000) {
    if (drift > 0) {
      let i = 0;
      for (let k = 1; k < n; k++) if (out[k] > out[i]) i = k;
      out[i] += drift;
      drift = 0;
    } else {
      let i = -1;
      for (let k = 0; k < n; k++) {
        if (out[k] > minMs && (i < 0 || out[k] - minMs > out[i] - minMs)) i = k;
      }
      if (i < 0) break;
      const step = Math.min(out[i] - minMs, -drift);
      out[i] -= step;
      drift += step;
    }
  }
  return out;
}

async function resolveScene(ref, ctx = {}) {
  const raw = String(ref ?? "").trim();
  if (UUID_RE.test(raw)) {
    const [hit] = await sbGet(`scenes?id=eq.${raw}&select=id,storyboard_id,idx,slug`);
    if (hit) return { scene: hit };
  }
  // "S3" is a POSITION IN THE OPEN BOARD, so it has to be read against that
  // board and no other — the same label names a different scene in every
  // episode of a series.
  const sbId = await currentStoryboardId(ctx);
  const scenes = sbId
    ? await sbGet(`scenes?storyboard_id=eq.${sbId}&order=idx&select=id,storyboard_id,idx,slug`)
    : [];
  const wantS = sceneRefToIdx(raw);
  const scene = (wantS != null && scenes.find((x) => x.idx === wantS))
    || scenes.find((x) => (x.slug || "").toLowerCase() === raw.toLowerCase());
  if (scene) return { scene };
  return {
    error: `no scene matches "${raw}"`,
    scenes: scenes.map((x) => ({ ref: sceneRef(x.idx), slug: x.slug, scene_id: x.id })),
  };
}

/** Same idea for beats: "b2" is a position inside a scene, not a row id.
 *
 * The select carries `duration_ms` and `meta` because two callers need them
 * without a second round trip: `set_beat_image` rewrites meta, and a dialogue
 * edit has to see the exchange pin it is invalidating.
 */
const BEAT_COLS = "id,scene_id,idx,duration_ms,meta";
async function resolveBeat(ref, sceneRef, ctx = {}) {
  const raw = String(ref ?? "").trim();
  if (UUID_RE.test(raw)) {
    const [hit] = await sbGet(`beats?id=eq.${raw}&select=${BEAT_COLS}`);
    if (hit) return { beat: hit };
  }
  if (!sceneRef) {
    return { error: `"${raw}" is not a beat id — pass scene_id too and I can take "b2", ` +
                    `or use the beat_id from the storyboard listing` };
  }
  const { scene, error, scenes } = await resolveScene(sceneRef, ctx);
  if (!scene) return { error, scenes };
  const beats = await sbGet(`beats?scene_id=eq.${scene.id}&order=idx&select=${BEAT_COLS}`);
  const wantB = shotRefToIdx(raw);
  const beat = wantB == null ? null : beats.find((b) => b.idx === wantB);
  // The slug travels with the hit so the caller can SAY where it landed: a
  // label pair like ("b2", "S3") resolves silently, and a model that means one
  // scene and names another gets a uuid back and no way to notice.
  if (beat) return { beat, slug: scene.slug ?? null };
  return { error: `no beat matches "${raw}" in that scene`,
           beats: beats.map((b) => ({ ref: shotRef(b.idx), beat_id: b.id })) };
}

/**
 * Blocks are addressed the way they are on screen: 'b7', or an id.
 *
 * Same reasoning as resolveScene — the model reads 'BLOCK b7' off the
 * storyboard the user is looking at, and sending that where a uuid was
 * expected used to come back as a raw Postgres 22P02. On a miss it hands back
 * the whole block list, so the next call is right instead of another guess.
 *
 * Note the index is the block's own `idx` (b0, b1, …), NOT the 1-based scene
 * and beat labels — that asymmetry is in the storyboard UI too, and the twin
 * in worker/director_tools.py resolves it the same way.
 *
 * @param {string} ref
 * @param {{projectId: string, episodeId?: string|null, storyboardId?: string|null}} ctx
 */
async function resolveBlock(ref, ctx = {}) {
  const raw = String(ref ?? "").trim();
  if (UUID_RE.test(raw)) {
    const [hit] = await sbGet(`generation_blocks?id=eq.${raw}&select=*`);
    if (hit) return { block: hit };
  }
  const sbId = await currentStoryboardId(ctx);
  if (!sbId) return noStoryboard(ctx);
  const blocks = await sbGet(`generation_blocks?storyboard_id=eq.${sbId}&order=idx&select=*`);
  const want = blockRefToIdx(raw);
  const block = want == null ? null : blocks.find((b) => b.idx === want);
  if (block) return { block };
  return {
    error: `no block matches "${raw}"`,
    blocks: blocks.map((b) => ({ ref: blockRef(b.idx), block_id: b.id, status: b.status })),
  };
}

/** THE BOARD OF ONE EPISODE, ordered the way the browser orders it.
 *
 *  `db/director.storyboardsForEpisode` sorts `version desc, created_at desc`
 *  and every screen reads `[0]`, so anything else here answers a question
 *  about a storyboard nobody is looking at. */
async function episodeStoryboardId(episodeId) {
  if (!episodeId) return null;
  const sbs = await sbGet(
    `storyboards?episode_id=eq.${episodeId}&order=version.desc,created_at.desc&limit=1&select=id`);
  return sbs[0]?.id ?? null;
}

/**
 * WHICH STORYBOARD THE TOOLS ARE TALKING ABOUT — the OPEN EPISODE'S, and this
 * is the whole reason the function exists.
 *
 * Every storyboard read used to be `latestStoryboardId(episodeIds(project))`,
 * i.e. the newest board ANYWHERE IN THE PROJECT — so a series answered about
 * whichever episode was re-planned most recently and switching episodes
 * changed nothing at all. The situational context block (lib/directorContext)
 * was episode-scoped the whole time, so the two halves of one turn disagreed:
 * MEASURED on Rei, EP03 open, S7 CITY_CAPTURE_2 on screen — `list_storyboard`
 * returned EP01's three scenes (THE_SHUTTER / WALK_AWAY / THE_ESCALATORS),
 * because EP01 v1 was written four days after EP03 v6. Nothing errored; the
 * director simply reported that the scene the user was pointing at does not
 * exist.
 *
 * AN OPEN EPISODE WITH NO BOARD RETURNS NULL RATHER THAN FALLING THROUGH.
 * That refusal is the fix — silently serving a sibling episode's storyboard is
 * the bug, and "this episode has no storyboard yet" is an answer somebody can
 * act on. The project-wide search survives only for the case it was written
 * for: no episode open at all.
 */
async function currentStoryboardId(ctx = {}) {
  if (ctx.storyboardId) return ctx.storyboardId;
  if (ctx.episodeId) return episodeStoryboardId(ctx.episodeId);
  return latestStoryboardId(await episodeIds(ctx.projectId));
}

/** Says WHICH thing has no board, because with the episode-first rule above
 *  the two are different failures with different fixes. */
const noStoryboard = (ctx = {}) => ({
  error: ctx.episodeId
    ? "this episode has no storyboard yet — plan one, or switch to an episode that has one"
    : "this project has no storyboard yet",
});

/** The project-wide fallback: the newest board across the episodes given.
 *  Ordered by RECENCY and not by version, because `version` counts within one
 *  episode — sorting a cross-episode list by it would rank EP03's v6 above an
 *  EP01 v1 written days later. */
async function latestStoryboardId(episodeIdList) {
  if (!episodeIdList.length) return null;
  const sbs = await sbGet(
    `storyboards?episode_id=in.(${episodeIdList.join(",")})&order=created_at.desc&limit=1&select=id`);
  return sbs[0]?.id ?? null;
}

/** The episode's CUTS, each with the two numbers that tell them apart.
 *
 *  `timelines` has always been a list per episode, and the director assumed
 *  one — so it read the block plan's total as "the timeline" while the user
 *  was looking at a cut of a different length. Clips are counted through the
 *  lanes because that is where they hang; one read per call, not one per cut.
 *
 *  Falls back to the project's episodes when there is no open one, so "what
 *  cuts do I have" answers rather than returning an empty list. */
async function listCuts(projectId, episodeId) {
  const eps = episodeId ? [episodeId] : await episodeIds(projectId);
  if (!eps.length) return [];
  const all = await sbGet(
    `timelines?episode_id=in.(${eps.join(",")})&order=created_at` +
    `&select=id,episode_id,name,fps,width,height,render_stale`);
  if (!all.length) return [];
  // The clip tally is one `track_id=in.(…)` per call, so an unbounded list
  // would build the URL out of every lane of every cut in the project — the
  // no-episode fallback is the path that could. Measured, the busiest project
  // here is 6 cuts / 32 lanes, so this is headroom rather than a real ceiling;
  // it is SAID rather than silently applied, because a truncated list that
  // looks complete is how "I only have 24 cuts" becomes a wrong answer.
  const rows = all.slice(0, MAX_CUTS);
  const dropped = all.length - rows.length;
  const tracks = await sbGet(
    `tracks?timeline_id=in.(${rows.map((t) => t.id).join(",")})&select=id,timeline_id`);
  const owner = new Map(tracks.map((t) => [t.id, t.timeline_id]));
  const clips = owner.size
    ? await sbGet(`clips?track_id=in.(${[...owner.keys()].join(",")})` +
                  `&select=track_id,t_start_ms,duration_ms`)
    : [];
  const tally = new Map();
  for (const c of clips) {
    const tl = owner.get(c.track_id);
    if (!tl) continue;
    const cur = tally.get(tl) || { clips: 0, ms: 0 };
    cur.clips += 1;
    cur.ms = Math.max(cur.ms, Number(c.t_start_ms || 0) + Number(c.duration_ms || 0));
    tally.set(tl, cur);
  }
  const out = rows.map((t) => {
    const n = tally.get(t.id) || { clips: 0, ms: 0 };
    return { id: t.id, episode_id: t.episode_id, name: t.name,
             clips: n.clips, duration_ms: n.ms, needs_render: t.render_stale };
  });
  if (dropped) out.push({ note: `${dropped} more cut(s) not listed` });
  return out;
}

const MAX_CUTS = 24;

async function episodeIds(projectId) {
  const eps = await sbGet(`episodes?project_id=eq.${projectId}&select=id&order=created_at.desc`);
  return eps.map((e) => e.id);
}

const blockLabel = (block) => blockRef(block.idx);
const blockSeconds = (b) =>
  Math.max(0, Number(b.t_end_ms || 0) - Number(b.t_start_ms || 0)) / 1000;

const assetById = async (id) => (await sbGet(`assets?id=eq.${id}`))[0] ?? null;

// ------------------------------------------------------- H3 frame grid ---
// generation_blocks.frames is NOT NULL and must be a legal 17n+5 count from
// the moment the row exists (invariant #5), so a block created here has to
// plan its own. Constants from worker/h3_timing.py, which is authoritative —
// master_pass re-plans from the same window before it renders.
// (src/lib/h3timing.ts is the browser's copy of this and is a .ts file in the
// Vite tree, so a serverless function cannot import it.)
const FPS = 24, FRAME_BASE = 17, FRAME_REM = 5;
const MIN_FRAMES = 5 + 17 * 5, MAX_FRAMES = 365;
const DEFAULT_WARMUP_F = 22, DEFAULT_COOLDOWN_F = 6;
const MAX_CONTENT_MS = Math.round(((MAX_FRAMES - DEFAULT_WARMUP_F) * 1000) / FPS);

const pad17 = (frames) => {
  const f = Math.max(Math.trunc(frames), FRAME_REM);
  return f + ((((FRAME_REM - f) % FRAME_BASE) + FRAME_BASE) % FRAME_BASE);
};
const framesToMs = (f) => Math.round((Math.trunc(f) * 1000) / FPS);

/** Mirrors h3_timing.plan_block, including the order it sheds padding in when
 *  the total overflows: cooldown first, then warmup. */
function planBlock(contentMs) {
  let warmupF = DEFAULT_WARMUP_F, cooldownF = DEFAULT_COOLDOWN_F;
  const contentF = Math.ceil((Math.trunc(contentMs) * FPS) / 1000);
  let renderF = pad17(contentF + warmupF + cooldownF);
  while (renderF > MAX_FRAMES && cooldownF > 0) renderF = pad17(contentF + warmupF + --cooldownF);
  while (renderF > MAX_FRAMES && warmupF > 0) renderF = pad17(contentF + --warmupF + cooldownF);
  if (renderF < MIN_FRAMES) renderF = pad17(MIN_FRAMES);
  return { warmupF, cooldownF, renderF, trimMs: Math.trunc(contentMs) };
}

// --------------------------------------------------------- re-rendering ---
/**
 * The master_pass payload for a chat-driven re-render.
 *
 * `activate: replace` is the default because these are CONTENT edits — the
 * user asked for the shot to be different, so the different one is the one
 * that should play. A side-by-side retake is the exception and says so.
 */
function rerenderPayload(block, input, labelSuffix = "") {
  const payload = {
    block_id: block.id,
    activate: input.activate || "replace",
    recompute_refs: input.recompute_refs ?? true,
    seed: input.seed != null ? input.seed : Math.floor(Math.random() * 1e9) + 1,
    label: `${blockLabel(block)} re-render${labelSuffix}`,
  };
  if (input.notes) payload.prompt_extra = String(input.notes).trim();
  if (input.model_key) payload.model_key = modelKeyOf(input.model_key);
  if (Array.isArray(input.loras)) payload.loras = input.loras;
  if (input.mode) payload.mode = input.mode;
  if (input.steps != null) payload.steps = Number(input.steps);
  return payload;
}

/** A master_pass already queued or running for this block -> its job id. */
async function pendingRerenderFor(blockId, ctx) {
  try {
    const rows = await sbGet(
      `jobs?project_id=eq.${ctx.projectId}&kind=eq.master_pass`
      + `&status=in.(queued,running)&select=id,payload,created_at&order=created_at`);
    const hit = rows.find((r) => (r.payload || {}).block_id === blockId);
    return hit ? hit.id : null;
  } catch {
    return null;                 // ordering is an enrichment, never a blocker
  }
}

/**
 * The prose this block will actually render, so a HALF-APPLIED edit is visible
 * at the moment it is queued.
 *
 * Asked to strip a motif from four blocks, the director rewrote two shots of
 * one of them, missed the other two, and reported the whole range clean.
 * Nothing here can make a model thorough — but returning what is about to
 * render puts the evidence in front of it, and in the transcript the user
 * reads, instead of leaving it in the database unseen.
 */
async function blockShots(block) {
  const ids = block.beat_ids || [];
  if (!ids.length) return [];
  try {
    const rows = await sbGet(`beats?id=in.(${ids.join(",")})&select=id,action`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((b, i) => (byId.has(b)
      ? [{ shot: i, action: String(byId.get(b).action || "").slice(0, 300) }]
      : []));
  } catch {
    return [];
  }
}

async function queueRerender(block, input, ctx, { dependsOn = null, suffix = "" } = {}) {
  const catalog = await catalogFor(ctx);
  const payload = rerenderPayload(block, input, suffix);
  // THE CHECKPOINT THIS RUN RENDERS ON, resolved here rather than left to the
  // worker's fallback: explicit `model_key` > the block's own stored pick >
  // the project's default video model (the dock's VIDEO picker). The block's
  // pick wins over the picker because an episode must not switch checkpoints
  // shot to shot; the picker wins over `H3_MODEL` because a block planned
  // with no pick was rendering on plain H3 while the chip at the top of the
  // chat said PDD, and the queue then filed it under "h3-local" anyway.
  const effective = renderParams(block.params, payload, ctx.settings, catalog);
  const stored = (block.params || {}).model_key;
  // Sent as a per-job override rather than written onto the block: the render
  // uses it, `persist_params` is what would make it stick, and a re-render is
  // not the moment to rewrite what the episode was planned with.
  if (effective.model_key && effective.model_key !== stored) {
    payload.model_key = effective.model_key;
  }
  const job = await sbIns("jobs", {
    kind: "master_pass", lane: "gpu", status: "queued",
    priority: USER_PRIORITY, project_id: ctx.projectId, episode_id: ctx.episodeId || null,
    // The catalog id the block REALLY renders on, not a constant: this column
    // is what the queue shows, what `job_timings` files the wall time under
    // and what `model_visibility` is checked against.
    model_id: jobModelId(effective, ctx.settings, catalog),
    ...(dependsOn ? { depends_on: dependsOn } : {}),
    payload,
  });
  await sbUpd(`generation_blocks?id=eq.${block.id}`, { status: "queued" });
  const out = { job, renders_on: effective.model_key || "the worker's default (plain MiniMax H3)" };
  if (stored && effective.model_key !== stored) out.instead_of = stored;
  return out;
}

/* ── what a block renders on, and what the queue calls it ─────────────── */

/* THE PICKER BEATS THE PLAN, and this is a REVERSAL of the rule that shipped
 * first. That one read "explicit model_key > the block's stored pick > the
 * project default", on the reasoning that an episode must not switch
 * checkpoints shot to shot — and it made the VIDEO picker at the top of the
 * director chat a control that could not change a re-render: PDD selected,
 * turbo queued, nothing said. Reported exactly that way.
 *
 * The rule it was protecting is about SILENT switching — a planner or a
 * fallback choosing a different checkpoint on its own. A person moving a
 * picker is not silent, and `settings.video_model` is only ever written by
 * one (the dock, the context panel, project settings, the wizard). An absent
 * setting still yields to the block, so an episode nobody has re-picked for
 * renders exactly as it was planned; and every render tool answers
 * `renders_on`, with `instead_of` when the picker overrode a stored pick, so
 * the switch is said rather than discovered. */

/** The visible catalog, memoised per project for a short while so a fan-out
 *  (rerender_stale over an episode) reads it once rather than per block. An
 *  unreadable catalog is an empty list — every use below degrades to its
 *  fallback. `resetToolCaches` exists for the tests, whose stubbed database
 *  changes between cases faster than the memo expires. */
const CATALOG_TTL_MS = 30_000;
const catalogMemo = new Map();
async function catalogFor(ctx) {
  const key = ctx?.projectId ?? "";
  const hit = catalogMemo.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.rows;
  const rows = await sbGet("model_catalog_visible?select=id,kind,provider,enabled")
    .then((r) => (Array.isArray(r) ? r : [])).catch(() => []);
  catalogMemo.set(key, { at: Date.now(), rows });
  return rows;
}
export function resetToolCaches() { catalogMemo.clear(); }

/** The project's default VIDEO model as a model_map key — only when it is a
 *  row the POD renders (`provider: local`). A hosted or desktop pick is not a
 *  key the worker can resolve, and passing one would fail the render rather
 *  than fall back. */
function projectVideoKey(settings, catalog) {
  const id = settings?.video_model;
  if (!id) return undefined;
  const row = (catalog ?? []).find((m) => m.id === id);
  if (row && (row.provider !== "local" || (row.kind && row.kind !== "video"))) return undefined;
  return modelKeyOf(id);
}

/** The effective params of one render. `model_key` in precedence order: what
 *  the tool was explicitly told, then the project's picked video model, then
 *  the block's own plan-time pick — see the note above for why the middle one
 *  moved ahead of the last. */
function renderParams(blockParams, payload, settings, catalog) {
  const p = { ...(blockParams || {}) };
  for (const k of ["loras", "steps", "mode"]) {
    if (payload && payload[k] != null) p[k] = payload[k];
  }
  const chosen = (payload && payload.model_key)
    || projectVideoKey(settings, catalog)
    || p.model_key;
  if (chosen) p.model_key = chosen; else delete p.model_key;
  return p;
}

/** The catalog id a `jobs` row carries for these params. */
function jobModelId(params, settings, catalog) {
  const fallback = (params.model_key && settings?.video_model
                    && modelKeyOf(settings.video_model) === params.model_key)
    ? settings.video_model : "h3-local";
  return catalogIdOf(params, catalog, fallback);
}

/* ── inheriting a neighbour's params ──────────────────────────────────── */

/**
 * Params a NEW shot may take from the block beside it.
 *
 * It inherits so a shot added to an episode renders on the same checkpoint
 * and adapters as the shots around it — switching model mid-episode is the
 * continuity break `_block_model` exists to prevent. What it must NOT take is
 * anything that describes the neighbour's OWN render: `clip_gen` is a stored
 * recipe, and `handle_master_pass` delegates any block carrying one straight
 * to the clip path — so a shot added after an extension REPLAYED THAT
 * EXTENSION (its prompt, its anchors, its references) and never compiled the
 * beat it was given; `clip_kind` made the lane and the sidebar call it
 * "Extension 29". Measured on a real episode, which is how this list came to
 * exist. `fight` is stamped per block from its own scene, `prompt_extra` is
 * one render's note, `sheet_asset_id` is one block's segment board.
 */
const NOT_INHERITED = ["clip_gen", "clip_kind", "derived_from", "prompt_extra",
                       "sheet_asset_id", "fight"];
function inheritParams(prev) {
  const p = { ...((prev && prev.params) || {}) };
  for (const k of NOT_INHERITED) delete p[k];
  return p;
}

/* ── pictures the user handed over ────────────────────────────────────── */

/**
 * Stage the pictures a tool was handed onto a block's plan.
 *
 * Two mechanisms, because they cover different pods: the FIRST look lands on
 * the block's first beat as `meta.still_asset_id` (the scene editor's own
 * key, which every worker build stages as a `look` reference), and EVERY look
 * is pinned into `ref_plan` with `pinned: true`, which a current worker
 * carries across a `recompute_refs` the way it already carries a closing
 * frame. A beat that already holds a user still keeps it — overwriting a
 * deliberate pick with an attachment would be the silent substitution this
 * codebase keeps naming — so on that beat the attachment rides the plan
 * alone. `start_frame_asset_id` makes the shot OPEN on the picture instead,
 * and only the first beat of a block can carry one.
 *
 * Ids that name nothing are reported, never dropped: a model that pasted a
 * filename where an id belongs would otherwise stage nothing and say nothing.
 */
async function applyUserRefs(block, input) {
  const looks = [...new Set((Array.isArray(input.ref_asset_ids) ? input.ref_asset_ids : [])
    .map((x) => String(x || "").trim()).filter(Boolean))];
  const start = input.start_frame_asset_id ? String(input.start_frame_asset_id).trim() : null;
  if (!looks.length && !start) return null;
  const ids = [...new Set([...looks, ...(start ? [start] : [])])];
  const rows = await sbGet(`assets?id=in.(${ids.join(",")})&select=id,kind,b2_key`);
  const known = new Map((rows || []).map((r) => [r.id, r]));
  const out = { staged: [], not_found: ids.filter((id) => !known.has(id)) };
  const usable = looks.filter((id) => known.has(id));
  const startOk = start && known.has(start) ? start : null;
  if (!usable.length && !startOk) return out;

  const firstBeatId = (block.beat_ids || [])[0];
  if (firstBeatId) {
    const [beat] = await sbGet(`beats?id=eq.${firstBeatId}&select=id,meta`);
    if (beat) {
      const meta = { ...(beat.meta || {}) };
      let changed = false;
      if (startOk) {
        meta.start_frame_asset_id = startOk;
        if (meta.still_asset_id === startOk) delete meta.still_asset_id;
        changed = true;
      }
      if (usable.length && !meta.still_asset_id && usable[0] !== startOk) {
        meta.still_asset_id = usable[0];
        meta.ref_role = meta.ref_role || "look";
        meta.ref_label = meta.ref_label || "attached picture";
        changed = true;
      }
      if (changed) await sbUpd(`beats?id=eq.${beat.id}`, { meta });
    }
  }
  const plan = (block.ref_plan || []).filter((e) => !(e && e.pinned));
  for (const id of usable) {
    if (id === startOk) continue;
    plan.push({ purpose: "look", role: "look", asset_id: id, label: "attached picture",
                shot_idxs: [1], pinned: true });
    out.staged.push({ asset_id: id, purpose: "look" });
  }
  if (startOk) {
    plan.unshift({ purpose: "start_frame", role: "first_frame", asset_id: startOk,
                   beat_id: firstBeatId || null, pinned: true });
    out.staged.push({ asset_id: startOk, purpose: "start_frame" });
  }
  await sbUpd(`generation_blocks?id=eq.${block.id}`, { ref_plan: plan });
  block.ref_plan = plan;
  return out;
}

/**
 * Add a shot to the storyboard — the twin of worker/director_tools.py
 * `_add_block` and of createManualBlock (src/lib/db/director.ts).
 *
 * Three invariants it has to respect, each of which fails at a different
 * distance from the mistake:
 *   * `frames` is NOT NULL and must be a legal 17n+5 count from the start.
 *   * `scenes.idx` and `generation_blocks.idx` are unique per parent, so an
 *     insert in the middle has to shift its siblings back-to-front.
 *   * `chain_from_block_id` may only point at a block that has RENDERED.
 *     Chaining to an unrendered one makes a job that cannot run: it dies at
 *     execution asking for a final frame that does not exist.
 */
/**
 * The mode a new block can actually render, given what it has to stage.
 * r2v raises in resolve() without at least one reference; i2v/flf need an
 * opening frame that only a chain supplies here. Asking anyway produces a job
 * that validates, queues, waits for a GPU and only then dies.
 */
function addBlockMode(wanted, hasRefs, chained) {
  let m = String(wanted || "").trim().toLowerCase() || null;
  if ((m === "i2v" || m === "flf") && !chained) m = null;
  if (m === "r2v" && !hasRefs) m = null;
  if (m) return m;
  if (hasRefs) return "r2v";
  return chained ? "i2v" : "t2v";
}

async function addBlock(input, ctx, after = null, before = null) {
  const eids = await episodeIds(ctx.projectId);
  const episodeId = ctx.episodeId || eids[0] || null;
  if (!episodeId) return { error: "this project has no episode yet" };
  let sbId = after?.storyboard_id || before?.storyboard_id || await currentStoryboardId(ctx);
  if (!sbId) {
    const row = await sbIns("storyboards", { episode_id: episodeId, status: "draft" });
    sbId = row.id;
  }

  const blocks = await sbGet(
    `generation_blocks?storyboard_id=eq.${sbId}&order=idx` +
    `&select=id,idx,t_start_ms,t_end_ms,active_take_id,params,scene_ids,beat_ids`);
  const requestedMs = Number(input.duration_ms) || 6000;
  // A LINE HAS A MEASURED SPEAKING TIME AND THE SHOT HAS TO CLEAR IT. That is
  // storyplan.shot_floor_ms's rule, applied by the planner to every dialogue
  // shot it writes and by nothing at all to a shot added by hand: the 6s
  // default takes a twenty-word line and delivers DIALOGUE_CUTOFF. The floor
  // RAISES an explicit duration_ms rather than yielding to it — a shot that
  // cuts off its own line is not what was asked for — and says so in the
  // result. It has to happen HERE, before the followers are shifted by
  // durationMs, or the block and the blocks after it disagree about where the
  // episode's clock is.
  const wantLines = (Array.isArray(input.dialogue) ? input.dialogue : [])
    .filter((d) => d && typeof d === "object");
  const speechMs = dialogueMs(wantLines);
  const durationMs = Math.max(2000,
    Math.min(Math.max(requestedMs, speechMs), MAX_CONTENT_MS));
  const plan = planBlock(durationMs);

  // INSERTING AT THE START WAS INEXPRESSIBLE: after_block was the only
  // positional argument and atIdx reached 0 solely on an EMPTY storyboard, so
  // "add a block before block 1" had no encoding and a model asked for one
  // does the closest thing it can say (after_block: b1) and lands one place
  // late. `prev` is what the new block CHAINS from and inherits beside — the
  // block now in front of it, which is nothing when inserting at 0.
  let prev, atIdx, startMs;
  if (before) {
    atIdx = before.idx;
    startMs = Number(before.t_start_ms);
    prev = blocks.find((b) => b.idx === atIdx - 1) || null;
  } else {
    prev = after || blocks.at(-1) || null;
    atIdx = prev ? prev.idx + 1 : 0;
    startMs = prev ? Number(prev.t_end_ms) : 0;
  }
  // Inserting in the middle: shift the followers back-to-front, because the
  // (storyboard_id, idx) pair is unique and a forward shift collides with the
  // row it is about to move. Same rule as add_scene.
  for (const b of blocks.filter((x) => x.idx >= atIdx).sort((a, z) => z.idx - a.idx)) {
    await sbUpd(`generation_blocks?id=eq.${b.id}`, {
      idx: b.idx + 1,
      t_start_ms: Number(b.t_start_ms) + durationMs,
      t_end_ms: Number(b.t_end_ms) + durationMs,
    });
  }

  const scenes = await sbGet(
    `scenes?storyboard_id=eq.${sbId}&order=idx&select=id,idx,slug,cast_ids,environment_id`);
  const sceneById = new Map(scenes.map((s) => [s.id, s]));

  const nameId = async (kind, nm) => {
    const rows = await sbGet(`bible_entries?project_id=eq.${ctx.projectId}`
      + `&kind=eq.${kind}&name=ilike.${encodeURIComponent(nm)}&select=id,name`);
    return rows[0] || null;
  };

  // WHERE THE SHOT LIVES. A shot added after b19 is the next shot of b19's
  // SCENE, not a scene of its own: the storyboard is scenes of shots, and a
  // fresh "SHOT 20" scene appended at the END of the scene list for a block
  // inserted in the MIDDLE of the episode is what made the storyboard and the
  // block order disagree — "b20" sat between b19 and b21 on the lane and
  // under S10 at the bottom of the page. So the neighbour's scene is the
  // host unless the caller asks for a new one, or names a different location
  // (a block may never span an environment change, and neither may a scene).
  // The `before` anchor's FIRST scene, the `after` anchor's LAST: those are
  // the scenes the new shot is adjacent to.
  const anchor = before ?? prev;
  const anchorSceneId = anchor
    ? (before ? (anchor.scene_ids || [])[0] : (anchor.scene_ids || []).at(-1)) ?? null
    : null;
  let host = !input.new_scene && anchorSceneId ? sceneById.get(anchorSceneId) ?? null : null;

  // WHO IS IN IT AND WHERE IT HAPPENS, or the block cannot render.
  //
  // `ref_plan_for` builds the reference set from `scenes.environment_id`,
  // `scenes.cast_ids` and `beats.meta.cast` — and this left all three empty
  // while declaring mode r2v, which REQUIRES at least one reference. So every
  // manually added shot queued a job that died in resolve() with
  // "reference-to-video needs at least one reference", and `recompute_refs`
  // could not rescue it: there was nothing to recompute FROM.
  //
  // A shot added into an episode is in the same place with the same people as
  // the shot beside it, so both are INHERITED — from the host scene when there
  // is one, else from the NEAREST STAGED neighbour (not merely the adjacent
  // one: the block next door may itself be an unstaged manual shot, and
  // inheriting from one propagates the emptiness instead of curing it).
  // Explicit cast/environment win.
  let inheritedCast = [], inheritedEnv = null;
  if (host && ((host.cast_ids || []).length || host.environment_id)) {
    inheritedCast = [...(host.cast_ids || [])];
    inheritedEnv = host.environment_id || null;
  } else {
    let byDistance = [...blocks].sort((a, b) =>
      Math.abs(a.idx - atIdx) - Math.abs(b.idx - atIdx)
      || (a.idx < atIdx ? -1 : 1));
    if (after) byDistance = [after, ...byDistance.filter((b) => b.id !== after.id)];
    for (const cand of byDistance) {
      if (!(cand.scene_ids || []).length) continue;
      const rows = cand.scene_ids.map((id) => sceneById.get(id)).filter(Boolean);
      const cast = rows.flatMap((r) => r.cast_ids || []);
      const env = rows.map((r) => r.environment_id).find(Boolean) || null;
      if (!cast.length && !env) continue;
      inheritedEnv = env;
      for (const cid of cast) if (!inheritedCast.includes(cid)) inheritedCast.push(cid);
      break;
    }
  }
  const unknown = [];
  let castIds = [...inheritedCast];
  if (Array.isArray(input.cast) && input.cast.length) {
    castIds = [];
    for (const nm of input.cast) {
      const hit = await nameId("character", nm);
      if (hit) castIds.push(hit.id); else unknown.push(nm);
    }
  }
  let envId = inheritedEnv;
  if (input.environment) {
    const hit = await nameId("environment", input.environment);
    if (hit) envId = hit.id; else unknown.push(input.environment);
  }
  // A different LOCATION is a different scene, whatever the caller said.
  if (host && envId && host.environment_id && envId !== host.environment_id) host = null;
  // THE SPEAKER HAS TO BE STAGED, or the line comes out of a stranger.
  // ref_plan_for builds the reference set from the cast, so a character who
  // speaks and is not cast is drawn from prose — the same failure `cast` itself
  // exists to prevent, arriving through the dialogue instead. An OFFSCREEN line
  // is the exception and is the whole point of that flag: it is a voice-over,
  // its speaker is deliberately out of frame, and staging them would put a body
  // on screen the shot says is not there.
  const dialogueLines = [], stagedSpeakers = [];
  for (const d of wantLines) {
    const nm = String(d.speaker ?? "").trim();
    const hit = nm ? await nameId("character", nm) : null;
    if (nm && !hit && !unknown.includes(nm)) unknown.push(nm);
    dialogueLines.push({
      speaker_id: hit?.id ?? null, speaker: d.speaker, line: d.line,
      ...(d.delivery ? { delivery: d.delivery } : {}),
      ...(d.offscreen ? { offscreen: true } : {}),
    });
    if (hit && !d.offscreen && !castIds.includes(hit.id)) {
      castIds.push(hit.id);
      stagedSpeakers.push(hit.name);
    }
  }
  const castNames = castIds.length
    ? (await sbGet(`bible_entries?id=in.(${castIds.join(",")})&select=name`))
        .map((r) => r.name)
    : [];

  let scene, beatIdx = 0, placedIn = null;
  if (host) {
    scene = host;
    // The scene's roster grows to include anyone named — `_cast_entry_id`
    // resolves a beat's names against the SCENE's cast first, so a name the
    // scene does not carry falls through to the whole bible and can land on
    // the wrong variant.
    const missing = castIds.filter((id) => !(host.cast_ids || []).includes(id));
    if (missing.length) {
      await sbUpd(`scenes?id=eq.${host.id}`, { cast_ids: [...(host.cast_ids || []), ...missing] });
    }
    // The new shot goes RIGHT AFTER the anchor's last shot in this scene (or
    // right before the `before` anchor's first), and the shots after it move
    // up one, back-to-front — so the storyboard reads in the same order as
    // the blocks. A clip-born anchor has no beats, and then it appends.
    const beats = await sbGet(`beats?scene_id=eq.${host.id}&order=idx&select=id,idx`);
    const anchorBeats = beats.filter((b) => (anchor?.beat_ids || []).includes(b.id));
    if (before && anchorBeats.length) beatIdx = anchorBeats[0].idx;
    else if (anchorBeats.length) beatIdx = anchorBeats.at(-1).idx + 1;
    else beatIdx = beats.length ? beats.at(-1).idx + 1 : 0;
    for (const b of beats.filter((x) => x.idx >= beatIdx).sort((a, z) => z.idx - a.idx)) {
      await sbUpd(`beats?id=eq.${b.id}`, { idx: b.idx + 1 });
    }
    placedIn = { scene: sceneRef(host.idx), slug: host.slug ?? null };
  } else {
    // A NEW SCENE, placed right after the anchor's scene in story order —
    // appending it to the end of the list is what put "SHOT 20" under S10 for
    // a block sitting between b19 and b21.
    const anchorScene = anchorSceneId ? sceneById.get(anchorSceneId) : null;
    const sceneIdx = anchorScene
      ? (before ? anchorScene.idx : anchorScene.idx + 1)
      : (scenes.length ? scenes.at(-1).idx + 1 : 0);
    for (const s of scenes.filter((x) => x.idx >= sceneIdx).sort((a, z) => z.idx - a.idx)) {
      await sbUpd(`scenes?id=eq.${s.id}`, { idx: s.idx + 1 });
    }
    scene = await sbIns("scenes", {
      storyboard_id: sbId, idx: sceneIdx,
      slug: String(input.slug || `Shot ${atIdx + 1}`).toUpperCase(),
      duration_ms: durationMs, cast_ids: castIds, environment_id: envId,
      status: "draft",
      scene_prompt: input.action ?? null, meta: { manual: true },
    });
  }

  // Pictures the caller handed over: the first look on the beat itself (the
  // key every worker build stages), and all of them pinned into the plan
  // below. Verified against the registry so a pasted filename is reported
  // rather than staged as nothing.
  const wantLooks = [...new Set((Array.isArray(input.ref_asset_ids) ? input.ref_asset_ids : [])
    .map((x) => String(x || "").trim()).filter(Boolean))];
  const wantStart = input.start_frame_asset_id ? String(input.start_frame_asset_id).trim() : null;
  const refIds = [...new Set([...wantLooks, ...(wantStart ? [wantStart] : [])])];
  const knownRefs = refIds.length
    ? new Set((await sbGet(`assets?id=in.(${refIds.join(",")})&select=id`)).map((r) => r.id))
    : new Set();
  const looks = wantLooks.filter((id) => knownRefs.has(id));
  const startFrame = wantStart && knownRefs.has(wantStart) ? wantStart : null;
  const refsNotFound = refIds.filter((id) => !knownRefs.has(id));

  const beatMeta = {};
  // `ref_plan_for` reads the BEAT's cast for video blocks.
  if (castNames.length) beatMeta.cast = castNames;
  if (startFrame) beatMeta.start_frame_asset_id = startFrame;
  if (looks.length && looks[0] !== startFrame) {
    beatMeta.still_asset_id = looks[0];
    beatMeta.ref_role = "look";
    beatMeta.ref_label = "attached picture";
  }
  const beat = await sbIns("beats", {
    scene_id: scene.id, idx: beatIdx, duration_ms: durationMs,
    camera: input.camera || "static", action: input.action,
    // Only when there are lines: a shot added without any must write the row
    // it always wrote.
    ...(dialogueLines.length ? { dialogue: dialogueLines } : {}),
    meta: beatMeta,
  });
  if (host) await syncSceneDuration(host.id);

  const wantChain = input.chain ?? true;
  const chainFrom = wantChain && prev?.active_take_id ? prev.id : null;
  const catalog = await catalogFor(ctx);
  // Inherited from the neighbour, MINUS anything describing its own render —
  // see inheritParams. Then the project's default fills an empty model_key,
  // so a shot added to an episode planned with no pick renders on what the
  // dock's picker says rather than on the worker's constant.
  const params = inheritParams(prev);
  if (input.model_key) params.model_key = modelKeyOf(input.model_key);
  // …and a NEW shot records what it renders on, so the block carries it.
  const effective = renderParams(params, null, ctx.settings, catalog);
  if (effective.model_key) params.model_key = effective.model_key;

  const refPlan = [];
  if (startFrame) {
    refPlan.push({ purpose: "start_frame", role: "first_frame", asset_id: startFrame,
                   beat_id: beat.id, pinned: true });
  }
  for (const id of looks) {
    if (id === startFrame) continue;
    refPlan.push({ purpose: "look", role: "look", asset_id: id, label: "attached picture",
                   shot_idxs: [1], pinned: true });
  }
  const hasRefs = !!(castIds.length || envId || looks.length || startFrame);
  const block = await sbIns("generation_blocks", {
    storyboard_id: sbId, idx: atIdx, scene_ids: [scene.id], beat_ids: [beat.id],
    t_start_ms: startMs, t_end_ms: startMs + durationMs, frames: plan.renderF,
    trim: { warmup_f: plan.warmupF, cooldown_f: plan.cooldownF, out_ms: plan.trimMs },
    // A mode the block cannot satisfy is a job that dies at execution.
    mode: addBlockMode(input.mode, hasRefs, !!chainFrom),
    ref_plan: refPlan, audio_mode: "native",
    chain_from_block_id: chainFrom, status: "planned",
    seed: Math.floor(Math.random() * 999001) + 1000, params,
  });

  const out = {
    // blockRef, never a hand-built label: refs count from one everywhere.
    block: blockRef(atIdx), block_id: block.id, kind: "shot",
    label: kindLabel("plan", atIdx),
    scene_id: scene.id, scene: sceneRef(scene.idx), scene_slug: scene.slug ?? null,
    shot: shotRef(beatIdx), beat_id: beat.id,
    placed: placedIn
      ? `into ${placedIn.scene}${placedIn.slug ? ` ${placedIn.slug}` : ""} as its shot ${shotRef(beatIdx)}`
      : `as a new scene ${sceneRef(scene.idx)}`,
    seconds: durationMs / 1000, chained: !!chainFrom,
    mode: block.mode, cast: castNames, located: !!envId,
    renders_on: params.model_key || "the worker's default (plain MiniMax H3)",
  };
  if (dialogueLines.length) {
    out.dialogue = dialogueLines.map((d) => ({
      speaker: d.speaker, line: d.line, ...(d.offscreen ? { offscreen: true } : {}) }));
    const warnings = [];
    if (stagedSpeakers.length) {
      out.cast_added = stagedSpeakers;
      warnings.push(`added ${stagedSpeakers.join(", ")} to the cast so their sheet is staged`);
    }
    if (durationMs > requestedMs) {
      warnings.push(`lengthened the shot to ${(durationMs / 1000).toFixed(1)}s — the lines ` +
                    `need about ${(speechMs / 1000).toFixed(1)}s of speaking time`);
    }
    // The one case the floor cannot fix: a block has a ceiling, so past it the
    // line is cut off however long the shot is asked to be. Say it here rather
    // than let it turn up as DIALOGUE_CUTOFF in a review.
    if (speechMs > MAX_CONTENT_MS) {
      warnings.push(`these lines need about ${(speechMs / 1000).toFixed(1)}s and a block ` +
                    `maxes at ${(MAX_CONTENT_MS / 1000).toFixed(1)}s — the last line will ` +
                    "be cut off. Split them across two shots.");
    }
    if (warnings.length) out.warnings = warnings;
  }
  if (looks.length || startFrame) {
    out.references = [...(startFrame ? [{ asset_id: startFrame, purpose: "start_frame" }] : []),
                      ...looks.filter((id) => id !== startFrame)
                        .map((id) => ({ asset_id: id, purpose: "look" }))];
  }
  if (refsNotFound.length) out.refs_not_found = refsNotFound;
  if (unknown.length) out.not_in_bible = unknown;
  if (!hasRefs) {
    out.warning = "nothing to stage — no cast and no location, so this renders as "
                + `${block.mode}. Give it \`cast\` and \`environment\` for a `
                + "reference-driven shot.";
  }
  if (wantChain && !chainFrom) {
    out.note = "not chained: the previous block has not rendered yet, so there " +
               "is no final frame to open on. Render it first, then set the " +
               "chain if the action should continue.";
  }
  if (input.render ?? true) {
    const job = await sbIns("jobs", {
      kind: "master_pass", lane: "gpu", status: "queued",
      priority: USER_PRIORITY, project_id: ctx.projectId, episode_id: episodeId,
      model_id: jobModelId(effective, ctx.settings, catalog),
      payload: { block_id: block.id, activate: "replace", recompute_refs: true,
                 label: `${blockRef(atIdx)} new shot` },
    });
    await sbUpd(`generation_blocks?id=eq.${block.id}`, { status: "queued" });
    out.job_id = job.id;
  }
  return out;
}

// ------------------------------------------------------------- dialogue ---
// Speaking time for a shot's lines — worker/storyplan.py's WORDS_PER_SEC 2.0
// and LINE_PAD_MS 1200. This is the floor a shot's duration must clear; a
// 12-word line in a 2-second shot is exactly the "cut off at the end" bug.
const wordCount = (t) => (String(t ?? "").match(/[\w'’-]+/g) || []).length;
const dialogueMs = (lines) => (lines || []).reduce((total, d) => {
  const w = wordCount(d?.line);
  return w ? total + Math.trunc((w / 2.0) * 1000) + 1200 : total;
}, 0);

/**
 * Unpin a beat from a recorded conversation its lines no longer match.
 *
 * Line and exchange clips are content-hash keyed, so edited text simply misses
 * the cache and re-synthesizes — that half looks after itself. What does NOT is
 * `beats.meta.xchg`: it pins the beat to ONE recording, and the beat's duration
 * was cut to that recording at plan time. Left in place, the master pass keeps
 * routing to the exchange path against a clip that no longer contains these
 * words. The whole RUN shares one recording, so every beat pinned to the same
 * asset is unpinned together.
 *
 * Returns human-readable warnings for the tool result — the model should say
 * these out loud rather than discover them in a review two renders later.
 */
async function invalidateDialogue(beat, lines) {
  const warnings = [];
  const pinned = (beat.meta || {}).xchg?.asset_id;
  if (pinned) {
    const siblings = await sbGet(`beats?scene_id=eq.${beat.scene_id}&select=id,meta`);
    const touched = [];
    for (const row of siblings) {
      if ((row.meta || {}).xchg?.asset_id !== pinned) continue;
      const { xchg, ...rest } = row.meta || {};   // eslint-disable-line no-unused-vars
      await sbUpd(`beats?id=eq.${row.id}`, { meta: rest });
      touched.push(row.id);
    }
    if (touched.length) {
      warnings.push(`unpinned ${touched.length} beat(s) from the old recorded conversation; ` +
                    "the run is re-recorded on the next render");
    }
  }
  const need = dialogueMs(lines);
  const have = Number(beat.duration_ms || 0);
  if (need && have && need > have) {
    warnings.push(
      `these lines need about ${(need / 1000).toFixed(1)}s of speaking time but the shot ` +
      `is ${(have / 1000).toFixed(1)}s — raise duration_ms to at least ${need} or the ` +
      "last line will be cut off");
  }
  return warnings;
}

// ---------------------------------------------------------------- voices ---
// The casting rule, ported from dialogue_synth.cast_voice: gender is a HARD
// filter when the prose declares one (vocal register terms included), and
// within the surviving pool more keyword hits outrank table order. Keyword
// affinity alone once handed "warm low mezzo-soprano" to a male voice.
const FEM_RE = /\b(soprano|mezzo(?:-soprano)?|contralto|alto|woman|female|girl|feminine|she|her)\b/;
const MASC_RE = /\b(baritone|bass|tenor|man|male|boy|masculine|he|his)\b/;

function castVoice(descriptor, taken, hint = "") {
  const d = String(descriptor || "").toLowerCase();
  const probe = `${d} ${String(hint || "").toLowerCase()}`;
  const g = FEM_RE.test(probe) ? "f" : MASC_RE.test(probe) ? "m" : null;
  const filtered = g ? VOICES.filter((v) => v.gender === g) : VOICES;
  const pool = filtered.length ? filtered : VOICES;
  const hits = (v) => v.reads_as.filter((k) => d.includes(k)).length;
  // Stable sort, so equal-scoring voices keep table order — the tie-break the
  // Python relies on.
  const ranked = pool.filter((v) => hits(v) > 0).sort((a, b) => hits(b) - hits(a))
    .map((v) => v.voice_id);
  for (const v of pool) if (!ranked.includes(v.voice_id)) ranked.push(v.voice_id);
  return ranked.find((v) => !taken.has(v)) ?? ranked[0];
}

/**
 * After a recast, drop every recorded conversation this character is in.
 *
 * An exchange clip is content-hash keyed on the SPEAKER'S VOICE ID as well as
 * the words, so a recast makes every pin point at a recording in the voice that
 * was just replaced — and because the beat's duration was cut to that
 * recording, leaving it also leaves the shot timed to a performance nobody will
 * hear. Blocks covering a cleared beat go stale.
 */
async function clearVoicePins(entry, projectId) {
  const base = entry.name.split(" — ")[0].trim().toLowerCase();
  const touched = [];
  for (const eid of await episodeIds(projectId)) {
    const sbId = await episodeStoryboardId(eid);
    if (!sbId) continue;
    const scenes = await sbGet(`scenes?storyboard_id=eq.${sbId}&select=id`);
    if (!scenes.length) continue;
    const beats = await sbGet(
      `beats?scene_id=in.(${scenes.map((s) => s.id).join(",")})&select=id,meta,dialogue`);
    // A recording covers a whole CONVERSATION, so it is cleared from every
    // beat that shares it, not only the ones this character speaks in.
    // Clearing half a run is the failure invalidateDialogue exists to prevent:
    // the other half keeps pointing into a clip about to be re-recorded, and
    // its shot keeps a duration cut to the old performance.
    const doomed = new Set(
      beats
        .filter((b) => (b.meta || {}).xchg && (b.dialogue || []).some(
          (d) => String(d.speaker || "").split(" — ")[0].trim().toLowerCase() === base))
        .map((b) => b.meta.xchg.asset_id)
        .filter(Boolean));
    if (!doomed.size) continue;
    for (const b of beats) {
      if (!doomed.has(((b.meta || {}).xchg || {}).asset_id)) continue;
      const { xchg, ...rest } = b.meta || {};    // eslint-disable-line no-unused-vars
      await sbUpd(`beats?id=eq.${b.id}`, { meta: rest });
      const rows = await sbUpdRows(
        `generation_blocks?storyboard_id=eq.${sbId}&beat_ids=cs.{${b.id}}` +
        `&status=in.(planned,generated)`, { status: "stale" });
      for (const r of rows) if (r.idx != null) touched.push(blockRef(r.idx));
    }
  }
  return [...new Set(touched)].sort();
}

/**
 * The id a QUEUED PIPELINE JOB should carry, given the CHAT backend this
 * turn is running on. Twin of `pipelineBackendId` in `src/lib/director.ts` —
 * kept as its own small function here rather than imported, since this
 * module runs both server-side (Vercel) and browser-side (BYOK/local desktop
 * chat) and importing a `.ts` module from either is more trouble than three
 * lines are worth.
 *
 * The chat picker offers several MODELS per provider (Opus/Sonnet/Haiku,
 * Luna/Sol/Terra) because a chat turn benefits from choosing one; the
 * worker's `pick_backend` has no such concept — an id it has never heard of
 * falls straight through its explicit-want checks and lands on its own
 * auto-selected default, silently overriding what was picked. This is what
 * keeps a `plan_storyboard` tool call — queued mid-conversation, from
 * WHATEVER hosted backend answered this turn — spending the credential the
 * conversation was actually running on rather than a re-guessed one.
 */
function pipelineBackendId(id) {
  if (!id) return id;
  if (id.startsWith("claude-api")) return "claude-api";
  if (id.startsWith("openai-compat")) return "openai-compat";
  return id;   // ollama-local, byok:*, or anything the worker already understands
}

/**
 * Run one tool, journaling its writes onto `ctx.journal` when the runner
 * supplied one (an array). The runner persists that array onto the assistant
 * message as a `changes` block; see director/changes.js for what the dock
 * does with it. A caller that passes no journal gets exactly the old
 * behaviour — nothing is recorded and nothing is read that would not have
 * been.
 */
async function runTool(name, input, ctx) {
  const ops = Array.isArray(ctx?.journal) ? ctx.journal : null;
  return ops
    ? withJournal(ops, () => runToolInner(name, input, ctx))
    : runToolInner(name, input, ctx);
}

async function runToolInner(name, input, ctx) {
  // `settings` has to come through ctx. It used to be read as a bare
  // identifier here while the only `settings` in the file is a `const` inside
  // the request handler — a different scope — so `generate_image` threw
  // ReferenceError: settings is not defined on EVERY call that did not pass an
  // explicit model_key, and the director dutifully reported it as a studio
  // outage and offered to retry. Defaulted to {} so a caller that forgets it
  // degrades to the worker's own model pick rather than throwing again.
  const { projectId, episodeId, backendId, persona, settings = {} } = ctx;
  switch (name) {
    case "get_project_state": {
      // `summary` matters as much as `identity_line`: a LORE entry has no
      // identity line by design (nothing about it is visual), so selecting only
      // the line rendered every lore row as a bare name with nothing under it.
      const [project, episodes, bible, jobs, pod, loreDocs] = await Promise.all([
        sbGet(`projects?id=eq.${projectId}&select=id,title,medium,genre,style,aspect,size_id,logline,status`),
        sbGet(`episodes?project_id=eq.${projectId}&order=idx&select=id,idx,code,title,status`),
        sbGet(`bible_entries?project_id=eq.${projectId}&order=kind&select=id,kind,name,status,identity_line,summary`),
        sbGet(`jobs?project_id=eq.${projectId}&order=created_at.desc&limit=8&select=id,kind,status,progress,progress_note,error_msg`),
        sbGet(`pod_status?select=state,gpu_util,session_sec`),
        loreDocList(projectId),
      ]);
      // The OPEN episode's board (`currentStoryboardId`), not the project's
      // newest — `episodes` above already lists the others by name.
      const sbId = await currentStoryboardId(ctx);
      let storyboard = null;
      if (sbId) {
        const [row] = await sbGet(`storyboards?id=eq.${sbId}&select=id,status,audio_asset_id`);
        const blocks = await sbGet(
          `generation_blocks?storyboard_id=eq.${sbId}&order=idx&select=id,idx,status,t_start_ms,t_end_ms`);
        storyboard = { ...row, blocks };
      }
      // Titles only — the text comes from search_lore. What this answers is
      // "is there a lore document at all", which the director could not
      // answer before and therefore answered "no" about a document sitting
      // indexed in the database.
      return { project: project[0], episodes, bible, storyboard,
               lore_documents: loreDocs, recent_jobs: jobs, pod: pod[0] };
    }
    case "search_lore":
      return searchLore(projectId, input.query, input.limit);
    case "set_lore_timing":
      return setLoreTiming(projectId, input);
    case "list_storyboard": {
      const sbId = input.storyboard_id || await currentStoryboardId(ctx);
      if (!sbId) return noStoryboard(ctx);
      // ONE scene when asked. Without this the only way to see a beat was to
      // pull every beat of every scene — 28KB of prose on a 71-beat board —
      // and a model working on one scene re-read the whole thing each round.
      // Measured: a "merge MEMORY_RETURN down to 14 shots" turn spent all 12
      // rounds on identical list_storyboard calls and made no edit at all.
      if (input.scene_id) {
        const found = await resolveScene(input.scene_id, ctx);
        if (!found.scene) return found;
        const [one] = await sbGet(
          `scenes?id=eq.${found.scene.id}&select=id,idx,slug,duration_ms,environment_id,cast_ids,scene_prompt,status`);
        if (!one) return { error: "scene not found" };
        one.beats = await sbGet(
          `beats?scene_id=eq.${one.id}&order=idx&select=id,idx,duration_ms,camera,action,dialogue,sfx`);
        one.beats.forEach((b, i) => { b.ref = `b${i + 1}`; });
        return { storyboard_id: one.storyboard_id ?? sbId, scenes: [one] };
      }
      const scenes = await sbGet(
        `scenes?storyboard_id=eq.${sbId}&order=idx&select=id,idx,slug,duration_ms,environment_id,cast_ids,scene_prompt,status`);
      for (const s of scenes) {
        s.beats = await sbGet(
          `beats?scene_id=eq.${s.id}&order=idx&select=id,idx,duration_ms,camera,action,dialogue,sfx`);
      }
      return { storyboard_id: sbId, scenes };
    }
    case "update_bible_entry": {
      const existing = await sbGet(
        `bible_entries?project_id=eq.${projectId}&kind=eq.${input.kind}&name=ilike.${encodeURIComponent(input.name)}&select=id,version,doc,identity_line`);
      if (existing.length) {
        const e = existing[0];
        const revs = await sbGet(`bible_revisions?entry_id=eq.${e.id}&order=version.desc&limit=1&select=version`);
        const version = Math.max(e.version || 1, revs[0]?.version || 0) + 1;
        const rev = await sbIns("bible_revisions", {
          entry_id: e.id, version,
          doc: { ...(e.doc || {}), ...(input.doc || {}), ...(input.summary ? { summary: input.summary } : {}) },
          identity_line: input.identity_line || e.identity_line,
          change_note: input.change_note || "director proposal",
          proposed_by: "director",
        });
        return { proposed_revision_id: rev.id, entry_id: e.id, version, note: "draft — user must confirm in Bible page" };
      }
      const row = await sbIns("bible_entries", {
        project_id: projectId, kind: input.kind, name: input.name.slice(0, 80),
        summary: input.summary, identity_line: input.identity_line,
        doc: input.doc || {}, status: "draft",
      });
      return { created_entry_id: row.id, status: "draft" };
    }
    case "search_assets": {
      // Binned and hidden assets are out: the director must not offer a
      // reference the user threw away, nor one they filed in an incognito
      // collection precisely so it would stop being offered.
      const parts = [`limit=${Math.min(24, input.limit || 12)}`, "order=created_at.desc",
        "select=id,kind,b2_key,tags,duration_ms,width,height",
        "deleted_at=is.null", "hidden=is.false"];
      if (input.kind) parts.push(`kind=eq.${input.kind}`);
      if (input.tag) parts.push(`tags=cs.{${input.tag}}`);
      if (input.text) parts.push(`b2_key=ilike.*${encodeURIComponent(input.text)}*`);
      parts.push(`or=(project_id.eq.${projectId},project_id.is.null)`);
      return { assets: await sbGet(`assets?${parts.join("&")}`) };
    }
    case "plan_storyboard": {
      const pipelineId = pipelineBackendId(backendId);
      const job = await sbIns("jobs", {
        kind: "llm_task", lane: "llm", status: "queued", priority: 30,
        project_id: projectId, episode_id: input.episode_id || episodeId || null,
        model_id: pipelineId,
        payload: {
          task: "plan_storyboard", project_id: projectId,
          episode_id: input.episode_id || episodeId || null,
          brief: {
            logline: input.logline, notes: input.notes,
            duration_target_ms: input.duration_target_ms,
            audio_asset_id: input.audio_asset_id || null,
          },
          tier: input.tier, auto_launch: input.tier === 1,
          backend: pipelineId, persona,
        },
      });
      // WHERE it runs is read off the row that came back, not asserted. Inside
      // a project that lives on the user's own machine the browser's queue
      // corrects the lane to the one that machine serves (`enqueueJob`), so a
      // note naming the cloud would be telling them to go and start a box that
      // has nothing to do with it.
      return { job_id: job.id,
               note: job.lane === "local"
                 ? "queued — runs on this machine"
                 : "queued — runs when the studio cloud is up" };
    }
    case "launch_render": {
      const job = await sbIns("jobs", {
        kind: "launch_render", lane: "cpu", status: "queued", priority: 30,
        project_id: projectId, episode_id: episodeId || null,
        payload: {
          storyboard_id: input.storyboard_id,
          dims: input.width ? { w: input.width, h: input.height } : {},
        },
      });
      return { job_id: job.id };
    }
    case "retake_block": {
      const [block] = await sbGet(`generation_blocks?id=eq.${input.block_id}&select=id,idx`);
      if (!block) return { error: "block not found" };
      const job = await sbIns("jobs", {
        kind: "master_pass", lane: "gpu", status: "queued", priority: 10,
        project_id: projectId, episode_id: episodeId || null, model_id: "h3-local",
        payload: { block_id: input.block_id, auto_activate: false, take_of: true,
                   ...(input.seed != null ? { seed: input.seed } : { seed: Math.floor(Math.random() * 1e9) }) },
      });
      return { job_id: job.id, block_idx: block.idx, note: "new take — keep it from the takes browser" };
    }
    case "generate_image": {
      const target = input.bible_entry_id
        ? { bible_entry_id: input.bible_entry_id, role: input.role || "master", slot: 0 }
        : input.scene_id ? { scene_id: input.scene_id } : {};
      const imgKey = modelKeyOf(input.model_key || settings.image_model);
      // ONE QUEUE. `enqueueJob` corrects the lane on the way in and refuses a
      // kind nothing here can run, so naming it is a formality — but it is
      // named rather than omitted, because the column is not nullable and a
      // row is easier to read when it says which worker it is for.
      const job = await sbIns("jobs", {
        kind: "image_gen", lane: "local", status: "queued", priority: 20,
        project_id: projectId, episode_id: episodeId || null,
        payload: {
          prompt: input.prompt, target,
          ref_asset_ids: input.ref_asset_ids || [],
          width: input.width || 1024, height: input.height || 1024,
          ...(imgKey ? { model_key: imgKey } : {}),
        },
      });
      return { job_id: job.id };
    }
    case "update_scene": {
      const found = await resolveScene(input.scene_id, ctx);
      if (!found.scene) return found;
      const scene = found.scene;
      const patch = {};
      for (const k of ["slug", "scene_prompt"]) if (input[k] != null) patch[k] = input[k];
      let refit = null;
      if (input.duration_ms != null) {
        const rows = await sbGet(
          `beats?scene_id=eq.${scene.id}&order=idx&select=id,duration_ms`);
        if (rows.length) {
          const fitted = refitBeats(rows.map((r) => r.duration_ms),
                                    Math.max(1000, input.duration_ms));
          let n = 0;
          for (let i = 0; i < rows.length; i++) {
            if (Math.round(Number(rows[i].duration_ms) || 0) === fitted[i]) continue;
            await sbUpd(`beats?id=eq.${rows[i].id}`, { duration_ms: fitted[i] });
            n++;
          }
          patch.duration_ms = fitted.reduce((a, b) => a + b, 0);
          refit = { beats_retimed: n, scene_ms: patch.duration_ms };
        } else {
          patch.duration_ms = Math.max(1000, input.duration_ms);
        }
      }
      // Names, not ids: the model is looking at the same cards the user is, and
      // asking it to carry uuids around is how the wrong character ends up in a
      // scene. Unknown names are reported rather than silently dropped.
      const missing = [];
      const idFor = async (kind, name) => {
        const [hit] = await sbGet(
          `bible_entries?project_id=eq.${projectId}&kind=eq.${kind}` +
          `&name=ilike.${encodeURIComponent(name)}&select=id`);
        if (!hit) missing.push(name);
        return hit?.id ?? null;
      };
      if (Array.isArray(input.cast_names)) {
        const ids = [];
        for (const n of input.cast_names) {
          const id = await idFor("character", n);
          if (id) ids.push(id);
        }
        patch.cast_ids = ids;
      }
      if (input.environment_name) patch.environment_id = await idFor("environment", input.environment_name);
      if (!Object.keys(patch).length) return { error: "nothing to change" };
      await sbUpd(`scenes?id=eq.${scene.id}`, patch);
      // The blocks were planned from the old scene; leaving them 'planned' would
      // render the previous version.
      await sbUpd(`generation_blocks?storyboard_id=eq.${scene.storyboard_id}` +
                  `&scene_ids=cs.{${scene.id}}&status=in.(planned,generated)`,
                  { status: "stale" }).catch(() => {});
      return { updated_scene_id: scene.id, changed: Object.keys(patch).sort(),
               ...(refit ?? {}),
               ...(missing.length ? { not_in_bible: missing } : {}),
               note: "blocks covering this scene are stale — re-plan or re-render them; "
                     + "its panels still show the old scene — redraw_panels"
                     + (refit ? "; its shots were retimed proportionally, because a "
                              + "scene's length IS the sum of its shots" : "") };
    }
    case "update_beat": {
      const hit = await resolveBeat(input.beat_id, input.scene_id, ctx);
      if (!hit.beat) return hit;
      const beat = hit.beat;
      const patch = {};
      for (const k of ["action", "camera", "sfx"]) if (input[k] != null) patch[k] = input[k];
      if (input.duration_ms != null) patch.duration_ms = Math.max(500, input.duration_ms);
      if (Array.isArray(input.cast)) {
        // `meta.cast` is what ref_plan_for reads to decide whose sheets are
        // staged, and until this existed no tool could touch it. Measured
        // 2026-08-15: rewriting the action to "two giant talking plants, no
        // people present" AND clearing the SCENE cast still left both
        // characters staged twice each plus both voices, because a beat name
        // resolves project-wide once the scene stops casting it.
        //
        // The render came back as plants anyway — for a transformation this
        // explicit the prose beat the pictures, the opposite of what "H3 obeys
        // a picture over a sentence" predicts. So this is a contradiction fix
        // rather than a correctness one: six of eight reference slots were
        // spent arguing with the prompt, and a subtler edit ("she is alone in
        // this shot") carries far less prose leverage than this one did.
        patch.meta = { ...(beat.meta || {}),
                       cast: input.cast.map((n) => String(n).trim()).filter(Boolean) };
      }
      if (Array.isArray(input.dialogue)) {
        const lines = [];
        for (const d of input.dialogue) {
          const [who] = await sbGet(
            `bible_entries?project_id=eq.${projectId}&kind=eq.character` +
            `&name=ilike.${encodeURIComponent(d.speaker || "")}&select=id`);
          lines.push({ speaker_id: who?.id ?? null, speaker: d.speaker,
                       line: d.line, ...(d.delivery ? { delivery: d.delivery } : {}),
                       ...(d.offscreen ? { offscreen: true } : {}) });
        }
        patch.dialogue = lines;
      }
      if (!Object.keys(patch).length) return { error: "nothing to change" };
      await sbUpd(`beats?id=eq.${beat.id}`, patch);
      // Against the duration this call is SETTING, not the old one.
      const warnings = patch.dialogue
        ? await invalidateDialogue({ ...beat, ...(patch.duration_ms != null
            ? { duration_ms: patch.duration_ms } : {}) }, patch.dialogue)
        : [];
      const [scene] = await sbGet(`scenes?id=eq.${beat.scene_id}&select=storyboard_id`);
      if (scene) {
        // `beat.id`, not the caller's ref: the ref may be a label ("b2"), and a
        // label in a uuid array filter matches nothing — so the edit lands and
        // the block is never marked stale.
        await sbUpd(`generation_blocks?storyboard_id=eq.${scene.storyboard_id}` +
                    `&beat_ids=cs.{${beat.id}}&status=in.(planned,generated)`,
                    { status: "stale" }).catch(() => {});
      }
      const sceneMs = patch.duration_ms != null
        ? await syncSceneDuration(beat.scene_id) : null;
      // Say WHICH scene and shot this landed in. A label ref ("b2" in "S3") is
      // resolved silently, so a model that means CITY_CAPTURE_2 and writes S3
      // edits HIDEOUT_ARRIVAL and is told only a uuid — measured exactly that
      // way. Echoing the slug is what lets the next turn (and the person
      // reading the transcript) notice.
      return { updated_beat_id: beat.id, changed: Object.keys(patch).sort(),
               scene: hit.slug ?? null, beat_ref: shotRef(beat.idx ?? 0),
               ...(sceneMs ? { scene_ms: sceneMs } : {}),
               ...(warnings.length ? { warnings } : {}),
               // TWO things now describe the old shot, and only one of them
               // is marked. The block carries a `stale` status; the PANEL on
               // the scene card carries nothing at all, so a model that reads
               // only what the row says will report the block and silently
               // leave the picture — which is exactly what happened on Rei
               // EP03 CITY_CAPTURE_2 (six beats rewritten, six panels stale,
               // the reply mentioned only the blocks).
               note: "the block covering this beat is stale — rerender_block to see the "
                     + "change; the panel on the scene card still shows the OLD shot — "
                     + "redraw_panels for this scene" };
    }
    case "add_scene": {
      // Where it goes: after a named sibling, else on the end. The storyboard
      // comes from that sibling so a new scene can never land in another one.
      let sbId = null, at = null;
      if (input.after_scene_id) {
        const found = await resolveScene(input.after_scene_id, ctx);
        if (!found.scene) return found;
        sbId = found.scene.storyboard_id;
        at = found.scene.idx + 1;
      } else {
        sbId = await currentStoryboardId(ctx);
        if (!sbId) return noStoryboard(ctx);
      }
      const siblings = await sbGet(`scenes?storyboard_id=eq.${sbId}&order=idx&select=id,idx`);
      if (at == null) at = siblings.length;
      // Shift from the back so the (storyboard_id, idx) pairs never collide.
      for (const sc of [...siblings].reverse().filter((x) => x.idx >= at)) {
        await sbUpd(`scenes?id=eq.${sc.id}`, { idx: sc.idx + 1 });
      }

      const nameToId = async (kind, name) => {
        const [hit] = await sbGet(
          `bible_entries?project_id=eq.${projectId}&kind=eq.${kind}` +
          `&name=ilike.${encodeURIComponent(name)}&select=id`);
        return hit?.id ?? null;
      };
      const castIds = [];
      for (const n of input.cast_names ?? []) {
        const id = await nameToId("character", n);
        if (id) castIds.push(id);
      }
      const beats = (input.beats ?? []).filter((b) => b?.action);
      if (!beats.length) return { error: "a scene needs at least one beat" };
      const dur = input.duration_ms
        ?? beats.reduce((t, b) => t + (b.duration_ms || 4000), 0);
      const scene = await sbIns("scenes", {
        storyboard_id: sbId, idx: at, slug: input.slug, duration_ms: dur,
        scene_prompt: input.scene_prompt ?? null, cast_ids: castIds,
        environment_id: input.environment_name
          ? await nameToId("environment", input.environment_name) : null,
        status: "draft",
      });
      for (const [i, b] of beats.entries()) {
        const dialogue = [];
        for (const d of b.dialogue ?? []) {
          dialogue.push({ speaker_id: await nameToId("character", d.speaker || ""),
                          speaker: d.speaker, line: d.line,
                          ...(d.delivery ? { delivery: d.delivery } : {}),
                          ...(d.offscreen ? { offscreen: true } : {}) });
        }
        await sbIns("beats", {
          scene_id: scene.id, idx: i, duration_ms: b.duration_ms || 4000,
          action: b.action, camera: b.camera ?? null, sfx: b.sfx ?? null,
          dialogue: dialogue.length ? dialogue : null,
        });
      }
      await sbUpd(`generation_blocks?storyboard_id=eq.${sbId}&status=in.(planned,generated)`,
                  { status: "stale" }).catch(() => {});
      return { created_scene_id: scene.id, idx: at, beats: beats.length,
               note: "the block plan is stale — it is rebuilt at launch" };
    }
    case "delete_scene": {
      const found = await resolveScene(input.scene_id, ctx);
      if (!found.scene) return found;
      const scene = found.scene;
      await sbDel(`scenes?id=eq.${scene.id}`);                // beats cascade
      const after = await sbGet(
        `scenes?storyboard_id=eq.${scene.storyboard_id}&idx=gt.${scene.idx}&order=idx&select=id,idx`);
      for (const sc of after) await sbUpd(`scenes?id=eq.${sc.id}`, { idx: sc.idx - 1 });
      await sbUpd(`generation_blocks?storyboard_id=eq.${scene.storyboard_id}&status=in.(planned,generated)`,
                  { status: "stale" }).catch(() => {});
      return { deleted_scene_id: scene.id, resequenced: after.length };
    }
    case "add_beat": {
      const found = await resolveScene(input.scene_id, ctx);
      if (!found.scene) return found;
      const scene = found.scene;
      const siblings = await sbGet(`beats?scene_id=eq.${scene.id}&order=idx&select=id,idx`);
      let at = siblings.length;
      if (input.after_beat_id) {
        const hit = siblings.find((b) => b.id === input.after_beat_id);
        if (hit) at = hit.idx + 1;
      }
      for (const b of [...siblings].reverse().filter((x) => x.idx >= at)) {
        await sbUpd(`beats?id=eq.${b.id}`, { idx: b.idx + 1 });
      }
      const dialogue = [];
      for (const d of input.dialogue ?? []) {
        const [who] = await sbGet(
          `bible_entries?project_id=eq.${projectId}&kind=eq.character` +
          `&name=ilike.${encodeURIComponent(d.speaker || "")}&select=id`);
        dialogue.push({ speaker_id: who?.id ?? null, speaker: d.speaker, line: d.line,
                        ...(d.delivery ? { delivery: d.delivery } : {}),
                        ...(d.offscreen ? { offscreen: true } : {}) });
      }
      const beat = await sbIns("beats", {
        scene_id: scene.id, idx: at, duration_ms: input.duration_ms || 4000,
        action: input.action, camera: input.camera ?? null, sfx: input.sfx ?? null,
        dialogue: dialogue.length ? dialogue : null,
      });
      await sbUpd(`generation_blocks?storyboard_id=eq.${scene.storyboard_id}&status=in.(planned,generated)`,
                  { status: "stale" }).catch(() => {});
      // Adding a shot lengthens the scene by exactly its duration.
      return { created_beat_id: beat.id, idx: at, scene: scene.slug ?? null,
               scene_ms: await syncSceneDuration(scene.id) };
    }
    case "delete_beat": {
      const hit = await resolveBeat(input.beat_id, input.scene_id, ctx);
      if (!hit.beat) return hit;
      const beat = hit.beat;
      const siblings = await sbGet(`beats?scene_id=eq.${beat.scene_id}&order=idx&select=id,idx`);
      if (siblings.length <= 1) return { error: "a scene needs at least one beat — delete the scene instead" };
      await sbDel(`beats?id=eq.${beat.id}`);
      for (const b of siblings.filter((x) => x.idx > beat.idx)) {
        await sbUpd(`beats?id=eq.${b.id}`, { idx: b.idx - 1 });
      }
      const [scene] = await sbGet(`scenes?id=eq.${beat.scene_id}&select=storyboard_id`);
      if (scene) {
        await sbUpd(`generation_blocks?storyboard_id=eq.${scene.storyboard_id}&status=in.(planned,generated)`,
                    { status: "stale" }).catch(() => {});
      }
      return { deleted_beat_id: beat.id, scene: hit.slug ?? null,
               scene_ms: await syncSceneDuration(beat.scene_id) };
    }
    case "redraw_panels": {
      // THIS TOOL DOES NOT COMPOSE A PANEL, deliberately. There is exactly one
      // panel generator — `scene_panel_specs` in worker/llm.py, twinned in
      // src/lib/panelSpec.ts — and its own docstring names this caller: "a
      // re-draw, a verification, a repair all had to reimplement it and then
      // drift". A hosted director runs in a serverless function that can import
      // neither twin, so composing here would mean a THIRD spelling of the
      // plate rotation, the featured-cast matcher and the anchor ordering, and
      // a panel redrawn from the chat would stop being the same picture as one
      // drawn by the button. So this resolves WHICH shots and queues the
      // llm_task that composes them.
      const sbId = await currentStoryboardId(ctx);
      if (!sbId) return noStoryboard(ctx);
      let scenes;
      if (input.scene_id) {
        const found = await resolveScene(input.scene_id, ctx);
        if (!found.scene) return found;
        scenes = [found.scene];
      } else {
        scenes = await sbGet(
          `scenes?storyboard_id=eq.${sbId}&order=idx&select=id,idx,slug`);
        if (!scenes.length) return { error: "this storyboard has no scenes yet" };
      }
      // Shot labels are resolved HERE, against the scene that gives them
      // meaning — "b2" is a position, and a label reaching the worker matches
      // no uuid, so the filter would quietly redraw nothing.
      let beatIds = null;
      if (Array.isArray(input.beat_ids) && input.beat_ids.length) {
        if (!input.scene_id) {
          return { error: "beat_ids needs scene_id — a shot label is a position inside one scene" };
        }
        beatIds = [];
        for (const ref of input.beat_ids) {
          const hit = await resolveBeat(ref, input.scene_id, ctx);
          if (!hit.beat) return hit;
          beatIds.push(hit.beat.id);
        }
      }
      // Count what will actually RENDER. A breath beat draws no panel (the
      // worker skips it, matching tier 1 and the button), so counting beats
      // would over-quote every scene that holds one — and the whole point of
      // the dry run below is that the number is honest.
      const pBeats = await sbGet(
        `beats?scene_id=in.(${scenes.map((x) => x.id).join(",")})&order=idx` +
        `&select=id,idx,scene_id,meta`);
      const drawn = pBeats.filter(
        (b) => !b.meta?.breath && (!beatIds || beatIds.includes(b.id)));
      if (!drawn.length) {
        return { error: "nothing to draw there — those shots are wordless holds, which get no panel" };
      }
      const plan = scenes
        .map((x) => ({ scene: x.slug || sceneRef(x.idx),
                       panels: drawn.filter((b) => b.scene_id === x.id).length }))
        .filter((r) => r.panels);
      // A FAN-OUT ASKS PERMISSION IN THE TOOL, not in the prose — the rule
      // `rerender_stale` already follows. A model told "fix the panels" will
      // otherwise redraw a 58-shot board on its own initiative and the bill is
      // the first anyone hears about it. ONE scene needs no confirmation: it is
      // the same scope, and the same cost, as the button already on screen.
      if (!input.scene_id && input.confirm !== true) {
        return { would_redraw: plan, panels: drawn.length, confirm_required: true,
                 note: `${drawn.length} panel(s) across ${plan.length} scene(s) — ` +
                       `call again with confirm:true to queue them` };
      }
      // WHERE THE COMPOSITION RUNS. `lane: "llm"` is the POD's queue, so on a
      // hosted image model that would still wake a $3.36/hr box — to compose a
      // prompt and insert rows, with the render itself going out to the
      // provider. `plannerHere` says this build has the bundled pipeline
      // Python (desktop + engine installed), in which case the local worker
      // claims it (PY_KINDS includes llm_task) and the whole redraw happens
      // with the pod stopped. Absent — the hosted director on Vercel, or a web
      // tab with no Python — it is the pod's, exactly as before. Passed
      // through ctx rather than imported: this module is loaded by a
      // serverless function that can resolve none of src/lib.
      const pJob = await sbIns("jobs", {
        kind: "llm_task", lane: ctx.plannerHere ? "local" : "llm",
        status: "queued", priority: USER_PRIORITY,
        project_id: projectId, episode_id: episodeId || null,
        payload: {
          task: "redraw_panels",
          project_id: projectId, episode_id: episodeId || null,
          scene_ids: scenes.map((x) => x.id),
          ...(beatIds ? { beat_ids: beatIds } : {}),
          // A catalog id is not a model_map key, and the worker resolves
          // against model_map. Omitted rather than sent empty, so the worker
          // falls back to the project's own image model.
          ...(modelKeyOf(input.model_key) ? { image_model: modelKeyOf(input.model_key) } : {}),
          label: `${plan[0]?.scene ?? "storyboard"} · redraw ${drawn.length} panel(s)`,
        },
      });
      return { job_id: pJob.id, panels: drawn.length, scenes: plan,
               ran: ctx.plannerHere ? "this machine" : "the studio cloud",
               note: "queued — each panel lands on its shot as it finishes. " +
                     "A still the user pinned themselves is left alone." };
    }
    case "list_timelines":
      return { timelines: await listCuts(projectId, input.episode_id || episodeId) };
    case "render_timeline": {
      // VALIDATED, because the alternative is a job that queues cleanly, waits
      // for a worker and then dies on the pod reading a row that is not there.
      // The error names the real cuts, so the next call is right instead of
      // being another guess.
      const cuts = await listCuts(projectId, episodeId);
      const want = cuts.find((t) => t.id === input.timeline_id);
      if (!want) {
        return { error: `no cut ${input.timeline_id} on this episode`, timelines: cuts };
      }
      const job = await sbIns("jobs", {
        kind: "tl_render", lane: "cpu", status: "queued", priority: 30,
        project_id: projectId, episode_id: episodeId || null,
        payload: { timeline_id: input.timeline_id },
      });
      return { job_id: job.id, rendering: want.name };
    }
    case "add_outfit_variant": {
      const cname = String(input.character || "").trim();
      const parents = await sbGet(
        `bible_entries?project_id=eq.${projectId}&kind=eq.character` +
        `&name=ilike.${encodeURIComponent(cname)}` +
        `&select=id,name,identity_line,doc,voice_ref_asset_id`);
      if (!parents.length) return { error: `no character named "${cname}" in the bible` };
      const parent = parents[0];
      const vname = `${parent.name} — ${String(input.outfit_name || "").trim()}`.slice(0, 80);
      const look = String(input.outfit_look || "").trim();
      if (!look) return { error: "outfit_look is required — exact pieces with colors" };
      const dup = await sbGet(
        `bible_entries?project_id=eq.${projectId}&kind=eq.character` +
        `&name=ilike.${encodeURIComponent(vname)}&select=id`);
      let variant = dup[0];
      if (!variant) {
        const base = (parent.identity_line || parent.name).replace(/\.$/, "");
        variant = await sbIns("bible_entries", {
          project_id: projectId, kind: "character", name: vname,
          summary: `${parent.name} in ${input.outfit_name}`,
          identity_line: `${base}; now wearing ${look}`,
          doc: { variant_of: parent.id, outfit: look,
                 ...(parent.doc?.voice ? { voice: parent.doc.voice } : {}) },
          status: "draft",
        });
      }
      const [proj] = await sbGet(`projects?id=eq.${projectId}&select=style`);
      const job = await sbIns("jobs", {
        kind: "image_gen", lane: "gpu", status: "queued", priority: 20,
        project_id: projectId, episode_id: episodeId || null,
        payload: {
          prompt: `Change only the clothing: now wearing ${look}. Keep the face, ` +
                  `hair, build and pose identical.`,
          prompt_spec: { kind: "character", role: "full_body", name: vname,
                         identity: `${parent.identity_line || parent.name}; now wearing ${look}`,
                         style: proj?.style || null },
          mode: "edit", denoise: 0.75,
          anchor_entry_id: parent.id, anchor_roles: ["full_body", "face"],
          loras: [{ key: "identity", strength: 1.0 }],
          width: 1024, height: 1024,
          target: { bible_entry_id: variant.id, role: "full_body", slot: 0 },
          auto_accept: true,
        },
      });
      const recast = [];
      for (const ref of input.scenes || []) {
        const found = await resolveScene(ref, ctx);
        if (!found.scene) { recast.push({ ref, error: found.error }); continue; }
        const [row] = await sbGet(`scenes?id=eq.${found.scene.id}&select=cast_ids,storyboard_id`);
        const cast = (row.cast_ids || []).map((c) => (c === parent.id ? variant.id : c));
        if (!cast.includes(variant.id)) cast.push(variant.id);
        await sbUpd(`scenes?id=eq.${found.scene.id}`, { cast_ids: cast });
        await sbUpd(
          `generation_blocks?storyboard_id=eq.${row.storyboard_id}` +
          `&scene_ids=cs.{${found.scene.id}}&status=in.(planned,generated)`,
          { status: "stale" });
        recast.push({ ref, scene_id: found.scene.id });
      }
      return { variant_entry_id: variant.id, name: vname, sheet_job_id: job.id, recast,
               note: "the parent's face sheet stays the identity anchor; blocks in " +
                     "recast scenes are stale" };
    }

    // ------------------------------------------------------- editing ----
    case "list_blocks": {
      const sbId = input.storyboard_id || await currentStoryboardId(ctx);
      if (!sbId) return noStoryboard(ctx);
      const blocks = await sbGet(
        `generation_blocks?storyboard_id=eq.${sbId}&order=idx` +
        `&select=id,idx,scene_ids,beat_ids,t_start_ms,t_end_ms,status,mode,active_take_id,` +
        `chain_from_block_id,params`);
      const sceneName = Object.fromEntries(
        (await sbGet(`scenes?storyboard_id=eq.${sbId}&select=id,slug`)).map((s) => [s.id, s.slug]));
      // The first shot's action, so "the block where she takes the helmet off"
      // resolves against what the blocks actually contain rather than against
      // scene names alone — a block index of bare refs and slugs is how a
      // re-render landed on the wrong block. A clip-born block has no beats;
      // its recipe's prompt stands in.
      const beatIds = [...new Set(blocks.flatMap((b) => (b.beat_ids || []).slice(0, 1)))];
      const firstAction = beatIds.length
        ? Object.fromEntries((await sbGet(`beats?id=in.(${beatIds.join(",")})&select=id,action`))
            .map((r) => [r.id, r.action]))
        : {};
      const out = [];
      for (const b of blocks) {
        const kind = blockKindOf(b);
        const recipe = (b.params || {}).clip_gen;
        const first = (b.beat_ids || [])[0]
          ? firstAction[(b.beat_ids || [])[0]]
          : (recipe && typeof recipe === "object" ? recipe.prompt : null);
        out.push({
          ref: blockLabel(b), block_id: b.id,
          // "Extension 19" / "Chain 17" / "Block 20": the noun the sidebar and
          // the lane use. A chain or an extension renders from a stored
          // recipe rather than from beats, which changes what can be edited.
          label: kindLabel(kind, b.idx), kind,
          scenes: (b.scene_ids || []).map((s) => sceneName[s]),
          at: `${(Number(b.t_start_ms || 0) / 1000).toFixed(1)}-` +
              `${(Number(b.t_end_ms || 0) / 1000).toFixed(1)}s`,
          status: b.status, mode: b.mode,
          has_take: !!b.active_take_id,
          chained: !!b.chain_from_block_id,
          ...(first ? { first_shot: String(first).replace(/\s+/g, " ").trim().slice(0, 120) } : {}),
        });
      }
      return { storyboard_id: sbId, blocks: out };
    }
    case "get_block": {
      const found = await resolveBlock(input.block, ctx);
      if (!found.block) return found;
      const block = found.block;
      const beats = block.beat_ids?.length
        ? await sbGet(`beats?id=in.(${block.beat_ids.join(",")})` +
                      `&select=id,idx,action,camera,duration_ms,dialogue,meta,scene_id`)
        : [];
      beats.sort((a, b) => block.beat_ids.indexOf(a.id) - block.beat_ids.indexOf(b.id));
      const takes = await sbGet(
        `block_takes?block_id=eq.${block.id}&order=created_at&select=id,kind,state,asset_id,created_at`);
      const params = block.params || {};
      const kind = blockKindOf(block);
      const clipBorn = isClipBornBlock(block);
      return {
        ref: blockLabel(block), block_id: block.id,
        label: kindLabel(kind, block.idx), kind,
        ...(clipBorn ? {
          clip_born: true,
          recipe_prompt: String((params.clip_gen || {}).prompt || "").slice(0, 400),
          note: "This block renders from its stored recipe (an extension, a chain or "
              + "a promoted clip), not from beats: update_beat and rerender_block "
              + "notes do not change it. edit_video changes what it shows; add_block "
              + "adds a real shot beside it.",
        } : {}),
        status: block.status, mode: block.mode, seconds: blockSeconds(block),
        active_take_id: block.active_take_id,
        chained_from: block.chain_from_block_id,
        renders_on: modelKeyOf(params.model_key)
          || projectVideoKey(settings, await catalogFor(ctx))
          || "the worker's default (plain MiniMax H3)",
        loras: params.loras || [],
        shots: beats.map((b) => ({
          beat_id: b.id, ref: shotRef(b.idx), action: b.action, camera: b.camera,
          seconds: (b.duration_ms || 0) / 1000,
          dialogue: (b.dialogue || []).map((d) => ({
            speaker: d.speaker, line: d.line, delivery: d.delivery })),
          has_still: !!((b.meta || {}).still_asset_id || (b.meta || {}).panel_asset_id),
        })),
        references: (block.ref_plan || []).map((e) => ({
          purpose: e.purpose, label: e.label || e.name, role: e.role })),
        takes: takes.map((t, i) => ({
          index: i + 1, take_id: t.id, kind: t.kind, state: t.state, asset_id: t.asset_id,
          active: t.id === block.active_take_id,
        })),
      };
    }
    case "list_takes": {
      const found = await resolveBlock(input.block, ctx);
      if (!found.block) return found;
      const block = found.block;
      const takes = await sbGet(
        `block_takes?block_id=eq.${block.id}&order=created_at&select=id,kind,state,asset_id,created_at`);
      return { block: blockLabel(block), takes: takes.map((t, i) => ({
        index: i + 1, take_id: t.id, kind: t.kind, state: t.state,
        active: t.id === block.active_take_id, made: t.created_at,
      })) };
    }
    case "activate_take": {
      const found = input.block ? await resolveBlock(input.block, ctx) : {};
      let block = found.block ?? null;
      let takeId = input.take_id;
      if (!takeId) {
        if (!block) return found.error ? found : { error: "pass take_id, or block plus index" };
        const takes = await sbGet(
          `block_takes?block_id=eq.${block.id}&order=created_at&select=id`);
        const i = Number(input.index || 0);
        if (!(i >= 1 && i <= takes.length)) {
          return { error: `index ${i} is out of range — this block has ${takes.length} take(s)` };
        }
        takeId = takes[i - 1].id;
      }
      const [row] = await sbGet(`block_takes?id=eq.${takeId}&select=id,block_id`);
      if (!row) return { error: "take not found" };
      if (!block) [block] = await sbGet(`generation_blocks?id=eq.${row.block_id}&select=*`);
      await sbUpd(`block_takes?id=eq.${takeId}`, { state: "kept" });
      await sbUpd(`generation_blocks?id=eq.${row.block_id}`, { active_take_id: takeId });
      // The chain anchor just moved, so every chained block after this one
      // opens on a frame that no longer exists in the cut.
      await sbUpd(`generation_blocks?storyboard_id=eq.${block.storyboard_id}` +
                  `&idx=gt.${block.idx}&chain_from_block_id=not.is.null` +
                  `&status=in.(generated,stale)`, { status: "stale" });
      return { block: blockLabel(block), active_take_id: takeId,
               note: "later chained blocks are now stale — rerender_stale if the joins matter" };
    }
    case "rerender_block": {
      const found = await resolveBlock(input.block, ctx);
      if (!found.block) return found;
      // Chain onto a re-render of the block this one follows, if one is
      // already queued. `rerender_stale` has always done this — "a
      // successor's opening frame is its predecessor's last one" — and this
      // path did not, so redoing a RUN of chained blocks one call at a time
      // (what the director does when asked to redo b5-b8) left four
      // independent jobs. They claim in created_at order today, which is luck
      // rather than design: each block's `<Picture 1>` is its predecessor's
      // ACTIVE take, so one rendering ahead of its predecessor opens on the
      // take that is about to be replaced.
      const dep = found.block.chain_from_block_id
        ? await pendingRerenderFor(found.block.chain_from_block_id, ctx)
        : null;
      // Pictures handed over for THIS shot are staged before the job is
      // written, and they force a recompute — a plan that is not rebuilt is a
      // plan the attachment never reached.
      const refs = await applyUserRefs(found.block, input);
      const args = refs && refs.staged.length ? { ...input, recompute_refs: true } : input;
      const { job, renders_on, instead_of } = await queueRerender(
        found.block, args, ctx, dep ? { dependsOn: [dep] } : {});
      const kind = blockKindOf(found.block);
      const out = { job_id: job.id, block: blockLabel(found.block),
                    label: kindLabel(kind, found.block.idx), kind,
                    activate: input.activate || "replace", renders_on,
                    ...(instead_of ? { instead_of } : {}),
                    shots: await blockShots(found.block),
                    note: "queued at user priority; it renders next. `shots` is "
                        + "the prose it will render — check it says what you "
                        + "meant before moving on." };
      if (isClipBornBlock(found.block)) {
        out.note = "queued. This block is clip-born (an extension, a chain or a "
                 + "promoted clip): it re-renders from its stored recipe, not from "
                 + "beats, so notes and beat edits do not reach it — edit_video or "
                 + "a new add_block are the tools that change what it shows.";
      }
      if (refs) {
        out.references = refs.staged;
        if (refs.not_found.length) out.refs_not_found = refs.not_found;
      }
      if (dep) out.after = "waits for the queued re-render of the block it chains "
                         + "from, so it opens on the NEW final frame";
      return out;
    }
    case "rerender_stale": {
      const sbId = await currentStoryboardId(ctx);
      if (!sbId) return noStoryboard(ctx);
      let blocks = await sbGet(
        `generation_blocks?storyboard_id=eq.${sbId}&status=eq.stale&order=idx&select=*`);
      const scope = String(input.scope || "all").trim();
      if (scope && scope.toLowerCase() !== "all") {
        const hit = await resolveScene(scope, ctx);
        if (!hit.scene) return hit;
        blocks = blocks.filter((b) => (b.scene_ids || []).includes(hit.scene.id));
      }
      if (!blocks.length) {
        return { blocks: [],
                 note: "nothing is stale — everything on screen matches its plan" };
      }
      const listing = blocks.map((b) => ({ ref: blockLabel(b), seconds: blockSeconds(b) }));
      const totalS = listing.reduce((t, x) => t + x.seconds, 0);
      // A dry run by default. This is the one tool that can spend real money at
      // scale, and a model that has just been told "fix it" will otherwise
      // re-render an episode on its own initiative.
      if (!input.confirm) {
        return { dry_run: true, blocks: listing, total_seconds: Number(totalS.toFixed(1)),
                 note: `${listing.length} block(s) would be re-rendered. Show the user ` +
                       `this list and call again with confirm=true only after they agree.` };
      }
      const queued = [];
      let prev = null;
      for (const b of blocks) {
        // Chained blocks must render in order — a successor's opening frame is
        // its predecessor's last one.
        const dep = prev && b.chain_from_block_id ? [prev] : null;
        const { job } = await queueRerender(b, input, ctx, { dependsOn: dep, suffix: " (stale)" });
        queued.push({ ref: blockLabel(b), job_id: job.id });
        prev = job.id;
      }
      return { queued, total_seconds: Number(totalS.toFixed(1)) };
    }
    case "add_block": {
      let after = null;
      if (input.after_block) {
        const found = await resolveBlock(input.after_block, ctx);
        if (!found.block) return found;
        after = found.block;
      }
      let before = null;
      if (input.before_block) {
        const found = await resolveBlock(input.before_block, ctx);
        if (!found.block) return found;
        before = found.block;
      }
      if (after && before) {
        return { error: "give after_block OR before_block, not both" };
      }
      return addBlock(input, ctx, after, before);
    }
    case "generate_clip": {
      const job = await sbIns("jobs", {
        kind: "clip_gen", lane: "gpu", status: "queued",
        priority: USER_PRIORITY, project_id: projectId, episode_id: episodeId || null,
        model_id: "h3-local",
        payload: dropNulls({
          prompt: input.prompt,
          // `?.length`, not the array itself: an empty ref list is no
          // references, and JS would call `[]` truthy and route it to r2v.
          mode: input.mode || (input.ref_asset_ids?.length ? "r2v" : "t2v"),
          model_key: modelKeyOf(input.model_key),
          loras: input.loras,
          ref_asset_ids: input.ref_asset_ids,
          start_asset_id: input.start_asset_id,
          end_asset_id: input.end_asset_id,
          duration_ms: input.duration_ms,
          seed: input.seed,
          project_id: projectId,
          label: `clip · ${String(input.prompt).slice(0, 48)}`,
        }),
      });
      return { job_id: job.id, note: "a standalone clip — it lands in the library" };
    }
    case "generate_music": {
      const key = input.model_key || "minimax-music3";
      const ace = key.startsWith("acestep");
      let target = null;
      if (input.attach) {
        const sbId = await currentStoryboardId(ctx);
        if (!sbId) return { error: "no storyboard to attach a master track to — plan one first" };
        target = { storyboard_id: sbId };
      }
      const job = await sbIns("jobs", {
        kind: "music_gen", lane: "gpu", status: "queued",
        priority: USER_PRIORITY, project_id: ctx.projectId, episode_id: episodeId || null,
        model_id: `${key}-local`,
        payload: dropNulls({
          prompt: input.prompt,
          lyrics: input.lyrics,
          instrumental: input.instrumental,
          duration_ms: input.duration_ms,
          // The model_map key travels verbatim here — unlike video and image,
          // the music rows' catalog ids are their map keys plus "-local", so
          // there is no exception table to route it through.
          model_key: key,
          // Sent only where the model has these inputs. On Music 3 they are
          // payload keys nothing reads, and a bpm there would quietly not be
          // the tempo of the track — the caption is what sets that.
          bpm: ace ? input.bpm : null,
          key_scale: ace ? input.key_scale : null,
          time_signature: ace ? input.time_signature : null,
          seed: input.seed,
          target,
          project_id: ctx.projectId,
          label: `music · ${String(input.prompt).slice(0, 48)}`,
        }),
      });
      return {
        job_id: job.id,
        note: target
          ? "rendering — it becomes the episode's master track when it lands, "
            + "and the storyboard page shows it there"
          : "rendering — it lands in the library",
        ...(!ace && (input.bpm || input.key_scale)
          ? { warning: "MiniMax Music 3 has no BPM or key inputs — put the tempo and "
                       + "key in the caption prose instead. They were dropped." }
          : {}),
      };
    }
    case "edit_video": {
      let block = null;
      if (input.block) {
        const found = await resolveBlock(input.block, ctx);
        if (!found.block) return found;
        block = found.block;
      }
      const job = await sbIns("jobs", {
        kind: "video_edit", lane: "gpu", status: "queued",
        priority: USER_PRIORITY, project_id: projectId, episode_id: episodeId || null,
        model_id: "h3-local",
        payload: dropNulls({
          source_asset_id: input.source_asset_id,
          prompt: input.prompt,
          ref_asset_ids: input.ref_asset_ids,
          seed: input.seed,
          block_id: block ? block.id : null,
          label: `edit · ${String(input.prompt).slice(0, 48)}`,
        }),
      });
      return { job_id: job.id, ...(block ? { block: blockLabel(block) } : {}) };
    }
    case "add_take": {
      const found = await resolveBlock(input.block, ctx);
      if (!found.block) return found;
      const asset = await assetById(input.asset_id);
      if (!asset) return { error: "asset not found" };
      if (asset.kind !== "video") {
        return { error: `a take must be a video — that asset is a ${asset.kind}` };
      }
      const take = await sbIns("block_takes", {
        block_id: found.block.id, asset_id: asset.id, kind: "edit",
        state: input.activate ? "kept" : "pending",
      });
      if (input.activate) {
        await sbUpd(`generation_blocks?id=eq.${found.block.id}`,
                    { active_take_id: take.id, status: "generated" });
      }
      return { take_id: take.id, block: blockLabel(found.block), active: !!input.activate };
    }
    case "set_block_params": {
      const found = await resolveBlock(input.block, ctx);
      if (!found.block) return found;
      const params = { ...(found.block.params || {}) };
      const changed = [];
      if (input.model_key) { params.model_key = modelKeyOf(input.model_key); changed.push("model_key"); }
      if (Array.isArray(input.loras)) { params.loras = input.loras; changed.push("loras"); }
      if (input.steps != null) { params.steps = Number(input.steps); changed.push("steps"); }
      const patch = { params };
      if (input.mode) {
        // A MODE THAT CANNOT RENDER IS REFUSED HERE, NOT AT RENDER TIME.
        // `handle_master_pass` raises on an flf block with no closing frame,
        // and nothing in either director toolset can set one — `ref_plan_for`
        // never emits an `end_frame` entry and only PromptRefsModal's UI does.
        // So "switch it to flf" used to store a mode, report success, queue a
        // render, and fail minutes later on the pod with the block already
        // marked queued. Same for i2v/flf with no opening frame.
        const rp = found.block.ref_plan || [];
        const hasEnd = rp.some((e) => e.purpose === "end_frame" && e.asset_id);
        const hasOpen = Boolean(found.block.chain_from_block_id)
          || rp.some((e) => e.purpose === "start_frame" && e.asset_id);
        if (input.mode === "flf" && !hasEnd) {
          return { error:
            `block ${found.block.idx} has no closing frame, and first-last-frame ` +
            `needs one — the render would fail at generation time, not here. Mark an ` +
            `image as the end frame in the block's prompt & references panel, ` +
            `then set the mode. i2v needs only an opening frame and this block ` +
            (hasOpen ? "has one." : "would need a chain or a start frame too.") };
        }
        if (["i2v", "flf"].includes(input.mode) && !hasOpen) {
          return { error:
            `block ${found.block.idx} is not chained and has no start frame, so ` +
            `${input.mode} has nothing to open on. Chain it to the previous ` +
            `block or mark a start frame first.` };
        }
        patch.mode = input.mode; changed.push("mode");   // a column, not a param
      }
      if (input.seed != null) { patch.seed = Number(input.seed); changed.push("seed"); }
      if (!changed.length) return { error: "nothing to change" };
      await sbUpd(`generation_blocks?id=eq.${found.block.id}`, patch);
      return { block: blockLabel(found.block), changed,
               note: "stored — rerender_block to render with it" };
    }
    case "set_beat_image": {
      const hit = await resolveBeat(input.beat_id, input.scene_id, ctx);
      if (!hit.beat) return hit;
      const beat = hit.beat;
      const asset = await assetById(input.asset_id);
      if (!asset) return { error: "asset not found" };
      const purpose = input.purpose || "look";
      // The two keys are opposite instructions, so writing one must clear the
      // other — a beat that is both "open on this frame" and "follow this look,
      // ignore its framing" is a contradiction the compiler would resolve
      // arbitrarily.
      const { start_frame_asset_id, still_asset_id, ...meta } = beat.meta || {}; // eslint-disable-line no-unused-vars
      meta[purpose === "start_frame" ? "start_frame_asset_id" : "still_asset_id"] = asset.id;
      await sbUpd(`beats?id=eq.${beat.id}`, { meta });
      const [scene] = await sbGet(`scenes?id=eq.${beat.scene_id}&select=storyboard_id`);
      if (scene) {
        await sbUpd(`generation_blocks?storyboard_id=eq.${scene.storyboard_id}` +
                    `&beat_ids=cs.{${beat.id}}&status=in.(planned,generated)`,
                    { status: "stale" }).catch(() => {});
      }
      return { beat_id: beat.id, purpose,
               note: "rerender_block with recompute_refs to stage it" };
    }
    case "list_voices": {
      const rows = input.gender ? VOICES.filter((v) => v.gender === input.gender) : VOICES;
      // Plus this project's own ElevenLabs clones, which are castable voices —
      // `voice_clones.reference_id` on that provider IS an ElevenLabs voice id.
      // A voice the director cannot see is one it can never pass to
      // recast_voice. No gender filter: nothing recorded one.
      const cloned = await sbGet(
        `voice_clones?provider=eq.elevenlabs&status=eq.ready` +
        `&reference_id=not.is.null&select=name,reference_id,project_id`);
      return { voices: [
        ...rows.map((v) => ({ ...v })),
        ...cloned
          .filter((c) => c.reference_id && (c.project_id === projectId || !c.project_id))
          .map((c) => ({ voice_id: c.reference_id, name: c.name || "clone",
                         gender: null, cloned: true, reads_as: [] })),
      ] };
    }
    case "redraw_sheets": {
      // Any KIND — the tool is about an entry, and the two shapes differ only
      // in which roles they read and produce. Props are excluded because
      // `_sheet_refs` has no ranking for them.
      const rows = await sbGet(
        `bible_entries?project_id=eq.${projectId}&kind=in.(character,environment)` +
        `&name=ilike.*${encodeURIComponent(input.entry)}*&select=id,name,kind`);
      if (!rows.length) {
        return { error: `no character or location matching "${input.entry}"` };
      }
      // AMBIGUITY IS A MISS, NOT A GUESS — the rule `match_brief_name` and
      // `resolveScene` already follow. Measured: "Katagiri" matches the
      // CHARACTER Mrs. Katagiri and the LOCATION Katagiri Print, and taking
      // rows[0] redrew a person's plates when a shop was asked for. That is
      // expensive, wrong, and reads as the tool ignoring you. An exact name
      // still resolves; anything else comes back as the list, so the next call
      // is right instead of another guess.
      let match = rows;
      if (rows.length > 1) {
        const exact = rows.filter(
          (r) => (r.name || "").toLowerCase() === input.entry.trim().toLowerCase());
        if (exact.length !== 1) {
          return { error: `"${input.entry}" matches ${rows.length} entries — name one exactly`,
                   candidates: rows.slice(0, 12).map((r) => ({ name: r.name, kind: r.kind })) };
        }
        match = exact;
      }
      const entry = match[0];
      // PRE-FLIGHT, not a second implementation: a coverage take conditions on
      // the plates already on file, so an entry with none raises inside the
      // handler after it has been claimed and staged. Same ranking as
      // `handlers/orbit._sheet_refs`, and the handler still resolves the real
      // set — a disagreement here costs a refusal, not a wrong render.
      const roles = entry.kind === "character"
        ? "face,turnaround,full_body,outfit,side"
        : "master,alt_angle,detail,atmosphere";
      const live = await sbGet(
        `bible_assets?entry_id=eq.${entry.id}&role=in.(${roles})` +
        `&slot=lt.90&select=role`);
      if (!live.length) {
        return { error: `'${entry.name}' has no reference plate to build from — ` +
                        `draw its ${entry.kind === "character" ? "face" : "master"} ` +
                        `plate first, then redraw the set as one take` };
      }
      // Deliberately NOT archiving here. The handler retires what it replaces
      // once the render lands, and it reads live rows only — archiving first
      // would withdraw the very pictures the take is built from.
      const job = await sbIns("jobs", {
        kind: "orbit_sheet", lane: "gpu", status: "queued",
        priority: USER_PRIORITY, project_id: projectId,
        payload: { entry_id: entry.id, sheet_mode: "coverage",
                   ...(input.model_key ? { model_key: input.model_key } : {}),
                   label: `${entry.name.split(" — ")[0].slice(0, 44)} · coverage sheet` },
      });
      return { entry: entry.name, kind: entry.kind, job_id: job.id,
               building_from: [...new Set(live.map((r) => r.role))].sort(),
               renders_on: input.model_key || "minimax-h3-pdd",
               note: "one take, every view; it replaces this entry's plates when " +
                     "it lands and archives the old ones" };
    }
    case "recast_voice": {
      const rows = await sbGet(
        `bible_entries?project_id=eq.${projectId}&kind=eq.character` +
        `&name=ilike.*${encodeURIComponent(input.character)}*&select=id,name,doc,identity_line`);
      if (!rows.length) return { error: `no character matching "${input.character}"` };
      const entry = rows[0];
      let voiceId = input.voice_id;
      if (!voiceId) {
        const all = await sbGet(
          `bible_entries?project_id=eq.${projectId}&kind=eq.character&select=doc`);
        const taken = new Set(all.map((e) => (e.doc || {}).el_voice_id).filter(Boolean));
        taken.delete((entry.doc || {}).el_voice_id);
        voiceId = castVoice(input.requirements || "", taken, entry.identity_line || "");
      }
      // The library voices PLUS this project's ElevenLabs clones — same
      // widening as the worker twin. Without it the guard rejects a cloned
      // voice as "not a voice", which is both wrong and the last place anyone
      // would look: the clone renders perfectly in the studio panel and simply
      // cannot be cast onto a character.
      const known = Object.fromEntries(VOICES.map((v) => [v.voice_id, v.name]));
      for (const c of await sbGet(
        `voice_clones?provider=eq.elevenlabs&status=eq.ready` +
        `&reference_id=not.is.null&select=name,reference_id,project_id`)) {
        if (c.reference_id && (c.project_id === projectId || !c.project_id)) {
          known[c.reference_id] = c.name || "cloned voice";
        }
      }
      if (!(voiceId in known)) return { error: `'${voiceId}' is not a voice — call list_voices` };
      await sbUpd(`bible_entries?id=eq.${entry.id}`,
                  { doc: { ...(entry.doc || {}), el_voice_id: voiceId } });
      // Their recorded lines are keyed by the OLD voice, and the timbre anchor
      // was synthesized in it too. Both have to go, or the render keeps
      // speaking in the voice that was just replaced.
      await sbUpd(`bible_entries?id=eq.${entry.id}`, { voice_ref_asset_id: null });
      const cleared = await clearVoicePins(entry, projectId);
      const job = await sbIns("jobs", {
        kind: "tts", lane: "api", status: "queued",
        priority: USER_PRIORITY, project_id: projectId, episode_id: episodeId || null,
        payload: { text: `This is ${entry.name.split(" — ")[0]}. ` +
                         `${(entry.identity_line || "").slice(0, 160)}`,
                   bible_entry_id: entry.id, label: `${entry.name} · voice ref` },
      });
      return { character: entry.name, voice_id: voiceId, voice_name: known[voiceId],
               voice_ref_job_id: job.id, stale_blocks: cleared,
               note: "their recordings were dropped; rerender_stale to hear it" };
    }
    case "inspect_take": {
      let takeId = input.take_id;
      const assetId = input.asset_id;
      if (!takeId && !assetId) {
        const found = await resolveBlock(input.block, ctx);
        if (!found.block) return found;
        takeId = found.block.active_take_id;
        if (!takeId) return { error: `${blockLabel(found.block)} has no take to look at yet` };
      }
      const job = await sbIns("jobs", {
        kind: "llm_task", lane: "llm", status: "queued",
        priority: USER_PRIORITY, project_id: projectId, episode_id: episodeId || null,
        // `model_id` is load-bearing, not decoration: worker.py only holds the
        // GPU semaphore for an llm-lane job whose model_id starts with
        // "ollama". Without it the judge (18GB) loads beside a render instead
        // of waiting for it — the pool lane runs concurrently with gpu.
        model_id: "ollama-local",
        payload: dropNulls({
          task: "vlm_query", take_id: takeId, asset_id: assetId,
          question: input.question,
          label: `look · ${String(input.question).slice(0, 48)}`,
        }),
      });
      return { job_id: job.id,
               note: "frames are being looked at — call get_job with this id for the answer" };
    }
    case "get_job": {
      const [j] = await sbGet(
        `jobs?id=eq.${input.job_id}` +
        `&select=id,kind,status,progress,progress_note,error_msg,payload,output_asset_id`);
      if (!j) return { error: "job not found" };
      return {
        job_id: j.id, kind: j.kind, status: j.status,
        progress: j.progress, note: j.progress_note,
        ...(j.error_msg ? { error: j.error_msg } : {}),
        ...(j.output_asset_id ? { output_asset_id: j.output_asset_id } : {}),
        ...((j.payload || {}).result ? { result: j.payload.result } : {}),
      };
    }
    case "delete_bible_entry": {
      let entry;
      if (!input.entry_id && !input.name) return { error: "pass entry_id or name" };
      if (!input.entry_id && input.name) {
        const rows = await sbGet(
          `bible_entries?project_id=eq.${projectId}` +
          `&name=ilike.*${encodeURIComponent(input.name)}*&select=id,name,status`);
        if (!rows.length) return { error: `no entry matching "${input.name}"` };
        entry = rows[0];
      } else {
        const rows = await sbGet(`bible_entries?id=eq.${input.entry_id}&select=id,name,status`);
        if (!rows.length) return { error: "entry not found" };
        entry = rows[0];
      }
      if (entry.status !== "draft") {
        return { error: `"${entry.name}" is confirmed canon — scenes reference it. ` +
                        `Only drafts can be deleted here.` };
      }
      await sbDel(`bible_entries?id=eq.${entry.id}`);
      return { deleted: entry.name };
    }
    case "propose_options": {
      const opts = input.options || [];
      if (!(opts.length >= 2 && opts.length <= 3)) return { error: "offer two or three options" };
      const clean = [];
      for (const [i, o] of opts.entries()) {
        if (!o || typeof o !== "object" || !o.tool) {
          return { error: "each option needs a label and a tool to run" };
        }
        if (!TOOL_NAMES.has(o.tool)) return { error: `'${o.tool}' is not a tool` };
        clean.push({ id: `opt${i + 1}`, label: o.label || `Option ${i + 1}`,
                     detail: o.detail ?? null, tool: o.tool, args: o.args || {},
                     preview_asset_id: o.preview_asset_id ?? null });
      }
      // Rendered as buttons; nothing runs until the user picks one. The whole
      // `choice` object rides back in the persisted tool_result, which is what
      // the browser reads to draw them.
      return { choice: { question: input.question, options: clean } };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

export {
  TOOLS, TOOL_NAMES, runTool,
  // The handler in api/director/chat.js still needs these directly — it
  // describes attachments and prices turns with the same label/lookup helpers
  // the tools use, and re-implementing them there is two answers to one
  // question.
  assetById, blockLabel, blockSeconds,
  // Exported for the tests, and re-exported by chat.js so its own suite keeps
  // reaching them: these are the pieces whose failure modes are silent.
  resolveBlock, rerenderPayload, planBlock, castVoice, dialogueMs,
};
