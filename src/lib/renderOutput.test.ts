// The output spec, and the pin that keeps it honest against the worker.
//
// Only the worker encodes, so there is no second implementation of the encode
// to drift. What CAN drift is the TABLE — a format this file offers and
// worker/render_output.py cannot build is a render that dies after every clip
// has been encoded and every post pass has spent its GPU time. So the table is
// parsed out of the Python and compared, the same way postChain.test.ts pins
// POST_ORDER.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUDIO_CODECS, describeOutput, encoderOf, isUpscale, normalizeOutput,
  outputSize, outputWarnings, RENDER_OUTPUT_DEFAULT, RESOLUTIONS, SAMPLE_RATES,
  VIDEO_FORMAT, VIDEO_FORMATS, type RenderOutput,
} from "./renderOutput.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// CRLF: git's autocrlf on Windows makes the working tree CRLF while these
// patterns are written LF, and `.` does not match `\r` — the regexes below
// would match nothing and the test would report an empty table as agreement.
const py = fs.readFileSync(path.join(ROOT, "worker", "render_output.py"), "utf8")
  .replace(/\r\n/g, "\n");

/* ── the two tables must name the same formats ───────────────────────────── */

const pyFormats = () => {
  const block = py.match(/VIDEO_FORMATS = \{([\s\S]*?)\n\}/);
  assert.ok(block, "could not find VIDEO_FORMATS in render_output.py");
  return [...block[1].matchAll(/^    "([a-z0-9_]+)": \{/gm)].map((m) => m[1]);
};

const pyField = (fmt: string, field: string) => {
  const block = py.match(new RegExp(`"${fmt}": \\{([\\s\\S]*?)\\n    \\}`));
  assert.ok(block, `no ${fmt} block in render_output.py`);
  const m = block[1].match(new RegExp(`"${field}": ("([^"]*)"|[^,\\n]+)`));
  return m ? (m[2] ?? m[1].trim()) : null;
};

test("the browser offers exactly the formats the worker can build", () => {
  assert.deepEqual(VIDEO_FORMATS.map((f) => f.id).sort(), pyFormats().sort());
});

test("container, encoder and quality model agree across the twins", () => {
  for (const f of VIDEO_FORMATS) {
    assert.equal(pyField(f.id, "ext"), f.ext, `${f.id} ext`);
    assert.equal(pyField(f.id, "content_type"), f.contentType, `${f.id} content_type`);
    assert.equal(pyField(f.id, "encoder"), f.encoder, `${f.id} encoder`);
    assert.equal(pyField(f.id, "quality"), f.quality, `${f.id} quality kind`);
    // A default the two disagree on is the worst kind: the browser shows one
    // number and the file is encoded at another, and both look plausible.
    assert.equal(Number(pyField(f.id, "q_default")), f.qualityDefault, `${f.id} default`);
    assert.equal(Number(pyField(f.id, "q_min")), f.qualityMin, `${f.id} min`);
    assert.equal(Number(pyField(f.id, "q_max")), f.qualityMax, `${f.id} max`);
    const hw = pyField(f.id, "hw_encoder");
    assert.equal(hw === "None" ? undefined : hw, f.hwEncoder, `${f.id} hw_encoder`);
  }
});

test("audio legality agrees across the twins", () => {
  for (const f of VIDEO_FORMATS) {
    const block = py.match(new RegExp(`"${f.id}": \\{([\\s\\S]*?)\\n    \\}`))![1];
    const list = block.match(/"audio": \[([^\]]*)\]/)![1];
    const ids = [...list.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, f.audio, `${f.id} audio list`);
  }
});

test("the default spec is the same on both sides", () => {
  const block = py.match(/DEFAULT = \{([\s\S]*?)\n\}/)![1];
  const get = (k: string) => block.match(new RegExp(`"${k}": ("([^"]*)"|[^,\\n]+)`))![2]
    ?? block.match(new RegExp(`"${k}": ([^,\\n]+)`))![1].trim();
  assert.equal(get("format"), RENDER_OUTPUT_DEFAULT.format);
  assert.equal(Number(get("quality")), RENDER_OUTPUT_DEFAULT.quality);
  assert.equal(get("audio"), RENDER_OUTPUT_DEFAULT.audio);
  assert.equal(Number(get("audio_bitrate")), RENDER_OUTPUT_DEFAULT.audioBitrate);
  assert.equal(Number(get("sample_rate")), RENDER_OUTPUT_DEFAULT.sampleRate);
  assert.equal(get("hardware"), "False");
  assert.equal(RENDER_OUTPUT_DEFAULT.hardware, false);
});

