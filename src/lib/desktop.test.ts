// What a machine is offered, and the two budgets that decide it.
//
// This is the one piece of the setup wizard that makes a PROMISE, so it is the
// one piece worth pinning. Getting it wrong is not cosmetic: it tells someone
// their laptop will render a 35GB checkpoint, they wait through the download,
// and the first job dies.
//
// IT USED TO PIN A SECOND LIST. `MODEL_PRESETS` + `recommendPreset` were a
// hand-written machine-to-plan mapping sitting beside `engineCatalog`, which
// answers the same question from measured data — and by the time the H3 tier
// benchmark landed, the hand-written numbers were wrong (it offered "H3 int8,
// 21GB download, 20GB VRAM" for a set measured at 35GB and an 8GB floor).
// Nothing in the UI called it. The presets are gone; the machines below are the
// part worth keeping, and they now interrogate `bestFor` — the answer the
// wizard actually shows.
//
// The profiles are real machines, including this one (`cargo test --lib
// detect_always -- --nocapture` prints it): a 16GB M3 Air, a 4090, a 12GB
// 4070 Ti, and a box with no GPU at all.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  isLocalMediaUrl, machineBudgetGb, machineRamGb, needsWebviewFetch,
  setLocalMediaOrigin, usableVramMb,
  type HardwareProfile,
} from "./desktop.ts";
import { FAMILIES, bestFor, fits } from "./engineCatalog.ts";

const base = {
  os: "Darwin 26.5.1", arch: "aarch64", cpu: "Apple M3", cores: 8,
  free_disk_mb: 121_429, comfy_paths: [],
};

const M3_AIR: HardwareProfile = {
  ...base, ram_mb: 16_384,
  gpus: [{ name: "Apple M3", vendor: "apple", vram_mb: 16_384, unified: true }],
};
const RTX_4090: HardwareProfile = {
  ...base, cpu: "AMD Ryzen 9", ram_mb: 65_536,
  gpus: [{ name: "NVIDIA GeForce RTX 4090", vendor: "nvidia", vram_mb: 24_564, unified: false }],
};
const RTX_4070TI: HardwareProfile = {
  ...base, cpu: "Intel i7", ram_mb: 32_768,
  gpus: [{ name: "NVIDIA GeForce RTX 4070 Ti", vendor: "nvidia", vram_mb: 12_282, unified: false }],
};
const HEADLESS: HardwareProfile = { ...base, ram_mb: 8_192, gpus: [] };

/** What the wizard computes before it asks anything. */
const budgets = (p: HardwareProfile | null) =>
  [machineBudgetGb(p), machineRamGb(p)] as const;

const videoFor = (p: HardwareProfile | null) => {
  const [v, r] = budgets(p);
  return bestFor("video", v, null, r);
};

test("a 24GB card with 64GB of RAM gets the PREFERRED H3 rung, not the biggest", () => {
  // The pod's own unpruned set has the highest VRAM floor of any rung and is
  // beaten by the pruned one at every tier — 24GB less download, 11GB less RAM,
  // no measured quality difference. Plain biggest-that-fits would hand a 4090
  // the worse deal, which is exactly what `ModelVariant.preferred` exists for.
  const pick = videoFor(RTX_4090);
  assert.equal(pick?.family.id, "minimax-h3");
  assert.equal(pick?.variant.id, "h3-int8");
  assert.ok(pick && fits(pick.variant, ...budgets(RTX_4090)));
});

test("a 12GB card with 32GB of RAM is refused the int8 rung ON RAM", () => {
  // It clears the VRAM floor (8GB) comfortably and wants 48GB of system memory,
  // which this machine does not have. The measurement that makes this real: a
  // 14G cgroup oom-killed a GGUF H3 run in 110 seconds.
  const [v, r] = budgets(RTX_4070TI);
  const h3 = FAMILIES.find((f) => f.id === "minimax-h3")!;
  const int8 = h3.variants.find((x) => x.id === "h3-int8")!;
  assert.ok(fits(int8, v), "the card is big enough");
  assert.ok(!fits(int8, v, r), "the memory is not");

  const pick = videoFor(RTX_4070TI);
  assert.equal(pick?.family.id, "minimax-h3", "a leaner H3 rung should still be offered");
  assert.notEqual(pick?.variant.id, "h3-int8");
  assert.ok((pick!.variant.ram_gb ?? 0) <= r);
});

