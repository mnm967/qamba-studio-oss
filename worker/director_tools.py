"""Director tools for worker-side chat (local/Ollama and Claude-on-worker).

api/director/chat.js has the same tools for the hosted SSE path. This is the
worker's copy, so the local model can *do* things rather than only describe
them: read project state, propose bible entries, queue renders.

Two rules, and they matter most on a local model, which is smaller and more
willing than a hosted one:

  * Bible writes are proposals. An existing entry gets a bible_revisions draft
    the user confirms in the UI; the model never overwrites confirmed canon.
  * Everything expensive is a queued job, never a direct render. The tool
    returns a job id and the queue stays the single place work is visible and
    cancellable.

Schemas are OpenAI function-calling shape, which is what Ollama's /api/chat
accepts and what the OpenAI-compatible backend needs too.
"""
import json
import random
import re
import urllib.parse

import hosted_image
import sb
from status import log

MAX_ROUNDS = 6          # tool calls per turn before we make it answer


def _fn(name, description, properties, required=()):
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": list(required),
            },
        },
    }


# Twin of REF_ASSET_IDS in director/brief.js — a picture the user attached FOR
# a named brief entry, which the planner then stages as its real reference
# sheet instead of drawing one from prose.
_REF_ASSET_IDS = {
    "type": "array", "items": {"type": "string"},
    "description": "asset ids of pictures the USER attached for this one — copy the id "
                   "out of the [image asset <id>] line above their message. These become "
                   "its actual reference sheets, so nothing is drawn from your description "
                   "of them. Only ever an id the user attached; never invent one.",
}

SCHEMAS = [
    _fn("get_project_state",
        "Read the project: medium, episodes, bible entries, lore documents, "
        "latest storyboard with its blocks, recent jobs and pod state. Call "
        "this first when you need to know what exists.",
        {}),
    _fn("set_lore_timing",
        "Say when a lore fact is true and when the audience learns it. Episodes are "
        "named as they appear ('EP01', 'ep2', '1'). Three cases: an ordinary fact — "
        "give `from` only; a RETCON that was always true and is only revealed later — "
        "give `from` AND a later `revealed`, and the earlier episodes will be written "
        "so the world behaves that way while no character states it; a fact a later "
        "episode undoes ('she doesn't know it's her power yet') — give `until`. "
        "Omit everything, or pass evergreen, for a rule that never changes. Applies "
        "immediately: timing decides which episodes see the fact, it is not story text.",
        {"name": {"type": "string", "description": "the lore entry's name"},
         "from": {"type": "string", "description": "episode it becomes true in"},
         "revealed": {"type": "string",
                      "description": "episode the audience learns it — later than `from` for a retcon"},
         "until": {"type": "string", "description": "episode it STOPS being true in"},
         "evergreen": {"type": "boolean", "description": "true = always true, clears the rest"}},
        ["name"]),
    _fn("search_lore",
        "Search the project's imported lore documents (world bibles, scripts, "
        "notes) and quote what they say. get_project_state lists which "
        "documents exist; this reads inside them. Use it before answering any "
        "question about established canon, and before inventing anything the "
        "documents may already have decided.",
        {"query": {"type": "string",
                   "description": "what you want the lore to tell you, in plain words"},
         "limit": {"type": "integer", "description": "passages to return (default 6, max 12)"}},
        ["query"]),
    _fn("list_storyboard",
        "List scenes and their beats for a storyboard (defaults to the latest). "
        "Pass scene_id to read ONE scene — a whole board is tens of kilobytes of "
        "beat prose, and re-reading it costs a round you could have spent editing.",
        {"storyboard_id": {"type": "string"},
         "scene_id": {"type": "string",
                      "description": 'one scene only — its id, an "S3" ref or its slug'}}),
    _fn("update_bible_entry",
        "Create a character/environment/prop/lore entry, or propose a revision "
        "to an existing one. Existing entries become drafts the user confirms — "
        "you cannot overwrite confirmed canon.",
        {"kind": {"type": "string", "enum": ["character", "environment", "prop", "style", "lore"]},
         "name": {"type": "string"},
         "summary": {"type": "string"},
         "identity_line": {"type": "string",
                           "description": "6-8 concrete visual attributes, repeated verbatim in "
                                          "every shot this entry appears in. Countable details "
                                          "only — hair length and colour, eye colour, marks, "
                                          "named garments. Not mood words."},
         "doc": {"type": "object",
                 "description": "character/environment: appearance, personality, arc, "
                                "wardrobe, voice, palette, layout. LORE: put the prose in "
                                "`body` — that is the field the planner reads and the one "
                                "the Lore tab edits. Merged over the existing doc, so omit "
                                "what you are not changing. Use set_lore_timing for when a "
                                "lore fact is true; do not hand-write `when` here."},
         "change_note": {"type": "string"}},
        ["kind", "name"]),
    _fn("search_assets",
        "Find images/videos/audio in this project's library.",
        {"kind": {"type": "string", "enum": ["image", "video", "audio", "frame", "render"]},
         "tag": {"type": "string"}, "text": {"type": "string"},
         "limit": {"type": "integer"}}),
    _fn("plan_storyboard",
        "Queue a full storyboard plan from a brief: scenes, beats, draft bible "
        "entries, and reference sheets. tier 1 renders automatically, tier 2 "
        "stops for review.",
        {"logline": {"type": "string"}, "notes": {"type": "string"},
         "duration_target_ms": {"type": "integer"},
         "audio_asset_id": {"type": "string"},
         "episode_id": {"type": "string"},
         "tier": {"type": "integer", "enum": [1, 2]}},
        # Matches the hosted schema, which has always demanded all three. The
        # two drifted from the day this file was written, and the stricter
        # side is the right one: tier decides whether the plan renders itself,
        # so leaving it implicit lets a model spend GPU time by omission.
        ["logline", "duration_target_ms", "tier"]),
    _fn("launch_render",
        "Queue every planned block of a storyboard for rendering.",
        {"storyboard_id": {"type": "string"},
         "width": {"type": "integer"}, "height": {"type": "integer"}},
        ["storyboard_id"]),
    _fn("retake_block",
        "Re-roll one block as a new take. The existing take is kept for "
        "comparison; the user chooses.",
        {"block_id": {"type": "string"}, "seed": {"type": "integer"}},
        ["block_id"]),
    _fn("generate_image",
        "Queue an image: a bible reference sheet, or a scene still. Write the prompt "
        "as a still, in this order: subject, then framing and angle, then light with a "
        "named source, then materials and palette, then style. Concrete and physical, "
        "no motion language, no negations — the model cannot subtract. (Mirrors the "
        "image guide in director/prompt_guides.js; a bible sheet is better queued with "
        "a prompt_spec so the worker writes it for the model that runs it.)",
        {"prompt": {"type": "string"},
         "bible_entry_id": {"type": "string"}, "scene_id": {"type": "string"},
         # The sheet slot. These are the values the column accepts, and a place
         # has angles where a person has views — asking for a location's "face"
         # is not a thing.
         "role": {"type": "string",
                  "enum": ["face", "full_body", "side", "outfit",
                           "master", "alt_angle", "detail", "atmosphere", "ref"],
                  "description": "character: face/full_body/side/outfit; "
                                 "location: master/alt_angle/detail/atmosphere"},
         "ref_asset_ids": {"type": "array", "items": {"type": "string"}},
         "width": {"type": "integer"}, "height": {"type": "integer"}},
        ["prompt"]),
    _fn("update_scene",
        "Change one scene of the storyboard: slug, prose, duration (ms), which bible "
        "characters are in it, or where it happens. Editing a scene makes the blocks "
        "covering it stale.",
        {"scene_id": {"type": "string"},
         "slug": {"type": "string", "description": "SHOUTY_SNAKE label"},
         "scene_prompt": {"type": "string"},
         "duration_ms": {"type": "integer"},
         "cast_names": {"type": "array", "items": {"type": "string"},
                        "description": "bible character names; replaces the cast"},
         "environment_name": {"type": "string"}},
        ["scene_id"]),
    _fn("update_beat",
        "Change one beat: action, camera, dialogue, sfx or duration (ms). Beats are what "
        "the H3 compiler reads — concrete and physical. You never write the compiled "
        "prompt format yourself.",
        {"beat_id": {"type": "string"},
         # The handler has always accepted this — `_resolve_beat` needs it to
         # turn a "b2" into a row — and it was never declared, so the model
         # could not send it and the error told it to do the impossible.
         "scene_id": {"type": "string",
                      "description": "the beat's scene, needed when beat_id is a "
                                     "'b2' style ref rather than an id"},
         "action": {"type": "string"},
         "camera": {"type": "string", "description": "type + amplitude + speed, in prose"},
         "duration_ms": {"type": "integer"},
         "sfx": {"type": "string"},
         "cast": {"type": "array", "items": {"type": "string"},
                  "description": "who is VISIBLE in this shot, by name. This is what "
                                 "decides whose character sheets are staged as "
                                 "references, so it is how you take someone OUT of a "
                                 "shot — rewriting the action alone leaves their "
                                 "reference pictures in, and the render follows the "
                                 "pictures. Pass [] for a shot with nobody in it."},
         "dialogue": {"type": "array", "description": "replaces the beat's dialogue; a line may carry offscreen: true — it plays as voice-over while the camera is elsewhere (a listener reaction, an insert) and its speaker stays out of frame",
                      "items": {"type": "object",
                                "properties": {"speaker": {"type": "string"},
                                               "line": {"type": "string"},
                                               "delivery": {"type": "string"}},
                                "required": ["speaker", "line"]}}},
        ["beat_id"]),
    _fn("add_scene",
        "Insert a scene (with its beats) into the storyboard. Use this with update_scene / "
        "delete_scene to change a storyboard that already exists — it happens here. "
        "plan_storyboard is different: it discards this plan and queues a worker job.",
        {"after_scene_id": {"type": "string", "description": "insert after this scene; omit to append"},
         "slug": {"type": "string"},
         "scene_prompt": {"type": "string"},
         "duration_ms": {"type": "integer"},
         "cast_names": {"type": "array", "items": {"type": "string"}},
         "environment_name": {"type": "string"},
         "beats": {"type": "array", "description": "at least one; 2-12s each",
                   "items": {"type": "object",
                             "properties": {"action": {"type": "string"},
                                            "camera": {"type": "string"},
                                            "duration_ms": {"type": "integer"},
                                            "sfx": {"type": "string"},
                                            "dialogue": {"type": "array", "items": {"type": "object"}}},
                             "required": ["action"]}}},
        ["slug", "beats"]),
    _fn("delete_scene",
        "Remove a scene and its beats. The scenes after it close up.",
        {"scene_id": {"type": "string"}},
        ["scene_id"]),
    _fn("add_beat",
        "Add a beat to a scene (2-12s of concrete physical action).",
        {"scene_id": {"type": "string"},
         "after_beat_id": {"type": "string"},
         "action": {"type": "string"},
         "camera": {"type": "string"},
         "duration_ms": {"type": "integer"},
         "sfx": {"type": "string"},
         "dialogue": {"type": "array", "items": {"type": "object"}}},
        ["scene_id", "action"]),
    _fn("delete_beat",
        "Remove a beat. The beats after it close up.",
        {"beat_id": {"type": "string"},
         "scene_id": {"type": "string",
                      "description": "the beat's scene, needed when beat_id is a "
                                     "'b2' style ref rather than an id"}},
        ["beat_id"]),
    _fn("redraw_panels",
        # NOTHING MARKS A PANEL STALE, so the description has to say it. Editing
        # a beat marks the covering BLOCK stale and update_beat reports that;
        # the panel drawn from the same beat keeps showing the old shot with
        # nothing on screen or in any row to say it is out of date, and a model
        # that cannot see the staleness will not think to redraw.
        "Re-draw the storyboard panels — the pictures on the scene card — from "
        "the beats as they stand NOW. Call this after you change a scene's "
        "shots: panels are drawn once and nothing marks them stale, so until "
        "you redraw them they still show the shots the scene used to have. One "
        "scene by default. Omit scene_id to redraw the whole board, which needs "
        "confirm:true because it is one render per shot.",
        {"scene_id": {"type": "string",
                      "description": "the scene_id from the listing, or how it is labelled "
                                     "on screen: \"S3\" or its slug. Omit for the whole board."},
         "beat_ids": {"type": "array", "items": {"type": "string"},
                      "description": "redraw only these shots — beat_ids, or \"b2\" labels "
                                     "when scene_id is set. Omit for every shot in the scene."},
         "model_key": {"type": "string",
                       "description": "override the image model; defaults to the one the "
                                      "project's reference sheets were drawn with"},
         "confirm": {"type": "boolean",
                     "description": "required to redraw the WHOLE board — call once without "
                                    "it to see how many panels that is"}},
        []),
    _fn("add_outfit_variant",
        "Create an outfit variant of an existing character: the SAME face and "
        "body (the parent's face sheet stays the identity anchor), new "
        "wardrobe. Optionally recast scenes to wear it. Use for 'her in the "
        "gala dress for scene 4' instead of inventing a second character.",
        {"character": {"type": "string", "description": "existing bible character name"},
         "outfit_name": {"type": "string", "description": "e.g. 'Gala Dress'"},
         "outfit_look": {"type": "string",
                         "description": "exact pieces with colors and materials"},
         "scenes": {"type": "array", "items": {"type": "string"},
                    "description": "scene refs (id / S3 / slug) that should cast "
                                   "this outfit instead of the base look"}},
        ["character", "outfit_name", "outfit_look"]),
    _fn("list_timelines",
        "The CUTS of an episode — an episode holds several timelines of the same "
        "blocks at different lengths. Returns each one's id, name, clip count and "
        "length. The cut on the user's screen is named in the context block; use "
        "this to see the others, or to get an id for render_timeline.",
        {"episode_id": {"type": "string",
                        "description": "defaults to the open episode"}},
        []),
    _fn("render_timeline",
        "Queue the ffmpeg render of one CUT into a final video. `timeline_id` is a "
        "specific cut, not 'the episode's timeline' — take it from the context "
        "block (the cut on screen) or from list_timelines. Rendering the wrong cut "
        "spends the same time on a film nobody is looking at.",
        {"timeline_id": {"type": "string"}},
        ["timeline_id"]),
    _fn("note_brief",
        "Write down what you have established in the brief interview. Send only "
        "what is new or changed — it merges into the brief the user sees. Call "
        "this every turn where anything was settled.",
        {"title": {"type": "string"},
         "logline": {"type": "string", "description": "one sentence: who wants what, against what, where"},
         "premise": {"type": "string"},
         "turn": {"type": "string", "description": "the emotional turn — where it flips, who loses what"},
         "ending": {"type": "string"},
         "tone": {"type": "string"},
         "palette": {"type": "string", "description": "named colours and light sources"},
         "audience": {"type": "string"},
         "cast": {"type": "array", "description": "characters: name + role + look + want",
                  "items": {"type": "object",
                            "properties": {"name": {"type": "string"},
                                           "previous_name": {"type": "string",
                                                             "description": "old name when renaming"},
                                           "role": {"type": "string"},
                                           "look": {"type": "string"},
                                           "want": {"type": "string"},
                                           "ref_asset_ids": _REF_ASSET_IDS},
                            "required": ["name"]}},
         "world": {"type": "array", "description": "locations: name + look + when",
                   "items": {"type": "object",
                             "properties": {"name": {"type": "string"},
                                            "previous_name": {"type": "string"},
                                            "look": {"type": "string"},
                                            "when": {"type": "string"},
                                            "ref_asset_ids": _REF_ASSET_IDS},
                             "required": ["name"]}},
         "props": {"type": "array", "description": "objects the story turns on",
                   "items": {"type": "object",
                             "properties": {"name": {"type": "string"},
                                            "previous_name": {"type": "string"},
                                            "look": {"type": "string"},
                                            "why": {"type": "string"},
                                            "ref_asset_ids": _REF_ASSET_IDS},
                             "required": ["name"]}},
         "remove": {"type": "object",
                    "description": "drop entries the user vetoed, by name: "
                                   "{cast: [], world: [], props: [], references: [], …}"},
         "motifs": {"type": "array", "items": {"type": "string"}},
         "references": {"type": "array", "items": {"type": "string"}},
         "constraints": {"type": "array", "items": {"type": "string"}},
         "open_questions": {"type": "array", "items": {"type": "string"},
                            "description": "gaps still to fill, as 2-6 word stubs "
                                           "(\"tone: action or dread\") — never the sentence "
                                           "you just asked"},
         "resolved_questions": {"type": "array", "items": {"type": "string"}},
         # Anything the studio will MAKE has to be storable here or the
         # interview is theatre: merge_brief is a whitelist, so a lyric sheet
         # written down before this field existed was silently dropped while
         # the tool call ticked green. Twin of `song` in director/brief.js.
         "song": {"type": "object",
                  "description": "the track, when the piece has an original one. The "
                                 "studio renders it with the episode — write it down "
                                 "here rather than saying you cannot make audio.",
                  "properties": {"lyrics": {"type": "string",
                                            "description": "the words, with [Verse]/[Chorus] "
                                                           "section tags"},
                                 "style": {"type": "string",
                                           "description": "genre, tempo, instruments, the "
                                                          "vocal, the production"},
                                 "instrumental": {"type": "boolean"},
                                 "length_s": {"type": "integer"},
                                 "bpm": {"type": "integer"}}},
         "shape": {"type": "object",
                   "properties": {"length_s": {"type": "integer"},
                                  "structure": {"type": "string"},
                                  "sections": {"type": "array", "items": {"type": "string"}}}},
         "expert_notes": {"type": "object",
                          "description": "one decision per expert: writing / directing / vfx / "
                                         "costume / choreo"},
         "ready": {"type": "boolean",
                   "description": "true once premise, turn, a described cast member, a location "
                                  "and a look are settled"}},
        []),

    # ---------------------------------------------------------- editing ----
    # Everything below exists so an episode can be finished in conversation.
    # Before them the chat could rewrite a scene and then only mark the block
    # `stale` — a status nothing in the worker reads — so every edit ended by
    # telling the user to go and click something.
    _fn("list_blocks",
        "List the render blocks of a storyboard: index, scenes covered, time "
        "range, status, mode, whether a take is active, and the latest review "
        "verdict. Use this to find which block covers the moment being talked "
        "about. Blocks are addressed as 'b3' (their index) or by id.",
        {"storyboard_id": {"type": "string"}}),
    _fn("get_block",
        "Everything about one block: its beats with action, camera and "
        "dialogue, the model and LoRAs it renders on, what references are "
        "staged, and its takes with review scores. Read this before changing a "
        "block so you know what is already there.",
        {"block": {"type": "string", "description": "'b3', or a block id"}},
        ["block"]),
    _fn("list_takes",
        "The takes of one block — which is active, when each was made, and how "
        "its review scored.",
        {"block": {"type": "string"}},
        ["block"]),
    _fn("rerender_block",
        "Re-render one block and, by default, make the result the version that "
        "plays. This is the tool for 'do that shot again', and for making an "
        "edit visible after update_beat / update_scene / a costume change — "
        "those change the plan, this changes the picture.\n"
        "activate: 'replace' (default) swaps the new take in, keeping the old "
        "ones in history; 'review' leaves it side by side for the user to pick.\n"
        "notes is a free-text director's adjustment ('more urgency', 'hold the "
        "camera still') appended to the compiled prompt — never write H3 prompt "
        "format yourself.\n"
        "recompute_refs (default true) restages the character, location and "
        "prop sheets. Leave it on after any casting, costume or artwork change, "
        "or the render still uses the old pictures.\n"
        "ref_asset_ids: pictures the user handed you for THIS shot (the ids in "
        "the [image asset …] lines of their message). They are staged as look "
        "references — the render follows their rendering, not their framing. "
        "start_frame_asset_id makes the shot OPEN on that exact picture instead. "
        "A picture the user attached and you did not pass here is a picture the "
        "render never sees.",
        {"block": {"type": "string"},
         "notes": {"type": "string"},
         "model_key": {"type": "string",
                       "description": "render this block on a different checkpoint, e.g. "
                                      "'minimax-h3-turbo'. Omit to keep the episode's."},
         "loras": {"type": "array", "description": "LoRA picks, e.g. [{key, strength}]",
                   "items": {"type": "object"}},
         "mode": {"type": "string", "enum": ["r2v", "i2v", "flf", "t2v"]},
         "seed": {"type": "integer"},
         "recompute_refs": {"type": "boolean"},
         "activate": {"type": "string", "enum": ["replace", "review"]},
         "ref_asset_ids": {"type": "array", "items": {"type": "string"},
                           "description": "asset ids to stage as look references for this shot"},
         "start_frame_asset_id": {"type": "string",
                                  "description": "asset id the shot opens on exactly"}},
        ["block"]),
    _fn("rerender_stale",
        "Re-render every block marked stale — the ones whose plan changed since "
        "they were last rendered. Returns the list and the cost WITHOUT queuing "
        "anything unless confirm is true. Always show the user that list and "
        "get a yes before confirming, because this spends GPU time per block.",
        {"scope": {"type": "string",
                   "description": "'all', or a scene ref like 'S2' to limit it to that scene"},
         "confirm": {"type": "boolean", "description": "false/absent = dry run"},
         "model_key": {"type": "string"},
         "notes": {"type": "string"}},
        []),
    _fn("activate_take",
        "Make one take the version that plays. Use after list_takes when the "
        "user picks ('use take 2').",
        {"block": {"type": "string"},
         "take_id": {"type": "string"},
         "index": {"type": "integer", "description": "1-based, as list_takes numbers them"}},
        []),
    _fn("add_block",
        "Add a new shot at the end of the storyboard, or after a given block. "
        "Use for 'add a shot where…' and for continuing a scene. When chain is "
        "true the new block opens on the previous block's last frame, so the "
        "action continues instead of restarting — that needs the previous block "
        "to have rendered.\n"
        "The shot is added INTO the scene of the block it follows (as that "
        "scene's next shot) unless new_scene is true or environment names a "
        "different location. Name EVERY character in the shot in cast — the "
        "render stages the sheets of the people named, and a character left "
        "out is drawn from prose as a stranger. What anyone SAYS goes in "
        "dialogue, in this same call — the shot is lengthened to fit the lines "
        "and the render is queued after they are written, so they reach the "
        "first take. ref_asset_ids stages pictures "
        "the user handed you as look references; start_frame_asset_id makes the "
        "shot open on one exactly.",
        {"action": {"type": "string", "description": "what happens in the shot, in prose"},
         "after_block": {"type": "string", "description": "'b6', or a block id. Default: the end."},
         "before_block": {"type": "string",
                          "description": "'b1', or a block id — insert IN FRONT of "
                                         "it. Use this for 'add a shot before block "
                                         "1' / 'a new opening'; after_block cannot "
                                         "express position 0."},
         "camera": {"type": "string"},
         "duration_ms": {"type": "integer", "description": "default 6000; snapped to H3's frame grid"},
         "chain": {"type": "boolean", "description": "default true"},
         "cast": {"type": "array", "items": {"type": "string"},
                  "description": "bible character names in this shot. Defaults to "
                                 "the neighbouring shot's cast."},
         # A LINE IS NOT PROSE. Before this existed the only way to give a new
         # shot dialogue was to write it into `action` — which reaches H3 as
         # description rather than through the compiler's vocal grammar, so no
         # recording is staged, no line is bound to a mouth, and nothing
         # measures whether it fits the shot. The two-step (add_block, then
         # update_beat) was worse than it looked: this tool queues the render
         # before the second call can land, and update_beat only marks the
         # block `stale`, which nothing in the worker reads.
         "dialogue": {"type": "array",
                      "description": "what is SPOKEN in this shot, in order. The "
                                     "shot is lengthened if the lines need longer "
                                     "than it, and each speaker is added to the "
                                     "cast so their sheet is staged. A line may "
                                     "carry offscreen: true — it plays as "
                                     "voice-over while the camera is elsewhere, "
                                     "and its speaker is NOT staged.",
                      "items": {"type": "object",
                                "properties": {"speaker": {"type": "string"},
                                               "line": {"type": "string"},
                                               "delivery": {"type": "string"}},
                                "required": ["speaker", "line"]}},
         "environment": {"type": "string",
                         "description": "bible location name. Defaults to the "
                                        "neighbouring shot's location."},
         "ref_asset_ids": {"type": "array", "items": {"type": "string"},
                           "description": "asset ids to stage as look references for this shot"},
         "start_frame_asset_id": {"type": "string",
                                  "description": "asset id the shot opens on exactly"},
         "new_scene": {"type": "boolean",
                       "description": "start a new scene for this shot instead of adding "
                                      "it to the neighbouring one (default false)"},
         "slug": {"type": "string", "description": "the new scene's name, when new_scene is true"},
         "mode": {"type": "string", "enum": ["r2v", "i2v", "flf", "t2v"]},
         "model_key": {"type": "string"},
         "render": {"type": "boolean", "description": "queue the render now (default true)"}},
        ["action"]),
    _fn("generate_clip",
        "Render a standalone clip that is not part of the storyboard — an idea, "
        "an insert, something to look at. Does not touch the episode.",
        {"prompt": {"type": "string"},
         "mode": {"type": "string", "enum": ["t2v", "i2v", "flf", "r2v"]},
         "ref_asset_ids": {"type": "array", "items": {"type": "string"}},
         "start_asset_id": {"type": "string"},
         "end_asset_id": {"type": "string"},
         "model_key": {"type": "string"},
         "loras": {"type": "array", "items": {"type": "object"}},
         "duration_ms": {"type": "integer"},
         "seed": {"type": "integer"}},
        ["prompt"]),
    _fn("generate_music",
        "Generate a music track: a song with sung lyrics, or an instrumental "
        "bed. Set `attach` to make it the episode's MASTER TRACK — on a music "
        "video that is what the whole render locks to (blocks get cut to its "
        "beats and each block is given its slice of the audio), so a track "
        "that replaces one the blocks were already cut against marks them "
        "stale. Two models: minimax-music3 (default) sings written lyrics "
        "almost verbatim and takes a descriptive CAPTION — genre and tempo, "
        "then the voice, then the arrangement; acestep-1.5 is ~4x faster, "
        "better for beds, and takes comma-separated TAGS with bpm/key/time "
        "signature as separate arguments.",
        {"prompt": {"type": "string", "description": "caption (music3) or tags (acestep)"},
         "lyrics": {"type": "string",
                    "description": "what the voice sings, with [Verse]/[Chorus] "
                                   "section tags. Leave empty for an instrumental."},
         "instrumental": {"type": "boolean", "description": "no vocals"},
         "duration_ms": {"type": "integer",
                         "description": "up to 360000 on music3, 300000 on acestep"},
         "model_key": {"type": "string",
                       "enum": ["minimax-music3", "acestep-1.5", "acestep-1.5-xl",
                                "acestep-1.5-xl-sft"]},
         "bpm": {"type": "integer",
                 "description": "acestep only; also becomes the beat grid when attached"},
         "key_scale": {"type": "string", "description": "acestep only, e.g. 'A minor'"},
         "time_signature": {"type": "string", "enum": ["2", "3", "4", "6"],
                            "description": "acestep only"},
         "attach": {"type": "boolean",
                    "description": "make it this episode's master track (music videos lock to it)"},
         "seed": {"type": "integer"}},
        ["prompt"]),
    _fn("edit_video",
        "Change ONE thing about a take that already exists and keep everything "
        "else. The clip becomes the model's video reference and the render is "
        "told its framing, camera, timing, subjects and sound are preserved "
        "except where the instruction applies — so this is the tool for "
        "'replace the photo she is holding', 'make her coat red', 'same shot "
        "but at night'. Reach for it INSTEAD OF rerender_block whenever the "
        "user is pointing at footage that exists and asking for a difference: a "
        "re-render composes the shot again from its plan and moves everything.\n"
        "source_asset_id is the take's own asset id — get_block returns one "
        "per take; use the active one unless they named another. Pass block "
        "too or the result lands only in the library.\n"
        "prompt is the CHANGE and nothing else: one difference, stated "
        "positively and concretely. Do not describe what stays — the envelope "
        "has already declared it held, and restating it invites the model to "
        "decide it again. Do not write what to REMOVE either; the model adds "
        "what it is told and cannot subtract, so 'no glove' renders a glove. "
        "Name what takes its place.\n"
        "ref_asset_ids become Picture 1, Picture 2 in the order you pass them, "
        "and the prompt must name the one it means or the render ignores it. A "
        "Picture N with no picture behind it is refused before it renders.",
        {"source_asset_id": {"type": "string"},
         "prompt": {"type": "string"},
         "ref_asset_ids": {"type": "array", "items": {"type": "string"}},
         "block": {"type": "string", "description": "attach the result to this block as a take"},
         "seed": {"type": "integer"}},
        ["source_asset_id", "prompt"]),
    _fn("add_take",
        "Attach an existing video asset to a block as a take — for a clip the "
        "user uploaded or generated separately.",
        {"block": {"type": "string"},
         "asset_id": {"type": "string"},
         "activate": {"type": "boolean"}},
        ["block", "asset_id"]),
    _fn("set_block_params",
        "Change how a block renders WITHOUT rendering it: model, LoRA stack, "
        "mode or seed. Follow with rerender_block to see it.",
        {"block": {"type": "string"},
         "model_key": {"type": "string"},
         "loras": {"type": "array", "items": {"type": "object"}},
         "mode": {"type": "string", "enum": ["r2v", "i2v", "flf", "t2v"]},
         "seed": {"type": "integer"},
         "steps": {"type": "integer"}},
        ["block"]),
    _fn("set_beat_image",
        "Pin a picture to a shot. purpose 'start_frame' means the shot OPENS on "
        "this exact image (only the first shot of a block can); 'look' means "
        "follow its rendering but not its framing. Use this when the user hands "
        "you an image and says where it goes.",
        {"beat_id": {"type": "string"},
         "scene_id": {"type": "string", "description": "needed when beat_id is a 'b2' style ref"},
         "asset_id": {"type": "string"},
         "purpose": {"type": "string", "enum": ["start_frame", "look"]}},
        ["beat_id", "asset_id"]),
    _fn("list_voices",
        "The speaking voices available for casting, with the qualities each one "
        "reads as. Use before recast_voice so you can name a real one.",
        {"gender": {"type": "string", "enum": ["f", "m"]}}),
    _fn("recast_voice",
        "Give a character a different speaking voice. Pass voice_id from "
        "list_voices, or describe what you want and the nearest is cast. Their "
        "existing recordings are dropped and re-made on the next render.",
        {"character": {"type": "string"},
         "voice_id": {"type": "string"},
         "requirements": {"type": "string",
                          "description": "e.g. 'deeper, older, unhurried' — used when no voice_id"}},
        ["character"]),
    _fn("redraw_sheets",
        "Redraw a character's or location's reference sheets as ONE H3 take, so "
        "every view is the same shot and cannot disagree with itself. Use for "
        "'redraw Eli's sheets', 'his turnaround is off', 'the four plates of the "
        "shop are all the same angle'. It BUILDS ON the plates already on file "
        "and replaces them when it lands, so it needs at least one to exist. "
        "Characters get 6 views plus a turnaround contact sheet; locations get "
        "8 views filling master, alt_angle, atmosphere and detail, plus a "
        "coverage contact sheet carrying every placement in one grid — which "
        "is what a video block then stages as its picture of the place.",
        {"entry": {"type": "string", "description": "character or location name"},
         "model_key": {"type": "string",
                       "description": "video model, default minimax-h3-pdd"}},
        ["entry"]),
    _fn("inspect_take",
        "Ask a question about what is really ON SCREEN in a rendered clip — "
        "'is she wearing the hat?', 'do they touch?'. Frames are sampled and "
        "looked at. Use it to CHECK an edit landed instead of assuming. The "
        "answer arrives on a job: call get_job with the id it returns.",
        {"block": {"type": "string", "description": "inspects the block's active take"},
         "take_id": {"type": "string"},
         "asset_id": {"type": "string"},
         "question": {"type": "string"}},
        ["question"]),
    _fn("get_job",
        "Status and result of a queued job — progress, failure reason, or the "
        "answer from inspect_take.",
        {"job_id": {"type": "string"}},
        ["job_id"]),
    _fn("delete_bible_entry",
        "Delete a DRAFT bible entry. Confirmed canon is referenced by scenes "
        "and cannot be deleted here.",
        {"entry_id": {"type": "string"}, "name": {"type": "string"}},
        []),
    _fn("propose_options",
        "Offer the user two or three choices to pick between, as buttons. Use "
        "when a request has real alternatives — two costume directions, two "
        "voices — instead of choosing for them. Each option names a tool to run "
        "when picked. This queues nothing by itself.",
        {"question": {"type": "string"},
         "options": {"type": "array",
                     "description": "2-3 of {label, detail?, tool, args, preview_asset_id?}",
                     "items": {"type": "object"}}},
        ["question", "options"]),
]