test("resolutions and sample rates agree", () => {
  const pyList = (name: string) =>
    [...py.match(new RegExp(`${name} = \\[([^\\]]*)\\]`))![1].matchAll(/[\d.]+/g)]
      .map((m) => Number(m[0]));
  assert.deepEqual(pyList("RESOLUTIONS"), RESOLUTIONS.map((r) => r.value));
  assert.deepEqual(pyList("SAMPLE_RATES"), SAMPLE_RATES);
});

/* ── normalization: correct the illegal, clamp the merely wrong ──────────── */

test("an unknown format falls back rather than reaching ffmpeg", () => {
  assert.equal(normalizeOutput({ format: "av1" }).format, "h264");
  assert.equal(normalizeOutput(null).format, "h264");
  assert.equal(normalizeOutput("nonsense").format, "h264");
  assert.equal(normalizeOutput([]).format, "h264");
});

test("quality is clamped into the format's own range, not a shared one", () => {
  // The ranges genuinely differ — h265 crf 22 looks like h264 crf 18 — so a
  // single clamp would let a value through that means something else.
  assert.equal(normalizeOutput({ format: "h264", quality: 99 }).quality, 32);
  assert.equal(normalizeOutput({ format: "h264", quality: 0 }).quality, 14);
  assert.equal(normalizeOutput({ format: "h265", quality: 0 }).quality, 18);
  assert.equal(normalizeOutput({ format: "prores", quality: 99 }).quality, 5);
});

test("switching format carries the quality into the new format's range", () => {
  // crf 18 is legal for h264 and BELOW h265's floor; left alone it would be
  // silently clamped at render time to something the UI never showed.
  const asH265 = normalizeOutput({ format: "h265", quality: 18 });
  assert.equal(asH265.quality, 18);
  assert.equal(normalizeOutput({ format: "h265", quality: 14 }).quality, 18);
});

test("an audio codec the container cannot mux is CORRECTED, not passed on", () => {
  // webm genuinely will not carry AAC: ffmpeg fails the whole render to say
  // so, at the end, after everything has been encoded.
  assert.equal(normalizeOutput({ format: "vp9", audio: "aac" }).audio, "opus");
  assert.equal(normalizeOutput({ format: "h264", audio: "opus" }).audio, "aac");
  assert.equal(normalizeOutput({ format: "h264", audio: "pcm_s24le" }).audio, "aac");
  // ProRes is the one that legitimately takes PCM.
  assert.equal(normalizeOutput({ format: "prores", audio: "pcm_s24le" }).audio, "pcm_s24le");
  // "none" is legal everywhere.
  assert.equal(normalizeOutput({ format: "vp9", audio: "none" }).audio, "none");
});

test("a bitrate is only kept where the codec has one", () => {
  assert.equal(normalizeOutput({ format: "h264", audio: "aac", audioBitrate: 320 }).audioBitrate, 320);
  assert.equal(normalizeOutput({ format: "h264", audio: "aac", audioBitrate: 7 }).audioBitrate, 192);
  assert.equal(normalizeOutput({ format: "prores", audio: "pcm_s24le", audioBitrate: 320 }).audioBitrate, 0);
});

test("hardware is refused on a format with no hardware encoder", () => {
  // Otherwise the switch reads as on and the render uses the software path,
  // which is a control that silently does nothing.
  assert.equal(normalizeOutput({ format: "vp9", hardware: true }).hardware, false);
  assert.equal(normalizeOutput({ format: "prores", hardware: true }).hardware, false);
  assert.equal(normalizeOutput({ format: "h264", hardware: true }).hardware, true);
});

test("encoderOf names what will actually run", () => {
  assert.equal(encoderOf(normalizeOutput({ format: "h264" })), "libx264");
  assert.equal(encoderOf(normalizeOutput({ format: "h264", hardware: true })), "h264_nvenc");
  assert.equal(encoderOf(normalizeOutput({ format: "vp9", hardware: true })), "libvpx-vp9");
});

test("an out-of-list resolution or fps falls back instead of resizing to nonsense", () => {
  assert.equal(normalizeOutput({ format: "h264", resolution: 999 }).resolution, null);
  assert.equal(normalizeOutput({ format: "h264", resolution: 1080 }).resolution, 1080);
  // The multiplier this replaced is not silently reinterpreted as a height.
  assert.equal(normalizeOutput({ format: "h264", scale: 2 } as unknown).resolution, null);
  assert.equal(normalizeOutput({ format: "h264", fps: 0 }).fps, null);
  assert.equal(normalizeOutput({ format: "h264", fps: -5 }).fps, null);
  assert.equal(normalizeOutput({ format: "h264", fps: 500 }).fps, 120);
  assert.equal(normalizeOutput({ format: "h264", fps: 30 }).fps, 30);
});

