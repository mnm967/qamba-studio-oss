"""tts — voiceover / dialogue text-to-speech for the v2 app.

The Audio & Voice Studio panel enqueues a `tts` job (invariant #1: the
browser writes a jobs row, nothing talks to the pod). We synth the line, put
the MP3 on B2, register it as an `audio` asset, and enqueue an asset_ingest so
the timeline gets duration + waveform peaks. The result is just another asset:
drag it onto A1/A2/A3.

FIVE providers, and which one speaks is now an EXPLICIT choice rather than an
accident of which field the caller happened to fill:

  openai      gpt-4o-mini-tts, six stock voices, `emotion` as `instructions`
  elevenlabs  v3, the voices `dialogue_synth` casts characters into
  fish        Fish Audio hosted, speaking as a registered clone
  fish-local  s2-pro on the pod, zero-shot from the clone's own clip
  voxtral     Voxtral 4B TTS over an OpenAI-shaped /v1/audio/speech, hosted or
              a local vLLM-Omni serve. Expression is the VOICE PRESET, not a
              per-line cue — see VOXTRAL_VOICES. CC-BY-NC weights.
  breeze      Breeze TTS 2 on the pod (worker/breeze_tts.py). Speaks as a
              CAST member whose voice was DESIGNED from the writer's prose
              (`doc.breeze_voice`), as a zero-shot CLONE of a `voice_clones`
              sample, or DESIGNS a one-off voice from `payload.instruction`.
              `emotion` is a voice-DIRECTION instruction here, not a tag, and
              vocal events in the text — "(sigh)" — are performed. Weights
              are research / NON-COMMERCIAL.

ElevenLabs does BOTH: a cast member's voice, or a clone — and a clone there is
an ordinary `voice_id`, so it needs no separate synthesis path and is the only
one that can be cast onto a character for a whole episode.

`payload.provider` decides. It is inferred only when absent, from what the
payload names — a `voice_clone_id` implies its clone's provider, a speaker
implies elevenlabs — so every existing caller keeps its behaviour and a new one
can be explicit. That inference used to be the WHOLE mechanism, which is how
the old panel shipped a five-model picker that changed nothing: `handle_tts`
read `voice`, and never `model`.

`bible_entry_id` is the one place that deliberately pins a provider. That key
means "this recording IS the character's timbre reference", the reviewer's
speaker verifier compares takes against it, and letting a picker change the
provider under it would silently re-baseline every similarity score in
`take_reviews`.
"""
import os

import genmedia
import media
import sb
from status import log

OPENAI_VOICES = ("alloy", "echo", "fable", "onyx", "nova", "shimmer")
PROVIDERS = ("openai", "elevenlabs", "fish", "fish-local", "voxtral",
             "breeze", "qwen")
# The providers whose voice is a designed CLIP on this box, dispatched through
# `voice_engines` rather than a branch each — see that module's docstring.
LOCAL_ENGINES = ("breeze", "qwen")

# Voxtral 4B TTS (mistralai/Voxtral-4B-TTS-2603). OpenAI-shaped
# `/v1/audio/speech`, so it needs no client of its own — just a base URL,
# which is either Mistral's hosted endpoint or a vLLM-Omni `vllm serve
# --omni` on some box. `VOXTRAL_BASE_URL` decides; `VOXTRAL_API_KEY` is sent
# when set (hosted) and omitted when not (a local serve wants no auth).
#
# ITS EXPRESSION IS THE VOICE, NOT A CUE, and that is the thing to know
# before reaching for it to fix a robotic read. ElevenLabs v3 takes inline
# performance tags — `[whispers]`, `[sighs]`, `[sarcastic]` — which is what
# `dialogue_synth.TAG_MAP` deterministically compiles a writer's `delivery`
# prose into, per line. Voxtral publishes no such grammar: its 20 presets are
# VOICE EMBEDDINGS whose affect is baked into the file
# (casual_/cheerful_/neutral_ x male/female, plus one pair per non-English
# language), so the only per-line expression available is the punctuation of
# the text itself. So `delivery` cannot reach it, and it is NOT in
# TAG_PROVIDERS — pretending otherwise would paste "[whispers]" into the
# words it reads aloud.
VOXTRAL_MODEL = os.environ.get("VOXTRAL_MODEL", "mistralai/Voxtral-4B-TTS-2603")
# The five English presets. The other fifteen are one male/female pair per
# supported language and are reachable by naming one explicitly.
VOXTRAL_VOICES = ("neutral_female", "neutral_male", "casual_female",
                  "casual_male", "cheerful_female")


