import { test } from "node:test";
import assert from "node:assert/strict";
import { msFromSeconds, needsEndSeek, probeElementFor } from "./mediaProbe.ts";

/* ── msFromSeconds ─────────────────────────────────────────────────────────
 * The two values that are NOT lengths are the whole point: `duration` is NaN
 * before metadata lands and Infinity for a container that cannot size itself
 * (a VBR mp3 with no Xing header — exactly what gets dragged in). Rounding
 * either produces a number that looks measured.                              */

test("a real duration converts to whole milliseconds", () => {
  assert.equal(msFromSeconds(372.48), 372480);
  assert.equal(msFromSeconds(0.5), 500);
});

test("NaN, Infinity and zero are not lengths", () => {
  assert.equal(msFromSeconds(NaN), null);
  assert.equal(msFromSeconds(Infinity), null);
  assert.equal(msFromSeconds(0), null);
  assert.equal(msFromSeconds(-3), null);
  assert.equal(msFromSeconds(undefined), null);
  assert.equal(msFromSeconds("120"), null);
});

test("a duration past a day is a decoder artefact, not a file", () => {
  assert.equal(msFromSeconds(24 * 3600), 86400000);      // exactly a day still counts
  assert.equal(msFromSeconds(24 * 3600 + 1), null);
});

/* ── needsEndSeek ─────────────────────────────────────────────────────────
 * Only Infinity. Seeking on NaN would be a write during the element's own
 * load, which decoders drop silently — the trap `aimVideoAt` documents.      */

test("only Infinity is fixed by seeking to the end", () => {
  assert.equal(needsEndSeek(Infinity), true);
  assert.equal(needsEndSeek(NaN), false);
  assert.equal(needsEndSeek(0), false);
  assert.equal(needsEndSeek(12.5), false);
});

/* ── probeElementFor ───────────────────────────────────────────────────── */

test("content type decides first, then kind, then the key", () => {
  assert.equal(probeElementFor({ content_type: "audio/mpeg" }), "audio");
  assert.equal(probeElementFor({ content_type: "video/mp4" }), "video");
  assert.equal(probeElementFor({ kind: "audio", content_type: null }), "audio");
  assert.equal(probeElementFor({ kind: "render" }), "video");
  assert.equal(probeElementFor({ b2_key: "audio/p/1787513199701_ea31a81f.mp3" }), "audio");
  assert.equal(probeElementFor({ b2_key: "library/clip.mov" }), "video");
});

test("a still has no timeline to read, and a <video> never finishes loading one", () => {
  assert.equal(probeElementFor({ kind: "image", b2_key: "x.png" }), null);
  assert.equal(probeElementFor({ kind: "frame", b2_key: "x.jpg" }), null);
  assert.equal(probeElementFor({ content_type: "image/jpeg" }), null);
  // An asset registered as `video` with a .jpg key: kind is trusted, but the
  // content type is more specific and wins — the same precedence isStill uses.
  assert.equal(probeElementFor({ content_type: "image/jpeg", kind: "video" }), null);
});

test("nothing recognisable is refused rather than guessed at", () => {
  assert.equal(probeElementFor({}), null);
  assert.equal(probeElementFor({ kind: "file", b2_key: "notes.pdf" }), null);
});