/* ── geometry ─────────────────────────────────────────────────────────────── */

test("the output frame is always even", () => {
  // yuv420p cannot represent an odd dimension and ffmpeg FAILS the encode
  // rather than rounding — on the last step of a long render.
  for (const r of [null, 540, 720, 1080, 1440, 2160]) {
    const { w, h } = outputSize(normalizeOutput({ resolution: r }), 1281, 705);
    assert.equal(w % 2, 0, `w for ${r}`);
    assert.equal(h % 2, 0, `h for ${r}`);
  }
  assert.deepEqual(outputSize(normalizeOutput({}), 1280, 704), { w: 1280, h: 704 });
});

test("a resolution is the SHORT EDGE, so one label works both ways up", () => {
  // Landscape: 1080p means 1080 tall.
  assert.deepEqual(outputSize(normalizeOutput({ resolution: 1080 }), 1920, 1080),
                   { w: 1920, h: 1080 });
  // Vertical: the same label means 1080 WIDE. Scaling by height instead would
  // deliver a 1920-wide portrait frame — four times the pixels nobody asked for.
  assert.deepEqual(outputSize(normalizeOutput({ resolution: 1080 }), 1080, 1920),
                   { w: 1080, h: 1920 });
});

test("the timeline's aspect is preserved, never re-framed to the label", () => {
  // A block renders 1280x704, which is NOT 16:9. 1080p delivers 1962x1080 —
  // the same shot, larger. Forcing 1920x1080 would letterbox or crop it, which
  // is a different picture than the one that was cut.
  const { w, h } = outputSize(normalizeOutput({ resolution: 1080 }), 1280, 704);
  assert.equal(h, 1080);
  assert.equal(w, 1964);
  assert.ok(Math.abs(w / h - 1280 / 704) < 0.002);
});

test("upscaling is recognised from the short edge, not from the pixel count", () => {
  assert.equal(isUpscale(normalizeOutput({ resolution: 1080 }), 1280, 704), true);
  assert.equal(isUpscale(normalizeOutput({ resolution: 540 }), 1280, 704), false);
  assert.equal(isUpscale(normalizeOutput({ resolution: null }), 1280, 704), false);
  // A vertical cut is judged on its width, which is its short edge.
  assert.equal(isUpscale(normalizeOutput({ resolution: 1080 }), 720, 1280), true);
});

/* ── what the user is told ────────────────────────────────────────────────── */

test("the summary names the container, because that is what changes on disk", () => {
  assert.match(describeOutput(normalizeOutput({ format: "h264" })), /\.mp4$/);
  assert.match(describeOutput(normalizeOutput({ format: "prores" })), /\.mov$/);
  assert.match(describeOutput(normalizeOutput({ format: "vp9" })), /\.webm$/);
});

test("ProRes quality reads as its profile name, never as a CRF", () => {
  // 3 means 422 HQ. Shown as "CRF 3" it would read as near-lossless h264,
  // which is a different thing at a hundredth of the size.
  const s = describeOutput(normalizeOutput({ format: "prores", quality: 3 }));
  assert.match(s, /422 HQ/);
  assert.doesNotMatch(s, /CRF/);
});

test("upscaling and ProRes size are warned about before the GPU time is spent", () => {
  const up = outputWarnings(normalizeOutput({ resolution: 2160 }), 1280, 704);
  assert.ok(up.some((w) => /adds no detail/.test(w)));
  const pr = outputWarnings(normalizeOutput({ format: "prores" }), 1920, 1080);
  assert.ok(pr.some((w) => /per minute/.test(w)));
  assert.deepEqual(outputWarnings(normalizeOutput({}), 1280, 704), []);
});

/* ── the round trip a stored setting takes ───────────────────────────────── */

test("normalize is idempotent, so a saved spec never drifts on reload", () => {
  for (const f of VIDEO_FORMATS) {
    for (const a of f.audio) {
      const once = normalizeOutput({ format: f.id, audio: a, quality: f.qualityDefault });
      assert.deepEqual(normalizeOutput(once as unknown), once, `${f.id}/${a}`);
    }
  }
});

test("every format's default audio is one it can actually mux", () => {
  for (const f of VIDEO_FORMATS) {
    const o: RenderOutput = normalizeOutput({ format: f.id });
    assert.ok(f.audio.includes(o.audio), `${f.id} defaulted to ${o.audio}`);
    assert.ok(AUDIO_CODECS.some((a) => a.id === o.audio));
    assert.ok(VIDEO_FORMAT[f.id]);
  }
});
