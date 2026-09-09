"""The cut assembles when every block HAS A TAKE — a `stale` block counts."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from handlers import blocks as B  # noqa: E402


def test_a_stale_block_with_a_take_is_delivered():
    assert B._delivered({"id": "x", "status": "stale", "active_take_id": "t"}, "me")
    assert B._delivered({"id": "x", "status": "generated", "active_take_id": "t"}, "me")


def test_an_unrendered_block_is_not():
    assert not B._delivered({"id": "x", "status": "queued", "active_take_id": None}, "me")
    assert not B._delivered({"id": "x", "status": "failed", "active_take_id": None}, "me")


def test_the_block_being_published_counts_before_its_row_is_read_back():
    assert B._delivered({"id": "me", "status": "generating", "active_take_id": None}, "me")


def test_master_pass_reads_the_take_column_to_decide():
    src = open(os.path.join(os.path.dirname(__file__), "..", "handlers", "blocks.py")).read()
    i = src.index("is_last = done_now == len(siblings)")
    assert "select=id,status,active_take_id" in src[i - 400:i]
    assert "_delivered(s, block[\"id\"])" in src[i - 200:i]
