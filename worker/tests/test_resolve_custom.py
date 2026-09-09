"""The slot map is written by TypeScript and read by Python, so it drifts.

`src/lib/workflowAdapter.ts` decides what a slot IS (`detectSlots`) and what
writing one means (`applySlots`); `worker/resolve_custom.py` is what actually
writes them at render time. Nothing connects the two but a shared shape, and
the failure mode is the quiet one: a slot the browser tags under a name the
worker does not read is simply never written, and the author's own prompt
renders instead of the user's.

So the first test parses the TypeScript. The rest pin the behaviour that makes
a custom render safe rather than merely possible.
"""

import json
import pathlib
import re
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "worker"))

import resolve_custom as RC                                   # noqa: E402

ADAPTER = (ROOT / "src" / "lib" / "workflowAdapter.ts").read_text()


def _ts_slot_keys():
    """The keys of the SlotMap interface in the TypeScript."""
    body = re.search(r"export interface SlotMap \{(.*?)\n\}", ADAPTER, re.S).group(1)
    # `prompt?: Slot;` / `size?: SizeSlot;` / `output?: {...}[];`
    return {m.group(1) for m in re.finditer(r"^\s{2}(\w+)\?:", body, re.M)}


def test_every_slot_the_browser_can_tag_is_one_the_worker_reads_or_ignores_on_purpose():
    ts = _ts_slot_keys()
    # What apply_slots writes, read out of the source so the test cannot drift
    # from it either.
    src = pathlib.Path(RC.__file__).read_text()
    written = set(re.findall(r'\("(\w+)", "[^"]+"\)', src)) | {"size"}

    # Slots the worker deliberately does not WRITE, with the reason:
    ignored = {
        "output": "read by outputs_of(), not written",
        "refs": "H3-specific staging; a custom graph declares its own inputs",
        "model": "an imported graph names its own checkpoint — the studio does "
                 "not substitute one, or it would render something else entirely",
    }
    unaccounted = ts - written - set(ignored)
    assert not unaccounted, (
        f"the browser can tag {sorted(unaccounted)} and resolve_custom neither "
        f"writes nor documents ignoring them — a tagged slot that is never "
        f"written is silently dropped at render time")


def test_the_python_and_typescript_agree_on_the_size_slot_shape():
    # size is the one nested slot, so it is the one whose shape can disagree.
    ts = re.search(r"export interface SizeSlot \{(.*?)\n\}", ADAPTER, re.S).group(1)
    for axis in ("width", "height", "length"):
        assert re.search(rf"\b{axis}\?: string", ts), f"SizeSlot lost {axis}"
    src = pathlib.Path(RC.__file__).read_text()
    assert 'for axis in ("width", "height", "length")' in src


# --- writing -------------------------------------------------------------

GRAPH = {
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "the author's prompt"}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry"}},
    "5": {"class_type": "KSampler", "inputs": {"seed": 111, "steps": 20}},
    "6": {"class_type": "EmptyLatentImage",
          "inputs": {"width": 512, "height": 512, "batch_size": 1}},
    "7": {"class_type": "LoadImage", "inputs": {"image": "author.png"}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["5", 0], "filename_prefix": "x"}},
}
SLOTS = {
    "prompt": {"node": "3", "input": "text", "class_type": "CLIPTextEncode"},
    "negative": {"node": "4", "input": "text", "class_type": "CLIPTextEncode"},
    "seed": {"node": "5", "input": "seed", "class_type": "KSampler"},
    "size": {"node": "6", "class_type": "EmptyLatentImage",
             "width": "width", "height": "height"},
    "start_frame": {"node": "7", "input": "image", "class_type": "LoadImage"},
    "output": [{"node": "9", "class_type": "SaveImage"}],
}
ROW = {"name": "test wf", "api_graph": GRAPH, "slots": SLOTS}


def test_values_land_in_the_tagged_inputs_and_nowhere_else():
    out = RC.resolve_custom("x", row=ROW, positive="a lighthouse", negative="ugly",
                            seed=999, width=768, height=768)
    g = out["graph"]
    assert g["3"]["inputs"]["text"] == "a lighthouse"
    assert g["4"]["inputs"]["text"] == "ugly"
    assert g["5"]["inputs"]["seed"] == 999
    assert g["6"]["inputs"]["width"] == 768 and g["6"]["inputs"]["height"] == 768
    # untouched: the sampler's other settings are the author's recipe
    assert g["5"]["inputs"]["steps"] == 20
    assert g["6"]["inputs"]["batch_size"] == 1
    assert g["9"]["inputs"]["filename_prefix"] == "x"


