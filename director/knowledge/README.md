# Craft guides the planner reads

Every `.md` in this directory is read off disk at run time by
`worker/llm.py::builtin_knowledge` and handed to the planning stages as
grounding. The files here are this project's own: shot grammar, blocking,
VFX staging, the music-video and comedy notes, and a distillation of how a
MiniMax H3 prompt is put together (`h3_prompt_craft.md`).

Which of them load depends on who is in the room — the wizard's expert
checkboxes map to `llm.EXPERTS`, and a medium's own guide always loads. Adding
a file is not enough on its own: name it from an expert's list, from
`MEDIUM_DOCS`, or from a model's entry in `director/prompt_guides.js`.

## The two vendor documents are NOT here

`director/prompt_guides.js` names `h3_official_base_modes.md` and
`h3_official_ref_mode.md`, and `worker/llm.py::format_reference` looks for the
first of them. Those are **MiniMax's own prompt-writing guides for H3** —
several thousand words of theirs, describing the exact envelope the model was
trained to read. This project has no licence to redistribute them, so they are
not in this repository and not in the installer.

Nothing breaks without them. `_read_knowledge` returns `""` for a file that is
not there and `format_reference` returns `""` in turn, so a plan runs on the
craft guides alone; what it loses is the planner knowing precisely what its
beats compile into. If you want that back, put MiniMax's two guides in this
directory under exactly those two filenames and the code picks them up on the
next run — no rebuild, no configuration.

Worth knowing either way: the guides are what the planner READS, never what it
writes. The H3 prompt format is produced by deterministic Python
(`worker/h3_prompt.py`), never by a model — see `h3_prompt_craft.md` and the
compiler's own header.
