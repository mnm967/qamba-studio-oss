"""`resolve.py`'s dynamic LoRA splice — how an adapter reaches an H3 graph.

Every MiniMax H3 template here is the plain one: unlike the Wan/LTX `*_style`
templates, none of them ships a `LoraLoaderModelOnly` placeholder. So an
adapter has to be SPLICED IN at graph-build time — inserted after the model
loader, with every former consumer of that loader's MODEL output rewired to
read the new node instead. That mechanism is what lets one template serve a
plain render, a style variant and a step distillation, and it is what these
pin.

THE FIXTURE IS SYNTHETIC ON PURPOSE. What is being tested is `resolve`, not
the catalogue: a test written against whichever rows happen to ship declares
its subject by accident and breaks whenever the catalogue moves. `STYLE_MODEL`
below is an ordinary H3 entry with a baked-in `style_lora` and a `style_loras`
table covering all three shapes an adapter can take — one file, several files
that only work together, and one whose trigger token has to reach the prompt.
"""
import copy
import json
import os

import pytest

os.environ.setdefault("MODEL_TIER", "full")
os.environ.setdefault("WORKFLOWS_DIR", os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "workflows"))

import resolve as R

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

#: A style variant: the base checkpoint plus one adapter baked into the entry,
#: with i2v/t2v/flf only. Withholding r2v is the shape a real variant takes
#: when its author trained against `fl2va` alone — `ref2va` is a different
#: checkpoint and an adapter trained on one does not transfer to the other.
STYLE_MODEL = "test-h3-style"
STYLE_FILE = "h3_test_style_v1.safetensors"

#: The per-job stack: keys a render carries, resolved through `style_loras`.
STACK = {
    # one file, ordinary
    "grain": "h3_test_grain_v1.safetensors",
    "handheld": "h3_test_handheld_v1.safetensors",
    # ONE PICK, TWO FILES. A stills-trained half and a motion-trained half whose
    # author is explicit that neither carries a render alone: two keys would let
    # somebody take half of it, which is the failure the pairing prevents. Their
    # RATIO is the recipe, so a caller's strength scales the set.
    "duotone": [{"file": "h3_test_duotone_stills.safetensors", "strength": 1.0},
                {"file": "h3_test_duotone_motion.safetensors", "strength": 0.35}],
    # trained with a token PREPENDED at training time and kept out of the
    # captions, so the token appears nowhere in the prose the adapter learned
    # and without it the file loads clean, logs nothing and does nothing.
    "inked": "h3_test_inked_v1.safetensors",
}
TRIGGERS = {"inked": "inkstyle", "duotone": ["Duotone", "duo2"]}


@pytest.fixture
def mm(monkeypatch):
    with open(os.path.join(ROOT, "infra", "model_map.full.json")) as f:
        full = json.load(f)
    tier = full["full"]
    base = tier["models"]["minimax-h3"]

    style = copy.deepcopy(base)
    style["style_lora"] = STYLE_FILE
    style["style_strength"] = 0.4
    style["style_loras"] = dict(STACK)
    style["lora_triggers"] = dict(TRIGGERS)
    style["modes"] = {k: v for k, v in base["modes"].items() if k != "r2v"}
    tier["models"][STYLE_MODEL] = style

    # The same variant with the step distillation on top — style and turbo are
    # orthogonal, so a real catalogue carries the pair and the chain has to hold
    # both.
    turbo = copy.deepcopy(tier["models"]["minimax-h3-turbo"])
    turbo["style_lora"] = STYLE_FILE
    turbo["style_strength"] = 0.4
    turbo["style_loras"] = dict(STACK)
    turbo["lora_triggers"] = dict(TRIGGERS)
    tier["models"][STYLE_MODEL + "-turbo"] = turbo

    # The plain rows get the same stack, so the per-job tests can use a row
    # with NO baked-in adapter and see only what the job asked for.
    for key in ("minimax-h3", "minimax-h3-turbo"):
        row = copy.deepcopy(tier["models"][key])
        row["style_loras"] = dict(STACK)
        row["lora_triggers"] = dict(TRIGGERS)
        tier["models"][key] = row

    # Off-engine: no checkpoints on disk and nothing to shell out to — stand
    # `ensure_model` down to a passthrough with the same contract (it returns
    # the model's own map entry) and none of the filesystem work.
    monkeypatch.setattr(R, "ensure_model", lambda model, mm=None: tier["models"][model])
    # The env setdefault above only lands when THIS module is the first to
    # import resolve; in a full-suite run some other test usually got there
    # first. Pin the module variable, not the env.
    monkeypatch.setattr(R, "TIER", "full")
    return full