test("unified memory is discounted, because it is not all available to a render", () => {
  // 16GB shared with the OS is not 16GB of VRAM. Treating it as such is how an
  // M3 Air gets promised a 35GB checkpoint.
  const [v] = budgets(M3_AIR);
  assert.ok(v < 10, `a 16GB unified machine reported a ${v}GB budget`);
  assert.ok(v < machineBudgetGb({ ...M3_AIR, gpus: [{ ...M3_AIR.gpus[0], unified: false }] }),
    "the discount is what does it");
});

test("a 16GB machine is offered no H3 at all — and that is the RAM, not the card", () => {
  // Both gates refuse it here, and the RAM one refuses even the 6GB rung. This
  // is the machine the benchmark's cgroup test was standing in for.
  const [v, r] = budgets(M3_AIR);
  const h3 = FAMILIES.find((f) => f.id === "minimax-h3")!;
  assert.ok(!h3.variants.some((x) => fits(x, v, r)), "no H3 rung may be offered here");
  assert.ok(h3.variants.every((x) => (x.ram_gb ?? 0) > r),
    "every H3 rung wants more RAM than this machine has");
});

test("an UNMEASURED ram_gb never refuses anything", () => {
  // "Nobody measured it" is not "it needs nothing", but it is certainly not a
  // reason to refuse — a family with no RAM figure must behave exactly as it
  // did before the axis existed.
  const noRam = FAMILIES.flatMap((f) => f.variants).filter((x) => x.ram_gb == null);
  assert.ok(noRam.length, "some rows are still unmeasured; that is the case under test");
  for (const x of noRam) assert.equal(fits(x, x.vram_gb, 0.001), true, x.id);
});

test("no GPU means nothing local, and a null profile never claims capability", () => {
  assert.equal(videoFor(HEADLESS), null);
  assert.equal(bestFor("image", machineBudgetGb(HEADLESS)), null);
  assert.equal(videoFor(null), null);
});

test("nothing offered ever exceeds the budgets it was derived from", () => {
  // The invariant that actually matters, now on both axes.
  for (const [name, hw] of Object.entries({ M3_AIR, RTX_4090, RTX_4070TI, HEADLESS })) {
    const [v, r] = budgets(hw);
    for (const media of ["image", "video", "audio"] as const) {
      const pick = bestFor(media, v, null, r);
      if (!pick) continue;
      assert.ok(pick.variant.vram_gb <= v,
        `${name}/${media}: offered ${pick.variant.label} (${pick.variant.vram_gb}GB) on a ${v.toFixed(1)}GB card`);
      assert.ok((pick.variant.ram_gb ?? 0) <= r,
        `${name}/${media}: offered ${pick.variant.label} needing ${pick.variant.ram_gb}GB RAM against ${r.toFixed(0)}GB`);
    }
  }
});

test("machineRamGb leaves headroom, and treats unknown as unbounded", () => {
  assert.equal(machineRamGb(RTX_4090), 64 - 4);
  assert.equal(machineRamGb(M3_AIR), 16 - 4);
  // A machine that reported no memory must not be refused everything — the
  // probe failing is not the same as the machine being small.
  assert.equal(machineRamGb(null), Infinity);
  assert.equal(machineRamGb({ ...M3_AIR, ram_mb: 0 }), Infinity);
});

test("usableVramMb takes the biggest card, since nothing splits a checkpoint", () => {
  const twoCards: HardwareProfile = {
    ...base, ram_mb: 65_536,
    gpus: [
      { name: "RTX 3060", vendor: "nvidia", vram_mb: 12_288, unified: false },
      { name: "RTX 4090", vendor: "nvidia", vram_mb: 24_564, unified: false },
    ],
  };
  assert.equal(usableVramMb(twoCards), 24_564);
  assert.equal(usableVramMb(HEADLESS), 0);
  assert.equal(usableVramMb(null), 0);
});

/* ── the mock bridge's shape ─────────────────────────────────────────────── */

test("the mock's engine status carries every field the real one does", () => {
  // A HARNESS THAT READS A SHAPE PRODUCTION NEVER SEES proves nothing. Every
  // `/ui/*` screen is driven by this mock, so a field Rust added and the mock
  // did not is a state those screens can never reach — and the one that
  // matters most is the newest, since it is the one under review.
  //
  // One direction only: the mock may legitimately carry harness-only extras.
  const rs = fs.readFileSync(
    path.join(process.cwd(), "src-tauri/src/engine.rs"), "utf8").replace(/\r\n/g, "\n");
  const body = rs.split("pub struct EngineStatus {")[1].split("\n}")[0];
  const fields = [...body.matchAll(/^ {4}pub ([a-z_]+):/gm)].map((m) => m[1]);
  assert.ok(fields.length > 12, `the EngineStatus scanner found ${fields.length}`);

  const mock = fs.readFileSync(
    path.join(process.cwd(), "src/lib/desktop.mock.ts"), "utf8");
  const missing = fields.filter((f) => !new RegExp(`\\b${f}:`).test(mock));
  assert.deepEqual(missing, [], `the mock never answers: ${missing.join(", ")}`);

  // ...and the TS type too, or a screen cannot read what the mock returns.
  const ts = fs.readFileSync(
    path.join(process.cwd(), "src/lib/desktop.ts"), "utf8");
  const typed = ts.split("export interface EngineStatus {")[1].split("\n}")[0];
  const untyped = fields.filter((f) => !new RegExp(`\\b${f}\\??:`).test(typed));
  assert.deepEqual(untyped, [], `desktop.ts does not declare: ${untyped.join(", ")}`);
});