def _clone(payload):
    """The `voice_clones` row this job speaks in, or None."""
    cid = payload.get("voice_clone_id")
    if not cid:
        return None
    rows = sb.get(f"voice_clones?id=eq.{cid}"
                  f"&select=id,name,provider,reference_id,sample_asset_id,"
                  f"sample_text,status")
    if not rows:
        raise ValueError(f"voice clone {cid} no longer exists")
    clone = rows[0]
    if clone.get("status") != "ready":
        raise ValueError(
            f"'{clone.get('name')}' is not ready yet ({clone.get('status')}) — "
            f"wait for its registration to finish")
    return clone


def _local_voice(payload):
    """The LOCAL-engine voice (`<engine>:<clip>`) a `speaker_entry_id` names,
    or None — an entry cast on ElevenLabs answers None here and its id from
    `_el_voice`, so the two never disagree about one character."""
    import dialogue_synth as ds
    eid = payload.get("speaker_entry_id")
    if not eid:
        return None
    rows = sb.get(f"bible_entries?id=eq.{eid}&select=id,name,doc")
    if not rows:
        return None
    vid = ds._entry_voice(rows[0], {})
    return vid if ds.is_local(vid) else None


def _speaker_entry(payload):
    """The bible row this job speaks AS, with what a DESIGNED voice is built
    from — including `identity_line`, which `_local_voice` does not fetch.

    Two different fields carry two different facts and only one of them is in
    `doc.voice`: the writer describes TIMBRE there ("a gravelly contralto with
    a slow deliberate pace") and puts WHOSE it is in the identity line, whose
    contract makes apparent age the opening attribute. A voice designed from
    the timbre alone is, in `voice_instruction`'s own words, a voice of no
    particular person.

    Never raises — a designed voice is a fallback path already, and failing it
    on a lookup would be worse than the generic read it exists to improve on.
    """
    eid = payload.get("speaker_entry_id") or payload.get("bible_entry_id")
    if not eid:
        return {}
    try:
        rows = sb.get(f"bible_entries?id=eq.{eid}"
                      f"&select=id,name,doc,identity_line")
    except Exception:  # noqa: BLE001
        return {}
    return rows[0] if rows else {}


def _local_voice_doc(entry_id, engine, dv):
    """The entry's `doc` with a DESIGNED local voice written onto it, or None.

    Read-modify-write, because `doc` is one jsonb column: a bare
    `{"doc": {...}}` patch would drop every other field on the character
    sheet. Shape matches `dialogue_synth.cast_local_voice` exactly —
    `doc.<engine>_voice` = {asset_id, ref_text, instruction} plus
    `doc.voice_provider` — because `_voice_of_doc` is the one reader and two
    spellings of one fact is the drift that file exists to end.

    Returns None (and says so) rather than raising: the clip is registered by
    the time this runs, and the timbre pin is worth writing even when this is
    not.
    """
    try:
        rows = sb.get(f"bible_entries?id=eq.{entry_id}&select=doc")
    except Exception as e:  # noqa: BLE001 — a cast is not worth failing a synth
        log(f"tts: could not read entry {entry_id} to record the {engine} "
            f"voice — the clip is pinned but the character stays uncast: {e}")
        return None
    if not rows:
        return None
    doc = dict(rows[0].get("doc") or {})
    doc[f"{engine}_voice"] = dv
    doc["voice_provider"] = engine
    return doc