def _resolve(mm, mode, model=STYLE_MODEL, **kw):
    return R.resolve(model, mode, positive="x", negative="", seed=1,
                     width=832, height=480, length=53, exact_frames=53, mm=mm, **kw)


def _h3(mm, model="minimax-h3", mode="t2v", **kw):
    return _resolve(mm, mode, model=model, **kw)["graph"]


def _links_to(node, target_id):
    return any(isinstance(v, list) and len(v) == 2 and v[0] == target_id
               for v in node.get("inputs", {}).values())


def _sched(g):
    return next(n["inputs"] for n in g.values() if n["class_type"] == "BasicScheduler")


def _lora_names(g):
    return [n["inputs"]["lora_name"] for n in g.values()
            if n["class_type"] == "LoraLoaderModelOnly"]


def _by_file(g):
    return {n["inputs"]["lora_name"]: n["inputs"]["strength_model"]
            for n in g.values() if n["class_type"] == "LoraLoaderModelOnly"}


def _classes(g):
    return [n["class_type"] for n in g.values()]


# --- the splice itself ------------------------------------------------------

@pytest.mark.parametrize("mode,extra", [
    ("i2v", {"source_image": "a.png"}),
    ("t2v", {}),
    ("flf", {"source_image": "a.png", "end_image": "b.png"}),
])
def test_style_lora_spliced_between_loader_and_consumers(mm, mode, extra):
    g = _resolve(mm, mode, **extra)["graph"]
    lora_nodes = [(nid, n) for nid, n in g.items()
                  if n["class_type"] == "LoraLoaderModelOnly"]
    assert len(lora_nodes) == 1
    lora_id, lora = lora_nodes[0]
    assert lora["inputs"]["lora_name"] == STYLE_FILE
    assert lora["inputs"]["strength_model"] == pytest.approx(0.4)

    loader_id = next(nid for nid, n in g.items() if n["class_type"] == "UNETLoader")
    assert lora["inputs"]["model"] == [loader_id, 0]  # loader feeds the LoRA…

    # …and every other former consumer of the loader now reads the LoRA's
    # output instead — nothing still points straight at the raw checkpoint.
    consumers = [(nid, n) for nid, n in g.items()
                 if nid != lora_id and _links_to(n, loader_id)]
    assert consumers == []
    # H3's sigmas come off BasicScheduler, so BOTH it and the guider have to
    # read the patched model or the render samples an unpatched schedule.
    guider = next(n for n in g.values() if n["class_type"] == "BasicGuider")
    scheduler = next(n for n in g.values() if n["class_type"] == "BasicScheduler")
    assert guider["inputs"]["model"] == [lora_id, 0]
    assert scheduler["inputs"]["model"] == [lora_id, 0]


def test_a_model_with_no_style_lora_gets_no_lora_node(mm):
    g = _h3(mm, mode="i2v", source_image="a.png")
    assert not [n for n in g.values() if n["class_type"] == "LoraLoaderModelOnly"]


def test_a_mode_the_entry_withholds_is_refused_rather_than_substituted(mm):
    # A variant trained against `fl2va` cannot read reference images at all, so
    # rendering r2v on it would return a clip that ignores every sheet staged
    # into it — the silent downgrade this codebase keeps naming.
    with pytest.raises(R.ResolveError, match="mode 'r2v' not available"):
        _resolve(mm, "r2v")


def test_the_prompt_passes_through_untouched(mm):
    # `resolve()`'s model-level `trigger` prepend targets the WHOLE positive
    # string, which for H3 is above `subject_definitions:` — present in the
    # string and outside every field the model reads. An H3 entry therefore
    # declares no `trigger`, and placement belongs to `h3_prompt`.
    g = _resolve(mm, "t2v")["graph"]
    node = next(n for n in g.values() if n["class_type"] == "MiniMaxH3ImageToVideo")
    assert node["inputs"]["prompt"] == "x"


# --- turbo: a step distillation, which is a different thing from a style ----