def test_the_stored_graph_is_never_mutated():
    before = json.dumps(GRAPH, sort_keys=True)
    RC.resolve_custom("x", row=ROW, positive="something else", seed=1)
    assert json.dumps(GRAPH, sort_keys=True) == before, (
        "the row's graph was mutated — the next render would inherit this one's values")


def test_an_axis_the_slot_does_not_name_is_left_alone():
    # SLOTS tags width and height but not length: a graph with no frame count
    # must not gain one.
    out = RC.resolve_custom("x", row=ROW, positive="p", length=107)
    assert "length" not in out["graph"]["6"]["inputs"]


def test_a_prompt_with_nowhere_to_go_RAISES_rather_than_rendering_the_authors():
    row = {**ROW, "slots": {k: v for k, v in SLOTS.items() if k != "prompt"}}
    with pytest.raises(RC.CustomWorkflowError) as e:
        RC.resolve_custom("x", row=row, positive="a lighthouse")
    assert "prompt slot" in str(e.value)
    # and it says what to do about it
    assert "Tag the node" in str(e.value)


def test_a_staged_start_frame_with_no_slot_RAISES():
    row = {**ROW, "slots": {k: v for k, v in SLOTS.items() if k != "start_frame"}}
    with pytest.raises(RC.CustomWorkflowError):
        RC.resolve_custom("x", row=row, positive="p", source_image="staged.png")


def test_no_prompt_asked_for_means_no_complaint():
    # a workflow driven entirely by its own values is legitimate
    row = {**ROW, "slots": {"output": SLOTS["output"]}}
    out = RC.resolve_custom("x", row=row)
    assert out["wrote"] == []


def test_a_slot_pointing_at_a_node_that_is_gone_names_the_node():
    row = {**ROW, "slots": {**SLOTS, "seed": {"node": "404", "input": "seed"}}}
    with pytest.raises(RC.CustomWorkflowError) as e:
        RC.resolve_custom("x", row=row, positive="p", seed=5)
    assert "#404" in str(e.value)
    assert "re-tag" in str(e.value)


# --- outputs -------------------------------------------------------------

def test_save_nodes_are_found_across_both_image_and_video_savers():
    for cls in ("SaveVideo", "SaveImage", "VHS_VideoCombine", "SaveAnimatedWEBP"):
        g = {"1": {"class_type": cls, "inputs": {}}}
        assert RC.outputs_of(g) == ["1"], cls


def test_a_preview_only_graph_is_refused_with_the_node_named():
    # ComfyUI runs it happily and writes nothing where fetch_output looks —
    # the job would "succeed" with no asset.
    g = {"8": {"class_type": "PreviewImage", "inputs": {}}}
    with pytest.raises(RC.CustomWorkflowError) as e:
        RC.outputs_of(g)
    assert "PreviewImage" in str(e.value) and "#8" in str(e.value)
    assert "Save node" in str(e.value)


def test_a_graph_with_no_output_at_all_is_refused():
    with pytest.raises(RC.CustomWorkflowError):
        RC.outputs_of({"1": {"class_type": "KSampler", "inputs": {}}})


def test_resolve_returns_the_shape_resolve_py_returns():
    # handle_clip_gen swaps one for the other, so the keys must match.
    out = RC.resolve_custom("x", row=ROW, positive="p")
    assert {"graph", "outputs", "workflow"} <= set(out)
    assert out["workflow"].startswith("custom:")


# --- preflight -----------------------------------------------------------

def test_preflight_names_every_missing_class_once():
    row = {"api_graph": {"1": {"class_type": "Weird"}, "2": {"class_type": "Weird"},
                         "3": {"class_type": "KSampler"}}}
    out = RC.preflight(row, {"KSampler"})
    assert out == ["Weird is not installed on this engine"]


def test_preflight_reports_nothing_when_it_could_not_ask():
    # "we could not check" must never render as "everything is missing"
    row = {"api_graph": {"1": {"class_type": "Weird"}}}
    assert RC.preflight(row, set()) == []
    assert RC.preflight(row, None) == []