def _el_voice(payload):
    """The ElevenLabs voice this job should speak in, or None.

    A `speaker_entry_id` that resolves to no voice returns None rather than
    raising: the character was simply never cast (planned before ElevenLabs
    was wired, or an entry added by hand), and a narrated line in a generic
    voice is a better answer than a failed job. It says so in the log, because
    silently getting a different voice than the one you picked is exactly the
    confusion this panel existed to create.
    """
    import dialogue_synth as ds
    if not ds.enabled():
        if payload.get("el_voice_id") or payload.get("speaker_entry_id"):
            log("tts: ELEVENLABS_API_KEY is unset — falling back to the OpenAI chain")
        return None
    vid = str(payload.get("el_voice_id") or "").strip()
    if vid:
        return vid
    eid = payload.get("speaker_entry_id")
    if not eid:
        return None
    rows = sb.get(f"bible_entries?id=eq.{eid}&select=id,name,doc")
    if not rows:
        log(f"tts: speaker {eid} is gone — using the OpenAI chain")
        return None
    entry = rows[0]
    # `_entry_voice` follows `doc.variant_of`, so an outfit variant speaks in
    # its parent's voice — the same rule every other identity fact follows.
    vid = ds._entry_voice(entry, {})
    if ds.is_local(vid):
        return None                     # `_local_voice` answers for this one
    if not vid:
        log(f"tts: '{entry.get('name')}' has no el_voice_id "
            f"(never cast) — using the OpenAI chain")
    return vid


def _pick_provider(payload, clone, el_voice, bz_voice=None):
    # `bz_voice` is any LOCAL engine's voice id; the engine NAMES ITSELF in
    # the id, so the provider is read off it rather than assumed to be the
    # one this handler happened to be written against first.
    """What the caller asked for, else what the payload implies."""
    want = str(payload.get("provider") or "").strip().lower()
    if want in PROVIDERS:
        return want
    if want:
        log(f"tts: unknown provider {want!r} — falling back to what the payload names")
    if clone:
        return clone["provider"]
    if bz_voice:
        import voice_engines as ENG
        return ENG.split(bz_voice)[0] or "breeze"
    if el_voice:
        return "elevenlabs"
    return "openai"