def test_turbo_swaps_the_sampler_and_drops_the_steps(mm):
    g = _h3(mm, model="minimax-h3-turbo")
    # The stock sampler must be GONE, not merely accompanied: the distilled
    # schedule is what makes 6 steps work, and res_multistep at 6 is mush.
    assert not [n for n in g.values() if n["class_type"] == "KSamplerSelect"]
    assert len([n for n in g.values() if n["class_type"] == "MiniMaxH3TurboSampler"]) == 1
    assert _sched(g)["steps"] == 6
    lora = next(n for n in g.values() if n["class_type"] == "MiniMaxH3TurboLoRA")
    assert lora["inputs"]["strength"] == pytest.approx(1.0)
    # bypass, not merge — merging rounds the delta away on a quantised base
    assert lora["inputs"]["low_vram"] is False


def test_turbo_sampler_keeps_the_node_id_so_the_link_survives(mm):
    """SamplerCustomAdvanced.sampler must still resolve after the swap."""
    g = _h3(mm, model="minimax-h3-turbo")
    adv = next(n for n in g.values() if n["class_type"] == "SamplerCustomAdvanced")
    assert g[adv["inputs"]["sampler"][0]]["class_type"] == "MiniMaxH3TurboSampler"


def test_a_style_variant_on_turbo_stacks_both_adapters_in_one_chain(mm):
    """Style and turbo are orthogonal; a combined entry carries both, and every
    model consumer has to sit downstream of the WHOLE chain."""
    g = _h3(mm, model=STYLE_MODEL + "-turbo")
    style = next(nid for nid, n in g.items() if n["class_type"] == "LoraLoaderModelOnly")
    turbo = next(nid for nid, n in g.items() if n["class_type"] == "MiniMaxH3TurboLoRA")
    loader = next(nid for nid, n in g.items() if n["class_type"] == "UNETLoader")
    # loader -> turbo -> style -> {guider, scheduler}
    assert g[turbo]["inputs"]["model"] == [loader, 0]
    assert g[style]["inputs"]["model"] == [turbo, 0]
    for cls in ("BasicGuider", "BasicScheduler"):
        assert next(n for n in g.values()
                    if n["class_type"] == cls)["inputs"]["model"] == [style, 0]
    # and nothing reaches around the chain back to the raw checkpoint
    assert [nid for nid, n in g.items() if nid != turbo and _links_to(n, loader)] == []


def test_plain_h3_keeps_its_stock_sampler_and_20_steps(mm):
    """The turbo work must not touch the models that did not ask for it."""
    for key in ("minimax-h3", STYLE_MODEL):
        g = _h3(mm, model=key)
        assert _sched(g)["steps"] == 20
        assert next(n for n in g.values() if n["class_type"] == "KSamplerSelect")
        assert not [n for n in g.values() if n["class_type"] == "MiniMaxH3TurboSampler"]


def test_basic_scheduler_honours_an_explicit_step_count(mm):
    """H3 samples through BasicScheduler, which nothing used to write, so a
    caller's `steps` was accepted and silently dropped on every H3 render."""
    assert _sched(_h3(mm, steps=12))["steps"] == 12


# --- the per-job LoRA STACK -------------------------------------------------
# Unlike a style variant (which replaces the checkpoint and is its own entry),
# these are keys the JOB carries, mapped through the entry's `style_loras`.

def test_two_picks_become_two_nodes_in_pick_order(mm):
    g = _h3(mm, loras=["grain", {"key": "handheld", "strength": 0.8}])
    assert _lora_names(g) == [STACK["grain"], STACK["handheld"]]
    by_file = _by_file(g)
    assert by_file[STACK["grain"]] == pytest.approx(1.0)
    assert by_file[STACK["handheld"]] == pytest.approx(0.8)


def test_the_stack_sits_below_a_baked_in_style_lora(mm):
    """ORDER MATTERS. The style splice's guard is "does this template already
    ship a LoraLoaderModelOnly" — splice the job's picks FIRST and that guard is
    satisfied, so the entry's own baked adapter is silently dropped and a style
    variant renders as the plain checkpoint with a concept LoRA on it."""
    g = _resolve(mm, "t2v", loras=["grain"])["graph"]
    assert sorted(_lora_names(g)) == sorted([STYLE_FILE, STACK["grain"]])


def test_a_pick_the_entry_already_bakes_in_is_not_loaded_twice(mm):
    """Loading one file twice applies it at compounding strength, so an entry
    must not offer its own baked adapter as a pickable key."""
    entry = mm["full"]["models"][STYLE_MODEL]
    assert STYLE_FILE not in (entry.get("style_loras") or {}).values()


def test_a_pick_stacks_on_a_turbo_row_too(mm):
    g = _h3(mm, model="minimax-h3-turbo", loras=["grain", "handheld"])
    assert sorted(_lora_names(g)) == sorted([STACK["grain"], STACK["handheld"]])
    assert "MiniMaxH3TurboLoRA" in _classes(g)


