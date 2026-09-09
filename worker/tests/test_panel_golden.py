"""The committed panel-prompt fixtures must still be what the composer emits.

`src/lib/panelPrompt.ts` is a twin of the prose branch of image_prompt.py, and
`src/lib/__fixtures__/panel_prompts.json` is what pins them together: the
strings are emitted by the REAL Python here, and the TypeScript test asserts
its own output is byte-identical to them.

That only holds while the fixture is current. Without this test the Python
could change, the fixture would keep describing the old composer, the TS test
would keep passing against it — and the browser and the pod would quietly draw
different pictures from the same beat, which is the one failure neither side
can see. So: a change to the composer fails HERE until the fixture is
regenerated, and the regenerated fixture then fails the TypeScript until the
twin is brought along. Neither language can move alone.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def test_the_committed_fixtures_match_the_composer():
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "gen_panel_golden.py"), "--check"],
        capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, (
        f"{r.stdout}{r.stderr}\n"
        "The panel composer changed and the golden fixtures did not. Run:\n"
        "  python3 scripts/gen_panel_golden.py\n"
        "then run `node --test src/lib/panelPrompt.test.ts` and bring "
        "src/lib/panelPrompt.ts along with it.")


def test_the_check_actually_compares_something():
    """A --check that silently found no cases would pass forever."""
    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "scripts", "gen_panel_golden.py"), "--check"],
        capture_output=True, text=True, cwd=ROOT)
    # The composer LOGS while it composes (the plate fallback, the envelope
    # prune), so the count is not the first thing on stdout — find the line.
    line = next((l for l in r.stdout.splitlines() if "panel golden ok" in l), "")
    assert "compose" in line and "finalize" in line, r.stdout
    n = int(line.split("—")[1].strip().split()[0])
    assert n > 25, f"only {n} compose cases"
