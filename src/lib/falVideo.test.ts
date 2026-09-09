// THE TWIN PIN. `src/lib/falVideo.ts` and `worker/providers/fal_video.py` build
// the same fal request from the same catalog dialect — one when the studio's
// pod runs the job, one when this machine does on the user's own key — and a
// disagreement between them is invisible: the same model, the same prompt, a
// different clip, with nothing saying which half was wrong.
//
// The fixture is emitted by the REAL Python (`gen_hosted_video_golden.py`)
// and carries the spec, the shot and the request beside the body, so this test
// transcribes nothing. `worker/tests/test_fal_video.py` fails the other suite
// the moment the Python moves and the fixture does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { falVideoBody, falEndpoint, falDuration, falResolution, falAspect,
         type FalVideoSpec, type FalShot } from "./falVideo.ts";

interface Case {
  name: string; endpoint: string; served_mode: string;
  spec: FalVideoSpec; shot: FalShot;
  req: Record<string, unknown>;
  body: Record<string, unknown>;
}
const CASES: Case[] = JSON.parse(
  readFileSync(new URL("./__fixtures__/hosted_video_bodies.json", import.meta.url), "utf8")).fal;

test("the fixture is not empty — an empty one passes every case below", () => {
  assert.ok(CASES.length >= 8, `only ${CASES.length} golden cases`);
});

for (const c of CASES) {
  test(`fal body matches the worker: ${c.name}`, () => {
    const routed = falEndpoint(c.spec, String(c.req.mode));
    assert.ok(routed, `no endpoint for ${c.req.mode}`);
    assert.equal(routed.endpoint, c.endpoint);
    assert.equal(routed.mode, c.served_mode);
    const body = falVideoBody(routed.spec, c.shot, {
      prompt: String(c.req.prompt ?? ""),
      mode: routed.mode,
      seconds: (c.req.seconds as number) ?? null,
      width: (c.req.width as number) ?? null,
      height: (c.req.height as number) ?? null,
      seed: (c.req.seed as number) ?? null,
      negative: (c.req.negative as string) ?? null,
      audio: (c.req.audio as boolean) ?? null,
    });
    assert.deepEqual(body, c.body);
  });
}

// ── the decisions the fixture cannot show, because they are refusals ───────

test("a mode with no endpoint degrades DOWNWARD and says so", () => {
  // A chain on a model with no `flf` endpoint is an extend: a worse answer and
  // not a wrong one. Doing it silently is how a picker offers a mode the
  // render never performs, which is why `degraded` exists at all.
  const spec: FalVideoSpec = { endpoints: { t2v: "a/t", i2v: "a/i" } };
  const r = falEndpoint(spec, "flf");
  assert.equal(r?.mode, "i2v");
  assert.equal(r?.degraded, true);
});

test("a row with no endpoints at all is null, not a guess", () => {
  assert.equal(falEndpoint({}, "t2v"), null);
});

test("an endpoint may withdraw a field the model declares", () => {
  // Seedance's image-to-video takes `image_url` and `end_image_url` and NO
  // reference list — a model-level `image_urls` written there is dropped by
  // fal and the extend loses the sheets staged for it.
  const spec: FalVideoSpec = {
    endpoints: { i2v: { id: "x/i2v", images: null }, r2v: "x/r2v" },
    start: "image_url", images: "image_urls",
  };
  const i = falEndpoint(spec, "i2v")!;
  const body = falVideoBody(i.spec, { start: "A", images: ["R"] },
                            { prompt: "p", mode: "i2v" });
  assert.deepEqual(body, { prompt: "p", image_url: "A" });
  const r = falEndpoint(spec, "r2v")!;
  assert.deepEqual(
    falVideoBody(r.spec, { images: ["R"] }, { prompt: "p", mode: "r2v" }),
    { prompt: "p", image_urls: ["R"] });
});

test("duration is a STRING enum where the endpoint says so, and snaps", () => {
  // A number is a 422 at submit on the current video endpoints; an unlisted
  // whole second is one too.
  const spec: FalVideoSpec = { duration: "string", durations: ["auto", "4", "8", "12"] };
  assert.equal(falDuration(spec, 8), "8");
  assert.equal(falDuration(spec, 7), "8");
  assert.equal(falDuration(spec, 1), "4");
  assert.equal(falDuration({ duration: "int" }, 7.6), 8);
  assert.equal(falDuration({}, 8), null, "a model with no duration field sends none");
});

test("resolution is clamped to what the ENDPOINT serves", () => {
  // Seedance tops out at 720p and FLUX 3 starts at 720p, so one shared
  // "1080p" would be a rejected request on one of them.
  assert.equal(falResolution({ resolutions: ["480p", "720p"] }, 1920, 1088), "720p");
  assert.equal(falResolution({ resolutions: ["720p", "1080p"] }, 640, 480), "720p");
  assert.equal(falResolution({}, 1920, 1088), null);
});

test("aspect is the SHORT-edge-independent ratio, or auto when nothing matches", () => {
  assert.equal(falAspect(1920, 1080), "16:9");
  assert.equal(falAspect(1080, 1920), "9:16");
  // 1280x736 is 1.74 — near enough 16:9 to name it.
  assert.equal(falAspect(1280, 736), "16:9");
  // A genuinely odd shape is better served by `auto` than by the nearest enum,
  // which would letterbox or crop the picture.
  assert.equal(falAspect(1000, 300), "auto");
  assert.equal(falAspect(null, null), "auto");
});

test("the reference cap counts the start frame against it", () => {
  const spec: FalVideoSpec = { start: "image_url", images: "image_urls", maxRefs: 3 };
  const shot: FalShot = { start: "A", images: ["1", "2", "3", "4", "5"] };
  const body = falVideoBody(spec, shot, { prompt: "p", mode: "i2v" });
  assert.deepEqual(body.image_urls, ["1", "2"], "start took one of the three");
});
