"""The PDD splice: official 8-step distill via MiniMaxH3PDDAccApply.

Pins the three things a wrong splice gets SILENTLY wrong: the sigmas must
come from the Apply node (a graph still reading BasicScheduler samples the
distilled trunk on the stock schedule — the exact failure the turbo splice's
docstring warns about), the sampler must be euler (multi-stage samplers
evaluate off the trained grid), and the FILE must follow the checkpoint
(fl2va vs ref2va trunks share identical key sets, so a crossed pairing
applies cleanly and renders wrong).
"""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ["MODEL_TIER"] = "full"
os.environ.setdefault("MODEL_MAP", os.path.join(
    os.path.dirname(__file__), "..", "..", "infra", "model_map.full.json"))
import pytest
import resolve as R

MM_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "infra",
                       "model_map.full.json")


# resolve() reads MODEL_MAP/MODEL_TIER at IMPORT time, and under the full
# suite it is imported (via the handlers) before any test file's env
# assignment runs — so the constants bake to the /kaggle defaults and
# load_map() FileNotFounds. Patch the module constants per test instead of
# relying on import order; ensure_model is stubbed because these tests are
# about the GRAPH, not about which weights are on this laptop.
@pytest.fixture(autouse=True)
def _map(monkeypatch):
    monkeypatch.setattr(R, "TIER", "full")
    monkeypatch.setattr(R, "MODEL_MAP_PATH", MM_PATH)
    monkeypatch.setattr(R, "ensure_model",
                        lambda model, mm=None: R.load_map()["full"]["models"][model])


def _graph(mode, **kw):
    r = R.resolve("minimax-h3-pdd", mode, positive="p", negative="",
                  seed=1, width=1216, height=672, length=124,
                  ref_images=["a.png"] if mode == "r2v" else None, **kw)
    return r["graph"]


def _nodes(g, ct):
    return [n for n in g.values() if n.get("class_type") == ct]


def test_r2v_takes_the_ref2va_file_and_rewires_sigmas_to_the_apply_node():
    g = _graph("r2v")
    apply = _nodes(g, "MiniMaxH3PDDAccApply")
    assert len(apply) == 1
    assert apply[0]["inputs"]["pdd_file"] == "MiniMax-H3-Ref2VA-Acc-8Step.safetensors"
    assert apply[0]["inputs"]["nfe"] == "8"
    aid = next(nid for nid, n in g.items()
               if n.get("class_type") == "MiniMaxH3PDDAccApply")
    sca = _nodes(g, "SamplerCustomAdvanced")[0]
    assert sca["inputs"]["sigmas"] == [aid, 1]


def test_fl2va_modes_take_the_fl2va_file():
    g = _graph("t2v")
    apply = _nodes(g, "MiniMaxH3PDDAccApply")[0]
    assert apply["inputs"]["pdd_file"] == "MiniMax-H3-FL2VA-Acc-8Step.safetensors"


def test_the_sampler_becomes_plain_euler():
    g = _graph("r2v")
    ks = _nodes(g, "KSamplerSelect")
    assert ks and all(n["inputs"]["sampler_name"] == "euler" for n in ks)


def test_the_guider_reads_the_patched_model():
    g = _graph("r2v")
    aid = next(nid for nid, n in g.items()
               if n.get("class_type") == "MiniMaxH3PDDAccApply")
    guider = _nodes(g, "BasicGuider")[0]
    assert guider["inputs"]["model"] == [aid, 0]


def test_declaring_pdd_beside_turbo_lora_is_refused():
    import copy
    mm = copy.deepcopy(R.load_map())
    mm["full"]["models"]["minimax-h3-pdd"]["turbo_lora"] = "x.safetensors"
    try:
        R.resolve("minimax-h3-pdd", "t2v", positive="p", negative="",
                  seed=1, width=1216, height=672, length=124, mm=mm)
        assert False, "should have raised"
    except R.ResolveError as e:
        assert "don't stack" in str(e)
