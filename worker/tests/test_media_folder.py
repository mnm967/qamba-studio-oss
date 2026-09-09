"""A local project's media is a FOLDER, and `media` serves it without boto3.

This is what lets the studio's own pipeline Python run a local project's jobs
on the desktop: the rows are a file (see the loopback PostgREST proxy) and the
media is a directory beside them, so neither half needs a bucket, a credential
or a network. Every `b2_*` verb has to work in that mode or the block
pipeline, `dialogue_synth` and the reviewer all stop at their first file.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import media  # noqa: E402


@pytest.fixture
def folder(tmp_path, monkeypatch):
    root = tmp_path / "media"
    root.mkdir()
    monkeypatch.setenv(media.MEDIA_ROOT_ENV, str(root))
    return root


def test_a_round_trip_needs_no_bucket_and_no_boto3(folder, tmp_path):
    src = tmp_path / "in.mp3"
    src.write_bytes(b"hello")
    media.b2_put(str(src), "audio/lines/abc.mp3", content_type="audio/mpeg")
    assert (folder / "audio" / "lines" / "abc.mp3").read_bytes() == b"hello"

    out = tmp_path / "nested" / "out.mp3"
    media.b2_get("audio/lines/abc.mp3", str(out))
    assert out.read_bytes() == b"hello"


def test_a_missing_key_says_so_rather_than_writing_an_empty_file(folder, tmp_path):
    out = tmp_path / "out.mp3"
    with pytest.raises(RuntimeError):
        media.b2_get("audio/nope.mp3", str(out))
    assert not out.exists()


def test_delete_and_list_walk_the_folder(folder, tmp_path):
    src = tmp_path / "a"
    src.write_bytes(b"x")
    media.b2_put(str(src), "images/a.png")
    media.b2_put(str(src), "audio/b.mp3")
    keys = {k for k, _size, _mtime in media.b2_list()}
    assert keys == {"images/a.png", "audio/b.mp3"}
    assert {k for k, _s, _m in media.b2_list("images/")} == {"images/a.png"}
    assert media.b2_delete("images/a.png") is True
    assert media.b2_delete("images/a.png") is False
    assert {k for k, _s, _m in media.b2_list()} == {"audio/b.mp3"}


@pytest.mark.parametrize("key", [
    "/etc/passwd",            # absolute
    "../../secrets.env",      # traversal
    "a/../../b",              # traversal mid-path
    "C:/Windows/win.ini",     # drive letter
    "",                       # nothing at all
])
def test_an_object_key_that_escapes_the_folder_is_refused(folder, tmp_path, key):
    # A key is attacker-adjacent data — it can arrive on a row a pull copied
    # down — and it is used to build a path. Same rule, same strictness, as
    # `localstore::safe_key` on the Rust side.
    src = tmp_path / "a"
    src.write_bytes(b"x")
    with pytest.raises(ValueError):
        media.b2_put(str(src), key)


def test_a_backslash_key_is_read_as_a_path_not_a_filename(folder, tmp_path):
    src = tmp_path / "a"
    src.write_bytes(b"x")
    media.b2_put(str(src), "images\\a.png")
    assert (folder / "images" / "a.png").exists()


def test_with_no_root_set_it_is_the_bucket_exactly_as_before(monkeypatch):
    monkeypatch.delenv(media.MEDIA_ROOT_ENV, raising=False)
    assert media.media_root() is None


def test_the_bucket_client_is_built_on_first_use_not_at_import():
    # The desktop's engine Python has no boto3. A module-level client made
    # `import media` fail there — and with it `import handlers.blocks`, i.e.
    # the entire block pipeline, on a machine that could have run the job.
    src = open(os.path.join(os.path.dirname(media.__file__), "media.py"),
               encoding="utf-8").read()
    head = src.split("def s3()")[0]
    assert "import boto3" not in head, "boto3 must not be imported at module level"


# ── there is one store, and a process without it says so ─────────────────────

def test_the_only_store_is_the_project_folder(monkeypatch, tmp_path):
    """The cloud build had three — a folder, an S3 client with an app key, and
    a presigned PUT through a hosted route. Two of those are gone rather than
    dormant: a code path that reaches for a write credential for somebody
    else's storage is not something to leave lying in a local app.

    A process with no folder is NAMED rather than left to fail on its first
    write, because finding that out after the sampling is the whole cost this
    avoids.
    """
    monkeypatch.delenv(media.MEDIA_ROOT_ENV, raising=False)
    assert media.store_mode() == "none"
    monkeypatch.setenv(media.MEDIA_ROOT_ENV, str(tmp_path))
    assert media.store_mode() == "folder"


def test_nothing_in_this_module_can_reach_a_bucket_or_a_hosted_route():
    """Pinned as SOURCE, because the failure it guards against is a path being
    added back rather than one behaving badly: an S3 client, an app key, or a
    presign against some deployment's own route.
    """
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "media.py"), encoding="utf-8").read()
    body = src.split('"""', 2)[-1]                      # past the module docstring
    for gone in ("boto3", "B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET", "B2_ENDPOINT",
                 "B2_CDN_BASE", "upload-url", "presign"):
        assert gone not in body, f"media.py can still reach {gone}"


@pytest.mark.parametrize("call", [
    lambda: media.b2_get("a/b.mp4", "/tmp/x.mp4"),
    lambda: media.b2_put("/tmp/x.mp4", "a/b.mp4"),
    lambda: media.b2_delete("a/b.mp4"),
    lambda: list(media.b2_list()),
])
def test_every_verb_refuses_by_name_with_no_folder(call, monkeypatch):
    monkeypatch.delenv(media.MEDIA_ROOT_ENV, raising=False)
    with pytest.raises(RuntimeError) as e:
        call()
    assert media.MEDIA_ROOT_ENV in str(e.value)


def test_a_key_with_no_file_names_the_key_AND_where_it_looked(folder, tmp_path):
    """A ROW IS NOT A FILE. A project can reference media it does not hold —
    a job cancelled between registering an asset and writing it, a folder
    somebody moved things out of — and the browser copes by rendering nothing.
    The pipeline cannot, so the failure has to be legible: which key, and the
    path it was expected at.
    """
    with pytest.raises(RuntimeError) as e:
        media.b2_get("blocks/nope.mp4", str(tmp_path / "out.mp4"))
    msg = str(e.value)
    assert "blocks/nope.mp4" in msg and str(folder) in msg
