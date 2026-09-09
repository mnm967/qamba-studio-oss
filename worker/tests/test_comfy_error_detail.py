"""A failed prompt's error must name the ERROR, not the status stream.

ComfyUI's history `status.messages` OPENS with execution_start and
execution_cached entries, so dumping the array truncated (the old behaviour,
`json.dumps(messages)[:400]`) cut off before the `execution_error` entry it
exists to report. Measured: three video_edit OOMs whose stored `error_msg` was
400 bytes of node-cache bookkeeping — `[["execution_start", {"prompt_id": …` —
naming no node, no exception and no message, which cost the diagnosis a trip
to the pod's journal (2026-08-23).
"""
import json

from comfy import _error_detail

# The real shape, abbreviated from the failed edit's own history entry.
MESSAGES = [
    ["execution_start", {"prompt_id": "906f9b8c", "timestamp": 1787526667452}],
    ["execution_cached", {"nodes": ["2", "3", "4", "8"], "prompt_id": "906f9b8c"}],
    ["execution_error", {
        "prompt_id": "906f9b8c", "node_id": "13",
        "node_type": "SamplerCustomAdvanced",
        "exception_message": "Allocation on device",
        "exception_type": "torch.OutOfMemoryError",
        "traceback": ["...", "..."],
    }],
]


def test_the_execution_error_entry_is_what_gets_reported():
    d = _error_detail(MESSAGES)
    assert "SamplerCustomAdvanced" in d
    assert "#13" in d
    assert "Allocation on device" in d
    assert "torch.OutOfMemoryError" in d
    assert "execution_start" not in d


def test_it_survives_the_stream_shapes_that_are_not_errors():
    # No error entry -> the old dump, bounded; junk entries are skipped.
    assert _error_detail(None) == "null"
    assert _error_detail([]) == "[]"
    assert _error_detail([["weird"], "junk", ["execution_start", {}]]) \
        == json.dumps([["weird"], "junk", ["execution_start", {}]])[:400]


def test_the_detail_is_bounded():
    long = [["execution_error", {"node_type": "X", "node_id": "1",
                                 "exception_type": "E",
                                 "exception_message": "m" * 2000}]]
    assert len(_error_detail(long)) <= 400