/* ── which transport can actually read a URL ────────────────────────────── */

test("a local project's media goes through the WEBVIEW — Rust speaks http/https only", () => {
  // macOS and Linux: what convertFileSrc builds.
  assert.equal(needsWebviewFetch("asset://localhost/%2FUsers%2Fme%2Fmedia%2Fx.mp4"), true);
  // Windows: Tauri's asset protocol, which IS http and still not Rust's to fetch.
  assert.equal(needsWebviewFetch("http://asset.localhost/C%3A%2Fmedia%2Fx.mp4"), true);
  assert.equal(needsWebviewFetch("https://asset.localhost/x.png"), true);
  // Same-origin by construction.
  assert.equal(needsWebviewFetch("blob:tauri://localhost/8f2c-11ee"), true);
  assert.equal(needsWebviewFetch("data:image/png;base64,iVBORw0KGgo="), true);
  assert.equal(needsWebviewFetch("file:///Users/me/x.png"), true);
});

test("the engine, the CDN and every remote host still go through RUST", () => {
  // ComfyUI sends no Access-Control-Allow-Origin — Rust is the only way in.
  assert.equal(needsWebviewFetch("http://127.0.0.1:8188/upload/image"), false);
  assert.equal(needsWebviewFetch("http://localhost:8188/view?filename=x.png"), false);
  // B2 will not approve `tauri://localhost` as an origin at all.
  assert.equal(needsWebviewFetch("https://media.example.com/library/x.mp4"), false);
  assert.equal(needsWebviewFetch("https://civitai.com/api/v1/models"), false);
});

test("our own loopback media server goes through the WEBVIEW too", () => {
  // It LOOKS like an ordinary remote http URL and is neither remote nor
  // Rust's to fetch: loopback is not on the capability allow-list, and
  // widening it to all of 127.0.0.1 would hand page content the user's own
  // ComfyUI. The server sends `Access-Control-Allow-Origin: *`, so the
  // webview reads it directly.
  const origin = "http://127.0.0.1:53411/9f2c-token";
  try {
    setLocalMediaOrigin(origin);
    assert.equal(needsWebviewFetch(`${origin}/proj-1/blocks/EP03/take.mp4`), true);
    assert.equal(isLocalMediaUrl(`${origin}/proj-1/x.png`), true);
    // A DIFFERENT loopback port is somebody else's server — the engine's, most
    // likely — and still Rust's to fetch.
    assert.equal(needsWebviewFetch("http://127.0.0.1:8188/upload/image"), false);
    assert.equal(isLocalMediaUrl("http://127.0.0.1:8188/upload/image"), false);
    // Right port, wrong token: not ours, and it would 404 anyway.
    assert.equal(isLocalMediaUrl("http://127.0.0.1:53411/other/proj-1/x.png"), false);
  } finally {
    setLocalMediaOrigin(null);
  }
});

test("with no media server, nothing is mistaken for one", () => {
  // The web build, and every moment before `bootLocalPlane` has asked.
  setLocalMediaOrigin(null);
  assert.equal(isLocalMediaUrl("http://127.0.0.1:53411/t/p/x.png"), false);
  assert.equal(needsWebviewFetch("http://127.0.0.1:53411/t/p/x.png"), false);
});

test("a host that merely STARTS like the asset protocol is not it", () => {
  // Matched on the hostname, not the prefix: this is somebody's real server.
  assert.equal(needsWebviewFetch("https://asset.localhost.example.com/x.png"), false);
  assert.equal(needsWebviewFetch("https://notasset.localhost/x.png"), false);
});

test("an unparseable or relative URL is the webview's problem, not a crash", () => {
  assert.equal(needsWebviewFetch("/api/upload"), false);
  assert.equal(needsWebviewFetch(""), false);
  assert.equal(needsWebviewFetch("::::"), false);
});