TOOL_NAMES = {s["function"]["name"] for s in SCHEMAS}


_BRIEF_STR = ("title", "logline", "premise", "turn", "tone", "palette", "audience", "ending")
_BRIEF_LIST = ("motifs", "references", "constraints", "open_questions")
_BRIEF_NAMED = {"cast": ("role", "look", "want"), "world": ("look", "when"), "props": ("look", "why")}
# The one list-valued field a named record carries: asset ids of pictures the
# user attached FOR this entry. It unions rather than overwrites — "here's her
# face" and "here's her coat" on two turns are two sheets, not a correction.
_BRIEF_NAMED_LISTS = ("ref_asset_ids",)
# Unanchored, unlike `_UUID_RE` further down (which asks "is this whole string
# an id?"): here the id has to be dug OUT of whatever the model wrapped it in.
_ASSET_ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_EXPERT_IDS = ("writing", "directing", "vfx", "costume", "choreo")


def attachment_lines(blocks):
    """Render a chat_messages row's attachment blocks as text.

    Twin of `replayAttachmentLines` in api/director/_attachments.js, and the
    only channel this path has: `llm.complete` is text, so a local turn cannot
    be shown a picture at all. What it CAN be given is the id — which is what
    `note_brief`'s `ref_asset_ids` takes and what every tool takes — so the
    line names it and says plainly that the picture itself is not visible.
    Rendering nothing (which is what this path did) meant a user attaching a
    ref sheet on the local backend got a director that had not been told an
    attachment existed.
    """
    out = []
    for a in blocks or []:
        if not isinstance(a, dict):
            continue
        if a.get("type") == "block_ref":
            out.append(f"[block {a.get('label') or a.get('block_id')}]")
        elif a.get("type") == "asset_ref":
            if a.get("text_content"):
                out.append(f"--- Attached Document: \"{a.get('label') or 'document'}\" ---\n"
                           f"{a['text_content']}\n--- End of Document ---")
                continue
            facts = " · ".join(str(x) for x in (
                a.get("label"),
                f"{a['width']}x{a['height']}" if a.get("width") and a.get("height") else None,
            ) if x)
            media = a.get("media") or "file"
            line = f"[{media} asset {a.get('asset_id')}{f' — {facts}' if facts else ''}]"
            if media == "image":
                line += " (not viewable on this backend — go by what the user says about it)"
            out.append(line)
    return out


def _clean(v):
    return v.strip() if isinstance(v, str) else ""


def _asset_ids(raw):
    """Asset ids out of whatever the model sent.

    Loose enough to catch the shapes models actually produce (a bare string
    instead of a list, an `asset:<uuid>` form), strict enough that a label or
    a filename never reaches the planner as an id. Twin of `assetIds` in
    director/brief.js.
    """
    items = raw if isinstance(raw, list) else ([raw] if raw else [])
    out = []
    for v in items:
        hit = _ASSET_ID_RE.search(v) if isinstance(v, str) else None
        if hit and hit.group(0).lower() not in out:
            out.append(hit.group(0).lower())
    return out


def _uniq(items):
    seen, out = set(), []
    for raw in items:
        s = _clean(raw)
        if s and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out


_QUESTION_MAX_CHARS = 60
_QUESTION_MAX_WORDS = 9


def _is_question_stub(q):
    return (bool(q) and len(q) <= _QUESTION_MAX_CHARS
            and len(q.split()) <= _QUESTION_MAX_WORDS
            and len(re.findall(r"[.!?](?:\s|$)", q)) < 2)


MAX_OPEN_QUESTIONS = 12


def _tidy_questions(items):
    """Open questions are gaps, not transcript — and a WORKING SET, not a log.

    Models hand back the whole thing they just asked, and the panel then
    repeats the line sitting an inch above it. A gap is a few words
    ("tone: action or dread"); anything sentence-shaped is the question itself.

    Nothing ever retired them either: the model adds a gap most turns and sends
    resolved_questions almost never, so a real interview reached SEVENTY, every
    one of them since answered — and `briefToPlan` hands the list to the
    planner as "decide these yourself, consistently". Text dedupe barely dents
    it (measured 70 -> 63; the rewordings are genuinely different), so the cap
    does the work and newest wins. Twin of `tidyQuestions` in director/brief.js.
    """
    stubs = [q for q in (" ".join(_clean(raw).split()) for raw in items or [])
             if _is_question_stub(q)]
    by_key = {}
    for q in stubs:                       # last phrasing wins
        by_key[_name_key(q) or q.lower()] = q
    return list(by_key.values())[-MAX_OPEN_QUESTIONS:]


_NOISE_WORDS = {"the", "a", "an", "of", "s"}


def _name_key(s):
    """A name reduced to what it is actually naming: lower case, no possessives,
    no articles, singular. Twin of `nameKey` in director/brief.js."""
    words = re.split(r"[^a-z0-9]+", re.sub(r"[’']s\b", " ", (s or "").lower()))
    out = []
    for w in words:
        if not w or w in _NOISE_WORDS:
            continue
        out.append(w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w)
    return " ".join(out)


_LOOK_WORDS = 12
_LOOK_MIN = 6           # too short to be evidence of anything

# How alike two entries must be before they are reported as one thing — and it
# is NOT the same question for people as for places. Measured across a real
# 20-entry brief: on raw text `Rei` and `Villian Rei` (two deliberate entries)
# scored 0.60 on their looks, exactly what the genuine location duplicate
# `Astronaut Capture Site` / `Astronaut Capture Environment` scored, so no
# single threshold separated them. `_common_words` is the better half of the
# answer; this table is the backstop for what it cannot see — it needs three
# entries to call anything common, so a cast of two is unprotected by it, and
# this app's cast is full of deliberate near-twins (outfit variants are their
# own character entries by design). Twin of DUPE_RULES in director/brief.js.
_DUPE_RULES = {
    "cast": (1.01, 1.01, 0.9),        # name, look, look-alone: verbatim only
    "default": (0.5, 0.3, 0.7),
}


def _look_words(x):
    """The opening of a description as a bag of words — how duplicates sharing
    no name tokens get caught. A SET compared by overlap, not a string compared
    for equality: the real pair differed only by an inserted "that" and a
    different closing clause, which a prefix comparison scores as unrelated."""
    text = str((x or {}).get("look") or "").split(".")[0].split(";")[0]
    return set(_name_key(text).split()[:_LOOK_WORDS])


def _jaccard(a, b):
    shared = len(a & b)
    union = len(a) + len(b) - shared
    return shared / union if union else 0.0


