"""The committed sheet-prompt fixtures must still be what the composer emits.

`src/lib/sheetPrompt.ts` is a twin of the prose branch of `compose()` in
image_prompt.py, and `src/lib/__fixtures__/sheet_prompts.json` is what pins
them together: the strings are emitted by the REAL Python here, and the
TypeScript test asserts its own output is byte-identical to them.

That only holds while the fixture is current. Without this test the Python
could change, the fixture would keep describing the old composer, the TS test
would keep passing against it — and the browser and the pod would quietly draw
different reference sheets from the same bible entry, which is the one failure
neither side can see (a sheet is the identity anchor every later render derives
from, so the drift propagates). So: a change to the composer fails HERE until
the fixture is regenerated, and the regenerated fixture then fails the
TypeScript until the twin is brought along. Neither language can move alone.

Same shape as test_panel_golden.py next door.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def test_the_committed_fixtures_match_the_composer():
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "gen_sheet_golden.py"), "--check"],
        capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, (
        f"{r.stdout}{r.stderr}\n"
        "The sheet composer changed and the golden fixtures did not. Run:\n"
        "  python3 scripts/gen_sheet_golden.py\n"
        "then run `node --test src/lib/sheetPrompt.test.ts` and bring "
        "src/lib/sheetPrompt.ts along with it.")


def test_the_check_actually_compares_something():
    """A --check that silently found no cases would pass forever."""
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "gen_sheet_golden.py"), "--check"],
        capture_output=True, text=True, cwd=ROOT)
    line = next((l for l in r.stdout.splitlines() if "sheet golden ok" in l), "")
    assert "compose" in line, r.stdout
    n = int(line.split("—")[1].strip().split()[0])
    assert n > 40, f"only {n} compose cases"


def test_every_kind_and_role_the_browser_can_queue_is_covered():
    """A fixture that skips a slot pins nothing about that slot.

    Every role in `FRAMING` reaches a sheet job from some surface (the bible
    modal offers a kind's whole slot list), and each takes its own branch —
    `face` trims, `alt_angle` from a reference swaps the framing for a move.
    """
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    sys.path.insert(0, os.path.join(ROOT, "worker"))
    os.environ.setdefault("SUPABASE_URL", "http://sb.invalid")
    os.environ.setdefault("SUPABASE_ANON_KEY", "local")
    os.environ.setdefault("SUPABASE_ACCESS_TOKEN", "test-token")
    import gen_sheet_golden as G
    import image_prompt as IP

    kinds = {s.get("kind") for _, _, s in G.CASES}
    assert kinds == {"character", "environment", "prop", "scene"}, kinds
    roles = {s.get("role") for _, _, s in G.CASES}
    for r in IP.FRAMING:
        assert r in roles, f"no fixture composes the {r} slot"
    # Both sides of the from_ref split, which is the branch that decides
    # whether a plate gets a camera MOVE or a description of a picture.
    assert {bool(s.get("from_ref")) for _, _, s in G.CASES} == {True, False}