def test_an_undeclared_key_is_dropped_rather_than_failing_the_render(mm):
    # Passing it through would fail the whole render inside ComfyUI on a
    # missing file; dropping it costs a flourish and logs a line.
    g = _h3(mm, loras=["grain", "not-a-real-lora"])
    assert _lora_names(g) == [STACK["grain"]]


def test_no_picks_is_no_nodes(mm):
    assert _lora_names(_h3(mm, loras=[])) == []
    assert _lora_names(_h3(mm, loras=None)) == []


def test_a_repeated_key_is_loaded_once(mm):
    g = _h3(mm, loras=["grain", "grain"])
    assert _lora_names(g) == [STACK["grain"]]


def test_the_chain_is_serial_and_every_consumer_reads_its_end(mm):
    # WALKED FROM THE GUIDER BACK, not read off dict order: node ids are
    # assigned as the splice inserts, so iteration order says nothing about
    # what feeds what — and "the chain is serial" is precisely a claim about
    # the links rather than about the ids.
    g = _h3(mm, loras=["handheld", "grain"])
    loader = next(nid for nid, n in g.items() if n["class_type"] == "UNETLoader")
    guider = next(n for n in g.values() if n["class_type"] == "BasicGuider")
    chain, at = [], guider["inputs"]["model"][0]
    while g[at]["class_type"] == "LoraLoaderModelOnly":
        chain.append(at)
        at = g[at]["inputs"]["model"][0]
    assert at == loader, "the chain does not start at the checkpoint"
    assert len(chain) == 2
    # …and the scheduler reads the same end of it, or the sigmas come off an
    # unpatched model.
    sched = next(n for n in g.values() if n["class_type"] == "BasicScheduler")
    assert sched["inputs"]["model"] == [chain[0], 0]


# --- a multi-FILE pick ------------------------------------------------------

def test_one_pick_can_be_several_files_at_the_authors_own_ratio(mm):
    g = _h3(mm, loras=["duotone"])
    assert _by_file(g) == {"h3_test_duotone_stills.safetensors": pytest.approx(1.0),
                           "h3_test_duotone_motion.safetensors": pytest.approx(0.35)}


def test_a_strength_on_a_multi_file_pick_SCALES_the_set(mm):
    """Their ratio IS the recipe, so there is no single absolute strength to
    replace — an explicit value multiplies, where on a one-file pick it
    replaces. 1.0 is the recipe as published."""
    got = _by_file(_h3(mm, loras=[{"key": "duotone", "strength": 0.5}]))
    assert got["h3_test_duotone_stills.safetensors"] == pytest.approx(0.5)
    assert got["h3_test_duotone_motion.safetensors"] == pytest.approx(0.175)


def test_a_strength_on_a_one_file_pick_REPLACES_it(mm):
    assert _by_file(_h3(mm, loras=[{"key": "handheld", "strength": 0.6}])) == {
        STACK["handheld"]: pytest.approx(0.6)}


def test_a_multi_file_pick_stacks_beside_ordinary_ones(mm):
    got = _by_file(_h3(mm, loras=[{"key": "grain", "strength": 0.5}, "duotone"]))
    assert got == {
        STACK["grain"]: pytest.approx(0.5),
        "h3_test_duotone_stills.safetensors": pytest.approx(1.0),
        "h3_test_duotone_motion.safetensors": pytest.approx(0.35),
    }


# --- trigger tokens ---------------------------------------------------------
# `lora_stack` places NOTHING and neither does `resolve()` — that is the whole
# reason this is a separate lookup that returns strings. Placement belongs to
# `h3_prompt`, which owns the envelope's format.

def test_a_trigger_is_returned_and_never_prepended(mm):
    g = _h3(mm, loras=["inked"])
    assert _lora_names(g) == [STACK["inked"]]
    node = next(n for n in g.values() if n["class_type"] == "MiniMaxH3ImageToVideo")
    assert node["inputs"]["prompt"] == "x", "resolve() must not place the token"
    assert R.lora_triggers("minimax-h3", ["inked"], mm=mm) == ["inkstyle"]


def test_triggers_come_back_in_pick_order_deduped(mm):
    assert R.lora_triggers("minimax-h3", [{"key": "inked"}], mm=mm) == ["inkstyle"]
    assert R.lora_triggers("minimax-h3", ["grain", "handheld"], mm=mm) == []
    assert R.lora_triggers("minimax-h3", ["grain", "inked"], mm=mm) == ["inkstyle"]
    assert R.lora_triggers("minimax-h3", ["inked", "inked"], mm=mm) == ["inkstyle"]
    assert R.lora_triggers("minimax-h3", [], mm=mm) == []
    assert R.lora_triggers("minimax-h3", None, mm=mm) == []