# --- the shared job path -------------------------------------------------
#
# BOTH HANDLERS RENDER CUSTOM GRAPHS, and they have to do it the same way.
# `handle_clip_gen` grew the path first; `handle_image_gen` joined it when
# image workflows became runnable — roughly half of what Civitai files under
# Workflows is image work, and until then those imported cleanly and had
# nowhere to go. Two copies of load/resolve/record would drift, and the half
# that drifts silently is the recording: a handler that forgets it still
# renders, still fails, and simply never says why on the card the user opens.

HANDLERS = ROOT / "worker" / "handlers"
IMAGES = (HANDLERS / "images.py").read_text()
BLOCKS = (HANDLERS / "blocks.py").read_text()


def test_resolve_for_job_puts_a_refusal_on_the_workflows_own_row(monkeypatch):
    seen = {}
    monkeypatch.setattr(RC, "load", lambda wid: dict(ROW, slots={}))
    monkeypatch.setattr(RC, "sb", type("S", (), {
        "patch": staticmethod(lambda path, body: seen.update(path=path, body=body)),
        "now": staticmethod(lambda: "t"),
    }))
    with pytest.raises(RC.CustomWorkflowError):
        # no prompt slot tagged, so a prompt that was asked for has nowhere to go
        RC.resolve_for_job("wf-1", positive="a lighthouse", seed=1)
    assert "custom_workflows?id=eq.wf-1" in seen["path"]
    assert seen["body"]["status"] == "error"
    assert "prompt slot" in seen["body"]["last_error"]["message"]


def test_resolve_for_job_returns_what_resolve_custom_returns(monkeypatch):
    monkeypatch.setattr(RC, "load", lambda wid: ROW)
    out = RC.resolve_for_job("wf-1", positive="a lighthouse", seed=7)
    assert out["graph"]["3"]["inputs"]["text"] == "a lighthouse"
    assert out["row"] is ROW
    assert out["outputs"] == ["9"]


@pytest.mark.parametrize("name,src", [("images.py", None), ("blocks.py", None)])
def test_both_handlers_go_through_the_shared_helper(name, src):
    src = IMAGES if name == "images.py" else BLOCKS
    assert "RC.resolve_for_job(" in src, f"{name} does not use the shared helper"
    # ...and neither reimplements it, which is how the recording gets dropped.
    assert "RC.resolve_custom(" not in src, (
        f"{name} calls resolve_custom directly — a refusal would then never "
        f"reach the workflow's row")


def test_handle_image_gen_branches_on_workflow_id():
    """The gap this closes: for its whole life images.py never read the field,
    so a workflow_id on an image job was accepted and ignored, and the render
    came back on the default model with nothing saying a substitution
    happened."""
    assert 'custom_id = payload.get("workflow_id")' in IMAGES
    assert "if custom_id:" in IMAGES


def test_a_custom_image_render_records_success_and_failure():
    # ComfyUI's own refusal names the node and the class, which is the most
    # useful thing in the whole import flow — it belongs on the card.
    assert "RC.record_failure(custom_id, e)" in IMAGES
    assert "RC.record_success(custom_id)" in IMAGES


def test_a_custom_image_render_does_not_claim_a_model_it_never_ran():
    """A custom graph names its own checkpoint, so recording the model_map key
    the picker happened to resolve would state a model that never ran."""
    assert '"workflow_id": custom_id' in IMAGES
    assert '{"model": model}' in IMAGES


def test_the_composer_sends_workflow_id_on_EVERY_branch_that_can_run_one():
    """A picker offered where the field is ignored is the silent no-op; a
    runner that reads a field the picker never sends is dead code. Three
    branches can run an imported graph — image_gen and clip_gen on the pod, and
    the `local` branch on the machine's own ComfyUI — so all three must carry
    it."""
    gc = (ROOT / "src" / "components" / "shell" / "GenComposer.tsx").read_text()
    assert gc.count("workflow_id: customWfId") == 3, (
        "workflow_id must ride the image_gen, clip_gen AND local payloads")
    kinds = re.search(r"const WF_KINDS: GenKind\[\] = \[(.*?)\]", gc).group(1)
    assert "video" in kinds and "image" in kinds
    assert "music" not in kinds, "no music handler reads workflow_id"