def handle_tts(job):
    payload = job.get("payload") or {}
    text = str(payload.get("text") or "").strip()
    if not text:
        raise ValueError("tts job payload missing text")
    emotion = str(payload.get("emotion") or "").strip() or None

    # WHAT THE ENGINE WAS ACTUALLY TOLD, where that is not the payload.
    # A designed voice is built here at render time from `doc.voice` PLUS the
    # speaker's identity line, so the job payload does not contain it and
    # neither did the asset — which made a correct render and a broken one
    # look identical from every surface in the app. Recorded below.
    designed = None
    # The DESIGNED clip's own reference text, kept for the same reason
    # `designed` is. On a local engine the recording IS the voice, so every
    # line later CLONES from this clip and the clone has to be told what the
    # clip says — see the write-back at the bottom of this handler.
    design_ref_text = None
    # WHAT THE CLIP ACTUALLY SAYS. `dialogue_synth._ref_text` reads
    # `meta.speech_text` and RAISES without it, because a clone is given
    # (audio, transcript) and a reference that cannot say what it says is not
    # usable — so a local clip registered without this key is a voice every
    # later line throws on. `design_voice` records it; this handler recorded
    # only `meta.line`, which is the text BEFORE `_speech_text` decided what
    # this engine does with its vocal events, i.e. not the transcript.
    spoken_text = None

    clone = _clone(payload)
    el_voice = _el_voice(payload)
    bz_voice = _local_voice(payload)
    provider = _pick_provider(payload, clone, el_voice, bz_voice)
    # A cloned voice IS the provider choice — asking for a clone and then
    # naming a different provider is a contradiction, and rendering the stock
    # voice would sound like the clone simply failed.
    if clone and provider != clone["provider"]:
        provider = clone["provider"]
    # The two Fish rows have no other voice source, so naming one without a
    # clone is unrenderable. ElevenLabs does have one (the cast), so it is
    # NOT in this list — it simply falls through to the cast branch.
    if provider in ("fish", "fish-local") and not clone:
        raise ValueError(f"the {provider} provider speaks as a cloned voice — "
                         f"pick one, or choose another provider")

    sample = None
    try:
        if clone:
            sample = _clone_sample(clone, job["id"])
            sb.job_progress(job["id"], 0.15,
                            note=f"{provider} · {clone.get('name')}")
            import voice_clone as VC
            data = VC.synth(clone, _tagged(text, emotion, provider),
                            sample_path=sample, instruction=emotion)
            dur = genmedia._mp3_duration(data)
            voice = clone["id"]
        elif provider in LOCAL_ENGINES:
            import dialogue_synth as ds
            import voice_engines as ENG
            m = ENG.engine(provider)
            if not m.enabled():
                raise ValueError(m.not_serving_reason())
            # THE ENGINE SPELLS THE EVENTS. Breeze performs "(sigh)"; Qwen has
            # no event vocabulary and would read the word aloud, so
            # `_speech_text` asks the engine rather than assuming Breeze's
            # answer — the same rule the dialogue path follows.
            spoken = ds._speech_text(text, emotion, f"{provider}:x")
            spoken_text = spoken
            # `emotion` reaches the engine as a DIRECTION instruction — open
            # prose — on an engine that can use one. `_local_line` drops it on
            # one that cannot, so nothing here has to know which.
            ins = ds._instruction(emotion) if emotion else None
            if bz_voice:
                sb.job_progress(job["id"], 0.15,
                                note=f"{provider} · {payload.get('speaker') or 'cast voice'}"
                                     + (f" · {emotion}" if emotion else ""))
                data = ds._local_line(bz_voice, spoken, ins)
                voice = bz_voice
            else:
                # No cast voice and no clone: DESIGN one — and design it
                # THE WAY THE PLANNER WOULD HAVE CAST THIS CHARACTER.
                # `voice_instruction` is `dialogue_synth.design_voice`'s own
                # sentence builder, so a voice ref made from the bible page
                # and a voice the plan casts are the same voice. They were
                # not: this branch handed the engine the raw delivery note,
                # so the clip that becomes `voice_ref_asset_id` — what every
                # line CLONES from and what the reviewer's speaker verifier
                # baselines takes against — was designed with no age and no
                # sex in it at all. Two paths designing one character's voice
                # is the drift this repo keeps paying for.
                #
                # An explicit `instruction` still wins: that is a caller
                # describing a voice outright rather than naming a character.
                design = str(payload.get("instruction") or "").strip()
                if not design:
                    who = _speaker_entry(payload)
                    # The ENTRY's own timbre prose, not the payload's delivery
                    # note: `doc.voice` is what the character sounds like and
                    # `emotion` is how this line is read. Only one of them
                    # belongs in a voice that outlives the line.
                    prose = str((who.get("doc") or {}).get("voice")
                                or emotion or "").strip()
                    design = ds.voice_instruction(
                        prose, who.get("identity_line") or "")
                fallback = getattr(m, "DEFAULT_INSTRUCTION",
                                   "Speak clearly and naturally.")
                # What was SENT, not what was asked for: with nothing to
                # describe, the engine's own neutral read is the answer, and
                # recording the empty string would say the opposite.
                designed = design or fallback
                sb.job_progress(job["id"], 0.15,
                                note=f"{provider} · designed voice"
                                     + (f" · {designed[:40]}" if designed else ""))
                data = m.to_mp3(m.design(designed, spoken,
                                         seed=int(payload.get("seed") or 42)))
                voice = f"{provider}:design"
                design_ref_text = spoken
            dur = genmedia._mp3_duration(data)
        elif provider == "voxtral":
            if not voxtral_enabled():
                raise ValueError(
                    "the voxtral provider needs VOXTRAL_BASE_URL (Mistral's "
                    "hosted endpoint, or a vLLM-Omni `vllm serve "
                    "mistralai/Voxtral-4B-TTS-2603 --omni`)")
            if emotion:
                # Said out loud rather than silently dropped: a delivery note
                # that reaches no engine is the picker-that-changes-nothing
                # this handler was rewritten to end.
                log(f"tts: voxtral has no inline performance tags — the "
                    f"'{emotion}' delivery note is not applied; its expression "
                    f"comes from the voice preset")
            voice = str(payload.get("voice") or "").strip() or VOXTRAL_VOICES[0]
            sb.job_progress(job["id"], 0.15, note=f"voxtral · {voice}")
            data, voice = _voxtral_synth(text, voice)
            dur = None          # measured off the written file below
        elif provider == "elevenlabs" and el_voice:
            import dialogue_synth as ds
            speech = ds._speech_text(text, emotion or "")
            sb.job_progress(job["id"], 0.15,
                            note=f"elevenlabs {el_voice[:8]}"
                                 + (f" · {emotion}" if emotion else ""))
            data = ds._synth(el_voice, speech)
            dur = genmedia._mp3_duration(data)
            voice = el_voice
        else:
            voice = str(payload.get("voice") or "").strip() or "alloy"
            if voice not in OPENAI_VOICES:
                voice = "alloy"
            provider = "openai"
            sb.job_progress(job["id"], 0.15,
                            note=f"synth on {voice}"
                                 + (f" · {emotion}" if emotion else ""))
            data, dur, provider = genmedia.generate_audio(
                text, emotion=emotion, openai_voice=voice)
    finally:
        if sample:
            try:
                os.remove(sample)
            except OSError:
                pass

    # The container follows the provider: every other one returns mp3, Voxtral
    # serves wav. Writing wav bytes under a .mp3 key would register an asset
    # whose extension lies about it — and `_mp3_duration` cannot read a wav
    # header either, which is why `dur` is measured off the file below when
    # the synth branch did not already know it.
    ext, ctype = ("wav", "audio/wav") if provider == "voxtral" else ("mp3", "audio/mpeg")
    key = f"audio/tts/{job['id']}.{ext}"
    local = f"/tmp/tts_{job['id']}.{ext}"
    with open(local, "wb") as f:
        f.write(data)
    if dur is None:
        dur = (media.probe(local).get("duration_ms") or 0) / 1000.0
    try:
        media.b2_put(local, key, content_type=ctype)
        asset = sb.register_asset(
            key, "audio", project_id=job.get("project_id"),
            content_type=ctype, source_job_id=job["id"],
            duration_ms=int(float(dur or 0) * 1000),
            origin="generated",
            meta={"line": text, "voice": voice, "emotion": emotion,
                  "provider": provider, "kind_hint": "voice",
                  **({"speech_text": spoken_text} if spoken_text else {}),
                  **({"instruction": designed} if designed else {}),
                  **({"voice_clone_id": clone["id"], "clone_name": clone.get("name")}
                     if clone else {}),
                  **({"speaker_entry_id": payload["speaker_entry_id"]}
                     if payload.get("speaker_entry_id") else {}),
                  **({"speaker": payload["speaker"]}
                     if payload.get("speaker") else {}),
                  **({"bible_entry_id": payload["bible_entry_id"]}
                     if payload.get("bible_entry_id") else {})},
            tags=["voiceover"])
        # A character voice reference: pin it on the entry so every Ref2VA
        # block can stage it as that speaker's voice-timbre anchor.
        #
        # AND ON A LOCAL ENGINE THE RECORDING *IS* THE VOICE, so the clip's id
        # goes on the DOC as well — the pin alone is half a cast. ElevenLabs
        # hides this: its voice is a library id the planner writes from a
        # table lookup, so there the timbre clip is a separate recording and
        # the pin really is the whole job. Breeze and Qwen have no such
        # table, and `dialogue_synth._voice_of_doc` reads
        # `doc.<engine>_voice.asset_id` — so writing only the pin leaves an
        # entry that HAS a timbre clip and NO cast voice, which is precisely
        # what `plan_lines` refuses on.
        #
        # MEASURED, and it is silent from every surface: a 29-beat episode
        # rendered every block on voice-timbre refs, one
        # "<name> has no cast voice — timbre refs instead" per block and the
        # spine refusing to build ("uncast speaker"), while the bible page
        # showed a voice clip for all seven characters. Nothing else on the
        # plan path calls `cast_local_voice` — its docstring says `llm.py`
        # does and that has not been true — so this handler is where a
        # locally-cast character is cast at all.
        if payload.get("bible_entry_id"):
            entry_patch = {"voice_ref_asset_id": asset["id"]}
            if design_ref_text is not None and provider in LOCAL_ENGINES:
                # Only a DESIGN writes the cast. A line read in a voice the
                # entry is already cast in (the clone branch above) must not
                # repoint that voice at one line's recording.
                doc = _local_voice_doc(
                    payload["bible_entry_id"], provider,
                    {"asset_id": asset["id"], "ref_text": design_ref_text,
                     "instruction": designed})
                if doc is not None:
                    entry_patch["doc"] = doc
            sb.patch(f"bible_entries?id=eq.{payload['bible_entry_id']}",
                     entry_patch)
        # Waveform peaks + exact probe come from the shared ingest path so the
        # timeline shows a real waveform, not silence.
        try:
            sb.insert("jobs", {
                "kind": "asset_ingest", "lane": "cpu", "status": "queued",
                "priority": 60, "payload": {"asset_id": asset["id"]},
                "project_id": job.get("project_id"),
            })
        except Exception as e:
            log(f"tts: asset_ingest enqueue failed: {e}")
        sb.job_done(job["id"], output_key=key, output_asset_id=asset["id"])
        log(f"JOB DONE {job['id']} -> tts {key} ({provider}, {dur}s, voice={voice})")
    finally:
        try:
            os.remove(local)
        except OSError:
            pass