def test_a_multi_file_pick_can_need_one_token_per_half(mm):
    assert R.lora_triggers("minimax-h3", ["duotone"], mm=mm) == ["Duotone", "duo2"]
    assert R.lora_triggers("minimax-h3", ["inked", "duotone"], mm=mm) == [
        "inkstyle", "Duotone", "duo2"]


def test_an_unknown_model_yields_no_tokens_rather_than_raising(mm):
    # `resolve()` is the place that refuses an unresolvable model; a duplicate
    # raise here would fail a render one step earlier with a worse message.
    assert R.lora_triggers("not-a-model", ["inked"], mm=mm) == []
    assert R.lora_triggers("wan2.2", ["inked"], mm=mm) == []


def test_a_picks_own_trigger_covers_an_adapter_no_map_declares(mm):
    """A hub-downloaded adapter is in no model_map, so it arrives as a bare
    filename and its token can only travel beside it. The TABLE still wins
    where both exist — that value is the studio's own measurement."""
    assert R.lora_triggers(
        "minimax-h3", [{"key": "mine.safetensors", "trigger": "mytoken"}], mm=mm) == ["mytoken"]
    assert R.lora_triggers(
        "minimax-h3", [{"key": "inked", "trigger": "wrong"}], mm=mm) == ["inkstyle"]


def test_a_bare_filename_pick_is_loaded_as_itself(mm):
    """The escape hatch for an adapter the user downloaded: it is in no
    `style_loras` table, so a key ending `.safetensors` is taken as the file."""
    g = _h3(mm, loras=["mine.safetensors"])
    assert _lora_names(g) == ["mine.safetensors"]


# --- two distillations, applied two different ways --------------------------
# One needs its vendor's pack (bypass application plus its own sampler); the
# other is an ordinary adapter its own docs load with `LoraLoaderModelOnly`.
# Assuming the first shape for both would make that pack a dependency of a
# distillation that never needed one, so `turbo_apply` picks — defaulting to
# "bypass" so every entry written before it is untouched.

def test_a_plain_turbo_uses_an_ordinary_loader_and_no_custom_nodes(mm):
    g = _h3(mm, model="minimax-h3-lightx2v")
    assert _by_file(g) == {
        "minimax_h3_lightx2v_turbo_4step_v01.safetensors": pytest.approx(0.75)}
    assert "MiniMaxH3TurboLoRA" not in _classes(g)
    assert "MiniMaxH3TurboSampler" not in _classes(g)
    assert "KSamplerSelect" in _classes(g)      # kept, not replaced


def test_it_carries_its_own_sampler_and_step_count(mm):
    g = _h3(mm, model="minimax-h3-lightx2v")
    sel = next(n["inputs"] for n in g.values() if n["class_type"] == "KSamplerSelect")
    assert sel["sampler_name"] == "er_sde"      # the vendor's documented sampler
    assert _sched(g)["steps"] == 4


def test_the_bypass_turbo_is_unchanged_by_turbo_apply(mm):
    """`turbo_apply` defaults to bypass, so the measured entry keeps its shape."""
    g = _h3(mm, model="minimax-h3-turbo")
    assert "MiniMaxH3TurboLoRA" in _classes(g)
    assert "MiniMaxH3TurboSampler" in _classes(g)
    assert "KSamplerSelect" not in _classes(g)
    assert _by_file(g) == {}                    # the turbo file is not a plain LoRA


def test_a_model_that_declares_no_sampler_keeps_the_templates(mm):
    """The `sampler`/`scheduler` writes must be inert for every entry that does
    not ask for them."""
    plain = _h3(mm)
    sel = next(n["inputs"] for n in plain.values()
               if n["class_type"] == "KSamplerSelect")
    with open(os.path.join(ROOT, "workflows", "minimax_h3_t2v.json")) as f:
        tmpl = json.load(f)
    # templates carry top-level `_comment` strings alongside their nodes
    want = next(n["inputs"]["sampler_name"] for n in tmpl.values()
                if isinstance(n, dict) and n.get("class_type") == "KSamplerSelect")
    assert sel["sampler_name"] == want
    assert _sched(plain)["steps"] == 20          # plain H3 declares no steps