def test_the_two_halves_agree_on_what_counts_as_an_OUTPUT():
    """The browser decides whether an import LOOKS runnable; the worker decides
    whether it IS. They had drifted: `OUTPUT_CLASSES` counted `PreviewImage` as
    an output while `SAVE_CLASSES` does not, so a preview-only graph imported
    with an output slot tagged, a clean report and a content compat panel — and
    was refused at RENDER time, after queueing to the pod. Found on real
    Civitai data: one of two usable SDXL image workflows sampled ends on three
    PreviewImage nodes.
    """
    ts_out = set(re.findall(r'"([\w]+)"', re.search(
        r"const OUTPUT_CLASSES = new Set\(\[(.*?)\]\)", ADAPTER, re.S).group(1)))
    ts_prev = set(re.findall(r'"([\w]+)"', re.search(
        r"const PREVIEW_CLASSES = new Set\(\[(.*?)\]\)", ADAPTER, re.S).group(1)))

    missing = ts_out - set(RC.SAVE_CLASSES)
    assert not missing, (
        f"the browser calls {sorted(missing)} an output and the worker cannot fetch it — "
        f"an import would look runnable and be refused at render time")
    assert not (ts_out & set(RC.PREVIEW_ONLY)), (
        "a preview node is being counted as an output again")
    assert ts_prev == set(RC.PREVIEW_ONLY), (
        f"preview lists disagree: browser {sorted(ts_prev)} vs worker {sorted(RC.PREVIEW_ONLY)}")


def test_a_preview_only_graph_is_named_by_BOTH_halves():
    """The worker's message names the offending nodes; so must the browser's,
    or "no output node" on a graph that visibly ends in three PreviewImages
    reads as a detection bug rather than as something to fix."""
    assert "preview_only" in ADAPTER
    assert "only previews its result" in ADAPTER


def test_the_local_runner_runs_an_imported_graph_too():
    """THE DESKTOP IS A SECOND IMPLEMENTATION OF ONE CONTRACT. The pod runs an
    imported graph through `resolve_custom.py`; the desktop runs the same
    stored `{api_graph, slots}` through `localRender.graphForJob`. While only
    the pod could, the picker had to be gated off the local tier — it sent no
    `workflow_id` and resolved every graph from `localGraphs.ts` by model_id,
    so a pick was silently dropped and the catalogue recipe rendered instead.
    """
    lr = (ROOT / "src" / "lib" / "localRender.ts").read_text()
    assert "if (p.workflow_id) {" in lr, "the local runner ignores workflow_id again"
    assert "applySlots(" in lr, "it must drive the graph by its TAGGED SLOTS"
    gc = (ROOT / "src" / "components" / "shell" / "GenComposer.tsx").read_text()
    assert "const wfPickable = WF_KINDS.includes(kind);" in gc


def test_the_local_runner_makes_the_SAME_two_refusals_as_the_worker():
    """Both planes must refuse a prompt with nowhere to go and a staged start
    frame with no slot. A plane that quietly renders the author's own prompt
    instead is the silent downgrade `resolve_custom` exists to prevent, and two
    implementations is exactly where one of them forgets."""
    lr = (ROOT / "src" / "lib" / "localRender.ts").read_text()
    assert "has no prompt slot tagged" in lr
    assert "has no start-frame slot tagged" in lr
    src = pathlib.Path(RC.__file__).read_text()
    assert "has no prompt slot tagged" in src
    assert "has no start-frame slot tagged" in src


def test_the_local_runner_records_the_outcome_on_the_workflow_row():
    """`recordTest` is the browser twin of record_success/record_failure. A
    render is the only thing that proves a graph; a clean import never was."""
    lr = (ROOT / "src" / "lib" / "localRender.ts").read_text()
    assert "recordTest(" in lr
    assert "await tell(true);" in lr and "await tell(false" in lr


def test_a_local_custom_render_does_not_claim_a_model_or_a_recipe():
    """A custom graph names its own checkpoint and its own sampler, so the
    asset must not record the model_id the picker happened to carry, nor a step
    count from a recipe that never ran — the same choice handle_image_gen makes
    on the pod."""
    lr = (ROOT / "src" / "lib" / "localRender.ts").read_text()
    assert "workflow_id: custom.id" in lr
    assert "steps: sampling!.steps" in lr, "the catalogue path must still record its recipe"