def _common_words(items):
    """Words this list uses for EVERYTHING, which therefore say nothing about
    whether two of its entries are the same thing.

    Models write a stock opener — "Reference authority: short black bob with one
    turquoise front streak, pale gray eyes, black…" in front of every character
    — and a bag-of-words comparison then scores an entire cast at 1.0. Dropping
    what half the list shares leaves exactly the distinctive part: the hoodie,
    the armour, the layered coat.

    Half the list, but never fewer than THREE entries: two duplicates among
    three share their words in 2 of 3, and dropping those would hide exactly
    what is being looked for. Twin of `commonWords` in director/brief.js.
    """
    seen = {}
    for it in items:
        for w in _look_words(it):
            seen[w] = seen.get(w, 0) + 1
    floor = max(3, -(-len(items) // 2))
    return {w for w, n in seen.items() if n >= floor}


def _looks_like_one(a, b, rule, common):
    al = _look_words(a) - common
    bl = _look_words(b) - common
    if len(al) < _LOOK_MIN or len(bl) < _LOOK_MIN:
        return False
    name_min, look_min, look_alone = rule
    lj = _jaccard(al, bl)
    if lj >= look_alone:
        return True
    nj = _jaccard(set(_name_key(a.get("name")).split()),
                  set(_name_key(b.get("name")).split()))
    return nj >= name_min and lj >= look_min


# Connectives and intensifiers a stub uses without saying anything about WHAT
# it asks. Kept apart from _NOISE_WORDS deliberately: that set feeds _name_key,
# which decides whether two CAST ENTRIES are one person, and widening it there
# so "tone & palette" matches "tone and palette" would also merge "Salt and
# Pepper" into "Salt Pepper". Twin of Q_NOISE in director/brief.js.
_Q_NOISE = {"and", "or", "for", "to", "in", "on", "with", "its", "their",
            "exact", "concrete", "full", "specific", "what", "which"}


def _question_tokens(q):
    return {w for w in _name_key(q).split(" ") if w and w not in _Q_NOISE}


_Q_SAME = 0.6


def _same_question(a, b):
    """Two phrasings of one gap. resolved_questions is documented as "exact
    text" and models paraphrase anyway — measured, "tone & palette" failed to
    retire "tone and palette" and the gap stayed open for the rest of the
    interview. Twin of `sameQuestion` in director/brief.js."""
    A, B = _question_tokens(a), _question_tokens(b)
    if not A or not B:
        return False
    shared = len(A & B)
    return shared / (len(A) + len(B) - shared) >= _Q_SAME


# Words that make a stub a question about how something LOOKS, so the thing it
# names having a `look` IS the answer to it.
_LOOK_ASKED = {"look", "design", "identity", "visual", "appearance", "silhouette",
               "outfit", "wardrobe", "costume", "sheet", "reference"}

# A stub that names a PART OF THE BRIEF, and the test that part is now filled.
# Deliberately narrow. "look" is NOT a tone word here: "hideout look" asks about
# the hideout, and retiring it because `tone` is set would drop a real gap.
# "who" is not a cast word for the same reason. Twin of ANSWERED_BY.
_ANSWERED_BY = (
    (("location", "where", "setting", "environment", "place", "world"),
     lambda b: any(_clean((w or {}).get("name")) for w in (b.get("world") or []))),
    (("tone", "palette", "mood", "grade"),
     lambda b: bool(_clean(b.get("tone")) or _clean(b.get("palette")))),
    (("ending", "end", "outro", "finale"), lambda b: bool(_clean(b.get("ending")))),
    (("turn",), lambda b: bool(_clean(b.get("turn")))),
    (("premise", "story", "logline"),
     lambda b: bool(_clean(b.get("logline")) or _clean(b.get("premise")))),
    (("title",), lambda b: bool(_clean(b.get("title")))),
    (("audience",), lambda b: bool(_clean(b.get("audience")))),
    (("length", "duration", "shape", "structure", "section"),
     lambda b: bool((b.get("shape") or {}).get("length_s")
                    or _clean((b.get("shape") or {}).get("structure"))
                    or (b.get("shape") or {}).get("sections"))),
    (("cast", "crew", "character", "protagonist", "hero", "heroine", "lead"),
     lambda b: any(_clean((c or {}).get("name")) and _clean((c or {}).get("look"))
                   for c in (b.get("cast") or []))),
    (("song", "track", "lyric", "music"),
     lambda b: bool(_clean((b.get("song") or {}).get("lyrics"))
                    or _clean((b.get("song") or {}).get("style")))),
)


def answered_questions(brief):
    """Open questions the brief now ANSWERS, retired with no model involved.

    resolved_questions was the only way a gap ever closed and the model sends
    it almost never, so the list only grew — and brief_to_plan hands it to the
    planner as "decide these yourself, consistently". Measured on a real
    interview: twelve open questions of which EIGHT were answered in the same
    document, including "primary location" beside six locations. The planner
    was being told to invent what the brief states three lines above.

    Two rules, both exact: NAMED (the stub asks how something looks and every
    roster entry it names now has a `look`) and FIELD (the stub names a part of
    the brief that is filled). A question about the look of something that HAS
    one retires even when it asks for more precision ("Rei exact continuity
    look") — that is the point rather than a wrinkle, since five phrasings of
    that one question is how the seventy-item list was built.

    Twin of `answeredQuestions` in director/brief.js.
    """
    b = brief or {}
    open_qs = b.get("open_questions") or []
    if not open_qs:
        return []
    roster = [x for x in (*(b.get("cast") or []), *(b.get("world") or []), *(b.get("props") or []))
              if isinstance(x, dict) and _clean(x.get("name"))]
    out = []
    for q in open_qs:
        toks = _question_tokens(q)
        if not toks:
            continue
        if toks & _LOOK_ASKED:
            named = [x for x in roster
                     if any(w and w in toks for w in _name_key(x["name"]).split(" "))]
            if named and all(_clean(x.get("look")) for x in named):
                out.append(q)
                continue
        for words, ok in _ANSWERED_BY:
            if toks.intersection(words):
                if ok(b):
                    out.append(q)
                break
    return out


def brief_patch_problems(patch):
    """Entries a note_brief patch will DROP, as sentences for the model.

    `_merge_named` requires a dict with a `name` and silently skips anything
    else, and note_brief then answered {"noted": True} over a list that lost
    every entry — measured: a patch of world: ["Docking Ring", "Command Deck"]
    merges to [] and reports success. Models send a bare string array for a
    list-shaped field often enough that the schema alone does not settle it,
    and a drop with no trace is the worst version of this: the interview
    believes it wrote the place down and never asks again.

    Twin of `briefPatchProblems` in director/brief.js.
    """
    p = patch if isinstance(patch, dict) else {}
    out = []
    for key in _BRIEF_NAMED:
        if key not in p:
            continue
        if not isinstance(p[key], list):
            out.append(f'"{key}" must be an ARRAY of {{"name": …}} objects — '
                       "that part of the patch was dropped.")
            continue
        bad = [x for x in p[key]
               if not (isinstance(x, dict) and _clean(x.get("name")))]
        if not bad:
            continue
        # Compact separators, or this sentence differs from the JS twin's by a
        # space and the two runners describe one drop two ways.
        shown = ", ".join(f'"{x}"' if isinstance(x, str)
                          else json.dumps(x, separators=(",", ":"))[:48]
                          for x in bad[:3])
        out.append(f'{len(bad)} "{key}" {"entry" if len(bad) == 1 else "entries"} had no '
                   f'"name" and {"was" if len(bad) == 1 else "were"} dropped ({shown}). '
                   'Each one is an object: {"name": "…", "look": "…"} — resend them.')
    return out


def _merge_named(base, patch, fields):
    """`previous_name` renames in place — without it "actually, call her Mara"
    leaves the placeholder behind and the planner gets two characters."""
    out = [dict(x) for x in (base or []) if isinstance(x, dict)]

    def find(n):
        return next((x for x in out if _clean(x.get("name")).lower() == _clean(n).lower()), None)

    def find_by_key(n):
        """The same thing under a plural, a possessive or an article — "Cloudy
        Glass Marbles" arriving over "Cloudy Glass Marble". Nothing has to be
        inferred, so it merges rather than becoming a second prop with its own
        reference sheet. Anything looser is a guess and goes to
        `duplicate_groups` for the model to confirm instead."""
        k = _name_key(n)
        return next((x for x in out if k and _name_key(x.get("name")) == k), None) if k else None

    for raw in patch if isinstance(patch, list) else []:
        name = _clean((raw or {}).get("name")) if isinstance(raw, dict) else ""
        if not name:
            continue
        by_name = find(name)
        # A rename replaces the stored name; a plain reference keeps it, so a
        # later "mara" cannot recase the character to lower case.
        prev = raw.get("previous_name")
        hit = by_name or (find(prev) or find_by_key(prev) if prev else None) or find_by_key(name)
        target = hit if hit is not None else {"name": name}
        if hit is not None and by_name is None:
            target["name"] = name
        for f in fields:
            if _clean(raw.get(f)):
                target[f] = _clean(raw[f])
        for f in _BRIEF_NAMED_LISTS:
            incoming = _asset_ids(raw.get(f))
            if incoming:
                have = list(target.get(f) or [])
                target[f] = have + [x for x in incoming if x not in have]
        if hit is None:
            out.append(target)
    return out


def merge_brief(base, patch):
    """Fold a note_brief patch into the accumulated brief.

    Additive on purpose: the model sends what it just learned, never the whole
    document, so a short patch must not erase earlier facts. Twin of
    `mergeBrief` in director/brief.js (hosted path) — keep them in step.
    """
    out = dict(base or {})
    p = patch if isinstance(patch, dict) else {}

    for f in _BRIEF_STR:
        if _clean(p.get(f)):
            out[f] = _clean(p[f])
    for f in _BRIEF_LIST:
        incoming = p.get(f)
        incoming = incoming if isinstance(incoming, list) else ([incoming] if _clean(incoming) else [])
        if not incoming:
            continue
        merged = _uniq(list(out.get(f) or []) + incoming)
        # Tidy the whole list, not just the patch, so anything already stored
        # from an earlier turn clears itself out too.
        out[f] = _tidy_questions(merged) if f == "open_questions" else merged
    for key, fields in _BRIEF_NAMED.items():
        if key in p:
            out[key] = _merge_named(out.get(key), p[key], fields)
    if isinstance(p.get("shape"), dict):
        shape = dict(out.get("shape") or {})
        try:
            if float(p["shape"].get("length_s") or 0) > 0:
                shape["length_s"] = int(float(p["shape"]["length_s"]))
        except (TypeError, ValueError):
            pass
        if _clean(p["shape"].get("structure")):
            shape["structure"] = _clean(p["shape"]["structure"])
        if isinstance(p["shape"].get("sections"), list) and p["shape"]["sections"]:
            shape["sections"] = _uniq(p["shape"]["sections"])
        out["shape"] = shape
    if isinstance(p.get("song"), dict):
        # Per-key replace, like `shape`. Twin of the `song` branch in
        # director/brief.js — the local interview fills the same
        # field, and the wizard reads it to set up the track.
        song = dict(out.get("song") or {})
        for key in ("lyrics", "style"):
            if _clean(p["song"].get(key)):
                song[key] = _clean(p["song"][key])
        if isinstance(p["song"].get("instrumental"), bool):
            song["instrumental"] = p["song"]["instrumental"]
        for key in ("length_s", "bpm"):
            try:
                if float(p["song"].get(key) or 0) > 0:
                    song[key] = int(float(p["song"][key]))
            except (TypeError, ValueError):
                pass
        if song:
            out["song"] = song
    if isinstance(p.get("expert_notes"), dict):
        notes = dict(out.get("expert_notes") or {})
        for eid, note in p["expert_notes"].items():
            if eid in _EXPERT_IDS and _clean(note):
                notes[eid] = _clean(note)
        out["expert_notes"] = notes
    if isinstance(p.get("ready"), bool):
        out["ready"] = p["ready"]
    # Answered questions stop being open ones. Matched on OVERLAP and not on the
    # "exact text" the schema asks for, because models paraphrase what they were
    # shown — see _same_question.
    if isinstance(p.get("resolved_questions"), list) and isinstance(out.get("open_questions"), list):
        done = [d for d in (_clean(q) for q in p["resolved_questions"]) if d]
        out["open_questions"] = [
            q for q in out["open_questions"]
            if not any(d.lower() == _clean(q).lower() or _same_question(d, q) for d in done)]
    if isinstance(p.get("remove"), dict):
        for key in (*_BRIEF_NAMED, *_BRIEF_LIST):
            drop = p["remove"].get(key)
            if not isinstance(drop, list) or not isinstance(out.get(key), list):
                continue
            gone = {_clean(n).lower() for n in drop}
            out[key] = [x for x in out[key]
                        if _clean(x if isinstance(x, str) else x.get("name")).lower() not in gone]
    # Tidy and retire the WHOLE list, UNCONDITIONALLY. Both used to run only
    # inside the _BRIEF_LIST loop, which `continue`s when the patch carries no
    # open_questions — so a stored list was never revisited by any patch that
    # did not happen to mention it. Measured: seventy stale questions survived
    # every turn of a real interview that way.
    if isinstance(out.get("open_questions"), list) and out["open_questions"]:
        tidy = _tidy_questions(out["open_questions"])
        answered = set(answered_questions({**out, "open_questions": tidy}))
        out["open_questions"] = [q for q in tidy if q not in answered]
    return out


def duplicate_groups(items, kind=None):
    """Entries in one brief list that look like the same thing.

    Deterministic, and phrased for the model as an instruction, for the reason
    this codebase keeps rediscovering: a model agrees with "don't write the
    same prop down twice" and then writes it down four times. A check is what
    changes that. Twin of `duplicateGroups` in director/brief.js.

    Groups on an EQUAL reduced name, or on descriptions that open the same way.
    Deliberately NOT on one name containing the other: "Rei" and "Guide Rei"
    are two characters in a real project here, and telling the model they are
    one invites it to merge two people.
    """
    rule = _DUPE_RULES.get(kind) or _DUPE_RULES["default"]
    rows = [x for x in (items or []) if isinstance(x, dict) and _clean(x.get("name"))]
    common = _common_words(rows)
    groups, placed = [], set()
    for i, a in enumerate(rows):
        if i in placed:
            continue
        ak = _name_key(a["name"])
        group = [a["name"]]
        for j in range(i + 1, len(rows)):
            if j in placed:
                continue
            b = rows[j]
            if (ak and ak == _name_key(b["name"])) or _looks_like_one(a, b, rule, common):
                placed.add(j)
                group.append(b["name"])
        if len(group) > 1:
            placed.add(i)
            groups.append(group)
    return groups


def note_brief_result(brief, patch=None):
    """What note_brief hands back: a mirror of the merged state, not a receipt.

    A model that cannot see the names it is already holding renames a character
    by adding a second one, and leaves answered questions open forever. Twin of
    `noteBriefResult` in director/brief.js.

    PROPS were missing from this mirror for its whole life, and props are what
    duplicated: one object came back as "Cloudy Glass Marbles", "Contained
    Black Hole Marble" and "Guide Rei's Cloudy Marble" in a single brief.
    """
    b = brief or {}
    names = lambda key: [x.get("name") for x in (b.get(key) or []) if x.get("name")]  # noqa: E731
    open_qs = list(b.get("open_questions") or [])
    missing = _brief_missing(b)
    hints = []
    dropped = brief_patch_problems(patch)
    if dropped:
        hints.append(" ".join(dropped))
    dupes = []
    for key, label in (("cast", "cast"), ("world", "location"), ("props", "prop")):
        for group in duplicate_groups(b.get(key), key):
            dupes.append(f"{label}: " + " / ".join(f'"{n}"' for n in group))
    if dupes:
        hints.append("These look like the SAME thing written down more than once: "
                     + "; ".join(dupes)
                     + ". If any group is one thing, resend the keeper with previous_name "
                       "set to each of the others, one call per merge — the planner makes "
                       "a separate sheet for every name here.")
    # ONE LOCATION FOR A MULTI-SECTION PIECE, which is the shape of the failure
    # this check exists for. Asked for a station with a docking ring, a command
    # deck, a maintenance spine, an observation gallery and a salvage bay, the
    # model wrote all five into ONE entry's `look` and reported them as added —
    # truthfully, and uselessly: the brief carried one location, so the planner
    # draws one master plate and five sets collapse to one camera position. It
    # was doing what it was told; the roster rule prices duplicates and nothing
    # priced the opposite.
    #
    # A PROSE check was written first and thrown away: the nested look and a
    # correct one are both comma enumerations ("welded hull plates, cargo nets,
    # gantries" is dressing INSIDE one bay), and nothing separates them without
    # a vocabulary of place nouns that would go stale. This one counts entries
    # against the shape the model itself wrote down, and goes quiet the moment
    # the split happens. A bottle episode really is one location, so the escape
    # is saying so in constraints. Twin of the block in director/brief.js.
    shape = b.get("shape") or {}
    sections = len(shape.get("sections") or [])
    bottle = any(re.search(r"\b(one|single|bottle)\b", c or "", re.I)
                 and re.search(r"\b(location|room|set|setting)\b", c or "", re.I)
                 for c in (b.get("constraints") or []))
    try:
        long_piece = float(shape.get("length_s") or 0) >= 120
    except (TypeError, ValueError):
        long_piece = False
    if len(b.get("world") or []) == 1 and not bottle and (sections >= 3 or long_piece):
        hints.append(
            f"The brief holds ONE location for a "
            f"{str(sections) + '-section' if sections >= 3 else str(shape.get('length_s')) + 's'}"
            ' piece. A place the camera cuts to is its own world entry — if that one\'s look '
            'names several (a deck, a bay, a corridor), send each as its own {"name", "look"}. '
            "If it really is one set, say so in constraints.")
    if open_qs:
        hints.append("Answered questions retire themselves; send resolved_questions only for "
                     "one the brief cannot show is settled.")
    out = {"noted": True, "ready": not missing and b.get("ready") is not False,
           "still_missing": missing, "cast": names("cast"), "world": names("world"),
           "props": names("props"), "open_questions": open_qs}
    if dropped:
        out["dropped"] = dropped
    if hints:
        out["hint"] = " ".join(hints)
    return out


def _brief_missing(brief):
    b = brief or {}
    checks = [
        ("a premise", bool(_clean(b.get("logline")) or _clean(b.get("premise")))),
        ("the turn", bool(_clean(b.get("turn")))),
        ("a named cast member with a look",
         any(_clean(c.get("name")) and _clean(c.get("look")) for c in (b.get("cast") or []))),
        ("somewhere it happens", any(_clean(w.get("name")) for w in (b.get("world") or []))),
        ("tone or palette", bool(_clean(b.get("tone")) or _clean(b.get("palette")))),
    ]
    return [label for label, ok in checks if not ok]


# --------------------------------------------- a scene IS its beats ---------
#
# `scenes.duration_ms` and the sum of its beats are the SAME NUMBER, and the
# planner is what makes that load-bearing: `planner.plan_blocks` reads beat
# durations ONLY (`dur = int(b["duration_ms"])`) and never looks at the scene
# row. So a scene duration edited on its own changes a number nothing in the
# render path reads, while every surface that reports length — the wizard
# total, the storyboard ruler, the cost and ETA estimates — starts quoting it.
#
# Measured on Rei E3 v6: "MEMORY_RETURN is too long, bring it to about 48s"
# set the scene to 48000 and left its 21 beats summing to 58000. The tool
# reported success, the UI said 48s, and the episode would still have rendered
# 58. The same turn's HIDEOUT_ARRIVAL fix was correct only because the model
# volunteered to call update_beat six times as well and did the arithmetic
# itself — i.e. correctness depended on the model choosing to keep the books.
BEAT_MIN_MS = 1500          # storyplan.SHOT_MIN_MS


def refit_beats(durations, target_ms, min_ms=BEAT_MIN_MS):
    """Scale beats to a new scene total, exactly. Pure.

    Proportional, so the shape of the scene survives — a 5s hold stays the
    longest shot. Every beat keeps `min_ms`, and because rounding a list of
    proportions never sums to the target on its own, the residual is absorbed
    one millisecond-batch at a time into the beats that have room above the
    floor. Returns a list that sums to EXACTLY `target_ms` whenever the floors
    allow it, and to the floor total when they do not — a scene cannot be
    shorter than its shots.
    """
    old = [max(0, int(d or 0)) for d in durations]
    n = len(old)
    if not n:
        return []
    target = max(int(target_ms or 0), min_ms * n)
    total = sum(old)
    if total <= 0:                       # nothing to scale from: split evenly
        base = [target // n] * n
        base[0] += target - sum(base)
        return base
    out = [max(min_ms, int(round(d * target / total))) for d in old]
    # Absorb the rounding drift. Give to the longest / take from the roomiest,
    # so a 1500ms floor is never breached and the residual lands where it is
    # least visible.
    drift = target - sum(out)
    guard = 0
    while drift and guard < 10000:
        guard += 1
        if drift > 0:
            i = max(range(n), key=lambda k: out[k])
            step = drift
            out[i] += step
            drift = 0
        else:
            room = [(out[k] - min_ms, k) for k in range(n) if out[k] > min_ms]
            if not room:
                break
            avail, i = max(room)
            step = min(avail, -drift)
            out[i] -= step
            drift += step
    return out


def _scene_beats(scene_id):
    return sb.get(f"beats?scene_id=eq.{scene_id}&order=idx&select=id,idx,duration_ms")


def _sync_scene_duration(scene_id):
    """Make the scene row agree with the beats under it. Cheap and idempotent."""
    rows = _scene_beats(scene_id)
    total = sum(int(r.get("duration_ms") or 0) for r in rows)
    if total:
        sb.patch(f"scenes?id=eq.{scene_id}", {"duration_ms": total})
    return total


_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _resolve_scene(ref, pid, eid=None):
    """Find a scene from whatever the model called it: the id, "S3", or the slug.

    It reads the labels off the same screen the user is looking at, and a label
    sent where a uuid was expected made PostgREST answer `22P02 invalid input
    syntax for type uuid` — a raw DB error the model cannot act on. Twin of
    `resolveScene` in api/director/chat.js.
    """
    raw = str(ref or "").strip()
    if _UUID_RE.match(raw):
        rows = sb.get(f"scenes?id=eq.{raw}&select=id,storyboard_id,idx")
        if rows:
            return rows[0], None
    # "S3" is a POSITION IN THE OPEN BOARD, so it has to be read against that
    # board and no other — the same label names a different scene in every
    # episode of a series.
    sbid = _current_storyboard_id(pid, eid)
    scenes = (sb.get(f"scenes?storyboard_id=eq.{sbid}&order=idx&select=id,storyboard_id,idx,slug")
              if sbid else [])
    want = _ref_to_idx(raw, "s")
    hit = None
    if want is not None:
        hit = next((x for x in scenes if x["idx"] == want), None)
    if hit is None:
        hit = next((x for x in scenes if (x.get("slug") or "").lower() == raw.lower()), None)
    if hit is not None:
        return hit, None
    return None, {"error": f'no scene matches "{raw}"',
                  "scenes": [{"ref": _scene_ref(x['idx']), "slug": x.get("slug"),
                              "scene_id": x["id"]} for x in scenes]}


def _resolve_beat(ref, scene_ref, pid, eid=None):
    """Same idea for beats: "b2" is a position inside a scene, not a row id."""
    raw = str(ref or "").strip()
    if _UUID_RE.match(raw):
        rows = sb.get(f"beats?id=eq.{raw}&select=id,scene_id,idx,duration_ms,meta")
        if rows:
            return rows[0], None
    if not scene_ref:
        return None, {"error": f'"{raw}" is not a beat id — pass scene_id too and I can take '
                               f'"b2", or use the beat_id from the storyboard listing'}
    scene, err = _resolve_scene(scene_ref, pid, eid)
    if scene is None:
        return None, err
    beats = sb.get(f"beats?scene_id=eq.{scene['id']}&order=idx"
                   f"&select=id,scene_id,idx,duration_ms,meta")
    want = _ref_to_idx(raw, "b")
    hit = next((b for b in beats if b["idx"] == want), None) if want is not None else None
    if hit is not None:
        return hit, None
    return None, {"error": f'no beat matches "{raw}" in that scene',
                  "beats": [{"ref": _shot_ref(b['idx']), "beat_id": b["id"]} for b in beats]}


def _lore_doc_list(project_id):
    """The project's lore documents, titles only.

    `get_project_state` is the tool whose description says to call it first to
    learn what exists, and for the whole life of the RAG corpus it did not
    mention that corpus — so a director asked "can you see the lore doc?"
    truthfully answered no about a document sitting indexed in the database.
    Titles are enough to answer that question; the text comes from search_lore.
    """
    try:
        docs = sb.get(f"rag_documents?project_id=eq.{project_id}"
                      f"&select=id,title,kind,source&order=created_at.desc&limit=50") or []
        if not docs:
            return []
        ids = ",".join(d["id"] for d in docs)
        rows = sb.get(f"rag_chunks?document_id=in.({ids})&select=document_id&limit=20000") or []
        n = {}
        for r in rows:
            n[r["document_id"]] = n.get(r["document_id"], 0) + 1
        return [{**d, "passages": n.get(d["id"], 0)} for d in docs]
    except Exception as e:                       # noqa: BLE001
        log(f"lore doc list skipped: {e}")
        return []


def _resolve_episode(episodes, ref):
    """An episode by whatever the director calls it: its uuid, its code ("EP01",
    "ep1"), or its position ("1", "episode 2").

    Same reasoning as `_resolve_scene` accepting "S3": the model reads these
    labels off the same project state the user sees, and making it hand back a
    uuid it never saw is how a tool call becomes `22P02 invalid input syntax`.
    """
    s = str(ref or "").strip().lower()
    if not s:
        return None
    for e in episodes:
        if str(e.get("id")) == s:
            return e["id"]
    for e in episodes:
        if (e.get("code") or "").lower() == s:
            return e["id"]
    digits = re.sub(r"[^0-9]", "", s)
    if digits:
        n = int(digits)
        for e in episodes:
            # Humans count episodes from 1; `idx` is 0-based.
            if int(e.get("idx") or 0) + 1 == n or (e.get("code") or "").lower() == f"ep{n:02d}":
                return e["id"]
    return None


def _set_lore_timing(project_id, args):
    """Write a lore entry's `doc.when`. Applied directly, not proposed.

    Unlike a change to what a fact SAYS, timing is not story text a user needs
    to review — it is scoping, and its whole value is that the next plan uses
    it. Routing it through bible_revisions would leave the planner reading the
    old scope until someone visited the Bible page, which is the silent-no-op
    this feature exists to avoid.
    """
    nm = (args.get("name") or "").strip()
    if not nm:
        return {"error": "name is required"}
    rows = sb.get(f"bible_entries?project_id=eq.{project_id}&kind=eq.lore"
                  f"&name=ilike.{urllib.parse.quote(nm)}&select=id,name,doc&limit=1")
    if not rows:
        known = [e.get("name") for e in sb.get(
            f"bible_entries?project_id=eq.{project_id}&kind=eq.lore&select=name&limit=50") or []]
        return {"error": f"no lore entry named '{nm}'", "lore_entries": known}
    entry = rows[0]
    episodes = sb.get(f"episodes?project_id=eq.{project_id}&order=idx&select=id,idx,code,title") or []
    if not episodes:
        return {"error": "this project has no episodes, so lore cannot be scoped to one"}

    doc = dict(entry.get("doc") or {})
    if args.get("evergreen"):
        doc.pop("when", None)
        sb.patch(f"bible_entries?id=eq.{entry['id']}", {"doc": doc})
        return {"entry": entry["name"], "timing": "always true — every episode is planned with it"}

    when = dict((doc.get("when") or {}) if isinstance(doc.get("when"), dict) else {})
    unknown = []
    for key in ("from", "until", "revealed"):
        if key not in args or args.get(key) in (None, ""):
            continue
        got = _resolve_episode(episodes, args[key])
        if not got:
            unknown.append(f"{key}={args[key]}")
        else:
            when[key] = got
    if unknown:
        return {"error": f"could not resolve {', '.join(unknown)}",
                "episodes": [{"code": e.get("code"), "title": e.get("title")} for e in episodes]}
    # An ordinary fact is established when it is shown; only a retcon separates
    # them, and that has to be said explicitly rather than defaulted into.
    if when.get("from") and not when.get("revealed"):
        when["revealed"] = when["from"]
    when.setdefault("until", None)
    doc["when"] = when
    sb.patch(f"bible_entries?id=eq.{entry['id']}", {"doc": doc})

    order = {e["id"]: int(e.get("idx") or 0) for e in episodes}
    name_of = {e["id"]: (e.get("code") or f"Ep{int(e.get('idx') or 0) + 1}") for e in episodes}
    try:
        import llm
        per_ep = {name_of[e["id"]]: llm.lore_status(doc, order, order[e["id"]]) for e in episodes}
    except Exception:                            # noqa: BLE001 — reporting only
        per_ep = {}
    return {"entry": entry["name"],
            "when": {k: name_of.get(v, v) for k, v in when.items() if v},
            "per_episode": per_ep,
            "note": "applied — the next plan for each episode uses this"}


def _search_lore(project_id, query, limit=None):
    """Search the project's lore documents.

    Two ways in, on purpose, and the second is the one that makes this usable:

      semantic — `llm.rag_search`, which embeds the query. Best answers, and it
                 needs OPENAI_API_KEY with quota.
      keyword  — a literal ilike over the stored passages. Needs nothing at all.

    Falling back rather than failing is the same rule `builtin_knowledge`
    follows against pgvector: a grounding layer that only works when credits are
    available is a grounding layer that is missing exactly when someone is
    trying to work out why the model seems ignorant. And a lore document the
    user can see in the shelf must never come back as "no lore found" — if
    retrieval cannot run, the honest answer is the titles plus the reason.

    `mode` rides in the result because the director must not describe a
    keyword hit as understanding.
    """
    # str(): a model calling this with a bare number ("search the lore for 1947")
    # otherwise raises inside a tool call, which the director reports as the
    # feature being broken. Mirrors the JS twin's String().
    q = str(query or "").strip()
    try:
        k = max(1, min(int(limit or 6), 12))
    except (TypeError, ValueError):
        k = 6
    docs = _lore_doc_list(project_id)
    if not docs:
        return {"documents": [], "hits": [],
                "note": "This project has no lore documents. Import one from the "
                        "Bible page's Lore tab."}
    if not q:
        return {"documents": docs, "hits": [],
                "note": "Give a query to search inside these documents."}

    try:
        import llm
        hits = llm.rag_search(q, project_id=project_id, k=k) or []
        if hits:
            return {"documents": docs, "mode": "semantic",
                    "hits": [{"title": h.get("title"), "kind": h.get("doc_kind"),
                              "similarity": round(float(h.get("similarity") or 0), 3),
                              "text": h.get("content")} for h in hits]}
    except Exception as e:                       # noqa: BLE001
        log(f"search_lore semantic pass skipped: {e}")

    # Keyword fallback. PostgREST `ilike` with * wildcards; the query is sent as
    # a value, never interpolated into a filter operator, so a user's asterisk
    # or comma cannot rewrite the request.
    try:
        ids = ",".join(d["id"] for d in docs)
        safe = urllib.parse.quote(f"*{q}*", safe="")
        rows = sb.get(f"rag_chunks?document_id=in.({ids})&content=ilike.{safe}"
                      f"&select=document_id,idx,content&order=idx&limit={k}") or []
        by_id = {d["id"]: d for d in docs}
        return {
            "documents": docs, "mode": "keyword",
            "hits": [{"title": (by_id.get(r["document_id"]) or {}).get("title"),
                      "text": r["content"]} for r in rows],
            "note": "Literal text match, not semantic — the embeddings were "
                    "unavailable. Nothing found here does not mean the lore is "
                    "silent on it; try another wording.",
        }
    except Exception as e:                       # noqa: BLE001
        return {"documents": docs, "hits": [],
                "error": f"could not search the passages: {e}",
                "note": "The documents above exist; only the search failed."}


def _episode_storyboard_id(eid):
    """THE BOARD OF ONE EPISODE, ordered the way the browser orders it.

    `db/director.storyboardsForEpisode` sorts `version desc, created_at desc`
    and every screen reads `[0]`, so anything else here answers a question
    about a storyboard nobody is looking at. Twin of `episodeStoryboardId` in
    director/tools.js.
    """
    if not eid:
        return None
    rows = sb.get(f"storyboards?episode_id=eq.{eid}"
                  f"&order=version.desc,created_at.desc&limit=1&select=id")
    return rows[0]["id"] if rows else None


def _current_storyboard_id(pid, eid=None, storyboard_id=None):
    """WHICH STORYBOARD THE TOOLS ARE TALKING ABOUT — the OPEN EPISODE'S.

    Every storyboard read used to resolve project-wide, so a series answered
    about whichever episode happened to come first and switching episodes
    changed nothing at all. The situational context block was episode-scoped
    the whole time, so the two halves of one turn disagreed: MEASURED on Rei,
    EP03 open with S7 CITY_CAPTURE_2 on screen, `list_storyboard` returned
    EP01's three scenes. Nothing errored — the director simply reported that
    the scene the user was pointing at does not exist.

    AN OPEN EPISODE WITH NO BOARD RETURNS None RATHER THAN FALLING THROUGH.
    That refusal is the fix: silently serving a sibling episode's storyboard
    is the bug. The project-wide search survives only for the case it was
    written for — no episode open at all. Twin of `currentStoryboardId`.
    """
    if storyboard_id:
        return storyboard_id
    if eid:
        return _episode_storyboard_id(eid)
    return _latest_storyboard_id(_episode_ids(pid))


def _no_storyboard(eid=None):
    """Says WHICH thing has no board — with the episode-first rule above the
    two are different failures with different fixes."""
    return {"error": ("this episode has no storyboard yet — plan one, or switch "
                      "to an episode that has one") if eid
                     else "this project has no storyboard yet"}


def _latest_storyboard_id(episode_ids):
    """The project-wide fallback: the first of these episodes with a board.

    Only reached when nothing is open. Kept per-episode rather than one
    `in.()` query because `version` counts WITHIN an episode, so a
    cross-episode sort by it is meaningless.
    """
    for eid in episode_ids:
        rows = _episode_storyboard_id(eid)
        if rows:
            return rows
    return None


# Anything a human asked for outruns the machine's own queue: the wizard's
# masters run at 50 and the reviewer's auto-retakes at 8. Same constant as
# src/lib/db/jobs.ts.
USER_PRIORITY = 5

# A catalog id is not a model_map key, and the two disagree for exactly the
# rows below. Kept identical to MODEL_KEY_EXCEPTIONS in
# director/model_keys.js (the canonical copy, which the browser and the hosted
# director both import) and scripts/gen_model_catalog.py — a tool may be
# handed either spelling, because the user reads catalog ids off the pickers.
# director/model_keys.test.mjs parses this table and fails on a disagreement:
# `h3-pdd-local` was added to two of the four copies when the PDD row shipped
# and to this one nowhere, so "re-render b6 on PDD" derived `h3-pdd` — not a
# model_map key — and the job died on `model 'h3-pdd' not available`.
MODEL_KEY_EXCEPTIONS = {
    "h3-local": "minimax-h3",
    "h3-turbo-local": "minimax-h3-turbo", "h3-pdd-local": "minimax-h3-pdd",
    "h3-lightx2v-local": "minimax-h3-lightx2v",
    "wan22-local": "wan2.2",
    # The quantised rungs, which exist in `model_map.desktop.json` alone.
    # Listed for the same reason as the rows above: this table is the only
    # thing carrying the real key, and deriving the wrong one fails the render
    # naming a string nobody typed.
    "h3-q5-local": "minimax-h3-q5", "h3-q4-local": "minimax-h3-q4",
    "h3-q3-local": "minimax-h3-q3",
}


def _model_key(value):
    """Catalog id (or an already-correct key) -> model_map key, or None.

    A DESKTOP model has no key at all: `local:` ids name a checkpoint on the
    user's own machine and model_map has never heard of one, so the bare strip
    hands back `local:wan22-5b/Q6_K` untouched — a key the worker cannot
    resolve. None DROPS it, so the render falls back to the block's own pick
    rather than dying. Same rule as the JS twin.
    """
    if not value:
        return None
    v = str(value).strip()
    if not v or v.startswith("local:"):
        return None
    return MODEL_KEY_EXCEPTIONS.get(v) or re.sub(r"-local$", "", v)


# Scene, shot and block REFS all count from one — the twin of
# director/refs.js. Until this constant existed the three disagreed: scenes and
# shots were 1-indexed while BLOCKS were 0-indexed, so `b6` named the seventh
# block but the sixth shot, on the same screen. `idx` in the database is
# untouched and stays 0-based; this is display and addressing only.
REF_BASE = 1


def _block_ref(idx):
    return f"b{int(idx) + REF_BASE}"


def _scene_ref(idx):
    return f"S{int(idx) + REF_BASE}"


def _shot_ref(idx):
    return f"b{int(idx) + REF_BASE}"


def _ref_to_idx(ref, letter="b"):
    """"b7" -> 6, or None when it is not a ref at all (try a slug, try a uuid)."""
    m = re.match(rf"^{letter}?(\d+)$", str(ref or "").strip(), re.I)
    if not m:
        return None
    idx = int(m.group(1)) - REF_BASE
    return idx if idx >= 0 else None


def _resolve_block(ref, pid, storyboard_id=None, eid=None):
    """Blocks are addressed the way they are on screen: 'b7', or an id.

    Same reasoning as _resolve_scene — the model reads 'BLOCK b7' off the
    storyboard the user is looking at, and sending that where a uuid was
    expected used to come back as a raw Postgres 22P02.
    """
    raw = str(ref or "").strip()
    if _UUID_RE.match(raw):
        rows = sb.get(f"generation_blocks?id=eq.{raw}&select=*")
        if rows:
            return rows[0], None
    sid = _current_storyboard_id(pid, eid, storyboard_id)
    if not sid:
        return None, _no_storyboard(eid)
    blocks = sb.get(f"generation_blocks?storyboard_id=eq.{sid}&order=idx&select=*")
    want = _ref_to_idx(raw, "b")
    if want is not None:
        hit = next((b for b in blocks if b["idx"] == want), None)
        if hit is not None:
            return hit, None
    return None, {"error": f'no block matches "{raw}"',
                  "blocks": [{"ref": _block_ref(b['idx']), "block_id": b["id"],
                              "status": b["status"]} for b in blocks]}


def _episode_ids(pid):
    return [e["id"] for e in
            sb.get(f"episodes?project_id=eq.{pid}&select=id&order=created_at.desc")]


def _list_cuts(client, pid, episode_id):
    """The episode's CUTS, each with the two numbers that tell them apart.

    `timelines` has always been a list per episode, and the director assumed
    one — so it read the block plan's total as "the timeline" while the user
    was looking at a cut of a different length. Clips are counted through the
    lanes because that is where they hang; one read per call, not one per cut.

    Falls back to the project's episodes when there is no open one, so "what
    cuts do I have" answers rather than returning an empty list. Twin of
    `listCuts` in director/tools.js.
    """
    eps = [episode_id] if episode_id else _episode_ids(pid)
    if not eps:
        return []
    every = client.get(f"timelines?episode_id=in.({','.join(eps)})&order=created_at"
                       f"&select=id,episode_id,name,fps,width,height,render_stale")
    if not every:
        return []
    # The clip tally is one `track_id=in.(...)` per call, so an unbounded list
    # would build the URL out of every lane of every cut in the project — the
    # no-episode fallback is the path that could. Measured, the busiest project
    # here is 6 cuts / 32 lanes, so this is headroom rather than a real ceiling;
    # it is SAID rather than silently applied.
    rows = every[:MAX_CUTS]
    dropped = len(every) - len(rows)
    tracks = client.get(f"tracks?timeline_id=in.({','.join(t['id'] for t in rows)})"
                        f"&select=id,timeline_id")
    owner = {t["id"]: t["timeline_id"] for t in tracks}
    clips = (client.get(f"clips?track_id=in.({','.join(owner)})"
                        f"&select=track_id,t_start_ms,duration_ms")
             if owner else [])
    tally = {}
    for c in clips:
        tl = owner.get(c["track_id"])
        if not tl:
            continue
        cur = tally.setdefault(tl, {"clips": 0, "ms": 0})
        cur["clips"] += 1
        cur["ms"] = max(cur["ms"], int(c.get("t_start_ms") or 0) + int(c.get("duration_ms") or 0))
    out = []
    for t in rows:
        n = tally.get(t["id"], {"clips": 0, "ms": 0})
        out.append({"id": t["id"], "episode_id": t["episode_id"], "name": t["name"],
                    "clips": n["clips"], "duration_ms": n["ms"],
                    "needs_render": t.get("render_stale")})
    if dropped:
        out.append({"note": f"{dropped} more cut(s) not listed"})
    return out


MAX_CUTS = 24


def _block_label(block):
    return _block_ref(block['idx'])


def _rerender_payload(block, args, label_suffix=""):
    """The master_pass payload for a chat-driven re-render.

    `activate: replace` is the default because these are CONTENT edits — the
    user asked for the shot to be different, so the different one is the one
    that should play. A side-by-side retake is the exception and says so.
    """
    activate = args.get("activate") or "replace"
    payload = {
        "block_id": block["id"],
        "activate": activate,
        "recompute_refs": args.get("recompute_refs", True),
        "seed": args.get("seed") if args.get("seed") is not None
        else random.randint(1, 10 ** 9),
        "label": f"{_block_label(block)} re-render{label_suffix}",
    }
    if args.get("notes"):
        payload["prompt_extra"] = str(args["notes"]).strip()
    if args.get("model_key"):
        payload["model_key"] = _model_key(args["model_key"])
    if isinstance(args.get("loras"), list):
        payload["loras"] = args["loras"]
    if args.get("mode"):
        payload["mode"] = args["mode"]
    if args.get("steps") is not None:
        payload["steps"] = int(args["steps"])
    return payload


def _pending_rerender_for(block_id, pid):
    """A master_pass already queued or running for this block -> its job id.

    `rerender_stale` chains its jobs because "a successor's opening frame is
    its predecessor's last one"; `rerender_block` did not, so re-rendering a
    RUN of chained blocks one call at a time — which is what the director
    actually does when asked to redo b5-b8 — produced four independent jobs
    with no ordering guarantee. They happen to claim in `created_at` order
    today, which is luck, not design: each block's `<Picture 1>` is its
    predecessor's ACTIVE take, so one rendering ahead of its predecessor
    chains off the take that is about to be replaced. That is the mechanism
    that made an invented prop unfixable in TEMPLE DUEL, one layer over.
    """
    try:
        rows = sb.get(f"jobs?project_id=eq.{pid}&kind=eq.master_pass"
                      f"&status=in.(queued,running)"
                      f"&select=id,payload,created_at&order=created_at")
    except Exception:  # noqa: BLE001 — ordering is an enrichment, never a block
        return None
    for r in rows:
        if ((r.get("payload") or {}).get("block_id")) == block_id:
            return r["id"]
    return None


def _block_shots(block):
    """The prose this block will actually render, so a HALF-APPLIED edit is
    visible at the moment it is queued.

    Asked to strip a motif from four blocks, the director rewrote two shots of
    one of them, missed the other two, and reported the whole range clean.
    Nothing in the tool layer can make a model thorough — but returning what
    is about to render puts the evidence in front of it (and in the transcript
    the user reads) instead of leaving it in the database unseen.
    """
    ids = list(block.get("beat_ids") or [])
    if not ids:
        return []
    try:
        rows = {r["id"]: r for r in sb.get(
            "beats?id=in.(%s)&select=id,action" % ",".join(ids))}
    except Exception:  # noqa: BLE001
        return []
    return [{"shot": i, "action": (rows.get(b, {}).get("action") or "")[:300]}
            for i, b in enumerate(ids) if b in rows]


def _queue_rerender(block, args, pid, eid, depends_on=None, suffix=""):
    """-> (job, renders_on). The checkpoint this run renders on is resolved
    here rather than left to the worker's fallback: explicit `model_key` >
    the block's own stored pick > the project's default video model (the
    dock's VIDEO picker). The block's pick wins over the picker because an
    episode must not switch checkpoints shot to shot; the picker wins over
    `H3_MODEL` because a block planned with no pick was rendering on plain H3
    while the chip at the top of the chat said PDD — and the queue then filed
    it under "h3-local" anyway."""
    payload = _rerender_payload(block, args, suffix)
    effective = _render_params(block.get("params") or {}, payload, pid)
    stored = (block.get("params") or {}).get("model_key")
    # A per-job override rather than a write onto the block: the render uses
    # it, `persist_params` is what would make it stick, and a re-render is not
    # the moment to rewrite what the episode was planned with.
    if effective.get("model_key") and effective["model_key"] != stored:
        payload["model_key"] = effective["model_key"]
    job = sb.insert("jobs", {
        "kind": "master_pass", "lane": "gpu", "status": "queued",
        "priority": USER_PRIORITY, "project_id": pid, "episode_id": eid,
        # The catalog id the block REALLY renders on, not a constant: this
        # column is what the queue shows, what `job_timings` files the wall
        # time under and what `model_visibility` is checked against.
        "model_id": _job_model_id(effective, pid),
        **({"depends_on": depends_on} if depends_on else {}),
        "payload": payload})
    sb.patch(f"generation_blocks?id=eq.{block['id']}", {"status": "queued"})
    return job, (effective.get("model_key") or "the worker's default (plain MiniMax H3)"), (
        stored if (stored and effective.get("model_key") != stored) else None)


# ---------------------------- what a block renders on, and what it is called

def _project_settings(pid):
    try:
        rows = sb.get(f"projects?id=eq.{pid}&select=settings")
        return (rows[0].get("settings") or {}) if rows else {}
    except Exception:  # noqa: BLE001 — a setting nobody could read is no setting
        return {}


def _project_video_key(pid):
    """The project's default VIDEO model as a model_map key — only when it is
    a row the POD renders (`provider: local`). A hosted or desktop pick is not
    a key the worker can resolve."""
    vid = _project_settings(pid).get("video_model")
    if not vid:
        return None
    row = (sb.model_catalog() or {}).get(vid)
    if row and (row.get("provider") != "local"
                or (row.get("kind") and row.get("kind") != "video")):
        return None
    return _model_key(vid)


def _render_params(block_params, payload, pid):
    """The effective params of one render. `model_key` in precedence order:
    what the tool was explicitly told, then the project's PICKED video model,
    then the block's own plan-time pick.

    THE PICKER BEATS THE PLAN, and that is a REVERSAL of the rule that shipped
    first — which read "explicit > the block's stored pick > the project
    default" on the reasoning that an episode must not switch checkpoints shot
    to shot, and which made the VIDEO picker at the top of the director chat a
    control that could not change a re-render: PDD selected, turbo queued,
    nothing said.

    The rule it was protecting is about SILENT switching — a planner or a
    fallback choosing a different checkpoint on its own. A person moving a
    picker is not silent, and `settings.video_model` is only ever written by
    one. An absent setting still yields to the block, so an episode nobody has
    re-picked for renders exactly as planned; and the tools answer
    `renders_on` (with `instead_of`) so the switch is said, not discovered.
    """
    p = dict(block_params or {})
    for k in ("loras", "steps", "mode"):
        if payload and payload.get(k) is not None:
            p[k] = payload[k]
    chosen = ((payload or {}).get("model_key") or _project_video_key(pid)
              or p.get("model_key"))
    if chosen:
        p["model_key"] = chosen
    else:
        p.pop("model_key", None)
    return p


def _job_model_id(params, pid):
    """The catalog id a `jobs` row carries for these params — the twin of
    `catalogIdOf` in director/model_keys.js. `params.model_id` is exact where
    PromptRefsModal wrote it; otherwise the model_key is inverted against the
    catalog; a block that stores neither files under plain H3."""
    stored = (params or {}).get("model_id")
    if isinstance(stored, str) and stored:
        return stored
    key = (params or {}).get("model_key")
    if isinstance(key, str) and key:
        for cid in (sb.model_catalog() or {}):
            if _model_key(cid) == key:
                return cid
    return "h3-local"


# Params a NEW shot may take from the block beside it — minus anything that
# describes the neighbour's OWN render. `clip_gen` is a stored recipe, and
# `handle_master_pass` delegates any block carrying one straight to the clip
# path: a shot added after an extension REPLAYED THAT EXTENSION (its prompt,
# its anchors, its references) and never compiled the beat it was given, and
# `clip_kind` made the lane and the sidebar call it "Extension 29". Measured
# on a real episode, which is how this list came to exist.
_NOT_INHERITED = ("clip_gen", "clip_kind", "derived_from", "prompt_extra",
                  "sheet_asset_id", "fight")


def _inherit_params(prev):
    return {k: v for k, v in dict((prev or {}).get("params") or {}).items()
            if k not in _NOT_INHERITED}


# The block-kind twin of director/block_kind.js (and of `_block_kinds` in
# handlers/blocks.py, which needs a database). Pinned against both by test.
_KIND_NOUN = {"chain": "Chain", "extend": "Extension", "shot": "Shot",
              "trim": "Block", "plan": "Block"}


def _block_kind(block):
    p = (block or {}).get("params") or {}
    if not isinstance(p, dict):
        return "plan"
    stamped = p.get("clip_kind")
    if stamped in ("chain", "extend", "shot", "trim"):
        return stamped
    rec = p.get("clip_gen")
    if isinstance(rec, dict) and isinstance(rec.get("prompt"), str):
        m = str(rec.get("mode") or "").lower()
        return {"flf": "chain", "i2v": "extend"}.get(m, "shot")
    frm = p.get("derived_from")
    if isinstance(frm, dict):
        if frm.get("clip_id"):
            return "shot"
        if frm.get("block_id"):
            return "trim"
    return "plan"


def _is_clip_born(block):
    return _block_kind(block) in ("chain", "extend", "shot")


def _kind_label(kind, idx):
    return f"{_KIND_NOUN.get(kind, 'Block')} {int(idx) + 1}"


def _apply_user_refs(block, args):
    """Stage the pictures a tool was handed onto a block's plan — twin of
    `applyUserRefs` in director/tools.js, same two mechanisms: the FIRST look
    lands on the first beat as `meta.still_asset_id` (staged by every worker
    build), and EVERY look is pinned into `ref_plan`, which a recompute
    carries across. A beat that already holds a user still keeps it."""
    looks, seen = [], set()
    for x in (args.get("ref_asset_ids") or []):
        x = str(x or "").strip()
        if x and x not in seen:
            seen.add(x)
            looks.append(x)
    start = str(args.get("start_frame_asset_id") or "").strip() or None
    if not looks and not start:
        return None
    ids = list(dict.fromkeys(looks + ([start] if start else [])))
    known = {r["id"] for r in sb.get("assets?id=in.(%s)&select=id,kind" % ",".join(ids))}
    out = {"staged": [], "not_found": [x for x in ids if x not in known]}
    usable = [x for x in looks if x in known]
    start_ok = start if (start and start in known) else None
    if not usable and not start_ok:
        return out
    first_beat = (block.get("beat_ids") or [None])[0]
    if first_beat:
        rows = sb.get(f"beats?id=eq.{first_beat}&select=id,meta")
        if rows:
            meta = dict(rows[0].get("meta") or {})
            changed = False
            if start_ok:
                meta["start_frame_asset_id"] = start_ok
                if meta.get("still_asset_id") == start_ok:
                    del meta["still_asset_id"]
                changed = True
            if usable and not meta.get("still_asset_id") and usable[0] != start_ok:
                meta["still_asset_id"] = usable[0]
                meta.setdefault("ref_role", "look")
                meta.setdefault("ref_label", "attached picture")
                changed = True
            if changed:
                sb.patch(f"beats?id=eq.{first_beat}", {"meta": meta})
    plan = [e for e in (block.get("ref_plan") or []) if not (e or {}).get("pinned")]
    for x in usable:
        if x == start_ok:
            continue
        plan.append({"purpose": "look", "role": "look", "asset_id": x,
                     "label": "attached picture", "shot_idxs": [1], "pinned": True})
        out["staged"].append({"asset_id": x, "purpose": "look"})
    if start_ok:
        plan.insert(0, {"purpose": "start_frame", "role": "first_frame", "asset_id": start_ok,
                        "beat_id": first_beat, "pinned": True})
        out["staged"].append({"asset_id": start_ok, "purpose": "start_frame"})
    sb.patch(f"generation_blocks?id=eq.{block['id']}", {"ref_plan": plan})
    block["ref_plan"] = plan
    return out


def _block_seconds(block):
    return max(0, int(block.get("t_end_ms") or 0) - int(block.get("t_start_ms") or 0)) / 1000


def _clear_voice_pins(entry, pid):
    """After a recast, drop every recorded conversation this character is in.

    An exchange clip is content-hash keyed on the SPEAKER'S VOICE ID as well as
    the words, so a recast makes every pin point at a recording in the voice
    that was just replaced — and because the beat's duration was cut to that
    recording, leaving it also leaves the shot timed to a performance nobody
    will hear. Blocks covering a cleared beat go stale.

    A recording covers a whole CONVERSATION, so it is cleared from every beat
    that shares it, not only from the ones this character speaks in. Clearing
    half a run is the failure `_invalidate_dialogue` exists to prevent: the
    other half keeps pointing into a clip that is about to be re-recorded, and
    its shot keeps a duration cut to the old performance.
    """
    base = entry["name"].split(" — ")[0].strip().lower()
    touched_blocks = []
    eids = _episode_ids(pid)
    for sbid in [x for x in (_episode_storyboard_id(e) for e in eids) if x]:
        scenes = sb.get(f"scenes?storyboard_id=eq.{sbid}&select=id")
        if not scenes:
            continue
        beats = sb.get(f"beats?scene_id=in.({','.join(s['id'] for s in scenes)})"
                       f"&select=id,meta,dialogue")
        # Which recordings this character is in at all...
        doomed = {((b.get("meta") or {}).get("xchg") or {}).get("asset_id")
                  for b in beats
                  if ((b.get("meta") or {}).get("xchg"))
                  and any(str(d.get("speaker") or "").split(" — ")[0].strip().lower() == base
                          for d in (b.get("dialogue") or []))}
        doomed.discard(None)
        if not doomed:
            continue
        # ...then unpin every beat that shares one of them.
        for b in beats:
            xchg = ((b.get("meta") or {}).get("xchg") or {})
            if xchg.get("asset_id") not in doomed:
                continue
            new_meta = {k: v for k, v in (b.get("meta") or {}).items() if k != "xchg"}
            sb.patch(f"beats?id=eq.{b['id']}", {"meta": new_meta})
            rows = sb.patch(f"generation_blocks?storyboard_id=eq.{sbid}"
                            f"&beat_ids=cs.{{{b['id']}}}&status=in.(planned,generated)",
                            {"status": "stale"}, want_rows=True) or []
            touched_blocks += [_block_ref(r['idx']) for r in rows if "idx" in r]
    return sorted(set(touched_blocks))


def _add_block_mode(wanted, has_refs, chained):
    """The mode this block can actually render, given what it has to stage.

    `r2v` raises in `resolve()` without at least one reference, and `i2v`/`flf`
    need an opening frame that only a chain supplies here. Asking for one
    anyway produces a job that validates, queues, waits for a GPU and only
    then dies — which is how every manually added shot failed.
    """
    wanted = (wanted or "").strip().lower() or None
    if wanted in ("i2v", "flf") and not chained:
        wanted = None
    if wanted == "r2v" and not has_refs:
        wanted = None
    if wanted:
        return wanted
    if has_refs:
        return "r2v"
    return "i2v" if chained else "t2v"


def _add_block(args, pid, eid, after=None, before=None):
    """Add a shot to the storyboard — the Python twin of `addBlock` in
    director/tools.js (and of createManualBlock in src/lib/db/director.ts).

    Three invariants it has to respect, each of which fails at a different
    distance from the mistake:
      * `frames` is NOT NULL and must be a legal 17n+5 count from the start
        (invariant #5) — h3_timing plans it from the window.
      * `scenes.idx` and `generation_blocks.idx` are unique per parent, so an
        insert in the middle has to shift its siblings back-to-front.
      * `chain_from_block_id` may only point at a block that has RENDERED.
        Chaining to an unrendered one makes a job that cannot run: it dies at
        execution asking for a final frame that does not exist.
    """
    import h3_timing
    import storyplan

    eids = _episode_ids(pid)
    episode_id = eid or (eids[0] if eids else None)
    if not episode_id:
        return {"error": "this project has no episode yet"}
    sid = ((after or {}).get("storyboard_id") or (before or {}).get("storyboard_id")
           or _current_storyboard_id(pid, eid))
    if not sid:
        rows = sb.insert("storyboards", {"episode_id": episode_id, "status": "draft"})
        sid = rows["id"]

    blocks = sb.get(f"generation_blocks?storyboard_id=eq.{sid}&order=idx"
                    f"&select=id,idx,t_start_ms,t_end_ms,active_take_id,params,scene_ids,beat_ids")
    requested_ms = int(args.get("duration_ms") or 6000)
    # A LINE HAS A MEASURED SPEAKING TIME AND THE SHOT HAS TO CLEAR IT. That is
    # `storyplan.shot_floor_ms`'s rule, applied by the planner to every dialogue
    # shot it writes and by nothing at all to a shot added by hand: the 6s
    # default takes a twenty-word line and delivers DIALOGUE_CUTOFF. The floor
    # RAISES an explicit duration_ms rather than yielding to it — a shot that
    # cuts off its own line is not what was asked for — and says so in the
    # result. It has to happen HERE, before the followers are shifted by
    # `duration_ms`, or the block and the blocks after it disagree about where
    # the episode's clock is.
    want_lines = [d for d in (args.get("dialogue") or []) if isinstance(d, dict)]
    speech_ms = storyplan.dialogue_ms(want_lines)
    duration_ms = max(2000, min(max(requested_ms, speech_ms),
                                h3_timing.MAX_CONTENT_MS))
    plan = h3_timing.plan_block(duration_ms)

    # INSERTING AT THE START WAS INEXPRESSIBLE. `after_block` was the only
    # positional argument and `at_idx` reached 0 solely on an EMPTY
    # storyboard — so "add a block before block 1" had no encoding, and a
    # model asked for one does the closest thing it can say (`after_block: b1`)
    # and lands one place late. Measured on RIVALS: the opening confrontation
    # was queued as b2, after the fight had already started.
    if before is not None:
        at_idx = before["idx"]
        start_ms = int(before["t_start_ms"])
        # `prev` is what this block CHAINS from and inherits beside — the
        # block now in front of it, which is nothing when inserting at 0.
        prev = next((b for b in blocks if b["idx"] == at_idx - 1), None)
    else:
        prev = after or (blocks[-1] if blocks else None)
        at_idx = (prev["idx"] + 1) if prev else 0
        start_ms = int(prev["t_end_ms"]) if prev else 0
    # Inserting in the middle: shift the followers back-to-front, because the
    # (storyboard_id, idx) pair is unique and a forward shift collides with the
    # row it is about to move. Same rule as add_scene.
    followers = [b for b in blocks if b["idx"] >= at_idx]
    for b in reversed(followers):
        sb.patch(f"generation_blocks?id=eq.{b['id']}",
                 {"idx": b["idx"] + 1,
                  "t_start_ms": int(b["t_start_ms"]) + duration_ms,
                  "t_end_ms": int(b["t_end_ms"]) + duration_ms})

    scenes = sb.get(f"scenes?storyboard_id=eq.{sid}&order=idx"
                    f"&select=id,idx,slug,cast_ids,environment_id")
    scene_by_id = {s["id"]: s for s in scenes}

    def _name_id(kind, nm):
        rows = sb.get(f"bible_entries?project_id=eq.{pid}&kind=eq.{kind}"
                      f"&name=ilike.{nm}&select=id,name")
        return rows[0] if rows else None

    # WHERE THE SHOT LIVES. A shot added after b19 is the next shot of b19's
    # SCENE, not a scene of its own: the storyboard is scenes of shots, and a
    # fresh "SHOT 20" scene appended at the END of the scene list for a block
    # inserted in the MIDDLE of the episode is what made the storyboard and
    # the block order disagree. The neighbour's scene hosts it unless the
    # caller asks for a new one or names a different location — a block may
    # never span an environment change, and neither may a scene. The `before`
    # anchor's FIRST scene, the `after` anchor's LAST: the scenes it is next to.
    anchor = before if before is not None else prev
    anchor_scene_id = None
    if anchor is not None and (anchor.get("scene_ids") or []):
        ids = anchor["scene_ids"]
        anchor_scene_id = ids[0] if before is not None else ids[-1]
    host = (scene_by_id.get(anchor_scene_id)
            if (anchor_scene_id and not args.get("new_scene")) else None)

    # WHO IS IN IT AND WHERE IT HAPPENS, or the block cannot render.
    #
    # `ref_plan_for` builds the reference set from `scenes.environment_id`,
    # `scenes.cast_ids` and `beats.meta.cast` — and this function used to leave
    # all three empty while declaring mode r2v, which REQUIRES at least one
    # reference. So every manually added shot queued a job that died in
    # `resolve()` with "reference-to-video needs at least one reference", and
    # `recompute_refs` could not save it: there was nothing to recompute FROM.
    #
    # A shot added into an episode is in the same place with the same people
    # as the shot beside it, so both are INHERITED — from the host scene when
    # there is one, else from the NEAREST STAGED neighbour (not merely the
    # adjacent one: the block next door may itself be an unstaged manual shot,
    # and inheriting from one propagates the emptiness instead of curing it).
    # Explicit `cast` / `environment` override it.
    inherited_cast, inherited_env = [], None
    if host is not None and ((host.get("cast_ids") or []) or host.get("environment_id")):
        inherited_cast = list(host.get("cast_ids") or [])
        inherited_env = host.get("environment_id")
    else:
        by_distance = sorted(blocks, key=lambda b: (abs(b["idx"] - at_idx),
                                                    0 if b["idx"] < at_idx else 1))
        if after:
            by_distance = [after] + [b for b in by_distance if b["id"] != after["id"]]
        for cand in by_distance:
            if not (cand.get("scene_ids") or []):
                continue
            rows = [scene_by_id[s] for s in cand["scene_ids"] if s in scene_by_id]
            cast = [c for r in rows for c in (r.get("cast_ids") or [])]
            env = next((r.get("environment_id") for r in rows
                        if r.get("environment_id")), None)
            if not (cast or env):
                continue
            inherited_env = env
            for cid in cast:
                if cid not in inherited_cast:
                    inherited_cast.append(cid)
            break

    unknown = []
    cast_ids, cast_names = list(inherited_cast), []
    if args.get("cast"):
        cast_ids = []
        for nm in args["cast"]:
            hit = _name_id("character", nm)
            (cast_ids.append(hit["id"]) if hit else unknown.append(nm))
    env_id = inherited_env
    if args.get("environment"):
        hit = _name_id("environment", args["environment"])
        if hit:
            env_id = hit["id"]
        else:
            unknown.append(args["environment"])
    # A different LOCATION is a different scene, whatever the caller said.
    if host is not None and env_id and host.get("environment_id") \
            and env_id != host.get("environment_id"):
        host = None
    # THE SPEAKER HAS TO BE STAGED, or the line comes out of a stranger.
    # `ref_plan_for` builds the reference set from the cast, so a character who
    # speaks and is not cast is drawn from prose — the same failure `cast`
    # itself exists to prevent, arriving through the dialogue instead. An
    # OFFSCREEN line is the exception and is the whole point of that flag: it
    # is a voice-over, its speaker is deliberately out of frame, and staging
    # them would put a body on screen the shot says is not there.
    dialogue_lines, staged_speakers = [], []
    for d in want_lines:
        nm = str(d.get("speaker") or "").strip()
        hit = _name_id("character", nm) if nm else None
        if nm and hit is None and nm not in unknown:
            unknown.append(nm)
        line = {"speaker_id": hit["id"] if hit else None,
                "speaker": d.get("speaker"), "line": d.get("line")}
        if d.get("delivery"):
            line["delivery"] = d["delivery"]
        if d.get("offscreen"):
            line["offscreen"] = True
        dialogue_lines.append(line)
        if hit and not d.get("offscreen") and hit["id"] not in cast_ids:
            cast_ids.append(hit["id"])
            staged_speakers.append(hit["name"])
    if cast_ids:
        cast_names = [r["name"] for r in sb.get(
            "bible_entries?id=in.(%s)&select=name" % ",".join(cast_ids))]

    beat_idx, placed_in = 0, None
    if host is not None:
        scene = host
        # The scene's roster grows to include anyone named — `_cast_entry_id`
        # resolves a beat's names against the SCENE's cast first, so a name
        # the scene does not carry falls through to the whole bible and can
        # land on the wrong variant.
        missing = [c for c in cast_ids if c not in (host.get("cast_ids") or [])]
        if missing:
            sb.patch(f"scenes?id=eq.{host['id']}",
                     {"cast_ids": list(host.get("cast_ids") or []) + missing})
        # RIGHT AFTER the anchor's last shot in this scene (or right before
        # the `before` anchor's first), shifting the later shots back-to-front
        # — so the storyboard reads in the same order as the blocks. A
        # clip-born anchor has no beats, and then it appends.
        beats = sb.get(f"beats?scene_id=eq.{host['id']}&order=idx&select=id,idx")
        anchor_beats = [b for b in beats if b["id"] in ((anchor or {}).get("beat_ids") or [])]
        if before is not None and anchor_beats:
            beat_idx = anchor_beats[0]["idx"]
        elif anchor_beats:
            beat_idx = anchor_beats[-1]["idx"] + 1
        else:
            beat_idx = (beats[-1]["idx"] + 1) if beats else 0
        for b in reversed([b for b in beats if b["idx"] >= beat_idx]):
            sb.patch(f"beats?id=eq.{b['id']}", {"idx": b["idx"] + 1})
        placed_in = {"scene": _scene_ref(host["idx"]), "slug": host.get("slug")}
    else:
        # A NEW SCENE, placed right after the anchor's scene in story order —
        # appending it to the end of the list is what put "SHOT 20" under S10
        # for a block sitting between b19 and b21.
        anchor_scene = scene_by_id.get(anchor_scene_id) if anchor_scene_id else None
        if anchor_scene is not None:
            scene_idx = anchor_scene["idx"] if before is not None else anchor_scene["idx"] + 1
        else:
            scene_idx = (scenes[-1]["idx"] + 1) if scenes else 0
        for s in reversed([s for s in scenes if s["idx"] >= scene_idx]):
            sb.patch(f"scenes?id=eq.{s['id']}", {"idx": s["idx"] + 1})
        scene = sb.insert("scenes", {
            "storyboard_id": sid, "idx": scene_idx,
            "slug": (args.get("slug") or f"Shot {at_idx + 1}").upper(),
            "duration_ms": duration_ms, "cast_ids": cast_ids,
            "environment_id": env_id, "status": "draft",
            "scene_prompt": args.get("action"), "meta": {"manual": True}})

    # Pictures the caller handed over: the first look on the beat itself (the
    # key every worker build stages), and all of them pinned into the plan
    # below. Verified against the registry so a pasted filename is reported
    # rather than staged as nothing.
    want_looks, seen = [], set()
    for x in (args.get("ref_asset_ids") or []):
        x = str(x or "").strip()
        if x and x not in seen:
            seen.add(x)
            want_looks.append(x)
    want_start = str(args.get("start_frame_asset_id") or "").strip() or None
    ref_ids = list(dict.fromkeys(want_looks + ([want_start] if want_start else [])))
    known = set()
    if ref_ids:
        known = {r["id"] for r in sb.get("assets?id=in.(%s)&select=id" % ",".join(ref_ids))}
    looks = [x for x in want_looks if x in known]
    start_frame = want_start if (want_start and want_start in known) else None
    refs_not_found = [x for x in ref_ids if x not in known]

    beat_meta = {}
    # `ref_plan_for` reads the BEAT's cast for video blocks, not the
    # scene's — leaving it empty stages nobody however the scene is cast.
    if cast_names:
        beat_meta["cast"] = cast_names
    if start_frame:
        beat_meta["start_frame_asset_id"] = start_frame
    if looks and looks[0] != start_frame:
        beat_meta["still_asset_id"] = looks[0]
        beat_meta["ref_role"] = "look"
        beat_meta["ref_label"] = "attached picture"
    beat = sb.insert("beats", {
        "scene_id": scene["id"], "idx": beat_idx, "duration_ms": duration_ms,
        "camera": args.get("camera") or "static", "action": args["action"],
        # Only when there are lines: a shot added without any must write the
        # row it always wrote.
        **({"dialogue": dialogue_lines} if dialogue_lines else {}),
        "meta": beat_meta})
    if host is not None:
        _sync_scene_duration(host["id"])

    want_chain = args.get("chain", True)
    chain_from = prev["id"] if (want_chain and prev and prev.get("active_take_id")) else None
    # Inherited from the neighbour, MINUS anything describing its own render
    # — see _inherit_params. Then the project's default fills an empty
    # model_key, so a shot added to an episode planned with no pick renders on
    # what the dock's picker says rather than on the worker's constant.
    params = _inherit_params(prev)
    if args.get("model_key"):
        params["model_key"] = _model_key(args["model_key"])
    # …and a NEW shot records what it renders on, so the block carries it.
    effective = _render_params(params, None, pid)
    if effective.get("model_key"):
        params["model_key"] = effective["model_key"]

    ref_plan = []
    if start_frame:
        ref_plan.append({"purpose": "start_frame", "role": "first_frame",
                         "asset_id": start_frame, "beat_id": beat["id"], "pinned": True})
    for x in looks:
        if x == start_frame:
            continue
        ref_plan.append({"purpose": "look", "role": "look", "asset_id": x,
                         "label": "attached picture", "shot_idxs": [1], "pinned": True})
    has_refs = bool(cast_ids or env_id or looks or start_frame)
    block = sb.insert("generation_blocks", {
        "storyboard_id": sid, "idx": at_idx, "scene_ids": [scene["id"]],
        "beat_ids": [beat["id"]], "t_start_ms": start_ms,
        "t_end_ms": start_ms + duration_ms, "frames": plan.render_f,
        "trim": {"warmup_f": plan.warmup_f, "cooldown_f": plan.cooldown_f,
                 "out_ms": plan.trim_ms},
        # A MODE THE BLOCK CANNOT SATISFY IS A JOB THAT DIES AT EXECUTION.
        "mode": _add_block_mode(args.get("mode"), has_refs, bool(chain_from)),
        "ref_plan": ref_plan, "audio_mode": "native",
        "chain_from_block_id": chain_from, "status": "planned",
        "seed": random.randint(1000, 10 ** 6), "params": params})

    out = {"block": _block_ref(at_idx), "block_id": block["id"], "kind": "shot",
           "label": _kind_label("plan", at_idx),
           "scene_id": scene["id"], "scene": _scene_ref(scene["idx"]),
           "scene_slug": scene.get("slug"), "shot": _shot_ref(beat_idx),
           "beat_id": beat["id"],
           "placed": (f"into {placed_in['scene']}"
                      + (f" {placed_in['slug']}" if placed_in.get("slug") else "")
                      + f" as its shot {_shot_ref(beat_idx)}")
           if placed_in else f"as a new scene {_scene_ref(scene['idx'])}",
           "seconds": duration_ms / 1000,
           "chained": bool(chain_from), "mode": block["mode"],
           "cast": cast_names, "located": bool(env_id),
           "renders_on": params.get("model_key")
           or "the worker's default (plain MiniMax H3)"}
    if dialogue_lines:
        out["dialogue"] = [{"speaker": d.get("speaker"), "line": d.get("line"),
                            **({"offscreen": True} if d.get("offscreen") else {})}
                           for d in dialogue_lines]
        warnings = []
        if staged_speakers:
            out["cast_added"] = staged_speakers
            warnings.append("added %s to the cast so their sheet is staged"
                            % ", ".join(staged_speakers))
        if duration_ms > requested_ms:
            warnings.append(
                f"lengthened the shot to {duration_ms / 1000:.1f}s — the lines need "
                f"about {speech_ms / 1000:.1f}s of speaking time")
        # The one case the floor cannot fix: a block has a ceiling, so past it
        # the line is cut off however long the shot is asked to be. Say it here
        # rather than let it turn up as DIALOGUE_CUTOFF in a review.
        if speech_ms > h3_timing.MAX_CONTENT_MS:
            warnings.append(
                f"these lines need about {speech_ms / 1000:.1f}s and a block maxes "
                f"at {h3_timing.MAX_CONTENT_MS / 1000:.1f}s — the last line will be "
                "cut off. Split them across two shots.")
        if warnings:
            out["warnings"] = warnings
    if looks or start_frame:
        out["references"] = (([{"asset_id": start_frame, "purpose": "start_frame"}]
                              if start_frame else [])
                             + [{"asset_id": x, "purpose": "look"}
                                for x in looks if x != start_frame])
    if refs_not_found:
        out["refs_not_found"] = refs_not_found
    if unknown:
        out["not_in_bible"] = unknown
    if not has_refs:
        out["warning"] = ("nothing to stage — no cast and no location, so this "
                          f"renders as {block['mode']}. Give it `cast` and "
                          "`environment` for a reference-driven shot.")
    if want_chain and not chain_from:
        out["note"] = ("not chained: the previous block has not rendered yet, so there "
                       "is no final frame to open on. Render it first, then set the "
                       "chain if the action should continue.")
    if args.get("render", True):
        job = sb.insert("jobs", {
            "kind": "master_pass", "lane": "gpu", "status": "queued",
            "priority": USER_PRIORITY, "project_id": pid, "episode_id": episode_id,
            "model_id": _job_model_id(effective, pid),
            "payload": {"block_id": block["id"], "activate": "replace",
                        "recompute_refs": True,
                        "label": f"{_block_ref(at_idx)} new shot"}})
        sb.patch(f"generation_blocks?id=eq.{block['id']}", {"status": "queued"})
        out["job_id"] = job["id"]
    return out


def _invalidate_dialogue(beat, lines):
    """Unpin a beat from a recorded conversation its lines no longer match.

    Line and exchange clips are content-hash keyed, so edited text simply
    misses the cache and re-synthesizes — that half looks after itself. What
    does NOT is `beats.meta.xchg`: it pins the beat to ONE recording, and the
    beat's duration was cut to that recording at plan time. Left in place, the
    master pass keeps routing to the exchange path against a clip that no
    longer contains these words, and `place_exchange` either mis-times the
    lines or gives up and falls back to timbre refs — a quality drop with
    nothing on screen to explain it.

    The whole RUN shares one recording, so every beat pinned to the same asset
    is unpinned together; unpinning only the edited one would leave its
    neighbours pointing into a clip that is about to be re-cut.

    Returns human-readable warnings for the tool result — the model should say
    these out loud rather than discover them in a review two renders later.
    """
    import storyplan

    warnings = []
    meta = beat.get("meta") or {}
    pinned_asset = ((meta.get("xchg") or {}) or {}).get("asset_id")
    touched = []
    if pinned_asset:
        siblings = sb.get(f"beats?scene_id=eq.{beat['scene_id']}&select=id,meta")
        for row in siblings:
            xchg = ((row.get("meta") or {}).get("xchg") or {})
            if xchg.get("asset_id") != pinned_asset:
                continue
            new_meta = {k: v for k, v in (row.get("meta") or {}).items() if k != "xchg"}
            sb.patch(f"beats?id=eq.{row['id']}", {"meta": new_meta})
            touched.append(row["id"])
        if touched:
            warnings.append(
                f"unpinned {len(touched)} beat(s) from the old recorded conversation; "
                "the run is re-recorded on the next render")

    # The floor that DIALOGUE_CUTOFF is a measurement of: a 12-word line does
    # not fit in a 2-second shot no matter how it is staged.
    need = storyplan.dialogue_ms(lines)
    have = int(beat.get("duration_ms") or 0)
    if need and have and need > have:
        warnings.append(
            f"these lines need about {need / 1000:.1f}s of speaking time but the shot "
            f"is {have / 1000:.1f}s — raise duration_ms to at least {need} or the "
            "last line will be cut off")
    return warnings


def execute(name, args, ctx):
    """Run one tool. `ctx` = {project_id, episode_id, thread_id, backend, persona}.

    Never raises: a tool error is information the model can act on, while an
    exception would kill the whole turn and lose the conversation.
    """
    pid = ctx.get("project_id")
    eid = ctx.get("episode_id")
    args = args if isinstance(args, dict) else {}
    try:
        if name == "get_project_state":
            project = sb.get(f"projects?id=eq.{pid}&select=id,title,medium,genre,style,aspect,logline,status")
            episodes = sb.get(f"episodes?project_id=eq.{pid}&order=idx&select=id,idx,code,title,status")
            # `summary` matters as much as `identity_line` here: a LORE entry
            # has no identity line by design (it has no visual identity), so
            # selecting only the line showed every lore row as a bare name with
            # nothing under it — the director could see that something was
            # called "The Concordat" and not one word about what it was.
            bible = sb.get(f"bible_entries?project_id=eq.{pid}&order=kind"
                           f"&select=id,kind,name,status,identity_line,summary")
            jobs = sb.get(f"jobs?project_id=eq.{pid}&order=created_at.desc&limit=8"
                          f"&select=id,kind,status,progress,progress_note,error_msg")
            pod = sb.get("pod_status?select=state,session_sec")
            lore_docs = _lore_doc_list(pid)
            sbid = _current_storyboard_id(pid, eid)
            storyboard = None
            if sbid:
                row = sb.get(f"storyboards?id=eq.{sbid}&select=id,status,audio_asset_id")
                blocks = sb.get(f"generation_blocks?storyboard_id=eq.{sbid}&order=idx"
                                f"&select=id,idx,status,t_start_ms,t_end_ms")
                storyboard = {**(row[0] if row else {}), "blocks": blocks}
            return {"project": project[0] if project else None, "episodes": episodes,
                    "bible": bible, "storyboard": storyboard,
                    # Titles only — the text is retrieved with search_lore. What
                    # this answers is "is there a lore document at all", which
                    # the director could not answer before and therefore
                    # answered "no".
                    "lore_documents": lore_docs,
                    "recent_jobs": jobs, "pod": pod[0] if pod else None}

        if name == "search_lore":
            return _search_lore(pid, args.get("query"), args.get("limit"))

        if name == "set_lore_timing":
            return _set_lore_timing(pid, args)

        if name == "list_storyboard":
            sbid = _current_storyboard_id(pid, eid, args.get("storyboard_id"))
            if not sbid:
                return _no_storyboard(eid)
            # ONE scene when asked — see the JS twin for the measurement that
            # produced this (a merge turn spent all its rounds re-reading the
            # whole board and edited nothing).
            if args.get("scene_id"):
                one, err = _resolve_scene(args["scene_id"], pid, eid)
                if one is None:
                    return err
                rows = sb.get(f"scenes?id=eq.{one['id']}"
                              f"&select=id,idx,slug,duration_ms,environment_id,"
                              f"cast_ids,scene_prompt,status")
                if not rows:
                    return {"error": "scene not found"}
                sc = rows[0]
                sc["beats"] = sb.get(f"beats?scene_id=eq.{sc['id']}&order=idx"
                                     f"&select=id,idx,duration_ms,camera,action,dialogue,sfx")
                for i, b in enumerate(sc["beats"]):
                    b["ref"] = f"b{i + 1}"
                return {"storyboard_id": one.get("storyboard_id") or sbid, "scenes": [sc]}
            scenes = sb.get(f"scenes?storyboard_id=eq.{sbid}&order=idx"
                            f"&select=id,idx,slug,duration_ms,environment_id,cast_ids,scene_prompt,status")
            for s in scenes:
                s["beats"] = sb.get(f"beats?scene_id=eq.{s['id']}&order=idx"
                                    f"&select=id,idx,duration_ms,camera,action,dialogue,sfx")
            return {"storyboard_id": sbid, "scenes": scenes}

        if name == "update_bible_entry":
            kind, nm = args.get("kind"), (args.get("name") or "").strip()
            if not kind or not nm:
                return {"error": "kind and name are required"}
            existing = sb.get(f"bible_entries?project_id=eq.{pid}&kind=eq.{kind}"
                              f"&name=ilike.{nm}&select=id,version,doc,identity_line")
            if existing:
                e = existing[0]
                revs = sb.get(f"bible_revisions?entry_id=eq.{e['id']}&order=version.desc&limit=1&select=version")
                version = max(e.get("version") or 1, (revs[0]["version"] if revs else 0)) + 1
                doc = {**(e.get("doc") or {}), **(args.get("doc") or {})}
                if args.get("summary"):
                    doc["summary"] = args["summary"]
                rev = sb.insert("bible_revisions", {
                    "entry_id": e["id"], "version": version, "doc": doc,
                    "identity_line": args.get("identity_line") or e.get("identity_line"),
                    "change_note": args.get("change_note") or "director proposal",
                    "proposed_by": "director",
                })
                return {"proposed_revision_id": rev["id"], "entry_id": e["id"], "version": version,
                        "note": "draft — the user confirms it on the Bible page"}
            row = sb.insert("bible_entries", {
                "project_id": pid, "kind": kind, "name": nm[:80],
                "summary": args.get("summary"), "identity_line": args.get("identity_line"),
                "doc": args.get("doc") or {}, "status": "draft",
            })
            return {"created_entry_id": row["id"], "name": nm, "status": "draft",
                    "note": "created as a draft — generate a reference sheet next so it holds"}

        if name == "search_assets":
            # Binned and hidden assets are out: the director must not offer a
            # reference the user threw away, nor one they filed in an incognito
            # collection precisely so it would stop being offered.
            parts = [f"limit={min(24, int(args.get('limit') or 12))}", "order=created_at.desc",
                     "select=id,kind,b2_key,tags,duration_ms,width,height",
                     "deleted_at=is.null", "hidden=is.false"]
            if args.get("kind"):
                parts.append(f"kind=eq.{args['kind']}")
            if args.get("tag"):
                parts.append(f"tags=cs.{{{args['tag']}}}")
            if args.get("text"):
                parts.append(f"b2_key=ilike.*{args['text']}*")
            parts.append(f"or=(project_id.eq.{pid},project_id.is.null)")
            return {"assets": sb.get("assets?" + "&".join(parts))}

        if name == "plan_storyboard":
            job = sb.insert("jobs", {
                "kind": "llm_task", "lane": "llm", "status": "queued", "priority": 30,
                "project_id": pid, "episode_id": args.get("episode_id") or eid,
                "model_id": ctx.get("backend"),
                "payload": {"task": "plan_storyboard", "project_id": pid,
                            "episode_id": args.get("episode_id") or eid,
                            "brief": {"logline": args.get("logline"), "notes": args.get("notes"),
                                      "duration_target_ms": args.get("duration_target_ms"),
                                      "audio_asset_id": args.get("audio_asset_id")},
                            "tier": args.get("tier") or 2,
                            "auto_launch": (args.get("tier") or 2) == 1,
                            "backend": ctx.get("backend"), "persona": ctx.get("persona")},
            })
            return {"job_id": job["id"], "note": "queued — runs on the worker"}

        if name == "launch_render":
            job = sb.insert("jobs", {
                "kind": "launch_render", "lane": "cpu", "status": "queued", "priority": 30,
                "project_id": pid, "episode_id": eid,
                "payload": {"storyboard_id": args.get("storyboard_id"),
                            "dims": ({"w": args["width"], "h": args.get("height")}
                                     if args.get("width") else {})},
            })
            return {"job_id": job["id"]}

        if name == "retake_block":
            blocks = sb.get(f"generation_blocks?id=eq.{args.get('block_id')}&select=id,idx")
            if not blocks:
                return {"error": "block not found"}
            job = sb.insert("jobs", {
                "kind": "master_pass", "lane": "gpu", "status": "queued", "priority": 10,
                "project_id": pid, "episode_id": eid, "model_id": "h3-local",
                "payload": {"block_id": args["block_id"], "auto_activate": False, "take_of": True,
                            "seed": args.get("seed") if args.get("seed") is not None
                            else random.randint(1, 10 ** 9)},
            })
            return {"job_id": job["id"], "block_idx": blocks[0]["idx"],
                    "note": "new take — the user keeps it from the takes browser"}

        if name == "generate_image":
            if args.get("bible_entry_id"):
                target = {"bible_entry_id": args["bible_entry_id"],
                          "role": args.get("role") or "master", "slot": 0}
            elif args.get("scene_id"):
                target = {"scene_id": args["scene_id"]}
            else:
                target = {}
            img_m = _model_key(args.get("model_key"))
            if not img_m and pid:
                prows = sb.get(f"projects?id=eq.{pid}&select=settings")
                if prows:
                    img_m = _model_key((prows[0].get("settings") or {}).get("image_model"))
            payload = {"prompt": args.get("prompt"), "target": target,
                       "ref_asset_ids": args.get("ref_asset_ids") or [],
                       "width": args.get("width") or 1024,
                       "height": args.get("height") or 1024}
            if img_m:
                payload["model_key"] = img_m
            # A STUDIO-HOSTED image render needs no pod: the deployment makes
            # the provider call (the cloud build's hosted-image route) and the user's own machine runs
            # the tail on `lane: "local"`. The hosted twin of this tool has
            # routed that way since the route shipped; this one hard-coded
            # "gpu", so the LOCAL director sent every hosted image to a $3.36/hr
            # box to run a curl — and, with the pod asleep, to a queue nothing
            # was going to claim.
            #
            # Safe here and nowhere else in this file: this payload is LITERAL
            # (a prompt and explicit ref_asset_ids). `add_outfit_variant` below
            # carries a prompt_spec and an anchor, so it composes on the worker
            # and stays where it is — see hosted_image.image_lane.
            row = sb.model_catalog().get(img_m) if img_m else None
            job = sb.insert("jobs", {
                "kind": "image_gen", "lane": hosted_image.image_lane(row),
                "status": "queued", "priority": 20,
                "project_id": pid, "episode_id": eid,
                # `isStudioHostedJob` reads model_id first, and on the web that
                # lookup IS the claim filter.
                **({"model_id": img_m} if hosted_image.studio_hosted(row) else {}),
                "payload": payload,
            })
            return {"job_id": job["id"]}

        if name == "note_brief":
            # The wizard's brief lives on the thread row so both writers (this
            # worker and the hosted endpoint) have one place to merge into, and
            # the browser sees it over realtime without another table.
            tid = ctx.get("thread_id")
            if not tid:
                return {"error": "no thread to write the brief to"}
            rows = sb.get(f"chat_threads?id=eq.{tid}&select=brief")
            brief = merge_brief(rows[0].get("brief") if rows else {}, args)
            sb.patch(f"chat_threads?id=eq.{tid}", {"brief": brief})
            return note_brief_result(brief, args)

        if name == "update_scene":
            scene, err = _resolve_scene(args.get("scene_id"), pid, eid)
            if scene is None:
                return err
            patch, missing = {}, []
            for k in ("slug", "scene_prompt"):
                if args.get(k) is not None:
                    patch[k] = args[k]
            # A scene duration is not a field of its own — see refit_beats.
            # Retime the beats to the requested total and take the achieved
            # sum as the scene's, so the row and the render agree.
            refit = None
            if args.get("duration_ms") is not None:
                rows = _scene_beats(scene["id"])
                if rows:
                    fitted = refit_beats([r.get("duration_ms") for r in rows],
                                         max(1000, int(args["duration_ms"])))
                    for r, d in zip(rows, fitted):
                        if int(r.get("duration_ms") or 0) != d:
                            sb.patch(f"beats?id=eq.{r['id']}", {"duration_ms": d})
                    patch["duration_ms"] = sum(fitted)
                    refit = {"beats_retimed": sum(
                        1 for r, d in zip(rows, fitted)
                        if int(r.get("duration_ms") or 0) != d),
                        "scene_ms": sum(fitted)}
                else:
                    patch["duration_ms"] = max(1000, int(args["duration_ms"]))

            def _entry_id(kind, nm):
                rows = sb.get(f"bible_entries?project_id=eq.{pid}&kind=eq.{kind}"
                              f"&name=ilike.{nm}&select=id")
                if not rows:
                    missing.append(nm)
                return rows[0]["id"] if rows else None

            if isinstance(args.get("cast_names"), list):
                patch["cast_ids"] = [i for i in (_entry_id("character", n)
                                                 for n in args["cast_names"]) if i]
            if args.get("environment_name"):
                patch["environment_id"] = _entry_id("environment", args["environment_name"])
            if not patch:
                return {"error": "nothing to change"}
            sb.patch(f"scenes?id=eq.{scene['id']}", patch)
            # Blocks were planned from the old scene; leaving them planned would
            # render the previous version.
            sb.patch(f"generation_blocks?storyboard_id=eq.{scene['storyboard_id']}"
                     f"&scene_ids=cs.{{{scene['id']}}}&status=in.(planned,generated)",
                     {"status": "stale"})
            out = {"updated_scene_id": scene["id"], "changed": sorted(patch),
                   "note": "blocks covering this scene are stale; its panels "
                           "still show the old scene — redraw_panels"}
            if refit:
                out.update(refit)
                out["note"] += ("; its shots were retimed proportionally, because "
                                "a scene's length IS the sum of its shots")
            if missing:
                out["not_in_bible"] = missing
            return out

        if name == "update_beat":
            beat, err = _resolve_beat(args.get("beat_id"), args.get("scene_id"), pid, eid)
            if beat is None:
                return err
            patch = {}
            for k in ("action", "camera", "sfx"):
                if args.get(k) is not None:
                    patch[k] = args[k]
            if args.get("duration_ms") is not None:
                patch["duration_ms"] = max(500, int(args["duration_ms"]))
            if isinstance(args.get("cast"), list):
                # `meta.cast` is what ref_plan_for reads to decide whose sheets
                # are staged, and until this existed no tool could touch it.
                # Measured 2026-08-15: rewriting the action to "two giant
                # talking plants, no people present" AND clearing the SCENE
                # cast still left Aki and Ren staged twice each plus both
                # voices, because a beat name resolves project-wide once the
                # scene stops casting it.
                #
                # The render came back as plants anyway — for a transformation
                # this explicit the prose beat the pictures, which is the
                # opposite of what "H3 obeys a picture over a sentence"
                # predicts. So this is not a correctness fix; it is a
                # contradiction fix. Six of the eight reference slots were
                # spent arguing with the prompt, and a subtler edit ("she is
                # alone in this shot") has far less prose leverage than this
                # one did.
                meta = dict(beat.get("meta") or {})
                meta["cast"] = [str(n).strip() for n in args["cast"] if str(n).strip()]
                patch["meta"] = meta
            if isinstance(args.get("dialogue"), list):
                lines = []
                for d in args["dialogue"]:
                    who = sb.get(f"bible_entries?project_id=eq.{pid}&kind=eq.character"
                                 f"&name=ilike.{d.get('speaker') or ''}&select=id")
                    line = {"speaker_id": who[0]["id"] if who else None,
                            "speaker": d.get("speaker"), "line": d.get("line")}
                    if d.get("delivery"):
                        line["delivery"] = d["delivery"]
                    if d.get("offscreen"):
                        line["offscreen"] = True
                    lines.append(line)
                patch["dialogue"] = lines
            if not patch:
                return {"error": "nothing to change"}
            sb.patch(f"beats?id=eq.{beat['id']}", patch)
            warnings = []
            if "dialogue" in patch:
                # against the duration this call is SETTING, not the old one
                warnings = _invalidate_dialogue(
                    {**beat, **{k: patch[k] for k in ("duration_ms",) if k in patch}},
                    patch["dialogue"])
            scenes = sb.get(f"scenes?id=eq.{beat['scene_id']}&select=storyboard_id")
            if scenes:
                # `beat['id']`, not the caller's ref: the ref may be a label
                # ("b2"), and a label in a uuid array filter matches nothing —
                # so the edit landed and the block was never marked stale.
                sb.patch(f"generation_blocks?storyboard_id=eq.{scenes[0]['storyboard_id']}"
                         f"&beat_ids=cs.{{{beat['id']}}}&status=in.(planned,generated)",
                         {"status": "stale"})
            # The other direction of the same invariant: lengthen a shot and
            # the scene got longer, whatever its row still said.
            scene_ms = (_sync_scene_duration(beat["scene_id"])
                        if "duration_ms" in patch else None)
            # Say WHICH scene and shot this landed in — see the JS twin. A
            # label pair like ("b2", "S3") resolves silently, so a model that
            # means one scene and names another edits the wrong one and is told
            # only a uuid. Measured exactly that way on Rei E3 v6.
            slugs = sb.get(f"scenes?id=eq.{beat['scene_id']}&select=slug")
            return {"updated_beat_id": beat["id"], "changed": sorted(patch),
                    "scene": (slugs[0].get("slug") if slugs else None),
                    "beat_ref": _shot_ref(beat.get('idx') or 0),
                    **({"warnings": warnings} if warnings else {}),
                    **({"scene_ms": scene_ms} if scene_ms else {}),
                    # TWO things now describe the old shot and only one of
                    # them is marked: the block carries a `stale` status, the
                    # PANEL carries nothing. A model reading only the row
                    # reports the block and silently leaves the picture —
                    # measured on Rei EP03 CITY_CAPTURE_2, six beats rewritten
                    # and six panels left describing the previous shots.
                    "note": "the block covering this beat is stale — "
                            "rerender_block to see the change; the panel on the "
                            "scene card still shows the OLD shot — redraw_panels "
                            "for this scene"}

        if name == "add_scene":
            sbid, at = None, None
            if args.get("after_scene_id"):
                sib, err = _resolve_scene(args["after_scene_id"], pid, eid)
                if sib is None:
                    return err
                sbid, at = sib["storyboard_id"], sib["idx"] + 1
            else:
                sbid = _current_storyboard_id(pid, eid)
                if not sbid:
                    return _no_storyboard(eid)
            siblings = sb.get(f"scenes?storyboard_id=eq.{sbid}&order=idx&select=id,idx")
            if at is None:
                at = len(siblings)
            # Shift from the back: (storyboard_id, idx) must stay unique.
            for sc in sorted([x for x in siblings if x["idx"] >= at],
                             key=lambda x: -x["idx"]):
                sb.patch(f"scenes?id=eq.{sc['id']}", {"idx": sc["idx"] + 1})

            def _name_id(kind, nm):
                rows = sb.get(f"bible_entries?project_id=eq.{pid}&kind=eq.{kind}"
                              f"&name=ilike.{nm}&select=id")
                return rows[0]["id"] if rows else None

            beats = [b for b in (args.get("beats") or []) if b.get("action")]
            if not beats:
                return {"error": "a scene needs at least one beat"}
            scene = sb.insert("scenes", {
                "storyboard_id": sbid, "idx": at, "slug": args.get("slug"),
                "duration_ms": args.get("duration_ms")
                or sum(int(b.get("duration_ms") or 4000) for b in beats),
                "scene_prompt": args.get("scene_prompt"),
                "cast_ids": [i for i in (_name_id("character", n)
                                         for n in args.get("cast_names") or []) if i],
                "environment_id": (_name_id("environment", args["environment_name"])
                                   if args.get("environment_name") else None),
                "status": "draft"})
            for i, b in enumerate(beats):
                dialogue = [{"speaker_id": _name_id("character", d.get("speaker") or ""),
                             "speaker": d.get("speaker"), "line": d.get("line"),
                             **({"delivery": d["delivery"]} if d.get("delivery") else {}),
                             **({"offscreen": True} if d.get("offscreen") else {})}
                            for d in (b.get("dialogue") or [])]
                sb.insert("beats", {
                    "scene_id": scene["id"], "idx": i,
                    "duration_ms": int(b.get("duration_ms") or 4000),
                    "action": b["action"], "camera": b.get("camera"), "sfx": b.get("sfx"),
                    "dialogue": dialogue or None})
            sb.patch(f"generation_blocks?storyboard_id=eq.{sbid}&status=in.(planned,generated)",
                     {"status": "stale"})
            return {"created_scene_id": scene["id"], "idx": at, "beats": len(beats),
                    "note": "the block plan is stale — it is rebuilt at launch"}

        if name == "delete_scene":
            sc, err = _resolve_scene(args.get("scene_id"), pid, eid)
            if sc is None:
                return err
            sb.delete(f"scenes?id=eq.{sc['id']}")                    # beats cascade
            after = sb.get(f"scenes?storyboard_id=eq.{sc['storyboard_id']}"
                           f"&idx=gt.{sc['idx']}&order=idx&select=id,idx")
            for row in after:
                sb.patch(f"scenes?id=eq.{row['id']}", {"idx": row["idx"] - 1})
            sb.patch(f"generation_blocks?storyboard_id=eq.{sc['storyboard_id']}"
                     f"&status=in.(planned,generated)", {"status": "stale"})
            return {"deleted_scene_id": sc["id"], "resequenced": len(after)}

        if name == "add_beat":
            scene, err = _resolve_scene(args.get("scene_id"), pid, eid)
            if scene is None:
                return err
            siblings = sb.get(f"beats?scene_id=eq.{scene['id']}&order=idx&select=id,idx")
            at = len(siblings)
            if args.get("after_beat_id"):
                hit = next((b for b in siblings if b["id"] == args["after_beat_id"]), None)
                if hit:
                    at = hit["idx"] + 1
            for b in sorted([x for x in siblings if x["idx"] >= at], key=lambda x: -x["idx"]):
                sb.patch(f"beats?id=eq.{b['id']}", {"idx": b["idx"] + 1})
            dialogue = []
            for d in args.get("dialogue") or []:
                who = sb.get(f"bible_entries?project_id=eq.{pid}&kind=eq.character"
                             f"&name=ilike.{d.get('speaker') or ''}&select=id")
                dialogue.append({"speaker_id": who[0]["id"] if who else None,
                                 "speaker": d.get("speaker"), "line": d.get("line"),
                                 **({"delivery": d["delivery"]} if d.get("delivery") else {}),
                                 **({"offscreen": True} if d.get("offscreen") else {})})
            beat = sb.insert("beats", {
                "scene_id": scene["id"], "idx": at,
                "duration_ms": int(args.get("duration_ms") or 4000),
                "action": args["action"], "camera": args.get("camera"),
                "sfx": args.get("sfx"), "dialogue": dialogue or None})
            sb.patch(f"generation_blocks?storyboard_id=eq.{scene['storyboard_id']}"
                     f"&status=in.(planned,generated)", {"status": "stale"})
            # Adding a shot lengthens the scene by exactly its duration.
            return {"created_beat_id": beat["id"], "idx": at,
                    "scene_ms": _sync_scene_duration(beat["scene_id"])}

        if name == "delete_beat":
            b, err = _resolve_beat(args.get("beat_id"), args.get("scene_id"), pid, eid)
            if b is None:
                return err
            siblings = sb.get(f"beats?scene_id=eq.{b['scene_id']}&order=idx&select=id,idx")
            if len(siblings) <= 1:
                return {"error": "a scene needs at least one beat — delete the scene instead"}
            sb.delete(f"beats?id=eq.{b['id']}")
            for row in [x for x in siblings if x["idx"] > b["idx"]]:
                sb.patch(f"beats?id=eq.{row['id']}", {"idx": row["idx"] - 1})
            scenes = sb.get(f"scenes?id=eq.{b['scene_id']}&select=storyboard_id")
            if scenes:
                sb.patch(f"generation_blocks?storyboard_id=eq.{scenes[0]['storyboard_id']}"
                         f"&status=in.(planned,generated)", {"status": "stale"})
            return {"deleted_beat_id": b["id"],
                    "scene_ms": _sync_scene_duration(b["scene_id"])}

        if name == "add_outfit_variant":
            cname = (args.get("character") or "").strip()
            rows = sb.get(f"bible_entries?project_id=eq.{pid}&kind=eq.character"
                          f"&name=ilike.{cname}"
                          f"&select=id,name,identity_line,doc,voice_ref_asset_id")
            if not rows:
                return {"error": f'no character named "{cname}" in the bible'}
            parent = rows[0]
            vname = f"{parent['name']} — {args.get('outfit_name', '').strip()}"[:80]
            look = (args.get("outfit_look") or "").strip()
            if not look:
                return {"error": "outfit_look is required — exact pieces with colors"}
            existing = sb.get(f"bible_entries?project_id=eq.{pid}&kind=eq.character"
                              f"&name=ilike.{vname}&select=id")
            if existing:
                variant = existing[0]
            else:
                base = (parent.get("identity_line") or parent["name"]).rstrip(".")
                variant = sb.insert("bible_entries", {
                    "project_id": pid, "kind": "character", "name": vname,
                    "summary": f"{parent['name']} in {args.get('outfit_name')}",
                    "identity_line": f"{base}; now wearing {look}",
                    "doc": {"variant_of": parent["id"], "outfit": look,
                            **({"voice": (parent.get("doc") or {}).get("voice")}
                               if (parent.get("doc") or {}).get("voice") else {})},
                    "status": "draft"})
            proj = sb.get(f"projects?id=eq.{pid}&select=style")
            job = sb.insert("jobs", {
                "kind": "image_gen", "lane": "gpu", "status": "queued", "priority": 20,
                "project_id": pid, "episode_id": eid,
                "payload": {
                    "prompt": f"Change only the clothing: now wearing {look}. Keep "
                              f"the face, hair, build and pose identical.",
                    "prompt_spec": {"kind": "character", "role": "full_body",
                                    "name": vname,
                                    "identity": f"{parent.get('identity_line') or parent['name']}; "
                                                f"now wearing {look}",
                                    "style": (proj[0].get("style") if proj else None)},
                    "mode": "edit", "denoise": 0.75,
                    "anchor_entry_id": parent["id"],
                    "anchor_roles": ["full_body", "face"],
                    "loras": [{"key": "identity", "strength": 1.0}],
                    "width": 1024, "height": 1024,
                    "target": {"bible_entry_id": variant["id"], "role": "full_body",
                               "slot": 0},
                    "auto_accept": True}})
            recast = []
            for ref in args.get("scenes") or []:
                scene, err = _resolve_scene(ref, pid, eid)
                if scene is None:
                    recast.append({"ref": ref, "error": err.get("error")})
                    continue
                row = sb.get(f"scenes?id=eq.{scene['id']}&select=cast_ids,storyboard_id")[0]
                cast = [variant["id"] if c == parent["id"] else c
                        for c in (row.get("cast_ids") or [])]
                if variant["id"] not in cast:
                    cast.append(variant["id"])
                sb.patch(f"scenes?id=eq.{scene['id']}", {"cast_ids": cast})
                sb.patch(f"generation_blocks?storyboard_id=eq.{row['storyboard_id']}"
                         f"&scene_ids=cs.{{{scene['id']}}}&status=in.(planned,generated)",
                         {"status": "stale"})
                recast.append({"ref": ref, "scene_id": scene["id"]})
            return {"variant_entry_id": variant["id"], "name": vname,
                    "sheet_job_id": job["id"], "recast": recast,
                    "note": "the parent's face sheet stays the identity anchor; "
                            "blocks in recast scenes are stale"}

        if name == "redraw_panels":
            # THIS TOOL DOES NOT COMPOSE A PANEL, deliberately. There is one
            # panel generator — llm.scene_panel_specs, twinned in
            # src/lib/panelSpec.ts — and its own docstring names this caller:
            # "a re-draw, a verification, a repair all had to reimplement it
            # and then drift". Composing here would be a third spelling of the
            # plate rotation, the featured-cast matcher and the anchor
            # ordering, and a panel redrawn from the chat would stop being the
            # same picture as one drawn by the button. So this resolves WHICH
            # shots and queues the llm_task that composes them.
            sbid = _current_storyboard_id(pid, eid)
            if not sbid:
                return _no_storyboard(eid)
            if args.get("scene_id"):
                scene, err = _resolve_scene(args["scene_id"], pid, eid)
                if scene is None:
                    return err
                scenes = [scene]
            else:
                scenes = sb.get(f"scenes?storyboard_id=eq.{sbid}&order=idx"
                                f"&select=id,idx,slug")
                if not scenes:
                    return {"error": "this storyboard has no scenes yet"}
            # Shot labels resolve HERE, against the scene that gives them
            # meaning — "b2" is a position, and a label reaching the worker
            # matches no uuid, so the filter would quietly redraw nothing.
            beat_ids = None
            refs = args.get("beat_ids")
            if isinstance(refs, list) and refs:
                if not args.get("scene_id"):
                    return {"error": "beat_ids needs scene_id — a shot label is a "
                                     "position inside one scene"}
                beat_ids = []
                for ref in refs:
                    beat, err = _resolve_beat(ref, args["scene_id"], pid, eid)
                    if beat is None:
                        return err
                    beat_ids.append(beat["id"])
            # Count what will actually RENDER. A breath beat draws no panel
            # (the worker skips it, matching tier 1 and the button), so
            # counting beats would over-quote every scene holding one — and
            # the dry run below is only worth having if the number is honest.
            ids = ",".join(x["id"] for x in scenes)
            rows = sb.get(f"beats?scene_id=in.({ids})&order=idx"
                          f"&select=id,idx,scene_id,meta")
            drawn = [b for b in rows
                     if not (b.get("meta") or {}).get("breath")
                     and (beat_ids is None or b["id"] in beat_ids)]
            if not drawn:
                return {"error": "nothing to draw there — those shots are wordless "
                                 "holds, which get no panel"}
            plan = [r for r in ({"scene": x.get("slug") or _scene_ref(x["idx"]),
                                 "panels": sum(1 for b in drawn
                                               if b["scene_id"] == x["id"])}
                                for x in scenes) if r["panels"]]
            # A FAN-OUT ASKS PERMISSION IN THE TOOL, not in the prose — the
            # rule rerender_stale already follows. A model told "fix the
            # panels" will otherwise redraw a 58-shot board on its own
            # initiative and the bill is the first anyone hears about it. ONE
            # scene needs no confirmation: same scope and same cost as the
            # button already on screen.
            if not args.get("scene_id") and args.get("confirm") is not True:
                return {"would_redraw": plan, "panels": len(drawn),
                        "confirm_required": True,
                        "note": f"{len(drawn)} panel(s) across {len(plan)} scene(s) — "
                                f"call again with confirm:true to queue them"}
            payload = {"task": "redraw_panels", "project_id": pid, "episode_id": eid,
                       "scene_ids": [x["id"] for x in scenes],
                       "label": f"{plan[0]['scene'] if plan else 'storyboard'} · "
                                f"redraw {len(drawn)} panel(s)"}
            if beat_ids is not None:
                payload["beat_ids"] = beat_ids
            # A catalog id is not a model_map key and the worker resolves
            # against model_map. Omitted rather than sent empty, so the worker
            # falls back to the project's own image model.
            mk = _model_key(args.get("model_key"))
            if mk:
                payload["image_model"] = mk
            job = sb.insert("jobs", {
                "kind": "llm_task", "lane": "llm", "status": "queued",
                "priority": USER_PRIORITY, "project_id": pid, "episode_id": eid,
                "payload": payload})
            return {"job_id": job["id"], "panels": len(drawn), "scenes": plan,
                    "note": "queued — each panel lands on its shot as it finishes. "
                            "A still the user pinned themselves is left alone."}

        if name == "list_timelines":
            return {"timelines": _list_cuts(sb, pid, args.get("episode_id") or eid)}

        if name == "render_timeline":
            # VALIDATED, because the alternative is a job that queues cleanly,
            # waits for a worker and then dies on the pod reading a row that is
            # not there. The error names the real cuts, so the next call is
            # right instead of being another guess.
            cuts = _list_cuts(sb, pid, eid)
            want = next((t for t in cuts if t["id"] == args.get("timeline_id")), None)
            if not want:
                return {"error": f"no cut {args.get('timeline_id')} on this episode",
                        "timelines": cuts}
            job = sb.insert("jobs", {
                "kind": "tl_render", "lane": "cpu", "status": "queued", "priority": 30,
                "project_id": pid, "episode_id": eid,
                "payload": {"timeline_id": args.get("timeline_id")},
            })
            return {"job_id": job["id"], "rendering": want["name"]}

        # ------------------------------------------------------- editing ----
        if name == "list_blocks":
            sid = _current_storyboard_id(pid, eid, args.get("storyboard_id"))
            if not sid:
                return _no_storyboard(eid)
            blocks = sb.get(f"generation_blocks?storyboard_id=eq.{sid}&order=idx"
                            f"&select=id,idx,scene_ids,beat_ids,t_start_ms,t_end_ms,status,mode,"
                            f"active_take_id,chain_from_block_id,params")
            scene_name = {s["id"]: s.get("slug") for s in
                          sb.get(f"scenes?storyboard_id=eq.{sid}&select=id,slug")}
            # The first shot's action, so "the block where she takes the
            # helmet off" resolves against what the blocks CONTAIN rather than
            # against scene names alone. A clip-born block has no beats; its
            # recipe's prompt stands in.
            first_ids = list(dict.fromkeys(
                (b.get("beat_ids") or [None])[0] for b in blocks if (b.get("beat_ids") or [])))
            first_action = ({r["id"]: r.get("action") for r in sb.get(
                "beats?id=in.(%s)&select=id,action" % ",".join(first_ids))}
                if first_ids else {})
            out = []
            for b in blocks:
                kind = _block_kind(b)
                rec = (b.get("params") or {}).get("clip_gen")
                first = (first_action.get((b.get("beat_ids") or [None])[0])
                         if (b.get("beat_ids") or [])
                         else (rec.get("prompt") if isinstance(rec, dict) else None))
                out.append({
                    "ref": _block_label(b), "block_id": b["id"],
                    # "Extension 19" / "Chain 17" / "Block 20": the noun the
                    # sidebar and the lane use.
                    "label": _kind_label(kind, b["idx"]), "kind": kind,
                    **({"first_shot": " ".join(str(first).split())[:120]} if first else {}),
                    "scenes": [scene_name.get(s) for s in (b.get("scene_ids") or [])],
                    "at": f"{b['t_start_ms'] / 1000:.1f}-{b['t_end_ms'] / 1000:.1f}s",
                    "status": b["status"], "mode": b.get("mode"),
                    "has_take": bool(b.get("active_take_id")),
                    "chained": bool(b.get("chain_from_block_id")),
                    })
            return {"storyboard_id": sid, "blocks": out}

        if name == "get_block":
            block, err = _resolve_block(args.get("block"), pid, eid=eid)
            if block is None:
                return err
            beats = sb.get(f"beats?id=in.({','.join(block['beat_ids'])})"
                           f"&select=id,idx,action,camera,duration_ms,dialogue,meta,scene_id"
                           ) if block.get("beat_ids") else []
            beats.sort(key=lambda b: block["beat_ids"].index(b["id"]))
            takes = sb.get(f"block_takes?block_id=eq.{block['id']}&order=created_at"
                           f"&select=id,kind,state,asset_id,created_at")
            params = block.get("params") or {}
            kind = _block_kind(block)
            return {
                "ref": _block_label(block), "block_id": block["id"],
                "label": _kind_label(kind, block["idx"]), "kind": kind,
                **({"clip_born": True,
                    "recipe_prompt": str((params.get("clip_gen") or {}).get("prompt") or "")[:400],
                    "note": "This block renders from its stored recipe (an extension, a "
                            "chain or a promoted clip), not from beats: update_beat and "
                            "rerender_block notes do not change it. edit_video changes "
                            "what it shows; add_block adds a real shot beside it."}
                   if _is_clip_born(block) else {}),
                "status": block["status"], "mode": block.get("mode"),
                "seconds": _block_seconds(block),
                "active_take_id": block.get("active_take_id"),
                "chained_from": block.get("chain_from_block_id"),
                "renders_on": (_model_key(params.get("model_key")) or _project_video_key(pid)
                               or "the worker's default (plain MiniMax H3)"),
                "loras": params.get("loras") or [],
                "shots": [{"beat_id": b["id"], "ref": _shot_ref(b['idx']),
                           "action": b.get("action"), "camera": b.get("camera"),
                           "seconds": (b.get("duration_ms") or 0) / 1000,
                           "dialogue": [{"speaker": d.get("speaker"), "line": d.get("line"),
                                         "delivery": d.get("delivery")}
                                        for d in (b.get("dialogue") or [])],
                           "has_still": bool((b.get("meta") or {}).get("still_asset_id")
                                             or (b.get("meta") or {}).get("panel_asset_id"))}
                          for b in beats],
                "references": [{"purpose": e.get("purpose"), "label": e.get("label")
                                or e.get("name"), "role": e.get("role")}
                               for e in (block.get("ref_plan") or [])],
                "takes": [{"index": i + 1, "take_id": t["id"], "kind": t["kind"],
                           "state": t["state"], "asset_id": t.get("asset_id"),
                           "active": t["id"] == block.get("active_take_id"),
                           }
                          for i, t in enumerate(takes)]}

        if name == "list_takes":
            block, err = _resolve_block(args.get("block"), pid, eid=eid)
            if block is None:
                return err
            takes = sb.get(f"block_takes?block_id=eq.{block['id']}&order=created_at"
                           f"&select=id,kind,state,asset_id,created_at")
            return {"block": _block_label(block), "takes": [
                {"index": i + 1, "take_id": t["id"], "kind": t["kind"], "state": t["state"],
                 "active": t["id"] == block.get("active_take_id"),
                 "made": t.get("created_at")}
                for i, t in enumerate(takes)]}

        if name == "activate_take":
            block, err = (_resolve_block(args.get("block"), pid, eid=eid) if args.get("block")
                          else (None, None))
            take_id = args.get("take_id")
            if not take_id:
                if block is None:
                    return err or {"error": "pass take_id, or block plus index"}
                takes = sb.get(f"block_takes?block_id=eq.{block['id']}&order=created_at"
                               f"&select=id")
                i = int(args.get("index") or 0)
                if not 1 <= i <= len(takes):
                    return {"error": f"index {i} is out of range — this block has "
                                     f"{len(takes)} take(s)"}
                take_id = takes[i - 1]["id"]
            rows = sb.get(f"block_takes?id=eq.{take_id}&select=id,block_id")
            if not rows:
                return {"error": "take not found"}
            bid = rows[0]["block_id"]
            if block is None:
                block = sb.get(f"generation_blocks?id=eq.{bid}&select=*")[0]
            sb.patch(f"block_takes?id=eq.{take_id}", {"state": "kept"})
            sb.patch(f"generation_blocks?id=eq.{bid}", {"active_take_id": take_id})
            # The chain anchor just moved, so every chained block after this one
            # opens on a frame that no longer exists in the cut.
            sb.patch(f"generation_blocks?storyboard_id=eq.{block['storyboard_id']}"
                     f"&idx=gt.{block['idx']}&chain_from_block_id=not.is.null"
                     f"&status=in.(generated,stale)", {"status": "stale"})
            return {"block": _block_label(block), "active_take_id": take_id,
                    "note": "later chained blocks are now stale — "
                            "rerender_stale if the joins matter"}

        if name == "rerender_block":
            block, err = _resolve_block(args.get("block"), pid, eid=eid)
            if block is None:
                return err
            dep = None
            if block.get("chain_from_block_id"):
                prior = _pending_rerender_for(block["chain_from_block_id"], pid)
                if prior:
                    dep = [prior]
            # Pictures handed over for THIS shot are staged before the job is
            # written, and they force a recompute — a plan that is not rebuilt
            # is a plan the attachment never reached.
            refs = _apply_user_refs(block, args)
            if refs and refs["staged"]:
                args = {**args, "recompute_refs": True}
            job, renders_on, instead_of = _queue_rerender(block, args, pid, eid, depends_on=dep)
            kind = _block_kind(block)
            out = {"job_id": job["id"], "block": _block_label(block),
                   "label": _kind_label(kind, block["idx"]), "kind": kind,
                   "activate": args.get("activate") or "replace",
                   "renders_on": renders_on,
                   **({"instead_of": instead_of} if instead_of else {}),
                   "shots": _block_shots(block),
                   "note": "queued at user priority; it renders next. `shots` is "
                           "the prose it will render — check it says what you "
                           "meant before moving on."}
            if _is_clip_born(block):
                out["note"] = ("queued. This block is clip-born (an extension, a chain "
                               "or a promoted clip): it re-renders from its stored "
                               "recipe, not from beats, so notes and beat edits do not "
                               "reach it — edit_video or a new add_block are the tools "
                               "that change what it shows.")
            if refs:
                out["references"] = refs["staged"]
                if refs["not_found"]:
                    out["refs_not_found"] = refs["not_found"]
            if dep:
                out["after"] = "waits for the queued re-render of the block it "
                out["after"] += "chains from, so it opens on the NEW final frame"
            return out

        if name == "rerender_stale":
            sid = _current_storyboard_id(pid, eid)
            if not sid:
                return _no_storyboard(eid)
            q = (f"generation_blocks?storyboard_id=eq.{sid}&status=eq.stale&order=idx"
                 f"&select=*")
            blocks = sb.get(q)
            scope = str(args.get("scope") or "all").strip()
            if scope and scope.lower() != "all":
                scene, serr = _resolve_scene(scope, pid, eid)
                if scene is None:
                    return serr
                blocks = [b for b in blocks if scene["id"] in (b.get("scene_ids") or [])]
            if not blocks:
                return {"blocks": [], "note": "nothing is stale — everything on screen "
                                              "matches its plan"}
            listing = [{"ref": _block_label(b), "seconds": _block_seconds(b)} for b in blocks]
            total_s = sum(x["seconds"] for x in listing)
            # A dry run by default. This is the one tool that can spend real
            # money at scale, and a model that has just been told "fix it" will
            # otherwise re-render an episode on its own initiative.
            if not args.get("confirm"):
                return {"dry_run": True, "blocks": listing,
                        "total_seconds": round(total_s, 1),
                        "note": f"{len(listing)} block(s) would be re-rendered. Show the "
                                f"user this list and call again with confirm=true only "
                                f"after they agree."}
            jobs, prev = [], None
            for b in blocks:
                # Chained blocks must render in order — a successor's opening
                # frame is its predecessor's last one.
                dep = [prev] if (prev and b.get("chain_from_block_id")) else None
                job, _, _sw = _queue_rerender(b, args, pid, eid, depends_on=dep, suffix=" (stale)")
                jobs.append({"ref": _block_label(b), "job_id": job["id"]})
                prev = job["id"]
            return {"queued": jobs, "total_seconds": round(total_s, 1)}

        if name == "add_block":
            after, err = ((_resolve_block(args["after_block"], pid, eid=eid))
                          if args.get("after_block") else (None, None))
            if args.get("after_block") and after is None:
                return err
            before, berr = ((_resolve_block(args["before_block"], pid, eid=eid))
                            if args.get("before_block") else (None, None))
            if args.get("before_block") and before is None:
                return berr
            if after is not None and before is not None:
                return {"error": "give after_block OR before_block, not both"}
            return _add_block(args, pid, eid, after, before)

        if name == "generate_clip":
            job = sb.insert("jobs", {
                "kind": "clip_gen", "lane": "gpu", "status": "queued",
                "priority": USER_PRIORITY, "project_id": pid, "episode_id": eid,
                "model_id": "h3-local",
                "payload": {k: v for k, v in {
                    "prompt": args["prompt"],
                    "mode": args.get("mode") or ("r2v" if args.get("ref_asset_ids")
                                                 else "t2v"),
                    "model_key": _model_key(args.get("model_key")),
                    "loras": args.get("loras"),
                    "ref_asset_ids": args.get("ref_asset_ids"),
                    "start_asset_id": args.get("start_asset_id"),
                    "end_asset_id": args.get("end_asset_id"),
                    "duration_ms": args.get("duration_ms"),
                    "seed": args.get("seed"),
                    "project_id": pid,
                    "label": f"clip · {str(args['prompt'])[:48]}",
                }.items() if v is not None}})
            return {"job_id": job["id"], "note": "a standalone clip — it lands in the library"}

        if name == "generate_music":
            key = args.get("model_key") or "minimax-music3"
            ace = key.startswith("acestep")
            target = None
            if args.get("attach"):
                sid = _current_storyboard_id(pid, eid)
                if not sid:
                    return {"error": "no storyboard to attach a master track to — plan one first"}
                target = {"storyboard_id": sid}
            job = sb.insert("jobs", {
                "kind": "music_gen", "lane": "gpu", "status": "queued",
                "priority": USER_PRIORITY, "project_id": pid, "episode_id": eid,
                "model_id": f"{key}-local",
                "payload": {k: v for k, v in {
                    "prompt": args["prompt"],
                    "lyrics": args.get("lyrics"),
                    "instrumental": args.get("instrumental"),
                    "duration_ms": args.get("duration_ms"),
                    # Verbatim, unlike video/image: the music catalog ids ARE
                    # their model_map keys plus "-local", so there is no
                    # exception table to route this through.
                    "model_key": key,
                    # Only where the model has the input. On Music 3 these are
                    # payload keys nothing reads, and a bpm there would quietly
                    # not be the tempo — the caption sets that.
                    "bpm": args.get("bpm") if ace else None,
                    "key_scale": args.get("key_scale") if ace else None,
                    "time_signature": args.get("time_signature") if ace else None,
                    "seed": args.get("seed"),
                    "target": target,
                    "project_id": pid,
                    "label": f"music · {str(args['prompt'])[:48]}",
                }.items() if v is not None}})
            out = {"job_id": job["id"],
                   "note": ("rendering — it becomes the episode's master track when it "
                            "lands, and the storyboard page shows it there") if target
                           else "rendering — it lands in the library"}
            if not ace and (args.get("bpm") or args.get("key_scale")):
                out["warning"] = ("MiniMax Music 3 has no BPM or key inputs — put the "
                                  "tempo and key in the caption prose instead. They "
                                  "were dropped.")
            return out

        if name == "edit_video":
            block = None
            if args.get("block"):
                block, err = _resolve_block(args["block"], pid, eid=eid)
                if block is None:
                    return err
            job = sb.insert("jobs", {
                "kind": "video_edit", "lane": "gpu", "status": "queued",
                "priority": USER_PRIORITY, "project_id": pid, "episode_id": eid,
                "model_id": "h3-local",
                "payload": {k: v for k, v in {
                    "source_asset_id": args["source_asset_id"],
                    "prompt": args["prompt"],
                    "ref_asset_ids": args.get("ref_asset_ids"),
                    "seed": args.get("seed"),
                    "block_id": block["id"] if block else None,
                    "label": f"edit · {str(args['prompt'])[:48]}",
                }.items() if v is not None}})
            return {"job_id": job["id"],
                    **({"block": _block_label(block)} if block else {})}

        if name == "add_take":
            block, err = _resolve_block(args.get("block"), pid, eid=eid)
            if block is None:
                return err
            asset = sb.asset_by_id(args["asset_id"])
            if not asset:
                return {"error": "asset not found"}
            if asset.get("kind") != "video":
                return {"error": f"a take must be a video — that asset is a {asset.get('kind')}"}
            take = sb.insert("block_takes", {
                "block_id": block["id"], "asset_id": asset["id"], "kind": "edit",
                "state": "kept" if args.get("activate") else "pending"})
            if args.get("activate"):
                sb.patch(f"generation_blocks?id=eq.{block['id']}",
                         {"active_take_id": take["id"], "status": "generated"})
            return {"take_id": take["id"], "block": _block_label(block),
                    "active": bool(args.get("activate"))}

        if name == "set_block_params":
            block, err = _resolve_block(args.get("block"), pid, eid=eid)
            if block is None:
                return err
            params = dict(block.get("params") or {})
            changed = []
            if args.get("model_key"):
                params["model_key"] = _model_key(args["model_key"])
                changed.append("model_key")
            if isinstance(args.get("loras"), list):
                params["loras"] = args["loras"]
                changed.append("loras")
            if args.get("steps") is not None:
                params["steps"] = int(args["steps"])
                changed.append("steps")
            patch = {"params": params}
            if args.get("mode"):
                # A MODE THAT CANNOT RENDER IS REFUSED HERE, NOT AT RENDER TIME.
                # `handle_master_pass` raises on an flf block with no closing
                # frame, and nothing in either director toolset can set one —
                # `ref_plan_for` never emits an `end_frame` entry, only
                # PromptRefsModal's UI does. So "switch it to flf" used to store
                # a mode, report success, queue a render, and fail minutes later
                # on the pod with the block already marked queued. The twin of
                # this guard lives in api/director/chat.js.
                rp = block.get("ref_plan") or []
                has_end = any(e.get("purpose") == "end_frame" and e.get("asset_id")
                              for e in rp)
                has_open = bool(block.get("chain_from_block_id")) or any(
                    e.get("purpose") == "start_frame" and e.get("asset_id") for e in rp)
                if args["mode"] == "flf" and not has_end:
                    return {"error":
                            f"block {block.get('idx')} has no closing frame, and "
                            f"first-last-frame needs one — the render would fail "
                            f"on the pod, not here. Mark an image as the end "
                            f"frame in the block's prompt & references panel, "
                            f"then set the mode."}
                if args["mode"] in ("i2v", "flf") and not has_open:
                    return {"error":
                            f"block {block.get('idx')} is not chained and has no "
                            f"start frame, so {args['mode']} has nothing to open "
                            f"on. Chain it to the previous block or mark a start "
                            f"frame first."}
                patch["mode"] = args["mode"]        # a column, not a param
                changed.append("mode")
            if args.get("seed") is not None:
                patch["seed"] = int(args["seed"])
                changed.append("seed")
            if not changed:
                return {"error": "nothing to change"}
            sb.patch(f"generation_blocks?id=eq.{block['id']}", patch)
            return {"block": _block_label(block), "changed": changed,
                    "note": "stored — rerender_block to render with it"}

        if name == "set_beat_image":
            beat, err = _resolve_beat(args.get("beat_id"), args.get("scene_id"), pid, eid)
            if beat is None:
                return err
            asset = sb.asset_by_id(args["asset_id"])
            if not asset:
                return {"error": "asset not found"}
            purpose = args.get("purpose") or "look"
            meta = dict(beat.get("meta") or {})
            # The two keys are opposite instructions, so writing one must clear
            # the other — a beat that is both "open on this frame" and "follow
            # this look, ignore its framing" is a contradiction the compiler
            # would resolve arbitrarily.
            meta.pop("start_frame_asset_id", None)
            meta.pop("still_asset_id", None)
            meta["start_frame_asset_id" if purpose == "start_frame"
                 else "still_asset_id"] = asset["id"]
            sb.patch(f"beats?id=eq.{beat['id']}", {"meta": meta})
            scenes = sb.get(f"scenes?id=eq.{beat['scene_id']}&select=storyboard_id")
            if scenes:
                sb.patch(f"generation_blocks?storyboard_id=eq.{scenes[0]['storyboard_id']}"
                         f"&beat_ids=cs.{{{beat['id']}}}&status=in.(planned,generated)",
                         {"status": "stale"})
            return {"beat_id": beat["id"], "purpose": purpose,
                    "note": "rerender_block with recompute_refs to stage it"}

        if name == "list_voices":
            import dialogue_synth as DS
            rows = [{"voice_id": v[0], "name": v[1], "gender": v[2],
                     "reads_as": list(v[3])} for v in DS.VOICE_TABLE]
            if args.get("gender"):
                rows = [r for r in rows if r["gender"] == args["gender"]]
            # The project's own ElevenLabs clones are castable voices too, and
            # listing them is the discovery half of that: a voice the director
            # cannot see is one it can never pass to recast_voice. No gender
            # filter — nothing recorded one, and guessing from a name is how
            # Mrs. Katagiri ended up speaking as George.
            rows += [{"voice_id": c["reference_id"], "name": c.get("name") or "clone",
                      "gender": None, "cloned": True, "reads_as": []}
                     for c in sb.get(f"voice_clones?provider=eq.elevenlabs"
                                     f"&status=eq.ready&reference_id=not.is.null"
                                     f"&select=name,reference_id,project_id")
                     if c.get("reference_id") and c.get("project_id") in (pid, None)]
            return {"voices": rows}

        if name == "redraw_sheets":
            # Any KIND — the tool is about an entry, and the two shapes differ
            # only in which roles they read and produce. Props are excluded
            # because `_sheet_refs` has no ranking for them.
            rows = sb.get(f"bible_entries?project_id=eq.{pid}"
                          f"&kind=in.(character,environment)"
                          f"&name=ilike.*{args['entry']}*&select=id,name,kind")
            if not rows:
                return {"error": f"no character or location matching "
                                 f"\"{args['entry']}\""}
            # AMBIGUITY IS A MISS, NOT A GUESS — the rule `match_brief_name`
            # and `resolveScene` already follow. Measured: "Katagiri" matches
            # the CHARACTER Mrs. Katagiri and the LOCATION Katagiri Print, and
            # taking rows[0] redrew a person's plates when a shop was asked
            # for. That is expensive, wrong, and reads as the tool ignoring
            # you. An exact name still resolves; anything else comes back as
            # the list, so the next call is right instead of another guess.
            if len(rows) > 1:
                exact = [r for r in rows
                         if (r["name"] or "").lower() == args["entry"].strip().lower()]
                if len(exact) != 1:
                    return {"error": f"\"{args['entry']}\" matches "
                                     f"{len(rows)} entries — name one exactly",
                            "candidates": [{"name": r["name"], "kind": r["kind"]}
                                           for r in rows[:12]]}
                rows = exact
            entry = rows[0]
            # PRE-FLIGHT, not a second implementation: a coverage take
            # conditions on the plates already on file, so an entry with none
            # raises inside the handler after it has been claimed and staged.
            # Same ranking as `handlers/orbit._sheet_refs`, and the handler
            # still resolves the real set — a disagreement here costs a
            # refusal, not a wrong render.
            roles = ("face,turnaround,full_body,outfit,side"
                     if entry["kind"] == "character"
                     else "master,coverage,alt_angle,detail,atmosphere")
            live = sb.get(f"bible_assets?entry_id=eq.{entry['id']}"
                          f"&role=in.({roles})&slot=lt.90&select=role")
            if not live:
                first = "face" if entry["kind"] == "character" else "master"
                return {"error": f"'{entry['name']}' has no reference plate to "
                                 f"build from — draw its {first} plate first, "
                                 f"then redraw the set as one take"}
            # Deliberately NOT archiving here. The handler retires what it
            # replaces once the render lands, and it reads live rows only —
            # archiving first would withdraw the very pictures the take is
            # built from.
            job = sb.insert("jobs", {
                "kind": "orbit_sheet", "lane": "gpu", "status": "queued",
                "priority": USER_PRIORITY, "project_id": pid,
                "payload": {"entry_id": entry["id"], "sheet_mode": "coverage",
                            **({"model_key": args["model_key"]}
                               if args.get("model_key") else {}),
                            "label": f"{entry['name'].split(' — ')[0][:44]} "
                                     f"· coverage sheet"}})
            return {"entry": entry["name"], "kind": entry["kind"],
                    "job_id": job["id"],
                    "building_from": sorted({r["role"] for r in live}),
                    "renders_on": args.get("model_key") or "minimax-h3-pdd",
                    "note": "one take, every view; it replaces this entry's "
                            "plates when it lands and archives the old ones"}

        if name == "recast_voice":
            import dialogue_synth as DS
            rows = sb.get(f"bible_entries?project_id=eq.{pid}&kind=eq.character"
                          f"&name=ilike.*{args['character']}*"
                          f"&select=id,name,doc,identity_line")
            if not rows:
                return {"error": f"no character matching \"{args['character']}\""}
            entry = rows[0]
            voice_id = args.get("voice_id")
            # A BREEZE-cast character (or a project asking for Breeze) is
            # recast by DESIGNING a new voice from the requirements — there is
            # no table to pick from; the description IS the voice. The designed
            # clip replaces the timbre reference directly, so no tts job.
            _edoc = dict(entry.get("doc") or {})
            _want_breeze = (str(args.get("provider") or "").lower() == "breeze"
                            or (not voice_id and _edoc.get("voice_provider") == "breeze"))
            if _want_breeze:
                if not DS.breeze_enabled():
                    return {"error": "Breeze TTS is not serving on this box — "
                                     "pick an ElevenLabs voice_id instead"}
                if args.get("requirements"):
                    _edoc["voice"] = str(args["requirements"])[:300]
                _edoc.pop("breeze_voice", None)
                entry["doc"] = _edoc
                vid = DS.cast_breeze_voice(entry, pid)
                cleared = _clear_voice_pins(entry, pid)
                return {"character": entry["name"], "voice_id": vid,
                        "provider": "breeze", "designed_from": _edoc.get("voice"),
                        "cleared_pins": cleared,
                        "note": "re-render the blocks they speak in"}
            if not voice_id:
                taken = {(e.get("doc") or {}).get("el_voice_id")
                         for e in sb.get(f"bible_entries?project_id=eq.{pid}"
                                         f"&kind=eq.character&select=doc")
                         if (e.get("doc") or {}).get("el_voice_id")}
                taken.discard((entry.get("doc") or {}).get("el_voice_id"))
                voice_id = DS.cast_voice(args.get("requirements") or "",
                                         taken, entry.get("identity_line") or "")
            # The library voices PLUS this project's own ElevenLabs clones.
            # `voice_clones.reference_id` on that provider IS an ElevenLabs
            # voice id — the same kind of value `doc.el_voice_id` holds — so a
            # cloned voice can carry a character for a whole episode. Without
            # this line the guard rejected it as "not a voice", which is both
            # wrong and the last place anyone would look: the clone renders
            # perfectly in the studio panel and simply cannot be cast.
            known = {v[0]: v[1] for v in DS.VOICE_TABLE}
            known.update({
                c["reference_id"]: c.get("name") or "cloned voice"
                for c in sb.get(f"voice_clones?provider=eq.elevenlabs"
                                f"&status=eq.ready&reference_id=not.is.null"
                                f"&select=name,reference_id,project_id")
                if c.get("reference_id")
                and c.get("project_id") in (pid, None)})
            if voice_id not in known:
                return {"error": f"'{voice_id}' is not a voice — call list_voices"}
            doc = dict(entry.get("doc") or {})
            doc["el_voice_id"] = voice_id
            sb.patch(f"bible_entries?id=eq.{entry['id']}", {"doc": doc})
            # Their recorded lines are keyed by the OLD voice, and the timbre
            # anchor was synthesized in it too. Both have to go, or the render
            # keeps speaking in the voice that was just replaced.
            sb.patch(f"bible_entries?id=eq.{entry['id']}", {"voice_ref_asset_id": None})
            cleared = _clear_voice_pins(entry, pid)
            job = sb.insert("jobs", {
                "kind": "tts", "lane": "api", "status": "queued",
                "priority": USER_PRIORITY, "project_id": pid, "episode_id": eid,
                "payload": {"text": f"This is {entry['name'].split(' — ')[0]}. "
                                    f"{(entry.get('identity_line') or '')[:160]}",
                            "bible_entry_id": entry["id"],
                            "label": f"{entry['name']} · voice ref"}})
            return {"character": entry["name"], "voice_id": voice_id,
                    "voice_name": known[voice_id], "voice_ref_job_id": job["id"],
                    "stale_blocks": cleared,
                    "note": "their recordings were dropped; rerender_stale to hear it"}

        if name == "inspect_take":
            take_id, asset_id = args.get("take_id"), args.get("asset_id")
            if not take_id and not asset_id:
                block, err = _resolve_block(args.get("block"), pid, eid=eid)
                if block is None:
                    return err
                take_id = block.get("active_take_id")
                if not take_id:
                    return {"error": f"{_block_label(block)} has no take to look at yet"}
            job = sb.insert("jobs", {
                "kind": "llm_task", "lane": "llm", "status": "queued",
                "priority": USER_PRIORITY, "project_id": pid, "episode_id": eid,
                # `model_id` is load-bearing, not decoration: worker.py only
                # holds the GPU semaphore for an llm-lane job whose model_id
                # starts with "ollama". Without it the judge (18GB) loads
                # beside a render instead of waiting for it — the pool lane
                # runs concurrently with the gpu lane by design.
                "model_id": "ollama-local",
                "payload": {k: v for k, v in {
                    "task": "vlm_query", "take_id": take_id, "asset_id": asset_id,
                    "question": args["question"],
                    "label": f"look · {str(args['question'])[:48]}",
                }.items() if v is not None}})
            return {"job_id": job["id"],
                    "note": "frames are being looked at — call get_job with this id "
                            "for the answer"}

        if name == "get_job":
            rows = sb.get(f"jobs?id=eq.{args['job_id']}"
                          f"&select=id,kind,status,progress,progress_note,error_msg,"
                          f"payload,output_asset_id")
            if not rows:
                return {"error": "job not found"}
            j = rows[0]
            return {"job_id": j["id"], "kind": j["kind"], "status": j["status"],
                    "progress": j.get("progress"), "note": j.get("progress_note"),
                    **({"error": j["error_msg"]} if j.get("error_msg") else {}),
                    **({"output_asset_id": j["output_asset_id"]}
                       if j.get("output_asset_id") else {}),
                    **({"result": (j.get("payload") or {}).get("result")}
                       if (j.get("payload") or {}).get("result") else {})}

        if name == "delete_bible_entry":
            eid_ = args.get("entry_id")
            if not eid_ and args.get("name"):
                rows = sb.get(f"bible_entries?project_id=eq.{pid}"
                              f"&name=ilike.*{args['name']}*&select=id,name,status")
                if not rows:
                    return {"error": f"no entry matching \"{args['name']}\""}
                eid_, entry = rows[0]["id"], rows[0]
            else:
                rows = sb.get(f"bible_entries?id=eq.{eid_}&select=id,name,status")
                if not rows:
                    return {"error": "entry not found"}
                entry = rows[0]
            if entry.get("status") != "draft":
                return {"error": f"\"{entry['name']}\" is confirmed canon — scenes "
                                 f"reference it. Only drafts can be deleted here."}
            sb.delete(f"bible_entries?id=eq.{eid_}")
            return {"deleted": entry["name"]}

        if name == "propose_options":
            opts = args.get("options") or []
            if not 2 <= len(opts) <= 3:
                return {"error": "offer two or three options"}
            clean = []
            for i, o in enumerate(opts):
                if not isinstance(o, dict) or not o.get("tool"):
                    return {"error": "each option needs a label and a tool to run"}
                if o["tool"] not in TOOL_NAMES:
                    return {"error": f"'{o['tool']}' is not a tool"}
                clean.append({"id": f"opt{i + 1}", "label": o.get("label") or f"Option {i + 1}",
                              "detail": o.get("detail"), "tool": o["tool"],
                              "args": o.get("args") or {},
                              "preview_asset_id": o.get("preview_asset_id")})
            # Rendered as buttons; nothing runs until the user picks one.
            return {"choice": {"question": args["question"], "options": clean}}

        return {"error": f"unknown tool {name}"}
    except Exception as e:                      # noqa: BLE001 — see docstring
        return {"error": f"{type(e).__name__}: {str(e)[:200]}"}


def truncate(result, limit=6000):
    """Tool results go back into context; a whole storyboard can blow a 32B
    model's window on its own."""
    s = json.dumps(result, default=str)
    return s if len(s) <= limit else s[:limit] + f"… (truncated, {len(s)} chars)"
