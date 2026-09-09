"""The LOCAL voice engines, as a table rather than a branch per call site.

`dialogue_synth` had thirty `is_breeze(...)` tests in it when Breeze was the
only local engine, and each one asked the same two questions: is this voice a
clip on this box rather than a vendor id, and which client speaks to it. A
second engine answered by copying those thirty into `is_qwen` would be the
twin drift this repo keeps paying for — so the questions are asked HERE, once,
and a third engine is a row.

A voice id is `<engine>:<asset id>` — a STRING, deliberately, so every place
that treats a voice id as an opaque key (plan_lines' dedupe, `line_key`,
`exchange_key`, the `taken` sets, the asset meta) keeps working unchanged.
That was `breeze_tts`'s own choice; this generalises it rather than replacing
it, and `breeze:<clip>` still means exactly what it meant.

WHAT AN ENGINE HAS TO PROVIDE is the surface `breeze_tts` already had:
`enabled/health/speak/design/to_mp3/wav_duration_ms/concat_wavs/write_temp/
park/unpark/gpu_busy/ensure_up/not_serving_reason/SAMPLE_RATE`. `qwen_tts` is
written to match it name for name, which is what makes dispatch a dict lookup.

WHERE THEY DIFFER IS DECLARED, NOT DISCOVERED. `SUPPORTS_DIRECTION` is the
first such flag: Breeze can steer a cloned line from a delivery note and Qwen
cannot (`generate_voice_clone` takes no `instruct`). A caller reads the flag
and does not ask, rather than sending an instruction the engine drops — which
is the silent downgrade that would otherwise cost a scene its delivery with
nothing in any log.
"""
import importlib

import gpu_park

# name -> module path. Order is PREFERENCE order for `first_available`, and
# it is deliberate: Breeze is the engine this studio has measured (a full
# episode, 92 lines on one spine) and Qwen is the newer one, so an
# unconfigured box keeps doing what it did. LICENCE is why anyone would move:
# Breeze's weights are BreezeBlue non-commercial, Qwen3-TTS is Apache 2.0.
ENGINES = {
    "breeze": "breeze_tts",
    "qwen": "qwen_voice",
}
PREFIXES = {name: f"{name}:" for name in ENGINES}

_CACHE = {}


def engine(name):
    """The client module for an engine name, imported once.

    Lazy because both modules are stdlib-only at import but neither is needed
    by a plan that records no dialogue, and `plan_cli`'s bundle test walks
    this closure."""
    if name not in ENGINES:
        raise KeyError(f"unknown voice engine {name!r}")
    if name not in _CACHE:
        _CACHE[name] = importlib.import_module(ENGINES[name])
    return _CACHE[name]


def voice_id(name, asset_id):
    """`<engine>:<asset id>` — the one place the spelling is decided."""
    if name not in ENGINES:
        raise KeyError(f"unknown voice engine {name!r}")
    return f"{PREFIXES[name]}{asset_id}"


def split(vid):
    """(engine name, asset id) for a local voice id, else (None, None).

    A vendor id — an ElevenLabs voice, a Fish reference — has no prefix and
    comes back (None, None), which is how every caller tells "a clip on this
    box" from "an id at a provider" without knowing the engine list."""
    s = str(vid or "")
    for name, pre in PREFIXES.items():
        if s.startswith(pre):
            return name, s[len(pre):]
    return None, None


def is_local(vid):
    return split(vid)[0] is not None


def engine_of(vid):
    """The client module a voice id belongs to, or None for a vendor id."""
    name, _ = split(vid)
    return engine(name) if name else None


def asset_id(vid):
    return split(vid)[1]


def supports_direction(vid_or_name):
    """Can a line in this voice carry a delivery instruction?

    False for a vendor id too — an ElevenLabs line carries its delivery as a
    leading v3 tag inside the TEXT, not as a separate instruction, so "send an
    instruction" is the wrong question there as well."""
    name, _ = split(vid_or_name)
    name = name or (vid_or_name if vid_or_name in ENGINES else None)
    if not name:
        return False
    return bool(getattr(engine(name), "SUPPORTS_DIRECTION", False))


def serving(name):
    """Is this engine configured AND answering — the test `resolve_provider`
    makes before casting a whole episode on it."""
    try:
        m = engine(name)
    except Exception:  # noqa: BLE001 — an engine that will not import is not serving
        return False
    return bool(m.enabled() and m.health())


def available():
    """Engine names that are actually answering, in preference order."""
    return [n for n in ENGINES if serving(n)]


def first_available():
    return next(iter(available()), None)


def park_all(log=print):
    """Park every CONFIGURED engine before a gpu-lane job.

    Both share one busy flag (one GPU, one flag), but each has its own systemd
    unit and only its own module can stop it — so a box serving two engines
    has to be told about both or the one nobody parked loads beside a render.
    Never raises: a render must not fail because a TTS unit would not stop."""
    parked = []
    for name in ENGINES:
        try:
            m = engine(name)
            if m.enabled() and m.park(log=log):
                parked.append(name)
        except Exception:  # noqa: BLE001
            continue
    return parked


def yield_to_voice(log=print):
    """Between gpu jobs: hold the lane while a waiting voice job takes a slot.

    THE GAP BETWEEN ONE JOB'S unpark AND THE NEXT ONE'S park IS MILLISECONDS.
    Measured on the pod, a batch of 38 renders draining: a voice ref waited on
    the gate, caught the one gap it was ever offered, started the unit — and
    the next claim stopped it in the same second. Without this the gate is a
    lottery a voice job cannot win, so it waits out its whole deadline and
    fails; the failure is honest and the person still has no voice.

    Bounded and ticket-driven (`gpu_park.wanted`): no ticket, no wait, and a
    ticket expires, so a killed voice job cannot hold a $3.36/hr render lane.
    Never raises — this is a courtesy between lanes, not a step in a render.
    """
    try:
        if not gpu_park.wanted():
            return 0.0
        holds = []
        for name in ENGINES:
            try:
                m = engine(name)
                if m.enabled():
                    holds.append(m.HOLD_PATH)
            except Exception:  # noqa: BLE001
                continue
        return gpu_park.yield_to_voice(holds, log=log)
    except Exception:  # noqa: BLE001
        return 0.0


def unpark_all():
    for name in ENGINES:
        try:
            engine(name).unpark()
        except Exception:  # noqa: BLE001
            continue
