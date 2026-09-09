// THE OTHER TWO TWIN PINS — Wan 3.0 and MiniMax H3 v2.
//
// Same contract `falVideo.test.ts` states: the fixture is emitted by the REAL
// Python builders and carries the shot and the request beside the body, so
// this transcribes nothing. `worker/tests/test_hosted_video.py` runs the
// generator `--check`, so the other suite fails the moment a Python builder
// moves and the fixture does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wanBody, wanMedia, wanRatio, wanResolution, wanSeconds, wanInferMode,
         WAN_MEDIA_CAPS, type WanShot } from "./wanVideo.ts";
import { minimaxBody, minimaxContent, minimaxRatio, minimaxResolution,
         minimaxSeconds, minimaxInferMode, MINIMAX_MAX_FILES,
         type MinimaxShot } from "./minimaxVideo.ts";

interface Case {
  name: string;
  shot: Record<string, unknown>;
  req: Record<string, unknown>;
  body: Record<string, unknown>;
}
const FIX = JSON.parse(readFileSync(
  new URL("./__fixtures__/hosted_video_bodies.json", import.meta.url), "utf8")) as
  { wan: Case[]; minimax: Case[] };

test("the fixture is not empty — an empty one passes every case below", () => {
  assert.ok(FIX.wan.length >= 7 && FIX.minimax.length >= 7,
    `wan ${FIX.wan.length}, minimax ${FIX.minimax.length}`);
});

for (const c of FIX.wan) {
  test(`wan body matches the worker: ${c.name}`, () => {
    assert.deepEqual(wanBody(c.shot as WanShot, {
      prompt: String(c.req.prompt ?? ""),
      mode: String(c.req.mode ?? "t2v"),
      seconds: (c.req.seconds as number) ?? null,
      width: (c.req.width as number) ?? null,
      height: (c.req.height as number) ?? null,
    }), c.body);
  });
}

for (const c of FIX.minimax) {
  test(`minimax body matches the worker: ${c.name}`, () => {
    const { body } = minimaxBody(c.shot as MinimaxShot, {
      prompt: String(c.req.prompt ?? ""),
      mode: String(c.req.mode ?? "t2v"),
      seconds: (c.req.seconds as number) ?? null,
      width: (c.req.width as number) ?? null,
      height: (c.req.height as number) ?? null,
    });
    assert.deepEqual(body, c.body);
  });
}

/* ── the one difference between the two rows, and it is not a field name ── */

test("Wan holds a start frame AND references; MiniMax refuses the combination", () => {
  // This is the practical reason both rows exist. An extend of a cast shot
  // stages identity sheets beside the opening frame — Wan takes them, MiniMax
  // documents the two as mutually exclusive, so they are dropped rather than
  // sent to be refused, and `dropped` is what lets the caller SAY so instead
  // of rendering a quietly weaker shot.
  const shot = { start: "A", images: ["R1", "R2"] };
  const wan = wanBody(shot, { prompt: "p", mode: "i2v" });
  const media = (wan.input as { media?: { type: string }[] }).media ?? [];
  assert.deepEqual(media.map((m) => m.type),
    ["first_frame", "reference_image", "reference_image"]);

  const { content, dropped } = minimaxContent(shot, "p", "i2v");
  assert.deepEqual(content.map((c) => c.role ?? c.type), ["text", "first_frame"]);
  assert.equal(dropped, 2);
});

test("neither puts a chain's CLOSING frame in the reference pool", () => {
  // There it reads as "another picture of this scene" rather than "end exactly
  // here" — a bridge that does not arrive at block B, with nothing to say why.
  const shot = { start: "A", end: "B" };
  const media = wanMedia(shot, "flf");
  assert.deepEqual(media, [
    { type: "first_frame", url: "A" }, { type: "last_frame", url: "B" }]);
  assert.ok(!media.some((m) => m.type === "reference_image"));

  const { content } = minimaxContent(shot, "p", "flf");
  assert.deepEqual(content.map((c) => c.role ?? c.type),
    ["text", "first_frame", "last_frame"]);
});

test("an r2v stages no opening frame at all", () => {
  // Staging one would tell the model to open on a picture the shot never asked
  // to open on.
  const shot = { start: "A", images: ["R"] };
  assert.deepEqual(wanMedia(shot, "r2v").map((m) => m.type), ["reference_image"]);
  assert.deepEqual(minimaxContent(shot, "p", "r2v").content.map((c) => c.role ?? c.type),
    ["text", "reference_image"]);
});

/* ── ceilings, enums and clamps: each is a rejected request when wrong ──── */

test("references are trimmed to each provider's documented ceiling", () => {
  const shot: WanShot = { images: Array(14).fill("R"), videos: Array(8).fill("V"),
                          audio: Array(8).fill("AU") };
  const w = wanMedia(shot, "r2v");
  assert.equal(w.filter((m) => m.type === "reference_image").length,
    WAN_MEDIA_CAPS.reference_image);
  assert.equal(w.filter((m) => m.type === "reference_video").length,
    WAN_MEDIA_CAPS.reference_video);

  // MiniMax has a TOTAL cap as well as per-kind ones, so the later kinds lose
  // out — which is why the budget is spent in order rather than per group.
  const { content } = minimaxContent(shot as MinimaxShot, "p", "r2v");
  assert.equal(content.length - 1, MINIMAX_MAX_FILES, "text does not count against it");
});

test("an aspect nothing declares becomes adaptive rather than the nearest enum", () => {
  // The nearest enum would letterbox or crop the picture; `adaptive` is each
  // provider's own documented value for "take it from what I staged".
  assert.equal(wanRatio(1920, 1080), "16:9");
  assert.equal(wanRatio(1000, 300), "adaptive");
  assert.equal(minimaxRatio(1920, 1080, "t2v"), "16:9");
  assert.equal(minimaxRatio(1000, 300, "t2v"), "adaptive");
  // MiniMax overrides ratio on the image-driven modes anyway — the staged
  // frame decides it — so saying so beats sending a number it will discard.
  assert.equal(minimaxRatio(1920, 1080, "i2v"), "adaptive");
});

test("resolution is a TIER off the short edge, so portrait gets the same one", () => {
  assert.equal(wanResolution(1280, 736), "720P");
  assert.equal(wanResolution(736, 1280), "720P");
  assert.equal(wanResolution(832, 480), "480P");
  assert.equal(wanResolution(1920, 1088), "1080P");
  assert.equal(minimaxResolution(1280, 736), "768P");
  assert.equal(minimaxResolution(1920, 1088), "2K");
});

test("duration is clamped to each provider's own legal range", () => {
  // Out of range is a rejected request, and the two ranges differ.
  assert.equal(wanSeconds(45), 30);
  assert.equal(wanSeconds(1), 2);
  assert.equal(minimaxSeconds(45), 15);
  assert.equal(minimaxSeconds(1), 4);
});

test("an unstated mode is inferred the same way on both planes", () => {
  for (const infer of [wanInferMode, minimaxInferMode]) {
    assert.equal(infer({ start: "A", end: "B" }), "flf");
    assert.equal(infer({ start: "A" }), "i2v");
    assert.equal(infer({ images: ["R"] }), "r2v");
    assert.equal(infer({}), "t2v");
  }
});

test("prompt_extend is OFF — it would rewrite a compiled envelope", () => {
  // Invariant #6: the studio compiles the prompt deterministically, and a
  // server-side rewrite is the one thing that must not happen to it.
  const body = wanBody({}, { prompt: "p" });
  assert.equal((body.parameters as { prompt_extend?: boolean }).prompt_extend, false);
});