# Engines that read the bracket-tag grammar. ElevenLabs v3 defined it and
# s2-pro adopted it, so the studio's one deterministic `delivery -> tag` map
# covers both (invariant #6 — the studio compiles the vendor format, never the
# LLM). Fish's HOSTED API is not one of them: it applies the clone's own
# prosody and reads a stray tag out loud.
TAG_PROVIDERS = ("elevenlabs", "fish-local")


def _tagged(text, emotion, provider):
    if provider not in TAG_PROVIDERS or not emotion:
        return text
    import dialogue_synth as ds
    return ds._speech_text(text, emotion)


def voxtral_enabled():
    return bool(os.environ.get("VOXTRAL_BASE_URL"))


def _voxtral_synth(text, voice):
    """One `/v1/audio/speech` call -> (wav bytes, duration_ms).

    WAV rather than mp3 on purpose: the endpoint serves both, and the studio
    already stores wav for anything it measures (the audio slices, the
    spine). `_mp3_duration` cannot read a wav header, so the duration comes
    from ffprobe via `media.probe`, the way every other wav in the pipeline
    is measured.
    """
    import json
    import urllib.request
    base = os.environ["VOXTRAL_BASE_URL"].rstrip("/")
    if not base.endswith("/v1"):
        base += "/v1"
    v = (voice or "").strip() or VOXTRAL_VOICES[0]
    body = json.dumps({"input": text, "model": VOXTRAL_MODEL,
                       "response_format": "wav", "voice": v}).encode()
    headers = {"Content-Type": "application/json"}
    key = os.environ.get("VOXTRAL_API_KEY")
    if key:
        headers["Authorization"] = f"Bearer {key}"
    last = None
    for _attempt in (1, 2):
        try:
            req = urllib.request.Request(f"{base}/audio/speech", data=body,
                                         method="POST", headers=headers)
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read(), v
        except Exception as e:      # noqa: BLE001 — one retry, then loud
            last = e
    raise RuntimeError(f"voxtral synth failed: {last}")


def _clone_sample(clone, jid):
    """The clone's reference clip on disk, for the zero-shot provider.

    Fetched for the hosted provider too — it costs one small download and
    means `VC.synth` never has to care which branch it is on. Returns None if
    the sample row is gone, which only the local path treats as fatal.
    """
    aid = clone.get("sample_asset_id")
    if not aid:
        return None
    rows = sb.get(f"assets?id=eq.{aid}&select=b2_key")
    if not rows:
        return None
    ext = os.path.splitext(rows[0]["b2_key"])[1] or ".mp3"
    dest = f"/tmp/clonesrc_{jid}{ext}"
    try:
        media.b2_get(rows[0]["b2_key"], dest)
        return dest
    except Exception as e:  # noqa: BLE001
        log(f"tts: could not fetch the clone's reference clip: {e}")
        return None
