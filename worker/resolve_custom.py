"""Render a user-imported ComfyUI graph.

WHY THIS IS NOT `resolve.py`. That module parameterises a BUNDLED template by
walking it and matching on `class_type`: a `UNETLoader` gets the mode's
checkpoint, a class in LATENT_CLASSES gets width/height/length, a `KSampler`
gets the seed. That works because we wrote those templates and know their
shape. An imported graph has no such contract — it may build its model through
a pack we have never seen, carry three samplers, or take its prompt through a
node whose class we cannot recognise. Guessing by class on someone else's graph
is exactly how you get a render that silently ignores the prompt.

So a custom workflow is driven by an EXPLICIT slot map instead: the import
tagged `{node, input}` pairs (and a human may have corrected them), and this
module writes into those addresses and nowhere else. Everything it cannot
address, it leaves alone — the author's value renders, which is the honest
outcome for a graph we did not write.

The contract with the browser half is `src/lib/workflowAdapter.ts`
(`detectSlots` / `applySlots`); `test_resolve_custom.py` pins the two together
by reading the TypeScript, because a slot written by one and read by the other
is the kind of thing that drifts silently.
"""

import copy
import json

import sb

# Save nodes whose output the worker knows how to fetch. Wider than resolve.py's
# list because an imported graph is as likely to end on an image saver as a
# video one — and a graph whose only output is a Preview node produces nothing
# on disk, which is a failure worth naming rather than discovering after the
# render.
SAVE_CLASSES = (
    "SaveVideo", "SaveAnimatedWEBP", "SaveWEBM", "VHS_VideoCombine",
    "SaveImage", "SaveAnimatedPNG", "SaveAudio",
)
PREVIEW_ONLY = ("PreviewImage", "PreviewAny", "SaveImageWebsocket")


class CustomWorkflowError(Exception):
    """Raised where the job cannot proceed, with a message meant for the UI.

    Every message here names the node or the slot, because the whole point of
    the import screen is that a failure is specific enough to act on.
    """


def load(workflow_id):
    """The stored row. Service key, so RLS does not apply — the job carrying
    this id was already authorised when it was inserted."""
    rows = sb.get(f"custom_workflows?id=eq.{workflow_id}&limit=1")
    if not rows:
        raise CustomWorkflowError(f"custom workflow {workflow_id} not found")
    return rows[0]


def _put(graph, slot, value, what):
    """Write one tagged input, or explain precisely why it could not be."""
    if not slot or value is None:
        return False
    node, key = str(slot.get("node") or ""), slot.get("input")
    if not node or not key:
        return False
    if node not in graph:
        raise CustomWorkflowError(
            f"the {what} slot points at node #{node}, which is not in this graph "
            f"— re-tag the workflow (the graph was probably re-exported and renumbered)")
    graph[node].setdefault("inputs", {})[key] = value
    return True


def apply_slots(api_graph, slots, values):
    """Pure: a copy of the graph with the job's values written into the tagged
    inputs. Mirrors `applySlots` in src/lib/workflowAdapter.ts."""
    g = copy.deepcopy(api_graph)
    wrote = []

    for key, what in (("prompt", "prompt"), ("negative", "negative prompt"),
                      ("seed", "seed"), ("start_frame", "start frame"),
                      ("end_frame", "end frame")):
        if _put(g, slots.get(key), values.get(key), what):
            wrote.append(key)

    size = slots.get("size") or {}
    node = str(size.get("node") or "")
    if node:
        if node not in g:
            raise CustomWorkflowError(
                f"the size slot points at node #{node}, which is not in this graph")
        for axis in ("width", "height", "length"):
            inp, val = size.get(axis), values.get(axis)
            if inp and val is not None:
                g[node].setdefault("inputs", {})[inp] = val
                wrote.append(axis)
    return g, wrote


def outputs_of(graph):
    """Which nodes the worker should fetch the render from.

    A graph that only PREVIEWS is the trap here: ComfyUI runs it happily, the
    user watches it render, and nothing is written where `fetch_output` looks.
    Naming that as an error beats returning an empty list that fails two
    minutes later with 'no output'.
    """
    saves = [nid for nid, n in graph.items() if n.get("class_type") in SAVE_CLASSES]
    if saves:
        return saves
    previews = [f"#{nid} {n.get('class_type')}" for nid, n in graph.items()
                if n.get("class_type") in PREVIEW_ONLY]
    if previews:
        raise CustomWorkflowError(
            "this workflow only previews its result (" + ", ".join(previews)
            + ") — nothing is saved to disk, so the job would finish with no asset. "
              "Add a Save node in ComfyUI and re-sync.")
    raise CustomWorkflowError("this workflow has no output node")


