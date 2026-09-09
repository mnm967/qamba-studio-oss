"""Audio analysis for take review: deterministic DSP first, ASR second.

No LLM decides whether audio clips or a line was cut off — those are
measurements. ffmpeg computes loudness/silence/clipping; faster-whisper
yields word timestamps that contract.compare_dialogue judges against the
expected lines. Every layer degrades gracefully: a pod without the ASR
package still gets the DSP report and a note saying transcription was
unavailable, never a failed review job.
"""
import json
import re
import subprocess

from status import log


def _run(args):
    return subprocess.run(["ffmpeg", "-v", "info", *args, "-f", "null", "-"],
                          capture_output=True, text=True).stderr


def parse_ebur128(stderr):
    """The LAST matches win: ffmpeg's running meter prints an `I:` line per
    frame starting at -70 LUFS while loudness accumulates, and the summary
    block at the end holds the real integrated value. Grabbing the first
    match scored every take 'silent' (live blocks 0 and its retake both
    'measured' -70 with a -4.6 dBFS peak — a contradiction)."""
    out = {}
    ints = re.findall(r"I:\s*(-?[\d.]+)\s*LUFS", stderr)
    if ints:
        out["integrated_lufs"] = float(ints[-1])
    peaks = re.findall(r"Peak:\s*(-?[\d.]+)\s*dBFS", stderr)
    if peaks:
        out["true_peak_dbfs"] = float(peaks[-1])
    return out


def dsp_metrics(path, content_ms):
    """Loudness, clipping, silence — the boring truths."""
    out = {}
    try:
        out.update(parse_ebur128(_run(["-i", path, "-af", "ebur128=peak=true"])))
    except Exception as e:  # noqa: BLE001
        log(f"audioqa ebur128 failed: {e}")
    silences = []
    try:
        err = _run(["-i", path, "-af", "silencedetect=noise=-38dB:d=0.9"])
        for s, e in re.findall(r"silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)", err):
            silences.append([round(float(s), 2), round(float(e), 2)])
    except Exception as e:  # noqa: BLE001
        log(f"audioqa silencedetect failed: {e}")
    out["silence_gaps"] = silences
    issues = []
    if out.get("integrated_lufs") is not None and out["integrated_lufs"] < -38:
        issues.append({"code": "SILENT_TAKE", "severity": "high",
                       "detail": f"integrated loudness {out['integrated_lufs']:.1f} LUFS — "
                                 f"effectively silent"})
    if out.get("true_peak_dbfs") is not None and out["true_peak_dbfs"] > -0.1:
        issues.append({"code": "CLIPPING", "severity": "medium",
                       "detail": f"true peak {out['true_peak_dbfs']:.2f} dBFS"})
    long_gaps = [g for g in silences if g[1] - g[0] > max(2.5, content_ms / 4000)]
    if long_gaps:
        issues.append({"code": "LONG_SILENCE", "severity": "low",
                       "detail": f"{len(long_gaps)} silence gap(s) over "
                                 f"{max(2.5, content_ms / 4000):.1f}s: {long_gaps[:3]}"})
    return out, issues


_ASR = {}


def transcribe(path):
    """Word-level ASR via faster-whisper (small, int8, CPU — a 15s clip takes
    seconds and never touches the render GPU). Returns (words, text) or
    (None, None) when the package or model is unavailable."""
    try:
        if "model" not in _ASR:
            from faster_whisper import WhisperModel
            _ASR["model"] = WhisperModel("small", device="cpu", compute_type="int8")
        segments, _info = _ASR["model"].transcribe(
            path, word_timestamps=True, vad_filter=True, language="en")
        words, text = [], []
        for seg in segments:
            text.append(seg.text)
            for w in seg.words or []:
                words.append({"word": w.word, "start": round(w.start, 3),
                              "end": round(w.end, 3)})
        return words, " ".join(t.strip() for t in text).strip()
    except Exception as e:  # noqa: BLE001 — ASR is an analyzer, not a gate
        log(f"audioqa transcribe unavailable: {e}")
        return None, None