def resolve_custom(workflow_id, *, positive=None, negative=None, seed=None,
                   width=None, height=None, length=None,
                   source_image=None, end_image=None, row=None):
    """Same return shape as `resolve.resolve`, so a handler can swap one for
    the other: {"graph", "outputs", "workflow"}.

    `row` lets a caller that already loaded the workflow avoid a second fetch.
    """
    row = row or load(workflow_id)
    api_graph = row.get("api_graph")
    if not isinstance(api_graph, dict) or not api_graph:
        raise CustomWorkflowError(f"custom workflow '{row.get('name')}' has no executable graph")

    slots = row.get("slots") or {}
    values = {
        "prompt": positive, "negative": negative, "seed": seed,
        "width": width, "height": height, "length": length,
        "start_frame": source_image, "end_frame": end_image,
    }
    graph, wrote = apply_slots(api_graph, slots, values)

    # A prompt that was ASKED FOR and has nowhere to go is the silent downgrade
    # this codebase keeps naming: the render succeeds and returns the author's
    # picture. Refuse instead, and say what to fix.
    if positive and "prompt" not in wrote:
        raise CustomWorkflowError(
            f"'{row.get('name')}' has no prompt slot tagged, so the prompt would be "
            "ignored and the workflow's own prompt would render. Tag the node that "
            "takes the prompt on the workflow's card.")
    # A start frame is a stronger case still: the caller staged a file for it.
    if source_image and "start_frame" not in wrote:
        raise CustomWorkflowError(
            f"'{row.get('name')}' has no start-frame slot tagged, so the image you "
            "picked would be ignored.")

    return {
        "graph": graph,
        "outputs": outputs_of(graph),
        "workflow": f"custom:{row.get('name')}",
        "wrote": wrote,
        "row": row,
    }


def resolve_for_job(workflow_id, **kw):
    """Load a workflow and resolve it for a job, recording a refusal on its row.

    THE POINT IS THAT BOTH HANDLERS DO THIS IDENTICALLY. `handle_clip_gen` grew
    it first and `handle_image_gen` needs the same three steps — load, resolve,
    and put a `CustomWorkflowError` on the workflow's own card before re-raising
    — because the person who has to fix a graph looks at the graph's card, not
    at a job's `error_msg`. Two copies of that would drift, and the half that
    drifts silently is the recording: a handler that forgets it still renders,
    still fails, and simply never explains itself.

    Raises exactly what `resolve_custom` raises; the caller still owns the
    submit and therefore still owns `record_failure` for ComfyUI's own refusal.
    """
    row = load(workflow_id)
    try:
        return resolve_custom(workflow_id, row=row, **kw)
    except CustomWorkflowError as e:
        record_failure(workflow_id, e)
        raise


def preflight(row, installed_classes):
    """What is missing on the engine that is about to run this.

    Returns a list of human-readable strings, empty when the graph can run.
    `installed_classes` is falsy when nothing could be asked — and then this
    reports nothing, because "we could not check" must never render as "1,300
    nodes are missing".
    """
    if not installed_classes:
        return []
    need = {n.get("class_type") for n in (row.get("api_graph") or {}).values()}
    missing = sorted(c for c in need if c and c not in installed_classes)
    return [f"{c} is not installed on this engine" for c in missing]


def record_failure(workflow_id, message, node=None, class_type=None):
    """Put the failure on the workflow's own row, so the card shows why.

    Best effort: a render that already failed must not fail differently
    because the bookkeeping did.
    """
    try:
        sb.patch(f"custom_workflows?id=eq.{workflow_id}",
                 {"status": "error",
                  "last_error": {"message": str(message)[:800], "node": node,
                                 "class_type": class_type, "at": sb.now()},
                  "last_tested_at": sb.now()})
    except Exception as e:                                    # noqa: BLE001
        print(f"[resolve_custom] could not record failure: {e}")


def record_success(workflow_id):
    """Clear the error and mark the graph proven. Clearing is the half that is
    easy to forget, and a stale error beside a working workflow is worse than
    no status at all."""
    try:
        sb.patch(f"custom_workflows?id=eq.{workflow_id}",
                 {"status": "ready", "last_error": None, "last_tested_at": sb.now()})
    except Exception as e:                                    # noqa: BLE001
        print(f"[resolve_custom] could not record success: {e}")


if __name__ == "__main__":                                    # pragma: no cover
    import sys
    out = resolve_custom(sys.argv[1], positive="a test prompt", seed=1)
    print(json.dumps({"outputs": out["outputs"], "wrote": out["wrote"]}, indent=2))
