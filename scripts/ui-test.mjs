#!/usr/bin/env node
// Drives the DESKTOP screens in a real browser, through the dev-only Tauri
// mock (src/lib/desktop.mock.ts).
//
// WHY NOT tauri-driver. Tauri's own WebDriver server does not support macOS —
// its README lists macOS as "[Todo] … (probably)" — because nothing can attach
// a WebDriver to another app's WKWebView. Screenshot-and-click needs assistive
// access and steals the pointer from whoever is at the keyboard. The desktop
// app is the same React tree behind one global, so faking that global is the
// only automation route that actually runs on this machine.
//
// WHAT IT PROVES, AND WHAT IT CANNOT. It proves the screens: that a 24GB card
// is offered the big preset and a 16GB laptop is not, that install progress
// ticks through four steps, that a download bar fills, that the engine chip
// changes state. It cannot prove the bridge — IPC, the CORS-free fetch, the
// capability allow-list — because that is the part being faked. The bridge is
// verified separately by running the real window.
//
//   node scripts/ui-test.mjs                 # against http://localhost:5177
//   BASE=http://localhost:5173 node scripts/ui-test.mjs
//   node scripts/ui-test.mjs --headed        # watch it
//
// Screenshots land in .ui-shots/ so a failure can be looked at rather than
// guessed at.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:5177";
const SHOTS = path.join(process.cwd(), ".ui-shots");
const HEADED = process.argv.includes("--headed");

fs.mkdirSync(SHOTS, { recursive: true });

let passed = 0;
let skipped = 0;
const failures = [];

const check = (label, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failures.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ""}`); }
};

/** A check that could not be run, and WHY — never a silent pass.
 *
 *  The Civitai section talks to a live third party; it answered 503 during one
 *  run of this suite. Reporting nine failures because someone else's service
 *  is down trains people to ignore the suite, and quietly passing them is
 *  worse. Anything that depends on the network says so out loud instead. */
const skip = (label, why) => { skipped++; console.log(`  – ${label} — SKIPPED: ${why}`); };

/** Open one desktop screen in the harness, with the bridge mocked.
 *
 *  `/ui/:screen` is deliberately outside AuthGate — see src/routes/
 *  DesktopPreview.tsx. A test that had to sign in would need a real session,
 *  which is a credential a test should not hold. */
/** Click one of the local-engine window's tabs and wait for it to take.
 *
 *  `[role="tab"]` rather than the label alone: "Models" also appears in body
 *  copy, and a locator that matched a paragraph would click nothing and time
 *  out somewhere unrelated. */
async function openTab(page, label) {
  await page.locator(`[role="tab"]`, { hasText: label }).first().click();
  await page.waitForTimeout(120);
}

async function open(page, screen, query) {
  await page.goto(`${BASE}/ui/${screen}?${query}`, { waitUntil: "domcontentloaded" });
  // The banner is the signal that the fake bridge installed at all; without
  // this check every assertion below would fail for one reason and report as
  // many.
  await page.waitForFunction(() => !!window.__TAURI__, null, { timeout: 15000 });
  // Not every desktop screen is a modal — the queue popover is a popover, the
  // repair panel is a plain card. Any
  // of them being visible means the screen mounted, which is all this wait is
  // for; a card inside a modal cannot resolve it early, because the modal is
  // visible by then anyway.
  await page.waitForSelector(".ws-modal, .ws-queuepop, .ws-card",
    { timeout: 20000 });
  await page.waitForTimeout(700);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

/** Open a modal by calling the store directly. Clicking the chrome is a
 *  separate test; every other test wants to be AT the screen, not navigating
 *  to it, so that one broken button does not fail nine assertions. */
async function openModal(page, modal) {
  await page.evaluate((m) => {
    const w = window;
    // the store is not exported to window, so go through the button when we can
    const ev = new CustomEvent("qamba:test-open-modal", { detail: m });
    window.dispatchEvent(ev);
    w.__qambaTestModal = m;
  }, modal);
}

async function run() {
  // `playwright-core` ships no browser of its own, so it borrows an installed
  // one. `channel: "chrome"` finds it on a Mac and finds NOTHING on a Windows
  // box with no Chrome — where the Chromium that is always present is the one
  // under WebView2/EdgeCore, at a versioned path nothing can guess. `CHROME=`
  // is how you point at it:
  //   CHROME="C:\Program Files (x86)\Microsoft\EdgeCore\151.0.4129.78\msedge.exe"
  const browser = await chromium.launch(
    process.env.CHROME
      ? { executablePath: process.env.CHROME, headless: !HEADED }
      : { channel: "chrome", headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 } });
  const page = await ctx.newPage();
  // A thrown exception and a third-party image that 404s are not the same
  // finding, and lumping them together made the suite fail on Civitai's own
  // media. Exceptions are ours; failed requests are only ours when they are
  // same-origin.
  const thrown = [];
  const badRequests = [];
  page.on("pageerror", (e) => thrown.push(String(e)));
  page.on("response", (r) => {
    if (r.status() < 400) return;
    if (new URL(r.url()).origin === new URL(BASE).origin) {
      badRequests.push(`${r.status()} ${r.url()}`);
    }
  });

  try {
    // ── 1. the bridge fake installs and labels itself
    console.log("\n▸ mock bridge");
    await open(page, "engine", "desktop=m3air&engine=absent");
    check("the fake bridge installs", await page.evaluate(() => !!window.__TAURI__));
    check("it labels itself on screen", (await page.locator("text=MOCK DESKTOP").count()) > 0);
    const modal = page.locator(".ws-modal");
    await shot(page, "01-engine-fresh");

    // ── 2. the engine screen on a machine with nothing installed
    console.log("\n▸ engine screen · nothing installed");
    let t = await modal.innerText();
    check("it is the engine screen", /Local engine/.test(t));
    check("it offers to install", await modal.locator("button", { hasText: "Install" }).count() > 0);
    check("it names the install steps", /Python runtime/.test(t) && /Dependencies/.test(t));
    check("it reads the machine it is on", /Apple M3/.test(t), t.slice(0, 100));
    check("it discounts unified memory rather than quoting the sticker", /usable/.test(t));
    check("it does not offer Start with no engine",
      await modal.locator("button", { hasText: "Start engine" }).count() === 0);

    // ── 3. install progress: four steps, two of them unmeasurable
    console.log("\n▸ install progress");
    await modal.locator("button", { hasText: "Install" }).first().click();
    await page.waitForTimeout(1200);
    check("a step reports itself while installing",
      /Downloading|Unpacking|Installing/.test(await modal.innerText()));
    await shot(page, "02-engine-installing");
    await page.waitForFunction(
      () => /Engine installed/.test(document.querySelector(".ws-modal")?.textContent ?? ""),
      null, { timeout: 40000 });
    check("it finishes and says so", true);
    await shot(page, "03-engine-installed");

    // ── 4. models and add-ons
    //
    // THE MODELS ARE A TAB NOW. The window was one scroll until the API-keys
    // section landed, and everything below is written against the model rows —
    // so the suite has to open the tab the way a person does. Asserting on the
    // engine tab instead is how a passing suite would go on describing a screen
    // nobody sees.
    console.log("\n▸ models and add-ons");
    await openTab(page, "Models");
    t = await modal.innerText();
    check("a family is offered", /Stable Diffusion 1.5/.test(t));
    check("with its real size", /4\.0 GB|3\.97 GB/.test(t), "no size");
    check("a family shows its VARIANT ladder, not one row",
      /Q4_K_M/.test(t) && /Q8_0/.test(t) && /fp16/.test(t), "no quant variants listed");
    check("quantised variants are labelled GGUF", /GGUF/.test(t));
    check("a quant is genuinely smaller than its fp16",
      /3\.2 GB|3\.1 GB/.test(t), "Wan 5B Q4_K_M size missing");
    check("shared files are charged once, at the family",
      /fetched once and reused/.test(t));
    check("a family nothing here can run says what it needs",
      /not this machine/.test(t));
    check("image and video are separate sections",
      /Image models/.test(t) && /Video models/.test(t));
    check("models this machine CANNOT run are still listed",
      /MiniMax H3/.test(t) && /I2V 14B/.test(t), "big models hidden");
    check("and each says why it will not run",
      /out of reach/i.test(t), "no explanation on an oversized model");
    check("each section counts what actually runs here",
      /run on this machine/.test(t));
    check("add-ons belong to the model they adapt",
      /ADD-ONS FOR STABLE DIFFUSION 1\.5/.test(t), "no per-family add-on group");
    check("the LCM speed adapter is offered under SD 1.5", /LCM/.test(t));
    check("turbo is an add-on, not a separate model",
      /Turbo v4|LightX2V/.test(t) && !/^MiniMax H3 Turbo$/m.test(t));
    check("H3 says it renders stills too",
      /Also:.*stills|T1 stills decoder/s.test(t), "H3's image capability is hidden");
    check("post-process is its own section", /Post-process/.test(t));
    check("the video upscaler is listed with its node caveat",
      /SeedVR2/.test(t) && /node pack/.test(t));
    check("a marginal model warns instead of silently failing later",
      /may swap/i.test(t), "no fit warning on a 16GB machine");
    check("Start is refused until there is something to render with",
      await modal.locator("button[disabled]", { hasText: "Start engine" }).count() > 0
      || !/Start engine/.test(t));

    await modal.locator("button:not([disabled])", { hasText: /^\s*Get\s*$/ }).first().click();
    // Wait for the note rather than a fixed 700ms: the mock's tick is derived
    // from `stepms` and a slow machine slid the whole download past the sleep,
    // which reported as "the note never appeared".
    await page.waitForFunction(
      () => /file \d+ of \d+|starting|resuming ·|installed/
        .test(document.querySelector(".ws-modal")?.textContent ?? ""),
      null, { timeout: 15000 }).catch(() => {});
    // the variant row shows "file 1 of 2 · <name>" rather than a bare percentage:
    // a multi-file model needs to say WHICH file, or a long pause looks stuck
    check("a download reports which file it is on",
      /file \d+ of \d+|starting|installed/.test(await modal.innerText()));
    await shot(page, "04-model-downloading");

    // REOPENING MID-DOWNLOAD MUST NOT OFFER THE DOWNLOAD AGAIN. The Rust task
    // outlives the modal — measured on the real app, a `.part` was still
    // growing 7MB/4s after the screen was closed — so a remount that trusts
    // its own empty state shows a Get button for a file already gigabytes in,
    // and pressing it opens a SECOND writer on the same `.part`.
    //
    // `qamba:test-remount` rather than a navigation: `page.goto` reloads, which
    // resets the mocked bridge's own download registry too and would test the
    // opposite of the thing that breaks. A slow mock (`stepms`) keeps the
    // download unambiguously in flight across the remount.
    await open(page, "engine", "desktop=m3air&engine=installed&stepms=9000");
    await openTab(page, "Models");
    await modal.locator("button:not([disabled])", { hasText: /^\s*Get\s*$/ }).first().click();
    await page.waitForTimeout(600);
    const midText = await modal.innerText();
    check("the download is genuinely in flight before the remount",
      /file \d+ of \d+|starting…/.test(midText), midText.slice(0, 120));
    const midActive = await page.evaluate(() =>
      window.__TAURI__.core.invoke("active_downloads"));
    check("…and the bridge agrees it is in flight", midActive.length === 1,
      JSON.stringify(midActive));

    await page.evaluate(() => window.dispatchEvent(new CustomEvent("qamba:test-remount")));
    await page.waitForTimeout(900);
    const back = await page.locator(".ws-modal").innerText();
    // Assert the STATE, not the copy: a progress bar only renders on a row
    // whose state is "downloading". Matching the note text instead is how this
    // check first failed against working code — an adopted row words itself
    // differently from one this mount started.
    const bars = await page.locator(".ws-modal .ns-dlbar").count();
    check("reopening mid-download adopts it instead of offering Get again",
      bars > 0 && /resuming ·/.test(back), `${bars} bars · ${back.slice(0, 160)}`);
    // The registry still holds exactly one entry: the remount must not have
    // started a second download of the same file.
    const afterActive = await page.evaluate(() =>
      window.__TAURI__.core.invoke("active_downloads"));
    check("and no duplicate download was started", afterActive.length === 1,
      JSON.stringify(afterActive));
    // Belt and braces: the Rust side refuses a duplicate even if a UI ever
    // does offer the button again.
    const dup = await page.evaluate(async (id) => {
      try {
        await window.__TAURI__.core.invoke("download_model_file",
          { id, url: "https://example.com/x", dest: "/mock/x" });
        return "allowed";
      } catch (e) { return String(e); }
    }, midActive[0]?.id ?? "x");
    check("a duplicate download of the same file is refused outright",
      /already downloading/.test(dup), dup);
    // ONE ROW, NOT THE WHOLE FAMILY. The shared text encoder (6.5GB) belongs
    // to every Wan variant, so the first version of adoption matched it by
    // FILENAME and marked five rows "resuming · umt5…" at once — five rows
    // each claiming to be fetching the same file. Attribution is by `owner`
    // (the catalogue key the Get button passed) for exactly this reason.
    const rows = await page.evaluate(() =>
      (document.querySelector(".ws-modal")?.textContent ?? "").match(/resuming ·/g)?.length ?? 0);
    check("a resumed download claims ONE row, not every row sharing the file",
      rows <= 1, `${rows} rows said "resuming"`);
    await shot(page, "04b-model-download-readopted");

    // `engine=installed` matters: every Get is `disabled={!status?.installed}`,
    // so on an absent engine this click waits 30s for a button that is
    // correctly dead.
    await open(page, "engine", "desktop=m3air&engine=installed&stepms=120");
    await openTab(page, "Models");
    await modal.locator("button:not([disabled])", { hasText: /^\s*Get\s*$/ }).first().click();
    await page.waitForFunction(
      () => /installed/.test(document.querySelector(".ws-modal")?.textContent ?? ""),
      null, { timeout: 40000 });
    check("and the model lands as installed", true);
    await shot(page, "05-model-installed");

    // ── 4b. what is on disk, and what is half on disk
    console.log("\n▸ installed and partial files");
    // A GGUF lands in `diffusion_models`, its encoder in `text_encoders` —
    // neither is `checkpoints` or `loras`, which is all the UI used to look
    // at, so no GGUF variant could EVER read as installed and a finished
    // 4.2GB download still offered a plain Get.
    await open(page, "engine",
      "desktop=m3air&engine=installed&checkpoints=Wan2.2-TI2V-5B-Q6_K.gguf");
    await openTab(page, "Models");
    let e = await modal.innerText();
    // Its shared encoder is still missing, so the variant is correctly NOT
    // "installed" — what must be true is that the 4GB already on disk is
    // COUNTED, i.e. the row quotes what is left rather than the full size.
    check("a model in a non-checkpoint directory counts toward what is left",
      /7\.6 GB of 11\.5 GB/.test(e),
      e.match(/Q6_K[\s\S]{0,90}/)?.[0]?.replace(/\n/g, " ") ?? "");
    // …and with the shared files there too, it reads as installed outright.
    //
    // `wan2.2_vae`, NOT `wan_2.1_vae`, and this fixture is the assertion: the
    // 5B's latent is 48-channel and every other Wan here is 16. The row named
    // the 2.1 file until 2026-08-17, so a completed download read "installed"
    // for a set that could not reach VAEDecode. Do not "fix" this back to the
    // smaller file because the sizes above stop matching.
    await open(page, "engine", "desktop=m3air&engine=installed&checkpoints="
      + "Wan2.2-TI2V-5B-Q6_K.gguf,umt5_xxl_fp8_e4m3fn_scaled.safetensors,wan2.2_vae.safetensors");
    await openTab(page, "Models");
    check("a complete set reads as installed",
      /Q6_K[\s\S]{0,120}?installed/.test(await modal.innerText()));

    // ── the bundled-pipeline family, whose verdict is NOT `localRecipe`
    //
    // MMAudio is the one family that renders through the studio's own Python
    // rather than a `localGraphs` builder, and for one release the engine
    // window judged it by asking for a builder: it printed "cannot be
    // rendered on this machine yet" over a downloaded, working model, in the
    // same sentence that named the two screens that render it. All three
    // states are checked here because the wrong one is a plausible-looking
    // banner rather than a broken page — which is exactly what a screenshot
    // catches and an assertion about state does not.
    // 620 chars: this family's blurb alone is ~330, and the VARIANT row —
    // which is where "installed" is written — sits after it and after the
    // shared-files line. A 420-char window cut off four characters short of
    // the word, so the ready case failed while the screen was correct.
    console.log("\n▸ a bundled-pipeline family says what is actually wrong");
    await open(page, "engine", "desktop=m3air&engine=installed");
    await openTab(page, "Models");
    let mm = (await modal.innerText()).match(/MMAudio[\s\S]{0,620}/)?.[0] ?? "";
    check("with no weights it is an OFFER, not a refusal",
      !/cannot be rendered|Download only|not runnable/.test(mm),
      mm.split("\n").find((l) => /cannot|Download only|not runnable/.test(l)) ?? "");

    await open(page, "engine", "desktop=m3air&engine=installed&mmaudio=1&planner=1");
    await openTab(page, "Models");
    mm = (await modal.innerText()).match(/MMAudio[\s\S]{0,620}/)?.[0] ?? "";
    check("downloaded with the engine stopped, it names the engine",
      /not runnable yet — start the engine/.test(mm),
      mm.split("\n").find((l) => /runnable|cannot/.test(l)) ?? "no line");
    await shot(page, "05b-mmaudio-blocked");

    await open(page, "engine", "desktop=m3air&engine=running&mmaudio=1&planner=1");
    await openTab(page, "Models");
    mm = (await modal.innerText()).match(/MMAudio[\s\S]{0,620}/)?.[0] ?? "";
    check("downloaded and running, it says nothing and reads installed",
      /installed/.test(mm) && !/cannot be rendered|not runnable/.test(mm),
      mm.split("\n").find((l) => /cannot|not runnable/.test(l)) ?? "");

    // A stopped download is otherwise indistinguishable from one never
    // started: the row says "Get 10.4 GB" with no sign a gigabyte is there.
    await open(page, "engine",
      "desktop=m3air&engine=installed&partial=Wan2.2-TI2V-5B-Q6_K.gguf:2500");
    await openTab(page, "Models");
    e = await modal.innerText();
    check("a half-finished download offers Resume, not Get", /Resume/.test(e));
    check("…and says how much is already on disk",
      /2\.4 GB already fetched/.test(e), e.match(/[\d.]+ GB already[^\n]*/)?.[0] ?? "none");
    // The shared 6.5GB encoder belongs to every variant in the family, so a
    // partial of IT must not label five rows as interrupted downloads — only
    // the size column should move.
    await open(page, "engine",
      "desktop=m3air&engine=installed&partial=umt5_xxl_fp8_e4m3fn_scaled.safetensors:966");
    await openTab(page, "Models");
    e = await modal.innerText();
    check("a part-fetched SHARED file claims no row as a resume",
      !/Resume/.test(e), (e.match(/[^\n]*Resume[^\n]*/g) ?? []).slice(0, 3).join(" | "));
    check("…but still counts against what is left to fetch",
      /of 10\.4 GB|of 11\.5 GB/.test(e), "shared partial not deducted");
    await shot(page, "06-partial-and-installed");

    // "0 models" WITH MODELS ON DISK. A GGUF lands in `diffusion_models`, and
    // both the header count and the Start-engine gate asked only about
    // `checkpoints` — so a machine holding two installed Wan GGUFs read "no
    // models yet" and could not start its engine.
    await open(page, "engine", "desktop=m3air&engine=installed&checkpoints="
      + "Wan2.2-TI2V-5B-Q6_K.gguf,umt5_xxl_fp8_e4m3fn_scaled.safetensors,wan2.2_vae.safetensors");
    // No tab click: the file COUNT and the Start gate are on the engine tab's
    // header, not among the model rows.
    e = await modal.innerText();
    check("a GGUF-only install does not report 'no models yet'",
      !/no models yet/.test(e), e.match(/[^\n]*model file[^\n]*/)?.[0] ?? "");
    check("…counts every model file, not just checkpoints and loras",
      /3 model file\(s\)/.test(e), e.match(/\d+ model file\(s\)/)?.[0] ?? "none");
    check("…and Start engine is offered",
      await modal.locator("button:not([disabled])", { hasText: "Start engine" }).count() > 0);

    // A SHARED file downloading has no single variant row to live on — the
    // 6.5GB encoder is what all five of them are waiting for — so it reports
    // at the FAMILY. Without this the model you were fetching showed no sign
    // of activity at all and the progress lived only in the queue pane.
    await open(page, "engine", "desktop=m3air&engine=installed&stepms=20000");
    await openTab(page, "Models");
    await page.evaluate(() => {
      void window.__TAURI__.core.invoke("download_model_file", {
        id: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", url: "https://example.invalid/x",
        dest: "/mock/engine/ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        owner: "wan22-5b",
      });
    });
    await page.waitForFunction(
      () => /every variant below is waiting on this/
        .test(document.querySelector(".ws-modal")?.textContent ?? ""),
      null, { timeout: 8000 }).catch(() => {});
    e = await modal.innerText();
    check("a shared file in flight reports at the family, not on each row",
      /shared umt5_xxl[^\n]*every variant below is waiting on this/.test(e),
      e.match(/shared umt5[^\n]*/)?.[0] ?? "no family-level line");
    // Every Wan family genuinely waits on it, so it appears on each of them —
    // that is not the "five rows claim one download" bug, which was about
    // VARIANT rows inside one family each claiming their own.
    const famLines = (e.match(/every variant below is waiting on this/g) ?? []).length;
    check("…on each family that shares it, and nowhere else",
      famLines >= 2 && !/resuming ·/.test(e), `${famLines} family lines`);
    await shot(page, "07-shared-file-downloading");

    // ── 5. a running engine reports what it is running on
    console.log("\n▸ running engine");
    await open(page, "engine", "desktop=m3air&engine=running");
    t = await page.locator(".ws-modal").innerText();
    check("it reports the engine is live", /engine live|running/i.test(t), t.slice(0, 120));
    check("and names the device it found", /mps/i.test(t), "no device line");
    await shot(page, "06-engine-running");

    // ── 5b. a ComfyUI the user already owns
    //
    // THE CLAIM IS THE GET BUTTONS, and it is only checkable by counting them
    // in two runs. "Installed" and "has somewhere to put weights" used to be
    // one flag, so a machine running its own ComfyUI got a Models tab with
    // every row greyed and no reason given — a whole tab dead, and dead in a
    // way that reads as the app being broken rather than as a setting. The
    // CONTROL is what makes the pair meaningful: it is also what caught the
    // first fix, which enabled every Get unconditionally (`models_dir` always
    // resolves, engine or not) and would have downloaded weights into a tree
    // no ComfyUI reads.
    console.log("\n▸ a linked ComfyUI");
    {
      const enabledGets = () => page.evaluate(() =>
        [...document.querySelectorAll("button")]
          .filter((b) => /Get/.test(b.textContent || "")).filter((b) => !b.disabled).length);

      await open(page, "engine", "desktop=m3air&engine=absent");
      await openTab(page, "Models");
      const none = await enabledGets();
      check("with no engine and no linked ComfyUI, nothing is offered", none === 0, `${none} enabled`);

      await open(page, "engine", "desktop=m3air&engine=absent&comfy=/Users/you/ComfyUI");
      const head = await page.locator(".ws-modal").innerText();
      check("the header says which ComfyUI it is using",
        /using your own ComfyUI/.test(head), head.slice(0, 90));
      await openTab(page, "Models");
      const linked = await page.locator(".ws-modal").innerText();
      check("the tab says where a download lands",
        /Downloads land in your own ComfyUI/.test(linked) && /\/Users\/you\/ComfyUI\/models/.test(linked));
      const many = await enabledGets();
      check("and the catalogue is live with no engine of ours", many > 0, `${many} enabled`);
      // Everything still refused must be refused for MEMORY, not for the
      // engine — otherwise the fix only moved the dead rows around.
      const otherReasons = await page.evaluate(() =>
        [...document.querySelectorAll("button")]
          .filter((b) => /Get/.test(b.textContent || "")).filter((b) => b.disabled)
          .map((b) => (b.closest("div")?.parentElement?.textContent || ""))
          .filter((t) => !/out of reach|may swap|needs ~|may not fit/.test(t)).length);
      // "may not fit" is the ESTIMATED footprint's wording — a rung whose
      // requirement was derived from the file rather than measured. It is
      // still a memory refusal, and leaving it out of this list reported nine
      // correct rows as refused for the wrong reason.
      check("every remaining refusal is about memory", otherReasons === 0, `${otherReasons} others`);
      await shot(page, "08-engine-linked-comfy");

      // A PATH THAT IS NOT A ComfyUI IS REFUSED, AND SAYS SO. This failed
      // POLITELY at first — `invoke` swallows a Rust error and returns null,
      // so the panel closed, the field cleared and the directory was silently
      // unchanged, which is indistinguishable from success.
      await page.locator("button", { hasText: "Change" }).first().click();
      await page.waitForTimeout(200);
      await page.locator('input[placeholder="/Users/you/ComfyUI"]').fill("/Users/me/Documents");
      await page.locator("button", { hasText: "Use it" }).first().click();
      await page.waitForTimeout(600);
      const refused = await page.locator(".ws-modal").innerText();
      check("a path that is not a ComfyUI is refused, in words",
        /does not look like a ComfyUI/.test(refused), refused.slice(0, 90));
      check("…and the directory is left alone",
        /\/Users\/you\/ComfyUI\/models/.test(refused));

      // A CANCELLED PICKER MUST BE A NO-OP. Backing out of a native dialog is
      // a normal thing to do, and it returns the same `null` a failure would —
      // so clearing the field, dropping the link or showing an error there
      // would all make "changed my mind" look like something went wrong.
      const typed = await page.locator('input[placeholder="/Users/you/ComfyUI"]');
      await typed.fill("/half/typed");
      await page.locator("button", { hasText: "Browse" }).first().click();
      await page.waitForTimeout(600);
      const cancelled = await page.locator(".ws-modal").innerText();
      check("cancelling the folder picker changes nothing",
        /\/Users\/you\/ComfyUI\/models/.test(cancelled)
        && !/does not look like/.test(cancelled));
      check("…and keeps what was already typed",
        (await typed.inputValue()) === "/half/typed");
    }

    // ── 5c. the folder picker actually links what it returns
    {
      await open(page, "engine", "desktop=m3air&engine=absent&pickdir=/Users/you/MyComfyUI");
      await openTab(page, "Models");
      const cold = await page.evaluate(() =>
        [...document.querySelectorAll("button")]
          .filter((b) => /Get/.test(b.textContent || "")).filter((b) => !b.disabled).length);
      await page.locator("button", { hasText: "Use my own ComfyUI" }).first().click();
      await page.waitForTimeout(250);
      await page.locator("button", { hasText: "Browse" }).first().click();
      await page.waitForTimeout(700);
      const t2 = await page.locator(".ws-modal").innerText();
      const warm = await page.evaluate(() =>
        [...document.querySelectorAll("button")]
          .filter((b) => /Get/.test(b.textContent || "")).filter((b) => !b.disabled).length);
      check("a picked folder is linked without typing anything",
        /\/Users\/you\/MyComfyUI\/models/.test(t2), t2.slice(0, 120));
      check("…and the catalogue comes alive with it", cold === 0 && warm > 0, `${cold} → ${warm}`);
    }

    // ── 6. the recommendation, per machine, on the first-run screen
    // ── 6b. the API keys tab
    //
    // THE CLAIMS HERE ARE ONES ONLY A PICTURE CAN CHECK. That a stored key is
    // shown as four characters and never in full; that the model list follows
    // the KEY SET rather than the catalog; that a provider whose key the pod
    // cannot use is offered no sharing tick. None of those is observable from
    // an assertion about state, and each fails silently — a share toggle on the
    // wrong card is a key leaving the machine for a pipeline that never reads
    // it.
    console.log("\n▸ api keys");
    {
      // EVERY OPEN IN THIS BLOCK IS `admin=1`, and that is the point rather
      // than a convenience: the open beta holds the three video-generation
      // providers back from a member (`BETA_HELD_PROVIDERS`), so the full
      // surface — fal's card, its model form, the share ticks — is the
      // ADMIN's. The member's is the block below.
      await open(page, "engine", "desktop=m3air&engine=installed&admin=1");
      await openTab(page, "API keys");
      let k = await modal.innerText();
      check("with no keys it still lists every provider",
        /OpenAI/.test(k) && /Anthropic/.test(k) && /fal\.ai/.test(k) && /Google Gemini/.test(k));
      check("…and offers nothing to untick, because nothing is unlocked",
        !/In your pickers/.test(k));
      check("it says where the keys live", /keychain/i.test(k));
      await shot(page, "12-byok-empty");

      await open(page, "engine", "desktop=m3air&engine=installed&byok=openai,fal&admin=1");
      await openTab(page, "API keys");
      k = await modal.innerText();
      // The tail, never the key. There is no command that could return one —
      // see secrets.rs — so this is checking the SURFACE keeps that promise.
      check("a stored key shows only its last four characters",
        /····\w{4}/.test(k), k.match(/····[^\s]*/)?.[0] ?? "no tail");
      check("…and never the key itself", !/sk-mock/.test(k));
      // SCOPED TO THE LIST, not to the tab. "Nano Banana" also appears in the
      // Google CARD's own blurb, which is present whether or not there is a
      // Google key — a whole-tab match tests the copy, not the filtering.
      const picker = k.split("In your pickers")[1] ?? "";
      check("the model list is exactly what those two keys unlock",
        /GPT Image 2/.test(picker) && /Seedream/.test(picker) && !/Nano Banana/.test(picker),
        `list was: ${picker.replace(/\s+/g, " ").slice(0, 160)}`);
      check("a keyed provider offers Check and Remove; an unkeyed one does not",
        (k.match(/Check/g) ?? []).length === 2, `${(k.match(/Check/g) ?? []).length} Check buttons`);
      check("fal — the only provider with no fixed list — can be given models",
        /Add a fal model/.test(k));
      await shot(page, "13-byok-keys");

      // WHICH CARDS GET A SHARE TICK IS THE SECURITY-RELEVANT ONE. Sharing
      // writes an encrypted copy off this machine, and only the providers the
      // POD's pipelines can actually spend should offer it — fal's key drives
      // NO KEY IS EVER SHARED ANYWHERE. The cloud build had a tick per card
      // that copied a key into a server-side vault so its render pod could
      // spend it; there is no pod and no vault here, `secrets.rs` has no
      // `byok_share`, and a key never leaves this machine's keychain except as
      // a header on a request to the provider it belongs to. Asserted as an
      // ABSENCE, because the alternative to a working tick is not a missing
      // tick — it is a tick that appears to work.
      const shareCards = await page.$$eval(".ws-card", (cards) => cards
        .filter((c) => /use this key|share this key/i.test(c.textContent ?? ""))
        .map((c) => (c.textContent ?? "").slice(0, 12).trim()));
      check("no card offers to share a key with anything",
        shareCards.length === 0, JSON.stringify(shareCards));

      // A REJECTED KEY IS A THIRD STATE. "Stored" and "working" are different
      // facts, and a rotated key is stored and dead — the copy has to say the
      // provider refused it rather than leaving a green tick.
      await open(page, "engine",
        "desktop=m3air&engine=installed&byok=openai&byokreject=openai&stepms=120&admin=1");
      await openTab(page, "API keys");
      await page.locator(".ws-btn", { hasText: /^Check$/ }).first().click();
      await page.waitForFunction(
        () => /rejected the key/.test(document.querySelector(".ws-modal")?.textContent ?? ""),
        null, { timeout: 10000 }).catch(() => {});
      k = await modal.innerText();
      check("a refused key reports the provider's own sentence",
        /rejected the key/.test(k) && /Incorrect API key/.test(k),
        k.match(/[^\n]*rejected[^\n]*/)?.[0] ?? "no refusal shown");
      await shot(page, "14-byok-rejected");
    }

    // THE OPEN BETA'S PROVIDER HOLD IS NOT PART OF THIS BUILD. The cloud
    // version withheld three providers and every hosted-video row from a
    // member's key list, because nothing behind them had ever answered a live
    // request on the studio's own account. There are no members here and no
    // studio account: a key is yours, it runs on your machine, and every
    // provider the adapters can speak to is offered. Pinned as an absence
    // where it matters — see the fal card above, which is listed and usable
    // rather than held.

    console.log("\n▸ hardware recommendations");
    // THE CLAIM LINE, NOT THE WHOLE MODAL. This block exists because step 1
    // once promised a model the next screen did not have — so what it checks
    // is that the model NAMED as runnable is one the installer offers, and
    // that a model this machine cannot hold is never the one named.
    //
    // Reading the whole modal cannot say that any more. The screen explains
    // what a machine CANNOT run and why (an M3 Air's refusal is its 16GB of
    // system RAM, not its GPU, and saying so is the useful half), so the
    // forbidden name legitimately appears in the sentence that rules it out.
    // Matching against everything scored that explanation as a promise.
    const claims = async () => {
      const txt = await page.locator(".ws-modal").innerText();
      const grab = (re) => (txt.match(re)?.[1] ?? "").trim();
      return {
        txt,
        image: grab(/Best image model it can run:\s*([^\n]+)/),
        video: grab(/Best video model it can run:\s*([^\n]+)/),
      };
    };
    for (const [machine, expect, forbid] of [
      // Each names a family AND the variant that fits, because the wizard and
      // the installer read the same catalogue — so these are the installer's
      // own words and a drift between the two screens fails here.
      ["rtx4090", /Krea 2 Turbo/, null],
      // Krea 2 was FORBIDDEN here while its only rung was 18GB — promising it
      // to a 12GB card was the mismatch this block exists to catch. It has an
      // 11GB Q3_K_M rung now, and a "12GB" card reports 11.99GB, so the studio
      // default genuinely does fit and recommending it is correct.
      ["rtx4070ti", /Krea 2 Turbo/, null],
      // 16GB of unified memory: an image model, and no H3 of any rung — the
      // leanest build streams ~23GB through system RAM.
      ["m3air", /Flux 2 Klein|Krea 2|Stable Diffusion/, /MiniMax H3/],
      ["headless", /No image model|Cloud mode|cloud|nothing/i, null],
    ]) {
      await open(page, "firstrun", `desktop=${machine}&engine=absent`);
      const c = await claims();
      const named = `${c.image} ${c.video}`.trim();
      check(`${machine}: names a model the installer actually has`,
        expect.test(machine === "headless" ? c.txt : named),
        named || c.txt.replace(/\n/g, " ").slice(0, 150));
      if (forbid) {
        check(`${machine}: does not promise what will not fit`,
          !forbid.test(named), named);
        // ...and the reason IS on screen, which is the other half: a machine
        // told only "no" learns nothing about what would change the answer.
        check(`${machine}: says why the big model is out`,
          forbid.test(c.txt), c.txt.replace(/\n/g, " ").slice(0, 160));
      }
      await shot(page, `07-machine-${machine}`);
    }

    // ── where a render runs ───────────────────────────────────────────
    // THERE IS ONE PLACE AND IT IS THIS MACHINE, so the picker the cloud
    // build put in the render modal — studio cloud or here — has nothing to
    // choose between and is gone rather than shown with one option ticked.
    // `enqueueJob` and `sb.insert` are what make that true of every job; the
    // modal simply has no card. Nothing to check on screen: an absent control
    // is asserted by the page-health pass at the bottom, which opens this
    // modal and fails on a console error.

    // ── the wizard's sheets bar ───────────────────────────────────────
    // OFFLINE, so it sits with the other offline sections and ahead of the
    // network-dependent ones. What only a picture can check here is the
    // OVERFLOW (twelve long names in a fixed width is the paragraph this
    // replaced, and a chip row that wraps to five lines is the same wall in a
    // new costume) and that the three states read DIFFERENTLY — an amber bar
    // that is amber whether or not you can do anything about it is wallpaper
    // by the second episode. The counts and the singulars are asserted,
    // because a chip row with the wrong number in the button beside it looks
    // exactly like a right one.
    console.log("\n▸ wizard · the sheets bar");
    {
      await open(page, "castworld", "desktop=m3air");
      await page.waitForSelector(".ws-wizard-refs", { timeout: 5000 });
      // SCOPED, because the voices bar shares this class with the sheets bar
      // ON PURPOSE — they are the same chore about the same people and reading
      // as one design is the point. `data-case` is what keeps the two sets of
      // assertions off each other's bars.
      const bars = page.locator('[data-case="sheets"] .ws-wizard-refs');
      check("every state is on screen at once", await bars.count() === 5,
        `${await bars.count()} bars`);

      const warn = bars.nth(0);
      check("something missing reads as a warning",
        (await warn.getAttribute("class") ?? "").includes("warn"),
        String(await warn.getAttribute("class")));
      const warnT = await warn.locator(".t").innerText().catch(() => "");
      check("…and names the KINDS, not just a total",
        /6 locations and 6 props have no reference sheet/.test(warnT), warnT);
      // Six chips and a counted remainder, against twelve names run together.
      check("…with the names as chips, capped",
        await warn.locator(".ws-wizard-refs-names button").count() === 6,
        `${await warn.locator(".ws-wizard-refs-names button").count()} chips`);
      // A count with no way to see what it counts is the paragraph's problem
      // one step in, so the rest are in the title.
      const moreTitle = await warn.locator(".ws-wizard-refs-names .more")
        .getAttribute("title").catch(() => null);
      check("…and the rest named on the overflow chip",
        (moreTitle ?? "").includes("Station Emergency Beacon"), String(moreTitle));
      const goText = await warn.locator(".ws-wizard-refs-go").innerText().catch(() => "");
      check("…and the button counts what it would draw",
        goText.includes("12 sheets"), goText);

      // A sheet already drawing is the button WORKING. Colouring it like the
      // thing you still have to do is how an alert stops being read.
      const drawing = bars.nth(2);
      check("a sheet already drawing is not a warning",
        !(await drawing.getAttribute("class") ?? "").includes("warn"),
        String(await drawing.getAttribute("class")));
      check("…and offers no button to re-queue it",
        await drawing.locator(".ws-wizard-refs-go").count() === 0);

      // The picker outlives the warning: the per-card re-rolls spend the same
      // pick, and a control that disappears while it can still be used is
      // worse than one that is merely quiet.
      // REDRAW ALL is on screen in EVERY state including the calm one, which
      // is the state it exists for and the one that is hardest to reach in the
      // real wizard (it needs a bible that is already fully drawn). The
      // primary is gated on something being missing; gating this one the same
      // way would hide it exactly when it is wanted. Quiet, not amber — an
      // amber pill in the calm state reads as a warning about a bible that has
      // nothing wrong with it.
      // "nothing to do" — the fourth case, and the one where the primary is
      // gone and this must not be.
      const calm = bars.nth(3);
      check("redraw all is offered in every state, the calm one included",
        await bars.locator(".ws-wizard-refs-redraw").count() === 5,
        `${await bars.locator(".ws-wizard-refs-redraw").count()} of 5 bars`);
      check("…and it is the quiet one beside the primary, not a second warning",
        await calm.locator(".ws-wizard-refs-go").count() === 0
        && await calm.locator(".ws-wizard-refs-redraw").count() === 1);
      // The confirmation is the half nobody can otherwise look at: the button
      // is one press away and the dialog behind it is behind a session, a
      // project and a finished plan.
      await calm.locator(".ws-wizard-refs-redraw").click().catch(() => {});
      await page.waitForSelector(".ws-modal", { timeout: 4000 }).catch(() => {});
      check("…and it asks before it spends, naming what it clears",
        /UNLINKED, not deleted/i.test(await page.locator(".ws-modal-body").innerText()
                                       .catch(() => "")));
      await page.keyboard.press("Escape");

      check("the model picker is in EVERY state",
        await page.locator('[data-case="sheets"] .ws-wizard-refs-on .pick').count() === 5,
        `${await page.locator(".ws-wizard-refs-on .pick").count()}`);
      const one = bars.nth(4);
      const oneT = await one.locator(".t").innerText().catch(() => "");
      const oneGo = await one.locator(".ws-wizard-refs-go").innerText().catch(() => "");
      check("one missing entry reads in the singular",
        /1 prop has no reference sheet/.test(oneT) && oneGo.includes("1 sheet"),
        `${oneT} / ${oneGo}`);
      await shot(page, "28-castworld-refs");

      // The second press is what the busy flag exists for: an entry stays
      // ref-less until its sheet LANDS, so an enabled button here queues a
      // second sheet for every one of them.
      await warn.locator(".ws-wizard-refs-go").click().catch(() => {});
      check("pressing generate disables it while the jobs go in",
        await warn.locator(".ws-wizard-refs-go").isDisabled().catch(() => false));

      // Narrow: the wizard's column loses ~340px to the director sidebar, and
      // the picker's own trigger is width:100% — a width set on the wrong
      // element either collapses the control or shoves the button off the row.
      await page.setViewportSize({ width: 900, height: 700 });
      await page.waitForTimeout(120);
      const fits = await page.evaluate(() => {
        const q = (s) => document.querySelector(s)?.getBoundingClientRect();
        const b = q(".ws-wizard-refs"), go = q(".ws-wizard-refs-go"),
              pick = q(".ws-wizard-refs-on .pick");
        if (!b || !go || !pick) return { inside: false, pickW: 0, missing: true };
        return { inside: go.right <= b.right + 1 && pick.right <= b.right + 1,
                 pickW: Math.round(pick.width) };
      });
      check("narrow, the picker and the button stay inside the bar",
        fits.inside && fits.pickW > 120, JSON.stringify(fits));
      await shot(page, "29-castworld-refs-narrow");
      await page.setViewportSize({ width: 1280, height: 900 });

      // ── the voices bar ───────────────────────────────────────────────
      // The claims are all pictures. It has to READ as the sheets bar's twin
      // (same box, same chips, same button shape) while its own states differ,
      // and the one that only a screenshot can check is the LAST: with nobody
      // speaking it renders NOTHING, because a bar telling you every character
      // in a silent film has a voice is a sentence about nobody.
      const vbars = page.locator('[data-case="voices"] .ws-wizard-refs');
      check("four voice states render and the fifth renders nothing",
        await vbars.count() === 4, `${await vbars.count()} bars`);
      const vwarn = vbars.nth(0);
      const vt = await vwarn.locator(".t").innerText().catch(() => "");
      check("…the count is OF the speaking cast, not of the bible",
        /7 of 7 speaking characters have no voice yet/.test(vt), vt);
      const vgo = await vwarn.locator(".ws-wizard-refs-go").innerText().catch(() => "");
      check("…and the button counts what it would record",
        vgo.includes("7 voices"), vgo);
      // An engine that cannot record here REFUSES rather than queueing seven
      // jobs that each fail a minute apart.
      const vblocked = vbars.nth(3);
      check("an engine that cannot record here disables the button",
        await vblocked.locator(".ws-wizard-refs-go").isDisabled().catch(() => false));
      check("…and says so rather than showing a bare warning",
        (await vblocked.locator(".d").innerText().catch(() => "")).includes("can't record here"));

      // ── what the plan draws (step 1's card) ──────────────────────────
      // The LADDER is the claim: panels are composed over the sheets, so they
      // cannot be turned on alone — and turning sheets back off has to take
      // them with it rather than leaving a switch that is on and does nothing.
      const auto = page.locator('[data-case="auto"]');
      const rows = auto.locator("button[title]");
      const panelRow = rows.filter({ hasText: "Storyboard panels" }).first();
      check("panels start refused, with the prerequisite named",
        await panelRow.isDisabled().catch(() => false)
        && (await panelRow.innerText()).includes("needs reference sheets"),
        await panelRow.innerText().catch(() => ""));
      await rows.filter({ hasText: "Reference sheets" }).first().click();
      check("…and turning sheets on frees them",
        !(await panelRow.isDisabled().catch(() => true)));
      await panelRow.click();
      await rows.filter({ hasText: "Reference sheets" }).first().click();
      check("turning sheets off takes panels with it",
        await panelRow.isDisabled().catch(() => false),
        await panelRow.innerText().catch(() => ""));
      await shot(page, "29b-castworld-voices");
    }

    // ── the wizard's model pickers ────────────────────────────────────
    // OFFLINE, so it sits with the other offline sections and ahead of the
    // network-dependent ones. Four claims here are pictures rather than state:
    // EVERY MODEL BOTH PLANES CAN RUN IS ON BOTH (so "where" is a decision,
    // and two cards of one model must not both light up), the LOCAL SECTION IS
    // ON TOP AND NEVER EMPTY on a desktop, a machine-wide shortfall is said
    // ONCE on a heading rather than on all seven rows, and a card is refused
    // by ITS OWN plane — which is what a project living on this disk broke,
    // taking the download button off the one section that could fix it.
    console.log("\n▸ wizard · model pickers");
    {
      await open(page, "wizmodels", "desktop=m3air&case=nothing%20downloaded");
      await page.waitForSelector(".wz-card", { timeout: 5000 });
      // PER PICKER, not over the page: the two columns are one DOM order, so
      // a flat read is [video-local, video-cloud, voice-local, …] and an index
      // into it says nothing about either column. Uppercase because the
      // heading is `text-transform`ed, which `innerText` reports.
      const firstTiers = await page.evaluate(() =>
        [...document.querySelectorAll("[data-picker]")]
          .map((p) => p.querySelector(".wz-tier b")?.innerText ?? ""));
      check("the local section comes first, in both columns",
        firstTiers.length === 2
          && firstTiers.every((t) => /ON THIS MACHINE/i.test(t)),
        JSON.stringify(firstTiers));

      // NOTHING is downloaded here, which is the state that used to draw no
      // local section at all.
      const localRows = page.locator('.wz-card[data-tier="local"]');
      check("…and lists what this machine could run, downloaded or not",
        await localRows.count() >= 4, `${await localRows.count()} rows`);
      check("…each with the download that would put it there",
        await localRows.locator(".wz-fix").count() >= 3,
        `${await localRows.locator(".wz-fix").count()} buttons`);
      // The same model, both planes, and only the picked CARD is on.
      const both = await page.evaluate(() => {
        const q = (s) => [...document.querySelectorAll(s)];
        return {
          h3: q('.wz-card[data-model="h3-local"]').map((e) => e.dataset.tier).sort(),
          hosted: q('.wz-card[data-model="h3-api"]').map((e) => e.dataset.tier),
          on: q(".wz-card.on").map((e) => e.dataset.pick),
        };
      });
      check("a model both planes can run is on both",
        JSON.stringify(both.h3) === '["cloud","local"]', JSON.stringify(both.h3));
      check("…and the hosted row is the studio's alone",
        JSON.stringify(both.hosted) === '["cloud"]', JSON.stringify(both.hosted));
      check("…with one card lit per picker, not two",
        both.on.length === 2, JSON.stringify(both.on));
      check("the studio's section says WHEN, once, on its heading",
        await page.locator(".wz-tier em.soon").count() >= 1);
      await shot(page, "30-wizmodels-fresh");

      // ONE FACT ABOUT THE MACHINE, SAID ONCE. Seven rows each carrying "the
      // local engine's Python is not installed" is the wall this replaced.
      await open(page, "wizmodels", "desktop=m3air&case=Python");
      await page.waitForSelector(".wz-card", { timeout: 5000 });
      const rowWhy = await page.locator(".wz-card .wz-why").count();
      check("a machine-wide shortfall is not repeated on every row",
        rowWhy === 0, `${rowWhy} row-level reasons`);
      const heads = await page.locator(".wz-tierblurb + .wz-why").allInnerTexts();
      check("…it is on the heading, with the one button that fixes it",
        heads.length >= 2 && heads.every((t) => /Python is not installed/.test(t)),
        JSON.stringify(heads));
      // …and it is never said under the STUDIO's heading, where the fix would
      // move nothing.
      const cloudWhy = await page.evaluate(() =>
        [...document.querySelectorAll(".wz-tier")]
          .filter((h) => /STUDIO CLOUD/i.test(h.querySelector("b")?.innerText ?? ""))
          .map((h) => h.nextElementSibling?.nextElementSibling?.className ?? ""));
      check("…and never under the studio's, whose rows it cannot fix",
        cloudWhy.every((c) => !c.includes("wz-why")), JSON.stringify(cloudWhy));
      await shot(page, "31-wizmodels-no-python");

      // A CARD IS REFUSED BY ITS OWN PLANE. On a project that lives here the
      // pod cannot see the rows — so the studio's cards go and the local ones
      // keep their own download, which is the section that can do anything.
      await open(page, "wizmodels", "desktop=m3air&case=on%20this%20computer");
      await page.waitForSelector(".wz-card", { timeout: 5000 });
      const split = await page.evaluate(() => ({
        cloudBlocked: [...document.querySelectorAll('.wz-card[data-tier="cloud"]')]
          .every((e) => e.dataset.blocked === "1"),
        localOk: [...document.querySelectorAll('.wz-card[data-tier="local"]')]
          .filter((e) => e.dataset.model !== "h3-turbo-local")
          .every((e) => !e.dataset.blocked),
      }));
      check("a local project loses the studio's cards and keeps its own",
        split.cloudBlocked && split.localOk, JSON.stringify(split));
      await shot(page, "33-wizmodels-localproject");

      // WEIGHTS ON DISK IS NOT AVAILABILITY: the loader has to be there too.
      await open(page, "wizmodels", "desktop=m3air&case=node%20packs");
      await page.waitForSelector(".wz-card", { timeout: 5000 });
      const packWhy = await page.locator('.wz-card[data-model="h3-q4-local"] .wz-why')
        .innerText().catch(() => "");
      check("a rung with no GGUF loader is refused, and names the pack",
        /ComfyUI-GGUF/.test(packWhy), packWhy);

      // An admin is refused nothing, and the fix goes SOMEWHERE.
      await open(page, "wizmodels", "desktop=m3air&case=own%20machine");
      await page.waitForSelector(".wz-card", { timeout: 5000 });
      check("an admin is refused nothing but what cannot run here",
        await page.locator('.wz-card[data-tier="cloud"][data-blocked]').count() === 0,
        `${await page.locator('.wz-card[data-tier="cloud"][data-blocked]').count()} blocked`);
      await open(page, "wizmodels", "desktop=m3air&case=nothing%20downloaded");
      await page.waitForSelector(".wz-card", { timeout: 5000 });
      await page.locator(".wz-fix").first().click();
      check("pressing a fix asks for the engine window",
        (await page.locator("[data-fixes]").first().getAttribute("data-fixes")
          .catch(() => "") ?? "").length > 0);

      // The web build has no local plane, so there is no section to draw —
      // one list, exactly as it was before this. `desktop=` is what installs
      // the mocked bridge, which every screen here needs to mount at all; the
      // WEB case is a fixture, not an absent bridge.
      await open(page, "wizmodels", "desktop=m3air&case=web%20build");
      await page.waitForSelector(".wz-card", { timeout: 5000 });
      check("on the web there is no local section at all",
        await page.locator('.wz-card[data-tier="local"]').count() === 0);
      await shot(page, "32-wizmodels-web");

      // EACH LOCAL ENGINE REPORTS ITS OWN SERVICE. This read
      // `breezeBlocked(f.breeze)` for every local voice row, so with one
      // engine up and the other absent the second card carried the FIRST
      // one's verdict — offering an engine that is not on the machine, and
      // refusing one that is fine. Both are plausible sentences about a
      // speech engine, so neither reads as wrong on the page.
      await open(page, "wizmodels", "desktop=m3air&case=one%20local%20engine");
      await page.waitForSelector(".wz-card", { timeout: 5000 });
      const voices = await page.evaluate(() => {
        const pick = [...document.querySelectorAll("[data-picker]")].at(-1);
        return [...pick.querySelectorAll('.wz-card[data-tier="local"]')].map((e) => ({
          model: e.dataset.model,
          blocked: e.dataset.blocked === "1",
          why: e.querySelector(".wz-why")?.innerText ?? "",
        }));
      });
      const breeze = voices.find((v) => v.model === "breeze");
      const qwen = voices.find((v) => v.model === "qwen");
      check("every local speech engine has a card of its own",
        !!breeze && !!qwen, JSON.stringify(voices.map((v) => v.model)));
      check("…the one that is serving is pickable",
        breeze && !breeze.blocked, JSON.stringify(breeze));
      check("…and the one that is absent is refused IN ITS OWN NAME",
        qwen && qwen.blocked && /Qwen/.test(qwen.why), JSON.stringify(qwen));
      // The button goes to the engine window's SPEECH TAB, which hosts both —
      // so naming one engine put "Set up Breeze" under a refusal about the
      // other, the button pointing at the wrong thing on a card that had just
      // named the right one.
      const fixLabel = await page.evaluate(() =>
        [...document.querySelectorAll('.wz-card[data-model="qwen"] .wz-fix')]
          .map((b) => b.innerText.trim())[0] ?? "");
      check("…and its fix names the destination, not an engine",
        fixLabel.length > 0 && !/Breeze|Qwen/.test(fixLabel), fixLabel);
      await shot(page, "34-wizmodels-two-engines");
    }

    // The bible sheet's voice row: every engine in one menu, and each entry
    // opening on the engine IT was cast on. Offline.
    console.log("\n▸ bible entry · voice picker");
    {
      await open(page, "biblevoice", "desktop=m3air");
      await page.waitForSelector(".ws-bs-row", { timeout: 5000 });
      // THE READING, per case. `providerForEntry` walked Breeze alone, so a
      // character cast on the second local engine read as UNCAST — the sheet
      // opened on Breeze and offered to re-record a voice that already
      // existed, on another engine, silently.
      const opened = await page.evaluate(() =>
        [...document.querySelectorAll("section")].map((s) => {
          const pill = [...s.querySelectorAll("button")]
            .find((b) => /TTS/.test(b.innerText) || /Breeze|Qwen|ElevenLabs|OpenAI/.test(b.innerText));
          return (pill?.innerText ?? "").replace(/\s+/g, " ").trim();
        }));
      check("a Qwen-cast character opens on Qwen, not on the default",
        /Qwen/.test(opened[2] ?? ""), JSON.stringify(opened));
      check("…and so does one whose only evidence is the clip itself",
        /Qwen/.test(opened[3] ?? ""), JSON.stringify(opened));
      check("…while a Breeze-cast one still opens on Breeze",
        /Breeze/.test(opened[1] ?? ""), JSON.stringify(opened));

      // THE MENU: one row per engine, from a shared component rather than
      // four copies of forty lines of JSX.
      await page.locator("section").first().locator("button")
        .filter({ hasText: /Breeze|Qwen|ElevenLabs|OpenAI/ }).first().click();
      await page.waitForSelector(".ws-menu", { timeout: 5000 });
      const rows = await page.locator(".ws-menu .ws-menu-row").allInnerTexts();
      check("every engine has a row, local ones included",
        rows.length === 4 && rows.some((r) => /Qwen3-TTS/.test(r)),
        JSON.stringify(rows.map((r) => r.split("\n")[0])));
      check("…and the Apache row says what it cannot do",
        rows.some((r) => /Qwen3-TTS/.test(r) && /cannot direct/i.test(r)));
      await shot(page, "35-biblevoice-menu");

      // Choosing one WRITES it — the row is what `cast_local_voice` and
      // `castVoiceOf` then read.
      await page.locator(".ws-menu .ws-menu-row").filter({ hasText: /Qwen3-TTS/ }).click();
      await page.waitForFunction(
        () => /voice_provider=qwen/.test(document.querySelector("section")?.innerText ?? ""),
        { timeout: 5000 }).catch(() => {});
      check("picking an engine records it on the entry",
        /voice_provider=qwen/.test(
          await page.locator("section").first().innerText()));
    }

    // The wizard's "add a character" tile opens the REAL new-entry modal,
    // nested. Offline, so it sits above the network-dependent sections.
    console.log("\n▸ nested new-entry modal (wizard)");
    {
      await open(page, "nestedentry", "desktop=m3air");
      await page.waitForSelector('.ws-scrim .ws-modal', { timeout: 5000 });

      const geom = await page.evaluate(() => {
        const scrims = [...document.querySelectorAll(".ws-scrim")].map((el) => ({
          z: Number(getComputedStyle(el).zIndex),
          onBody: el.parentElement === document.body,
          w: Math.round(el.getBoundingClientRect().width),
          h: Math.round(el.getBoundingClientRect().height),
        }));
        return { scrims, vw: innerWidth, vh: innerHeight };
      });
      const nested = geom.scrims.find((x) => x.z === 150);
      const opener = geom.scrims.find((x) => x.z === 95);
      // Portalled: rendered in the wizard's tree it would still be a child of
      // the wizard's scrim, which is what makes it opener-dependent.
      check("the nested modal is portalled to <body>", !!nested?.onBody,
        JSON.stringify(geom.scrims));
      // Above the modal that opened it — the failure this repo already shipped
      // once was a picker that "rendered, took the clicks, and sat under the
      // panel that summoned it".
      check("it sits above the wizard's own scrim", !!opener && nested.z > opener.z,
        `${nested?.z} vs ${opener?.z}`);
      check("its scrim is the viewport, not a box inside the wizard",
        nested.w === geom.vw && nested.h === geom.vh,
        `${nested?.w}x${nested?.h} vs ${geom.vw}x${geom.vh}`);

      // Step 2 renders cast, world and props and has no lore column, so a lore
      // entry saved from here would be a row nothing on screen shows.
      const kinds = await page.evaluate(() => {
        const shell = [...document.querySelectorAll(".ws-scrim")]
          .find((e) => getComputedStyle(e).zIndex === "150");
        return [...shell.querySelectorAll(".ws-seg button")].map((b) => b.textContent.trim());
      });
      check("only the kinds this step can show are offered",
        kinds.length === 3 && !kinds.some((k) => /lore/i.test(k)), kinds.join("/"));

      // The whole point: closing must not take the wizard with it. Routed
      // through ws.openModal it would, because the store holds ONE modal.
      await page.evaluate(() => {
        const shell = [...document.querySelectorAll(".ws-scrim")]
          .find((e) => getComputedStyle(e).zIndex === "150");
        shell.querySelector(".ws-modal-head .ws-icobtn").click();
      });
      await page.waitForFunction(
        () => ![...document.querySelectorAll(".ws-scrim")]
          .some((e) => getComputedStyle(e).zIndex === "150"), null, { timeout: 3000 });
      check("closing it leaves the wizard mounted",
        await page.locator('[data-testid="add-character"]').count() === 1);

      await page.evaluate(() => document.querySelector('[data-testid="add-character"]').click());
      await page.waitForSelector('.ws-scrim .ws-modal', { timeout: 3000 });
      check("the tile reopens it", await page.evaluate(() =>
        [...document.querySelectorAll(".ws-scrim")]
          .some((e) => getComputedStyle(e).zIndex === "150")));
      await shot(page, "33b-nested-new-entry");
    }

    console.log("\n▸ civitai hub");
    await open(page, "civitai", "desktop=m3air&engine=running");
    // Wait for a RESULT rather than a fixed delay — Civitai's latency varies and
    // a timeout that is usually long enough is a flake generator.
    await page.waitForFunction(
      () => (document.querySelector(".ws-modal")?.textContent ?? "").length > 700,
      null, { timeout: 25000 }).catch(() => {});
    t = await page.locator(".ws-modal").innerText();
    check("the hub opens", /Civitai hub/.test(t));
    check("it states the token rule before it bites", /API token/.test(t));
    // COUNT THE CARDS. "Workflows" is also a tab label, so a text match here
    // passed while the grid was empty and Civitai was answering 503 — the
    // assertion reported the opposite of the truth.
    const results = await page.evaluate(
      () => document.querySelectorAll(".ws-modal button .mono").length);
    const live = results > 0;
    if (live) check("live search returned results", true);
    else skip("live search returned results", `Civitai answered nothing — ${t.slice(0, 80)}`);
    // A preview on these model types is usually an mp4, and the CDN's smallest
    // is measured in megabytes — one was 161MB. The grid must therefore be
    // stills throughout: `mediaUrl(…, "card")` asks for a video's poster
    // frame. This regresses silently (it just looks nicer, and the page eats
    // a few hundred MB), so it is pinned rather than reviewed.
    // Read the SRCs, not the network log: cards below the fold are
    // `loading="lazy"` and never requested, so a resource-timing count says
    // "no videos" on a grid full of them.
    let g = await page.evaluate(() => {
      const src = [...document.querySelectorAll(".ws-modal button img")].map((i) => i.src);
      return {
        cards: src.length,
        videos: document.querySelectorAll(".ws-modal video").length,
        posters: src.filter((u) => /anim=false/.test(u)).length,
        rawVideo: src.filter((u) => /\.(mp4|webm)($|\?)/.test(u) && !/anim=false/.test(u)).length,
        unsized: src.filter((u) => /original=true/.test(u)).length,
      };
    });
    if (live) {
      check("every card shows a preview", g.cards >= 8, `${g.cards} images`);
      check("the grid plays no video", g.videos === 0, `${g.videos} elements`);
      check("video previews come through as poster frames",
        g.posters > 0 && g.rawVideo === 0, `${g.posters} posters, ${g.rawVideo} raw`);
      check("no card asks the CDN for the original", g.unsized === 0, `${g.unsized}`);
    } else {
      skip("the grid's media rules", "no results to render");
    }

    // Civitai pages by CURSOR, not offset, and scrolling the grid must APPEND
    // a second page rather than replace the first. Confirmed live during
    // development that the follow-up request can itself 503 under repeated
    // testing (the same condition `live` above already guards against) — a
    // failed page 2 must not corrupt the 24 already on screen, so growth and
    // the documented error banner both count as the feature working; only
    // silence (no growth, no error, no "that's everything") is a failure.
    if (live) {
      const before = g.cards;
      await page.evaluate(() => document.querySelector(".ws-modal-body")?.scrollTo({ top: 0 }));
      await page.waitForTimeout(150);
      await page.evaluate(() => document.querySelector(".ws-modal-body")?.scrollTo({ top: 99999 }));
      await page.waitForFunction(() => {
        const grid = document.querySelector('.ws-modal div[style*="grid-template-columns"]');
        const t = document.querySelector(".ws-modal")?.innerText ?? "";
        return (grid?.children.length ?? 0) > 24 || /Civitai is having trouble/.test(t)
          || /everything Civitai has/.test(t);
      }, null, { timeout: 15000 }).catch(() => {});
      const after = await page.evaluate(() => ({
        count: document.querySelector('.ws-modal div[style*="grid-template-columns"]')
          ?.children.length ?? 0,
        text: document.querySelector(".ws-modal")?.innerText ?? "",
      }));
      if (after.count > before) {
        check("scrolling appends a second page", true, `${before} → ${after.count}`);
      } else if (/Civitai is having trouble/.test(after.text)) {
        skip("scrolling appends a second page", "the follow-up request itself got a 503");
      } else if (/everything Civitai has/.test(after.text)) {
        check("scrolling appends a second page", true, "search was already exhausted at 24");
      } else {
        check("scrolling appends a second page", false, `stuck at ${after.count}, no error shown`);
      }
    }
    await shot(page, "08-civitai-hub");

    // ── 8. the nested detail screen
    console.log("\n▸ civitai detail");
    if (!live) skip("the detail screen", "Civitai search returned nothing to open");
    else {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".ws-modal button")]
        .find((x) => x.querySelector("img"));
      b?.click();
    });
    await page.waitForFunction(() => document.querySelectorAll(".ws-scrim").length > 1,
      null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const d = await page.evaluate(() => ({
      scrims: document.querySelectorAll(".ws-scrim").length,
      // `.ns-l3` has a backdrop-filter, which makes the hub a containing block
      // for fixed descendants — rendered in place, this scrim would be clipped
      // by the hub's own overflow:hidden and open INSIDE it. Only the NESTED
      // one has to escape: the hub itself lives in the React root, and
      // asserting that too is how this check first failed on correct code.
      portaled: !document.querySelector(".ws-modal .ws-scrim")
        && document.querySelectorAll(".ws-scrim")[1]?.parentElement === document.body,
      thumbs: document.querySelectorAll(".ns-cvthumb").length,
      thumbVideos: document.querySelectorAll(".ns-cvthumb video").length,
      heroes: document.querySelectorAll(".ns-cvgal video, .ns-cvgal img").length,
      rich: document.querySelectorAll(".ns-rh").length,
      // The description is author HTML from a public site. It is rebuilt as an
      // allow-list of React elements, never innerHTML'd — a literal tag left
      // in the text would mean the parser was bypassed.
      rawTags: /<(script|p |div|img )/i.test(
        document.querySelector(".ns-rh")?.textContent ?? ""),
      text: document.querySelectorAll(".ws-scrim")[1]?.innerText ?? "",
    }));
    check("the detail screen opens over the hub", d.scrims === 2);
    check("both modals portal to <body>", d.portaled);
    check("the gallery has a strip", d.thumbs > 1, `${d.thumbs} thumbs`);
    check("only the hero is ever a <video>", d.thumbVideos === 0 && d.heroes === 1,
      `${d.thumbVideos} thumb videos, ${d.heroes} hero`);
    check("the description renders as elements", d.rich > 0 && !d.rawTags);
    check("versions are listed with their files", /VERSIONS/.test(d.text)
      && /\.json|MB/.test(d.text));
    check("it says why there are no comments", /does not serve comments/.test(d.text));
    await shot(page, "09-civitai-detail");

    // The gallery box must span the FULL WIDTH of its column for EVERY media
    // orientation — a portrait item must never narrow the box itself, only
    // pillarbox the picture inside it. This regressed once already: an
    // `aspect-ratio` on the stretched flex box, combined with a `max-height`
    // clamp, made the browser recompute the box's WIDTH too, so a 1184x1792
    // showcase item shrank the whole card down to a ~300px column.
    const stage = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const thumbs = [...document.querySelectorAll(".ns-cvthumb")];
      const out = [];
      for (const t of thumbs.slice(0, 8)) {
        t.click();
        await sleep(150);
        const gal = document.querySelector(".ns-cvgal");
        const m = gal?.querySelector("video, img");
        if (!gal || !m) continue;
        // `img.decode()` forces the load+decode rather than waiting on it —
        // the hero is `loading="eager"` (it's the one thing always in view,
        // unlike the 30+ thumbnails), but decoding still takes a moment the
        // test should not have to guess the length of.
        if (m.tagName === "IMG") await m.decode().catch(() => {});
        out.push({ galW: gal.offsetWidth, sectionW: gal.parentElement.offsetWidth,
                   nw: m.videoWidth || m.naturalWidth, nh: m.videoHeight || m.naturalHeight });
      }
      return out;
    });
    const sized = stage.filter((s) => s.nw > 0 && s.nh > 0);
    check("the gallery box spans the full section width for every item",
      sized.length > 0 && sized.every((s) => s.galW === s.sectionW),
      JSON.stringify(sized));
    check("that includes at least one portrait item, not just landscape ones",
      sized.some((s) => s.nh > s.nw), JSON.stringify(sized.map((s) => `${s.nw}x${s.nh}`)));

    // The fullscreen button: what's provable in headless Chrome stops at the
    // OS boundary. The button, its label/icon, the 'F' shortcut and the
    // `requestFullscreen?.()` call itself are all checked here. Whether the
    // browser actually TRANSITIONS to native fullscreen is not — a CDP-driven
    // click is not the kind of user gesture Chromium's fullscreen
    // implementation honours in a headless/automated context (confirmed live:
    // no `fullscreenchange`, no `fullscreenerror`, `fullscreenElement` stays
    // null, even though `fullscreenEnabled` reports true). Same category of
    // gap as tauri-driver not working on macOS at all — this harness proves
    // the wiring, not the OS-level transition, and says so rather than
    // silently passing or failing on something it cannot observe.
    const fs = await page.evaluate(async () => {
      const btn = document.querySelector(".ns-cvfull");
      if (!btn) return { exists: false };
      const before = document.fullscreenElement;
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      return {
        exists: true, label: btn.getAttribute("aria-label"), hasIcon: !!btn.querySelector("svg"),
        changed: document.fullscreenElement !== before,
      };
    });
    check("a fullscreen button sits on the stage, correctly labelled",
      fs.exists && /fullscreen/i.test(fs.label ?? "") && fs.hasIcon, JSON.stringify(fs));
    if (fs.changed) check("clicking it enters native fullscreen", true);
    else skip("clicking it enters native fullscreen",
      "headless Chrome does not treat a CDP-driven click as a fullscreen-triggering gesture");

    await page.keyboard.press("f");
    await page.waitForTimeout(150);
    const afterF = await page.evaluate(() => {
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
      return document.querySelectorAll(".ws-scrim").length;
    });
    check("the 'F' shortcut is wired without disturbing anything else",
      afterF === 2, `${afterF} scrims`);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      scrims: document.querySelectorAll(".ws-scrim").length,
      results: document.querySelectorAll(".ws-modal button img").length,
    }));
    check("Escape closes the detail, not the hub", after.scrims === 1);
    check("the search behind it survived", after.results >= 8, `${after.results}`);
    }

    // ── 9. "will this run here", against machines this Mac is not
    console.log("\n▸ compatibility check");
    const WAN_FILES = ["wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
                       "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
                       "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "wan_2.1_vae.safetensors",
                       "v1-5-pruned-emaonly.safetensors"].join(",");

    await open(page, "compat", `desktop=m3air&engine=running&checkpoints=${WAN_FILES}`);
    let c = await page.locator(".ws-modal").innerText();
    check("a 16GB Mac is refused Wan 2.2 14B", /too big|would not fit/i.test(c), c.slice(0, 120));
    check("SD 1.5 still runs on it", /runs here/.test(c));
    // The measured discount, stated rather than implied.
    check("unified memory is shown as discounted", /60% of unified memory/.test(c));
    await shot(page, "10-compat-m3air");

    await open(page, "compat", `desktop=rtx4090&engine=running&checkpoints=${WAN_FILES}`);
    c = await page.locator(".ws-modal").innerText();
    // max() not sum(): summing 14.6 + 14.6 + 6.3 would refuse the card this
    // model demonstrably runs on.
    check("a 4090 is NOT refused the same graph", !/too big/i.test(c));
    check("…and its peak is the largest file, not their total", /14\.6 GB against 24\.0 GB/.test(c),
      c.match(/Largest single weight[^.]*/)?.[0] ?? "no line");

    check("a known pack is named for a missing class",
      /ComfyUI-Frame-Interpolation/.test(c) && /ComfyUI-SeedVR2_VideoUpscaler/.test(c));
    // Never guess at a repository.
    check("an unknown class says 'pack unknown' rather than guessing",
      /pack unknown/.test(c));
    // The guard that stops a truncated /object_info accusing core ComfyUI.
    check("core nodes are never accused of being missing",
      !/CLIPTextEncode|EmptyLatentImage|VAEDecode/.test(
        c.split("MISSING NODES").slice(1).join(" ")));
    await shot(page, "11-compat-4090");

    // ── 10. a download is visible OUTSIDE the engine screen
    console.log("\n▸ downloads in the queue popover");
    await open(page, "queue", "desktop=m3air&engine=installed&stepms=20000");
    // `innerText` is the RENDERED text and `.ws-mlabel` uppercases in CSS, so
    // these match case-insensitively — the first version asserted the source
    // casing and failed against a working screen.
    const DL_HEAD = /downloading to this machine/i;
    let q = await page.locator(".ws-queuepop").innerText();
    check("the popover renders with no download", !DL_HEAD.test(q));
    // Braces, not a bare arrow: returning the invoke promise makes
    // page.evaluate await the ENTIRE download before continuing, which is the
    // opposite of watching one in progress.
    await page.evaluate(() => {
      void window.__TAURI__.core.invoke("download_model_file", {
        id: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        url: "https://example.invalid/x",
        dest: "/mock/engine/ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        owner: "wan22-5b/q6",
      });
    });
    await page.waitForFunction(
      () => /downloading to this machine/i
        .test(document.querySelector(".ws-queuepop")?.textContent ?? ""),
      null, { timeout: 8000 }).catch(() => {});
    q = await page.locator(".ws-queuepop").innerText();
    check("a weight download shows in the queue popover", DL_HEAD.test(q), q.slice(0, 160));
    check("…named, with bytes rather than a bare percentage",
      /umt5_xxl/.test(q) && /GB|MB/.test(q), q.slice(0, 200));
    check("…and it says what closing the window does",
      /close the engine window/i.test(q));
    // It is counted, but as its own thing — a download is not a render and
    // folding it into the job list would make "N active" mean two things.
    check("…and it is counted in the header without becoming a job",
      /1 downloading/i.test(q) && /0 running/i.test(q), q.slice(0, 120));
    check("…with its own progress bar",
      await page.locator(".ws-queuepop .ws-jobbar").count() > 0);
    await shot(page, "12-queue-with-download");

    // A STOPPED download needs a button, not a bar — and the queue pane is the
    // only place a SHARED file can have one: the engine screen offers Resume
    // against a variant row, and the 6.5GB Wan encoder belongs to every
    // variant of every Wan family at once. The key here is the legacy STEM
    // form (`x.part`, extension replaced), because that is what an existing
    // interrupted download on disk actually looks like — reporting only the
    // new `x.gguf.part` form left a real 966MB file invisible and
    // unresumable, since the rename-forward only runs once a download starts.
    await open(page, "queue",
      "desktop=m3air&engine=installed&stepms=20000&partial=umt5_xxl_fp8_e4m3fn_scaled:966");
    let s2 = await page.locator(".ws-queuepop").innerText();
    check("a stopped download is listed with a Resume button",
      /pick up where it left off/i.test(s2)
      && (await page.locator(".ws-queuepop button", { hasText: "Resume" }).count()) > 0,
      s2.slice(0, 160));
    check("…matched from the legacy .part name, not just the current one",
      /umt5_xxl_fp8_e4m3fn_scaled\.safetensors/.test(s2));
    check("…and a shared file names every family, not the first one",
      /shared by .*,/.test(s2), s2.match(/shared by[^\n]*/)?.[0] ?? "not labelled as shared");
    await shot(page, "13-queue-paused-resume");

    await page.locator(".ws-queuepop button", { hasText: "Resume" }).first().click();
    await page.waitForFunction(
      () => /downloading to this machine/i
        .test(document.querySelector(".ws-queuepop")?.textContent ?? ""),
      null, { timeout: 8000 }).catch(() => {});
    s2 = await page.locator(".ws-queuepop").innerText();
    check("Resume actually starts it, and the row moves to the live group",
      /downloading to this machine/i.test(s2) && !/pick up where it left off/i.test(s2),
      s2.slice(0, 160));
    const resumed = await page.evaluate(() =>
      window.__TAURI__.core.invoke("active_downloads"));
    check("…as a real download, attributed to a catalogue row",
      resumed.length === 1 && !!resumed[0].owner, JSON.stringify(resumed));

    // ---- the wizard's Re-plan popup -------------------------------------
    // Not a desktop screen. It is driven here because the real one is behind a
    // sign-in, a project, an interview and a several-minute plan — and because
    // its one structural risk is a picture: `.ws-scrim` carries a
    // `backdrop-filter`, so a nested scrim rendered in place would resolve
    // against the wizard's padding box and leave an unblurred border instead
    // of covering the screen. It portals to <body> for exactly that reason.
    console.log("\n▸ re-plan popup");
    await open(page, "replan", "desktop=m3air&scenes=8&beats=41");
    const rp = await page.locator(".ws-modal").innerText();
    check("it says what it is about to change",
      /What should change\?/i.test(rp) && /8 scenes/.test(rp), rp.slice(0, 120));
    check("…and that the bible is reused rather than redrawn",
      /nothing already drawn is redrawn/i.test(rp));
    check("…and that a new version is added beside this one",
      /added beside this one/i.test(rp));

    // The whole point of portalling: the popup's scrim has to be the VIEWPORT,
    // not the wizard's padding box.
    const scrimBox = await page.evaluate(() => {
      const s = [...document.querySelectorAll(".ws-scrim")].pop();
      const r = s.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height,
               iw: window.innerWidth, ih: window.innerHeight,
               body: s.parentElement === document.body };
    });
    check("the popup's scrim covers the viewport, not the wizard's padding box",
      scrimBox.body && scrimBox.x === 0 && scrimBox.y === 0
      && scrimBox.w === scrimBox.iw && scrimBox.h === scrimBox.ih,
      JSON.stringify(scrimBox));

    // Neither route can run on an empty note, and the footer says so rather
    // than leaving two dead buttons unexplained.
    const footBtns = () => page.locator(".ws-modal-foot button");
    check("both routes are refused until there is a note",
      await footBtns().nth(0).isDisabled() && await footBtns().nth(1).isDisabled()
      && /say what should change/i.test(await page.locator(".ws-modal-foot").innerText()));

    await page.locator(".ws-modal textarea").fill("Cut the training scene.");
    check("…and offered once there is one",
      !(await footBtns().nth(0).isDisabled()) && !(await footBtns().nth(1).isDisabled()));

    // Each checkbox describes the state it is IN. A hint that always explains
    // the OFF case reads as a bug the moment it is ticked.
    const panelBox = page.locator(".ws-modal input[type=checkbox]").nth(1);
    check("panels off says what you get instead",
      /arrives as prose/i.test(await page.locator(".ws-modal").innerText()));
    await panelBox.check();
    const onText = await page.locator(".ws-modal").innerText();
    // Prices are gone from the app, so the hint states the SHOT COUNT it was
    // given — the number that actually varies with the storyboard.
    check("…and panels on quotes the shot count it was given",
      /one render per shot/i.test(onText) && /\b41 of them\b/.test(onText),
      onText.match(/One render per shot[^\n]*/)?.[0] ?? "no shot count");
    await shot(page, "14-replan-popup");

    check("the choice reaches the caller intact",
      await (async () => {
        await footBtns().nth(1).click();
        await page.waitForTimeout(200);
        const out = await page.locator('[data-testid="replan-result"]').innerText();
        return /new-version:/.test(out) && /prev=true/.test(out) && /panels=true/.test(out);
      })(), await page.locator('[data-testid="replan-result"]').innerText());

    // A blocked pod route must not block the free one: editing these scenes in
    // the chat has none of its preconditions.
    await open(page, "replan", "desktop=m3air&blocker=a%20new%20version%20is%20already%20being%20written");
    await page.locator(".ws-modal textarea").fill("make it shorter");
    check("a blocker stops the pod route, says why, and leaves the chat route",
      await footBtns().nth(1).isDisabled() && !(await footBtns().nth(0).isDisabled())
      && /already being written/i.test(await page.locator(".ws-modal-foot").innerText()));

    // ── the hub's OTHER two tabs: weights, not graphs
    console.log("\n▸ civitai hub · weights");
    await page.evaluate(() => localStorage.removeItem("qamba.civitai.token"));
    await open(page, "civitai", "desktop=m3air&engine=running");
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".ws-modal button")]
        .find((x) => (x.innerText || "").trim() === "LoRAs");
      b?.click();
    });
    await page.waitForFunction(
      () => document.querySelectorAll(".ws-modal button img").length > 0,
      null, { timeout: 25000 }).catch(() => {});
    const loraCards = await page.evaluate(
      () => document.querySelectorAll(".ws-modal button img").length);
    if (!loraCards) {
      skip("the LoRA tab's weights flow", "Civitai answered nothing");
    } else {
      check("the LoRAs tab returns cards", loraCards > 0, `${loraCards}`);
      // The same media rule as the workflow grid: a preview here is usually an
      // mp4 and the CDN's smallest is measured in megabytes.
      const lm = await page.evaluate(() => {
        const src = [...document.querySelectorAll(".ws-modal button img")].map((i) => i.src);
        return { videos: document.querySelectorAll(".ws-modal video").length,
                 raw: src.filter((u) => /\.(mp4|webm)($|\?)/.test(u) && !/anim=false/.test(u)).length };
      });
      check("…as stills, never video", lm.videos === 0 && lm.raw === 0, JSON.stringify(lm));

      // OPEN A CARD THAT ACTUALLY HAS WEIGHTS. Measured across 69 LORA
      // listings, every one publishes a weight file — but not all do (a
      // link-out post has versions and no downloadable file), and the first
      // card is whatever Civitai ranked today. Trying a few keeps this a test
      // of the download flow rather than of the search ordering.
      let det = null;
      for (let i = 0; i < 4 && !det?.get; i++) {
        await page.evaluate((n) => {
          const cards = [...document.querySelectorAll(".ws-modal button")].filter((b) => b.querySelector("img"));
          cards[n]?.click();
        }, i);
        await page.waitForFunction(
          () => document.querySelectorAll(".ws-modal").length > 1, null, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2500);
        det = await page.evaluate(() => {
          const d = [...document.querySelectorAll(".ws-modal")].pop();
          // The detail modal opens on a card that a LIVE search returned. When
          // Civitai answers 503 there are no cards, nothing opened, and reading
          // `.innerText` off nothing threw here — aborting the whole run over
          // somebody else's outage, which is the failure `skip()` exists to
          // prevent one section further up.
          if (!d) return null;
          const t = d.innerText || "";
          const btn = [...d.querySelectorAll("button")].find((b) => /^Get /.test((b.innerText || "").trim()));
          return { text: t, get: btn ? { label: btn.innerText.trim(), disabled: btn.disabled } : null,
                   noWeights: /No weights on this version/.test(t),
                   importBtn: [...d.querySelectorAll("button")].some((b) => /^Import /.test((b.innerText||"").trim())) };
        });
        if (!det) continue;
        if (!det.get) {
          // a listing with no downloadable file — say so correctly, then move on
          check("…and a listing with no weight file says so rather than offering one",
            det.noWeights, det.text.slice(0, 80));
          await page.keyboard.press("Escape");
          await page.waitForTimeout(600);
        }
      }
      if (!det?.get) { skip("the LoRA download button", "no sampled listing published a weight file"); det = null; }
      if (det) {
        // Weights are a download, not an import — offering "Import" here would
        // hand a .safetensors to a JSON parser.
        check("a LoRA offers a download, not an import",
          !!det.get && !det.importBtn, JSON.stringify(det.get));
        check("…sized from the file Civitai lists", /Get \d/.test(det.get.label), det.get.label);
        // A dead primary with no explanation reads as a broken screen, and each
        // reason is a DIFFERENT fix.
        check("with no token it is disabled and says which fix that is",
          det.get.disabled === true && /Add a Civitai API token/.test(det.text),
          det.text.slice(-120));
      }
    }

    console.log("\n▸ workflow repair");
    await open(page, "repair", "desktop=m3air&engine=absent");
    const rep = await page.locator(".ws-card").first().innerText();
    // The engine's own answer and a model's opinion must not read alike — if
    // they did, a user would either distrust the exact ones or over-trust the
    // guesses.
    check("an exact fix quotes the engine's own list",
      /Use Wan2\.2-TI2V-5B-Q8_0\.gguf/.test(rep) && /97% match/.test(rep), rep.slice(0, 140));
    check("…and every proposal wears its confidence",
      /exact/.test(rep) && /likely/.test(rep) && /guess/.test(rep));
    // Defaults are the difference between a fixer and something that edits
    // your work: the engine's answer is worth ticking, a judgement is not.
    const ticks = await page.evaluate(() =>
      [...document.querySelectorAll(".ws-card input[type=checkbox]")].map((b) => b.checked));
    check("only the exact one is ticked by default",
      ticks.length >= 3 && ticks[0] === true && ticks.slice(1).every((t) => t === false),
      JSON.stringify(ticks));
    check("…so Apply names how many it would write",
      /Apply 1/.test(rep), rep.slice(-160));
    // "Not checked" is never "fine" and never "broken". With no engine the
    // panel names BOTH the ones it tried — this machine's and the cloud's —
    // because "no engine" that meant only the laptop is how a verdict about
    // the wrong machine went unnoticed.
    check("with no engine it says what it could not check, and which it asked",
      /No engine answered/.test(rep) && /studio cloud/.test(rep), rep.slice(-200));
    check("…and does not offer a node swap it could not validate",
      !/Ask AI/.test(rep));

    // ── the workflow inspector's tier
    //
    // This page hardcoded `tier = "aws"` for its whole life, so on the desktop
    // app it described the render pod — the right answer to a question nobody
    // had asked, next to a local engine rendering from a different map. The
    // unit tests pin which templates each tier reaches; what only a browser
    // can show is that the page SAYS which machine it means, and that the
    // switch changes the answer rather than just the label.
    console.log("\n▸ workflow inspector · tiers");
    await open(page, "workflows", "desktop=m3air");
    const wfHead = () => page.locator(".ws-viewhead").innerText();
    const onDesktop = await wfHead();
    check("on the desktop app it opens on this machine, and says so",
      /in use on this machine/.test(onDesktop), onDesktop.replace(/\n/g, " | "));
    const deskCount = Number((onDesktop.match(/· (\d+) in use/) ?? [])[1]);

    // The desktop map is the full one MINUS every entry whose weights the
    // engine window cannot fetch, and a shorter list with no reason reads as
    // a studio with nothing in it. The map records why it dropped each
    // entry; the page's job is to show it.
    const report = await page.locator(".ws-card").first().innerText();
    check("a generated map explains itself",
      /This map is generated/.test(report) && /entries dropped/.test(report), report.slice(0, 120));
    await page.locator("button", { hasText: "What is missing" }).first().click();
    await page.waitForTimeout(150);
    const missing = await page.locator(".ws-card").first().innerText();
    check("…and names what it dropped, with the generator's own reason",
      /IMAGE_MODELS/.test(missing) && /engine window cannot download/.test(missing),
      missing.slice(0, 160));
    await shot(page, "27-workflows-desktop-tier");

    // A handler is tier-scoped too: run_lipsync is the v1 studio's and no kind
    // in plan_cli.KINDS reaches it, so counting it here would call a template
    // live on a machine that can never run it. The reason lives on the ROW, so
    // the row has to be opened — it is not in the page until then, and the
    // dormant list it sits in is folded away by default.
    await page.locator("aside button", { hasText: "NOT REACHABLE" }).first().click();
    await page.waitForTimeout(200);
    await page.locator("button", { hasText: "lipsync_latentsync" }).first().click();
    await page.waitForTimeout(150);
    const lipsync = await page.locator("section").first().innerText();
    check("a pod-only handler reads unused here, and says why",
      /does not run on this tier/.test(lipsync), lipsync.slice(0, 160));
    // …and it is still SHOWN. What the file is for is worth knowing on either
    // tier; only the count changes.
    check("…while still naming the handler that owns it",
      /run_lipsync/.test(lipsync));

    // THE OTHER RENDERER. "I have Wan installed and see no workflow for it"
    // was a correct reading of a page that only listed files: the desktop's
    // Wan renders through a TypeScript builder, and the templates it was
    // ported from are named by no model_map, so every tier called them unused.
    await page.locator("button", { hasText: "wan22-5b" }).first().click();
    await page.waitForTimeout(200);
    const recipe = await page.locator("section").first().innerText();
    check("a downloadable family with no template says what renders it",
      /built in code/.test(recipe) && /no template at all/.test(recipe), recipe.slice(0, 160));
    check("…and names the templates it was ported from",
      /wan22_5b_t2v\.json/.test(recipe));
    // The round trip is the point: the source is a link, and the template it
    // lands on says it is a source rather than dead weight.
    await page.locator("section button", { hasText: "wan22_5b_t2v.json" }).first().click();
    await page.waitForTimeout(200);
    const src = await page.locator("section").first().innerText();
    check("the source template says which recipe it feeds",
      /Ported into/.test(src) && /wan22-5b/.test(src), src.slice(0, 200));
    await shot(page, "28-workflows-local-recipe");

    // OPEN COMFYUI IS A WINDOW, NOT A TAB. The editor cannot be framed (403 on
    // Sec-Fetch-Site: cross-site, measured), so the in-app answer is a
    // top-level Tauri window — which a browser harness cannot show. What it
    // CAN check is what the button asked the bridge for, and that the guard
    // holds: loopback only.
    await open(page, "workflows", "desktop=m3air&engine=running");
    await page.locator("button", { hasText: "Open ComfyUI" }).first().click();
    await page.waitForTimeout(200);
    const opened = await page.evaluate(() => window.__qambaComfyWindows ?? []);
    check("Open ComfyUI asks for a window at the local engine",
      opened.length === 1 && /^http:\/\/127\.0\.0\.1:8188/.test(opened[0]),
      JSON.stringify(opened));
    // EDIT IN COMFYUI stages the graph where ComfyUI's browser reads it. The
    // conversion is unit-tested by round trip; what a browser can check is
    // that the button sends a UI document under a name that says where it came
    // from — and that it reports where the file LANDED rather than claiming
    // the editor opened it, which nothing can do.
    await page.locator("button", { hasText: "Edit in ComfyUI" }).first().click();
    await page.waitForTimeout(400);
    const stagedWf = await page.evaluate(() => window.__qambaStagedWorkflows ?? []);
    check("Edit in ComfyUI stages a UI graph under a Qamba name",
      stagedWf.length === 1 && /^Qamba - /.test(stagedWf[0].file)
        && Array.isArray(JSON.parse(stagedWf[0].json).nodes)
        && JSON.parse(stagedWf[0].json).nodes.length > 0,
      JSON.stringify(stagedWf.map((x) => x.file)));
    const said = await page.locator("section").first().innerText();
    check("…and reports it opened, naming the file",
      /Opened in ComfyUI as/.test(said) && /Qamba - /.test(said), said.slice(0, 200));
    // The window is asked to OPEN it, not merely to appear — the whole
    // complaint this answers was "it opens ComfyUI on some other workflow".
    const asked = await page.evaluate(() => window.__qambaComfyWindows ?? []);
    check("…and the window was asked for that workflow",
      asked.some((u) => u.includes("#Qamba - ")), JSON.stringify(asked));

    // AND A SECOND SEND MUST NOT EAT YOUR WORK. The filename is derived from
    // the workflow, so the second click aims at the same file — the first
    // version wrote unconditionally, which rewrote it from the template and
    // took whatever ComfyUI had saved with it.
    const kept = await page.evaluate(async () => {
      const st = window.__qambaStagedWorkflows ?? [];
      if (!st.length) return "nothing was staged";
      // Stand in for "the user edited and saved it in ComfyUI".
      st[0].json = JSON.stringify({ nodes: [], id: "theirs", revision: 1 });
      const r = await window.__TAURI__.core.invoke("stage_comfy_workflow",
        { name: st[0].file.replace(/\.json$/, ""), json: "{\"nodes\":[1]}" });
      return { kept: r.kept, still: st[0].json.includes("theirs") };
    });
    check("a second send keeps the copy edited in ComfyUI",
      kept.kept === true && kept.still === true, JSON.stringify(kept));

    const refused = await page.evaluate(async () => {
      try {
        await window.__TAURI__.core.invoke("open_comfy_window", { url: "http://example.com/" });
        return "accepted";
      } catch (e) { return String(e); }
    });
    check("…and refuses a URL that is not this machine",
      /not this machine/.test(refused), refused);

    // THE RETURN TRIP. ComfyUI saves where it opened from, so the edit lands
    // back in its own folder — including a graph the user built there, which
    // this app never staged (`?comfysaved=`).
    await open(page, "workflows",
      "desktop=m3air&engine=running&comfysaved=" + encodeURIComponent("My own graph"));
    const side = await page.locator("aside").innerText();
    check("a workflow saved in ComfyUI is offered for import",
      /IN COMFYUI/.test(side) && /My own graph/.test(side), side.slice(0, 200));
    await page.locator("aside button", { hasText: "My own graph" }).first().click();
    await page.waitForTimeout(250);
    const fromComfy = await page.locator("section").first().innerText();
    check("…marked as theirs rather than ours",
      /made in ComfyUI/.test(fromComfy), fromComfy.slice(0, 120));
    // The rule the whole feature is shaped around: it becomes an IMPORT, and
    // the pane says so — an edited template would keep rendering and silently
    // stop taking the prompt.
    check("…and the pane says it lands as an import, not an edit to the template",
      /never edits the template/.test(fromComfy) && /tagged slots/.test(fromComfy),
      fromComfy.slice(-260));

    // THE DORMANT LIST IS AN AUDIT, NOT A WALL. On the desktop tier it is 17 of
    // 22 rows, and "unused" was the same word for three different facts — most
    // of it is just "the pod renders this", which is nothing to act on. Folded
    // away, with the one number worth reading in the heading.
    // Re-open the page so the fold is back in its default state — an earlier
    // check above expanded it.
    // `admin=1` — the workflows tier switch is admin-only, and /ui/* has no session. The
    // default stays the MEMBER view; see `harnessAdmin` for why.
    await open(page, "workflows", "desktop=m3air&admin=1&engine=running");
    const fold = page.locator("aside button", { hasText: "NOT REACHABLE" }).first();
    const foldText = await fold.innerText();
    check("the dormant list leads with the finding, not the count",
      /referenced by nothing/.test(foldText) && /elsewhere/.test(foldText),
      foldText.replace(/\n/g, " | "));
    const beforeOpen = await page.locator("aside").innerText();
    check("…and is folded away until asked for",
      !/nothing references it/.test(beforeOpen));
    await fold.click();
    await page.waitForTimeout(200);
    const dormantOpen = await page.locator("aside").innerText();
    // Three different reasons, and every row says which one it is.
    check("…each row saying why it is dormant",
      /nothing references it/.test(dormantOpen)
        && /renders on a machine with every weight/.test(dormantOpen)
        && /ported into wan22-5b/.test(dormantOpen), dormantOpen.slice(0, 200));

    // THE OTHER TIER IS THE FULL MAP, not another machine. It is the source
    // the desktop map is generated from, so it answers "why is X not on the
    // list" — and a template dormant HERE because the full map is the only
    // thing that names it is a different fact from one nothing names at all.
    await page.locator(".ws-seg button", { hasText: "Full map" }).first().click();
    await page.waitForTimeout(250);
    const onFull = await wfHead();
    const fullCount = Number((onFull.match(/· (\d+) in use/) ?? [])[1]);
    // THE MACHINE IS WHAT CHANGES, not the template count. The desktop map
    // drops ENTRIES — a row whose weights the engine window cannot fetch — and
    // the templates those entries used are reached by surviving rows anyway,
    // so both tiers legitimately name the same files. Asserting a bigger
    // number here was asserting a property neither map has.
    check("switching tier changes the machine AND the answer",
      /in use on a machine with every weight/.test(onFull)
        && fullCount === deskCount, `desktop ${deskCount} → full ${fullCount}`);
    // ...and the full map says outright that a graph cannot be EDITED there,
    // which is the difference that matters on this screen: it describes what
    // the pipeline can resolve given every weight, not what this machine runs.
    check("…and says the other tier is a reference rather than a place to work",
      /reference only/.test(onFull), onFull.replace(/\n/g, " | "));
    const fullBody = await page.locator("body").innerText();
    check("the hand-written map has no generated banner",
      !/This map is generated/.test(fullBody));
    // `graphs.py`'s image builders are reachable only where `image_gen` runs
    // on Python, which the full map describes and the desktop one does not —
    // so they belong to this tier and the local recipes to the other one.
    // Showing both everywhere would claim a renderer that does not run there.
    check("the full map lists the python image builders, not the local recipes",
      /IMAGE FAMILIES/.test(fullBody) && !/LOCAL RECIPES/.test(fullBody));

    // ── the local storage plane
    //
    // The unit tests pin the store, the query shim and the sync arithmetic.
    // What only a browser can show is that `supabase.from(...)` — the call
    // every screen in this app makes — actually lands on the local store, that
    // a project survives a reload, and that the destructive half of a sync
    // does not fire when the sync fails.
    // ── video → audio on this machine ────────────────────────────────────
    //
    // `desktopRows.test.ts` pins the ARITHMETIC of the mark, fifteen cases of
    // it. What only a browser can show is the half that decides whether the
    // feature is usable: that the mark reaches the picker at all, that a
    // blocked row says its own sentence rather than a generic refusal, and —
    // the one an assertion about state cannot make — that the job the button
    // sends carries `lane: "local"`. The states come from the MOCK BRIDGE, so
    // this exercises the live path (status → mark → tier → menu → payload)
    // rather than a hand-written mark.
    console.log("\n▸ video to audio · this machine");
    const v2aPick = () => page.locator(".ba-modelbtn").first().innerText();
    const v2aHint = async () =>
      (await page.locator(".ba-hint").allInnerTexts()).join(" ");

    await open(page, "blockaudio", "desktop=m3air&engine=running&mmaudio=1&fixture=solo");
    const readyPick = await v2aPick();
    check("a downloaded MMAudio with both packs is offered under this machine",
      /MMAudio/.test(readyPick), readyPick);
    check("…and a ready row says nothing — a usable row needs no sentence",
      (await v2aHint()) === "", await v2aHint());
    // THE CLAIM THE WHOLE FEATURE RESTS ON. A `gpu` row waits for a pod that
    // need not even be awake; `local` is the lane this machine claims.
    await page.locator("button", { hasText: "Generate the audio" }).first().click();
    await page.waitForTimeout(400);
    const sent = JSON.parse(await page.locator('[data-testid="queued"]').innerText())[0];
    check("…and the job it sends runs HERE, on the local lane",
      sent.kind === "v2a_gen" && sent.lane === "local",
      `${sent.kind} on ${sent.lane}`);
    check("…carrying the model_map key, not the catalog id",
      sent.payload.model_key === "mmaudio-large-44k-v2", sent.payload.model_key);
    await shot(page, "34-blockaudio-desktop-ready");

    // Three refusals, three different fixes. One word for all of them is what
    // leaves a user with nothing to do.
    for (const [q, want, label] of [
      ["engine=absent", /download .*engine window/i, "not downloaded"],
      ["engine=installed&mmaudio=1", /start the engine/i, "engine asleep"],
      ["engine=running&mmaudio=broken", /would not install/i, "a pack was refused"],
    ]) {
      await open(page, "blockaudio", `desktop=m3air&${q}&fixture=solo`);
      const hint = await v2aHint();
      check(`${label}: the picker says so, in its own words`, want.test(hint), hint);
    }
    await shot(page, "35-blockaudio-desktop-blocked");

    // ── the speech tab ───────────────────────────────────────────────────
    //
    // `breezeLocal.test.ts` pins the action TABLE. What only a browser shows
    // is that each state reaches the card with the right one offered — and in
    // particular that `foreign` offers NOTHING, which is the state where a
    // button would kill a server this app did not start.
    console.log("\n▸ speech · Breeze TTS 2");
    const speech = async (state) => {
      await open(page, "engine", `desktop=m3air&engine=installed&breeze=${state}`);
      await openTab(page, "Speech");
      await page.waitForSelector('[data-testid="breeze"]', { timeout: 8000 });
      const card = page.locator('[data-testid="breeze"]');
      return {
        text: await card.innerText(),
        buttons: await card.locator("button").allInnerTexts(),
      };
    };

    const bAbsent = await speech("absent");
    check("with nothing installed it offers the install, with its size",
      /Install Breeze TTS 2/.test(bAbsent.buttons.join(" ")) && /GB/.test(bAbsent.buttons.join(" ")),
      bAbsent.buttons.join(" | "));
    // The weights AND their outputs are non-commercial, which is a fact about
    // what the user may do with what they make — so it is on the card, not
    // in a comment.
    check("…and states the licence before 7.7GB is fetched",
      /non-commercial/i.test(bAbsent.text));
    await shot(page, "36-speech-absent");

    const bHalf = await speech("half");
    check("an interrupted install offers to RESUME, not to start again",
      /Resume/.test(bHalf.buttons.join(" ")), bHalf.buttons.join(" | "));
    check("…and says how many files are left", /of 12 files/.test(bHalf.text));

    const bReady = await speech("installed");
    check("installed and down offers Start", /Start/.test(bReady.buttons.join(" ")),
      bReady.buttons.join(" | "));
    check("…and names the device it will use", /mps/.test(bReady.text));

    const bStarting = await speech("starting");
    check("a loading model says so rather than reading as down",
      /Starting/.test(bStarting.text) && /30 to 60 seconds/.test(bStarting.text));

    const bForeign = await speech("foreign");
    // WE DO NOT FIGHT FOR THE PORT. A Stop here would kill somebody else's
    // server; an Install would load 7.7GB beside it.
    check("something else on the port is offered NOTHING to press",
      bForeign.buttons.length === 0, bForeign.buttons.join(" | "));
    check("…and the card says whose server it is",
      /already serving on port 7860/.test(bForeign.text));
    await shot(page, "37-speech-foreign");

    // ── the SECOND engine, on the same tab ───────────────────────────────
    //
    // `qwenLocal.test.ts` pins its action table too. What only a browser
    // shows is that the two cards are on screen TOGETHER and in independent
    // states — which is the point of the tab: the choice between them is a
    // licence and a capability, and both have to be readable at once.
    console.log("\n▸ speech · Qwen3-TTS");
    await open(page, "engine",
               "desktop=m3air&engine=installed&breeze=running&qwen=absent");
    await openTab(page, "Speech");
    await page.waitForSelector('[data-testid="qwen"]', { timeout: 8000 });
    const qCard = page.locator('[data-testid="qwen"]');
    const bCard = page.locator('[data-testid="breeze"]');
    const qAbsent = {
      text: await qCard.innerText(),
      buttons: await qCard.locator("button").allInnerTexts(),
    };
    check("both engines are on the Speech tab at once",
      (await bCard.count()) === 1 && (await qCard.count()) === 1);
    check("each is in its own state — one running, one not installed",
      /running/i.test(await bCard.innerText())
        && /not installed/i.test(qAbsent.text));
    check("Qwen offers its install, with its size",
      /Install Qwen3-TTS/.test(qAbsent.buttons.join(" "))
        && /GB/.test(qAbsent.buttons.join(" ")), qAbsent.buttons.join(" | "));
    // THE LICENCE IS THE REASON TO PICK IT, so it has to be legible next to
    // the card above that says "non-commercial" — and must NOT borrow that
    // word, which is the other engine's caveat.
    check("…and states Apache 2.0 rather than borrowing Breeze's caveat",
      /Apache 2\.0/.test(qAbsent.text) && !/non-commercial/i.test(qAbsent.text),
      qAbsent.text.slice(0, 160));
    // The capability it LACKS decides between the two as much as the licence,
    // and it is invisible everywhere else — a delivery note simply stops
    // arriving.
    check("…and says outright that it cannot act a direction",
      /cannot act a direction/i.test(qAbsent.text));
    await shot(page, "38-speech-two-engines");

    await open(page, "engine",
               "desktop=m3air&engine=installed&breeze=absent&qwen=half");
    await openTab(page, "Speech");
    await page.waitForSelector('[data-testid="qwen"]', { timeout: 8000 });
    const qHalf = {
      text: await page.locator('[data-testid="qwen"]').innerText(),
      buttons: await page.locator('[data-testid="qwen"] button').allInnerTexts(),
    };
    // ONE CHECKPOINT IS THIS ENGINE'S OWN HALF-INSTALL: it can design a voice
    // and cannot speak a second line in it, so "resume" is the only honest
    // offer.
    check("one checkpoint of two offers RESUME, not a fresh install",
      /Resume/.test(qHalf.buttons.join(" ")), qHalf.buttons.join(" | "));
    check("…and says how many files are left, out of 22",
      /of 22 files/.test(qHalf.text), qHalf.text.slice(0, 200));
    await shot(page, "39-speech-qwen-half");

    console.log("\n▸ local storage plane");
    // WHAT ONLY A BROWSER CAN SHOW. The store, the query shim and the media
    // paths are unit-tested; what they cannot say is that `supabase.from(...)`
    // — the call every screen in this app makes — actually lands on the local
    // store, that the rows survive a reload, and that a key with no file
    // behind it resolves to nothing rather than to a broken image.
    await page.evaluate(() => sessionStorage.clear());
    await open(page, "local", "desktop=m3air");
    check("no local projects to begin with",
      /PROJECTS \(0\)/i.test(await page.locator("body").innerText()));

    await page.getByTestId("make-local").click();
    await page.waitForFunction(
      () => /PROJECTS \(1\)/i.test(document.body.innerText), null, { timeout: 15000 });
    let lp = await page.locator("body").innerText();
    check("beats written through supabase.from() read back from the local store",
      /beat 0 — written through supabase\.from\(\)/.test(lp), lp.slice(0, 200));
    // `project_id` is DERIVED by the store's own trigger the way Postgres used
    // to derive it — half the app's queries filter on it, and a null there is
    // a row every one of them steps over.
    check("project_id is derived up the chain rather than passed",
      /project_id derived: true/.test(lp), lp.match(/project_id[^\n]*/)?.[0] ?? "");
    check("the project is tagged as living on this computer",
      (await page.getByTestId("tag-local").count()) === 1);

    // The media path with REAL BYTES: written through `uploadMedia`, which on
    // this plane is a file in the project's folder, then resolved by the same
    // `mediaUrl` the grid and the player use.
    const shown = await page.getByTestId("local-media").first().getAttribute("src");
    check("local media resolves to a URL the page can load",
      !!shown && !/^https?:/.test(shown), String(shown).slice(0, 60));
    check("…and the bytes really landed on disk",
      /[1-9]\d* bytes of media/.test(await page.getByTestId("local-bytes").innerText()),
      await page.getByTestId("local-bytes").innerText());
    // A ROW IS NOT A FILE, and there is no bucket to fall through to here — so
    // a registered key with nothing behind it answers null and the surface
    // renders nothing, rather than pointing an <img> at a host that does not
    // exist.
    const ghost = await page.getByTestId("local-media-missing").first().getAttribute("src");
    check("a registered key with no local file resolves to nothing",
      ghost === "" || ghost === null, String(ghost).slice(0, 60));
    check("…and the demo says so in as many words",
      /null \(correct\)/.test(lp), lp.match(/missing[^\n]*/)?.[0] ?? "");
    await shot(page, "20-local-plane");

    // A PROJECT IS A FILE, so a reload is the test: the rows come back off
    // disk, and nothing is open until something opens it.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="make-local"]', { timeout: 20000 });
    await page.waitForTimeout(600);
    lp = await page.locator("body").innerText();
    check("the project survives a reload", /PROJECTS \(1\)/i.test(lp), lp.slice(0, 160));
    check("…and no plane is open until one is opened",
      /plane: none open/.test(await page.getByTestId("active-plane").innerText()),
      await page.getByTestId("active-plane").innerText());
    await page.locator('[data-testid="project-row"] button', { hasText: "Open" }).first().click();
    await page.waitForFunction(
      () => /beat 0/.test(document.body.innerText), null, { timeout: 10000 });
    check("opening it reads the rows back off disk",
      /beat 0 — written through supabase\.from\(\)/.test(await page.locator("body").innerText()));

    // WHERE THE PROJECT LIVES IS SAID WHERE SOMEBODY GOES TO ASK. There is one
    // answer on this build, so it is a fact rather than a control — and the
    // size is the part worth knowing, since nothing is backing it up.
    await page.getByTestId("open-settings").click();
    await page.waitForSelector(".ws-modal");
    await page.waitForFunction(
      () => /Storage/i.test(document.querySelector(".ws-modal")?.textContent ?? ""),
      null, { timeout: 15000 });
    const st = await page.locator(".ws-modal").innerText();
    check("project settings says where the project lives",
      /Storage/.test(st) && /On this computer/.test(st), st.slice(0, 160));
    check("…and that nothing is backing it up",
      /nothing is backing it up/.test(st), st.slice(0, 240));
    check("…and how much is on disk, which is what a copy would cost",
      /of media on disk/.test(st), st.match(/[^\n]*on disk[^\n]*/)?.[0] ?? "");
    await shot(page, "22-local-settings-storage");
    await page.evaluate(() => {
      for (const s of document.querySelectorAll(".ws-scrim")) s.dispatchEvent(
        new MouseEvent("click", { bubbles: true }));
    });

    // ── the queued-row prompt panel
    //
    // Everything about this is a claim only a picture settles: that a row whose
    // prompt can be changed and a row whose prompt does not exist YET are told
    // apart before either is opened, and that the panel opens over the queue
    // rather than inside it — `.ws-queuepop` is `.ns-l2`, which carries a
    // backdrop-filter, so an unportalled scrim resolves against the popover's
    // own box and is clipped by its `overflow: hidden`.
    console.log("\n▸ queued-row prompt panel");
    await open(page, "jobprompt", "desktop=m3air");
    const jpBtns = page.getByTestId("job-prompt-btn");
    check("every row with something to say has a button, and the one with nothing has none",
      await jpBtns.count() === 6);
    const jpTitles = await jpBtns.evaluateAll((els) => els.map((e) => e.title));
    check("an editable row and a compiled one read differently before opening",
      jpTitles[0].includes("change it") && jpTitles[1].includes("compiled when the worker picks it up"),
      jpTitles.slice(0, 2).join(" | "));
    check("a claimed row offers no edit either", !jpTitles[5].includes("change it"), jpTitles[5]);

    await jpBtns.nth(0).click();
    await page.waitForSelector(".ws-modal", { timeout: 8000 });
    await shot(page, "jobprompt-editable");
    // PORTALLED: the scrim must fill the viewport, not the popover it came
    // from. Measured against the window rather than trusted.
    const jpScrim = await page.locator(".ws-scrim").boundingBox();
    const jpVp = page.viewportSize();
    check("the panel's scrim covers the whole window",
      Math.abs(jpScrim.width - jpVp.width) < 2 && Math.abs(jpScrim.height - jpVp.height) < 2,
      `${jpScrim.width}x${jpScrim.height} vs ${jpVp.width}x${jpVp.height}`);
    const jpBox = await page.locator(".ws-modal").boundingBox();
    check("the panel fits the window, so its footer is reachable",
      jpBox.y >= 0 && jpBox.y + jpBox.height <= jpVp.height + 1,
      `${jpBox.y} + ${jpBox.height} > ${jpVp.height}`);

    const jpSave = page.getByRole("button", { name: "Save and requeue" });
    check("save is off until something changes", await jpSave.isDisabled());
    check("the footer says nothing has changed",
      /Nothing changed yet/.test(await page.locator(".ws-modal-foot .sum").innerText()));
    await page.locator(".ws-modal textarea").first().fill("a close-up instead");
    await page.waitForTimeout(150);
    check("editing the prompt arms the button", await jpSave.isEnabled());
    check("and the footer states what saving costs — a new id, not an in-place edit",
      /new id, back of its priority band/.test(
        await page.locator(".ws-modal-foot .sum").innerText()));
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(200);

    // The row from the screenshot that started this: a block re-render, whose
    // prompt is compiled from the beats when the worker claims the job.
    await jpBtns.nth(1).click();
    await page.waitForSelector(".ws-modal", { timeout: 8000 });
    await shot(page, "jobprompt-compiled");
    const jpCompiled = await page.locator(".ws-modal-body").innerText();
    check("a block re-render says its prompt does not exist yet",
      /compiled from the block's beats/.test(jpCompiled));
    check("…and offers the block's own editor instead",
      await page.getByRole("button", { name: /prompt & references/ }).isVisible());
    check("it offers no save at all", await page.getByRole("button", { name: "Save and requeue" }).count() === 0);
    // The overlap between "sent with it" and the block-shaping flags is real,
    // so each value must appear once — twice under two spellings reads as two
    // settings that happen to agree.
    check("each override is listed once, not once per table",
      (jpCompiled.match(/minimax-h3/g) || []).length === 1, jpCompiled);
    await page.getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(200);

    // ---- the take assembly viewer ---------------------------------------
    // Also not a desktop screen, and here because both of its failure modes
    // are invisible to every other kind of check. A cell of the WRONG SHAPE
    // still renders a video; a cell showing the WRONG MOMENT still plays. The
    // harness synthesises clips with the elapsed time burned into the picture,
    // so the screenshots are the evidence and these numbers are the assertion.
    console.log("\n▸ take assembly viewer");
    {
      // The clips are RECORDED in the page, in real time — there is no faster
      // way to make a real <video> — so every shape change costs a take's
      // length. Waiting on the loaded video's own shape rather than on a timer
      // is what keeps the screenshots off the transition, where the previous
      // shape's clip is still in the new shape's cell.
      // NINETY seconds, and it is not slack. The harness SYNTHESISES its clips
      // with MediaRecorder, which records in real time — and the drawing loop
      // is a `setTimeout` chain, which Chrome throttles hard in a page that has
      // been navigated as much as this one has by the time the suite gets here.
      // Measured in a context walked through five screens first: the blob does
      // not exist until ~34s and the clips are ready at ~36s, against a
      // nominal 6. At 30s this section timed out before its first check ran.
      const clipsReady = (arWant) => page.waitForFunction((want) => {
        const vs = [...document.querySelectorAll(".tas-cell video")];
        return vs.length > 0 && vs.every(
          (v) => v.videoWidth > 0 && Math.abs(v.videoWidth / v.videoHeight - want) / want < 0.02);
      }, arWant, { timeout: 90000 });
      const openTakes = async (q = "") => {
        await page.goto(`${BASE}/ui/takes?desktop=m3air&${q}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".tas-cell video", { timeout: 20000 });
        await clipsReady(16 / 9);
      };
      const setShape = async (shape, n, ar) => {
        await page.click(`[data-shape="${shape}"]`);
        await page.click(`[data-takes="${n}"]`);
        await page.waitForFunction(
          (k) => document.querySelectorAll(".tas-cell").length === k, n, { timeout: 10000 });
        await clipsReady(ar);
        await page.waitForTimeout(200);
      };
      /** Every visible picture box, the stage's included.
       *
       *  `perRow` is the most cells sharing a top — NOT the number of distinct
       *  lefts, which counts a centred orphan row as its own column and reads
       *  a correct 2x2-minus-one as "3 columns". */
      const boxes = () => page.evaluate(() => {
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), top: Math.round(r.top),
                   left: Math.round(r.left), ar: r.height ? r.width / r.height : 0 };
        };
        const cells = [...document.querySelectorAll(".tas-cell")].map(rect);
        const tops = [...new Set(cells.map((c) => c.top))];
        const mv = document.querySelector(".tas-mv").getBoundingClientRect();
        return {
          frame: rect(document.querySelector(".tas-frame")),
          cells,
          rows: tops.length,
          perRow: Math.max(...tops.map((t) => cells.filter((c) => c.top === t).length)),
          mv: { w: +mv.width.toFixed(2), h: +mv.height.toFixed(2) },
          fits: cells.every((c) => c.left >= mv.left - 1 && c.top >= mv.top - 1
            && c.left + c.w <= mv.right + 1 && c.top + c.h <= mv.bottom + 1),
        };
      });
      const off = (ar, want) => Math.abs(ar - want) / want;
      /** The biggest cell any arrangement could give, from the DOM's own
       *  numbers. Deliberately a second implementation: `fitGrid`'s unit tests
       *  pin the arithmetic, and what this pins is that the box the layout was
       *  computed from is the box it was laid out in — the failure mode a
       *  stale measurement produces, and the only one a screenshot shows. */
      const bestCellW = (mv, n, ar, gap = 8) => {
        let best = 0;
        for (let cols = 1; cols <= n; cols++) {
          const rows = Math.ceil(n / cols);
          const availW = (mv.w - gap * (cols - 1)) / cols;
          const availH = (mv.h - gap * (rows - 1)) / rows;
          if (availW > 0 && availH > 0) best = Math.max(best, Math.min(availW, availH * ar));
        }
        return best;
      };

      await openTakes("");                                       // 16:9, two takes
      let b = await boxes();
      check("the viewer's frame is the render's own shape, not the column's",
        off(b.frame.ar, 16 / 9) < 0.01, `ar ${b.frame.ar.toFixed(3)}`);
      check("every multiview cell is that shape too",
        b.cells.length === 2 && b.cells.every((c) => off(c.ar, 16 / 9) < 0.01),
        b.cells.map((c) => `${c.w}x${c.h}`).join(" "));
      check("two wide takes in a tall column stack instead of being cut to strips",
        b.perRow === 1 && b.rows === 2, `${b.perRow} per row x ${b.rows} rows`);
      // The bug this replaces: `1fr` tracks gave each cell the full column
      // height, so a 16:9 render was cropped to about a third of its width.
      check("…and a stacked cell is most of the column wide",
        b.cells[0].w > 400, `${b.cells[0].w}px`);
      check("…which is the biggest arrangement there is room for",
        Math.abs(b.cells[0].w - bestCellW(b.mv, 2, 16 / 9)) < 1.5,
        `${b.cells[0].w} vs best ${bestCellW(b.mv, 2, 16 / 9).toFixed(2)}`);

      // The picture must not be letterboxed INSIDE its own frame either: the
      // video box and the frame box are the same rectangle.
      check("nothing is letterboxed inside the frame", await page.evaluate(() => {
        const f = document.querySelector(".tas-frame").getBoundingClientRect();
        const v = document.querySelector(".tas-cell video").getBoundingClientRect();
        const c = document.querySelector(".tas-cell").getBoundingClientRect();
        return Math.abs(v.width - c.width) < 1 && Math.abs(v.height - c.height) < 1 && f.width > 0;
      }));
      await shot(page, "15-takes-16x9");

      // Playback. The stage and the cells are separate <video> elements, so
      // "in sync" is a real claim about real decoders, not about one clock.
      await page.click('[data-act="play"]');
      await page.waitForTimeout(2500);
      const times = await page.evaluate(() => ({
        stage: [...document.querySelectorAll(".tas-video")].map((v) => v.currentTime),
        cells: [...document.querySelectorAll(".tas-cell video")].map((v) => v.currentTime),
        rolling: [...document.querySelectorAll(".tas-cell video")].filter((v) => !v.paused).length,
      }));
      check("the multiview cells are actually rolling", times.rolling === 2, `${times.rolling}/2`);
      check("…and past the start, so this is playback and not a still",
        Math.min(...times.cells) > 0.4, `${Math.min(...times.cells).toFixed(2)}s`);
      // A cell plays its take THROUGH, so it has to survive the end of one:
      // a take that simply ran out reads as a frozen cell.
      check("…and each of them loops rather than stopping at its take's end",
        await page.evaluate(() => [...document.querySelectorAll(".tas-cell video")]
          .every((v) => v.loop)));
      // Only the take on screen may be heard — two elements of one take
      // playing aloud is a flanged echo, not a louder take.
      check("a multiview cell is never audible", await page.evaluate(
        () => [...document.querySelectorAll(".tas-cell video")].every((v) => v.muted)));
      await shot(page, "16-takes-playing");

      // ---- the cut is an EDIT, not a selection ---------------------------
      // Pieces are dropped where you point, dragged into a new order and
      // retrimmed by their own edges, and the cut's length is whatever they
      // make it. Every one of those is a GESTURE — a drop that lands one piece
      // to the left is a perfectly good cut of the wrong thing, and no
      // assertion about state can see the difference.
      await page.click('[data-act="play"]');                 // pause
      await page.waitForTimeout(200);
      const wallBefore = await page.evaluate(
        () => [...document.querySelectorAll(".tas-cell video")].map((v) => +v.currentTime.toFixed(3)));

      // ---- the bench's playhead has something to hold ---------------------
      // Every strip draws a line at the current SOURCE moment; the arrow is
      // the top of it. It is STICKY inside the strips rather than a row above
      // them — the strips scroll, and a sibling outside the scroll container
      // is misaligned by the scrollbar's width the moment one appears.
      const scrub = await page.evaluate(() => {
        const bar = document.querySelector(".tas-scrub").getBoundingClientRect();
        const strip = document.querySelector(".tas-strip").getBoundingClientRect();
        const lbl = document.querySelector(".tas-rowlabel.ghost");
        return { pos: getComputedStyle(document.querySelector(".tas-scrubrow")).position,
                 dx: Math.round(bar.left - strip.left), dw: Math.round(bar.width - strip.width),
                 wraps: lbl.scrollHeight > lbl.clientHeight + 1 };
      });
      check("the bench playhead is pinned and its track is the strips' track",
        scrub.pos === "sticky" && Math.abs(scrub.dx) <= 1 && Math.abs(scrub.dw) <= 1 && !scrub.wraps,
        `${scrub.pos} · dx ${scrub.dx} dw ${scrub.dw} · wraps ${scrub.wraps}`);
      const sbar = await page.locator(".tas-scrub").boundingBox();
      await page.mouse.move(sbar.x + sbar.width * 0.2, sbar.y + sbar.height / 2);
      await page.mouse.down();
      await page.mouse.move(sbar.x + sbar.width * 0.62, sbar.y + sbar.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      const scrubbed = await page.evaluate(() => ({
        head: document.querySelector(".tas-srchead").style.left,
        cut: document.querySelector(".tas-playhead").style.left,
      }));
      check("…and dragging it takes every strip AND the viewer there",
        Math.abs(parseFloat(scrubbed.head) - 62) < 3 && parseFloat(scrubbed.cut) > 50,
        `source ${scrubbed.head} · cut ${scrubbed.cut}`);
      // The wall is not on that clock. Under the tiling model every cell was
      // yanked to the cut's source moment; a reordered cut sends that moment
      // backwards, which is what made the grid unwatchable.
      const wallAfter = await page.evaluate(
        () => [...document.querySelectorAll(".tas-cell video")].map((v) => +v.currentTime.toFixed(3)));
      check("…and leaves the multiview exactly where it was — the wall is not on the cut's clock",
        wallBefore.length === wallAfter.length
        && wallAfter.every((t, i) => Math.abs(t - wallBefore[i]) < 0.05),
        `${wallBefore.join(" ")} -> ${wallAfter.join(" ")}`);

      const cutState = () => page.evaluate(() => {
        const tr = document.querySelector(".tas-track");
        const t = tr.getBoundingClientRect();
        return {
          dur: document.querySelector(".tas-asmlabel .tas-dur").textContent,
          notes: [...document.querySelectorAll(".tas-asmlabel .tas-cnt")].map((e) => e.textContent),
          pieces: [...document.querySelectorAll(".tas-span")].map((e) => {
            const r = e.getBoundingClientRect();
            return { lb: e.querySelector(".tas-lb").textContent,
                     l: Math.round(r.left - t.left), w: Math.round(r.width) };
          }),
          caret: [...document.querySelectorAll(".tas-caret")].length,
          track: { l: t.left, w: t.width, cy: t.top + t.height / 2 },
        };
      });
      let cut = await cutState();
      check("the cut lays every piece out at its own length",
        cut.pieces.length === 2 && Math.abs(cut.pieces[0].w - cut.pieces[1].w) < 4
        && cut.pieces[0].l === 0 && cut.dur === "0:06.0",
        `${cut.dur} · ${cut.pieces.map((p) => `${p.lb}@${p.l}+${p.w}`).join(" ")}`);

      // Two clocks. `shuffled` makes the cut's SECOND half take 2's FIRST
      // half, so clicking that moment on the bench puts the playhead two
      // thirds of the way through a cut whose takes are all showing 1.0s.
      await page.click('[data-act="shuffle"]');
      await page.waitForTimeout(150);
      const strip = await page.locator(".tas-strip").nth(1).boundingBox();
      await page.mouse.click(strip.x + strip.width / 6, strip.y + strip.height / 2);
      await page.waitForTimeout(250);
      const clocks = await page.evaluate(() => ({
        head: document.querySelector(".tas-playhead").style.left,
        src: document.querySelector(".tas-srchead").style.left,
        times: [...document.querySelectorAll(".tas-video")].map((v) => +v.currentTime.toFixed(2)),
      }));
      check("a piece plays where it was DROPPED and shows where it came FROM",
        Math.abs(parseFloat(clocks.head) - 66.7) < 1 && Math.abs(parseFloat(clocks.src) - 16.7) < 1,
        `cut ${clocks.head} · source ${clocks.src}`);
      // STAGE elements only — one per take, and the wall is deliberately not
      // among them any more. The ELEMENTS are the weaker half of this claim and
      // the assertion says so: the harness's clips are MediaRecorder output,
      // and a headless run can hand back one 0.17s long, which clamps every
      // seek in it. What survives that is the part that would break if the
      // player fed the elements cut time — they agree with each other, and they
      // are nowhere near 4.0s.
      check("…and every take the STAGE could cut to is at that one moment, not at the cut's",
        clocks.times.length >= 2
        && Math.max(...clocks.times) - Math.min(...clocks.times) < 0.35
        && Math.max(...clocks.times) < 2,
        clocks.times.join(" "));

      // Reorder: drag the second piece to the front. The caret is the promise
      // and the order after the drop is whether it was kept.
      cut = await cutState();
      await page.mouse.move(cut.track.l + cut.pieces[1].l + cut.pieces[1].w / 2, cut.track.cy);
      await page.mouse.down();
      await page.mouse.move(cut.track.l + cut.pieces[0].w / 2, cut.track.cy, { steps: 8 });
      await page.mouse.move(cut.track.l + 12, cut.track.cy, { steps: 4 });
      const mid = await cutState();
      check("a piece being dragged shows the caret it would drop into",
        mid.caret === 1, `${mid.caret} caret(s)`);
      await page.mouse.up();
      await page.waitForTimeout(150);
      const reordered = await cutState();
      check("…and dropping it there is what happens",
        reordered.pieces[0].lb.startsWith("Take 2") && reordered.dur === cut.dur,
        `${reordered.pieces.map((p) => p.lb).join(" | ")} · ${reordered.dur}`);

      // Retrim: an edge is a RIPPLE, so the cut gets shorter and says so.
      const edge = cut.track.l + reordered.pieces[0].l + reordered.pieces[0].w - 3;
      await page.mouse.move(edge, cut.track.cy);
      await page.mouse.down();
      await page.mouse.move(edge - 200, cut.track.cy, { steps: 8 });
      await page.waitForTimeout(120);
      // The TIMELINE's own frame card, on the cut's handles: "does this land
      // before or after she turns her head" is not answerable from a width and
      // a duration, and it was not answerable here at all until it was shared.
      const fp = await page.evaluate(() => {
        const el = document.querySelector(".ws-trimfp");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { text: el.innerText.replace(/\n/g, " · "),
                 onScreen: r.top > 0 && r.left > 0 && r.right < window.innerWidth };
      });
      check("holding a retrim handle raises the frame it will land on",
        !!fp && /OUT/.test(fp.text) && fp.onScreen, fp ? fp.text : "no .ws-trimfp");
      await page.mouse.up();
      await page.waitForTimeout(100);
      check("…and it goes away on release",
        !(await page.evaluate(() => !!document.querySelector(".ws-trimfp"))));
      await page.waitForTimeout(150);
      const trimmed = await cutState();
      check("retrimming a piece's edge shortens the cut and reports the delta",
        trimmed.dur < reordered.dur && trimmed.pieces[0].w < reordered.pieces[0].w
        && trimmed.notes.some((n) => /vs block/.test(n)),
        `${trimmed.dur} · ${trimmed.notes.join(" · ")}`);
      check("…and the piece after it moved up to meet it — nothing leaves a gap",
        Math.abs(trimmed.pieces[1].l - (trimmed.pieces[0].w + 3)) < 4,
        `piece 2 at ${trimmed.pieces[1].l}, piece 1 ends ${trimmed.pieces[0].w}`);

      // ---- THE STUCK PIECE ------------------------------------------------
      // A drag starts on a strip and ends over the cut, so it spans two
      // components, and a pointerup goes to whichever element captured the
      // pointer — nothing at all when the release happens outside the window.
      // Neither component owned the END of the gesture, so the piece stayed
      // glued to the cursor with nothing on screen able to put it down.
      const liftFromBench = async (rowIdx, a, b) => {
        const strip = await page.locator(".tas-strip").nth(rowIdx).boundingBox();
        const t = await page.locator(".tas-track").boundingBox();
        const sy = strip.y + strip.height / 2;
        await page.mouse.move(strip.x + strip.width * a, sy);          // trim it
        await page.mouse.down();
        await page.mouse.move(strip.x + strip.width * b, sy, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(60);
        await page.mouse.move(strip.x + strip.width * ((a + b) / 2), sy);   // lift it
        await page.mouse.down();
        await page.mouse.move(strip.x + strip.width * ((a + b) / 2), sy - 15, { steps: 3 });
        await page.mouse.move(t.x + t.width * 0.5, t.y + t.height / 2, { steps: 6 });
        await page.waitForTimeout(80);
        return t;
      };
      const held = await cutState();
      const overCut = await liftFromBench(0, 0.10, 0.28);
      check("a piece lifted off the bench is in flight over the cut",
        (await cutState()).caret === 1);
      // No pointerup at all — the release landed where this window cannot see
      // it, and the next move with no button held is the only notice there is.
      await page.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, buttons: 0 })),
        { x: overCut.x + overCut.width * 0.5, y: overCut.y + overCut.height / 2 });
      await page.waitForTimeout(150);
      const landed = await cutState();
      check("…and a release this window never saw still puts it down",
        !landed.caret && landed.dur !== held.dur,
        `${held.dur} → ${landed.dur} · caret ${landed.caret}`);
      await page.mouse.up();
      await page.waitForTimeout(60);

      // Released away from the cut: nothing inserted, and nothing left in hand.
      const beforeOff = await cutState();
      await liftFromBench(1, 0.40, 0.58);
      const headBox = await page.locator(".tas-head").boundingBox();
      await page.mouse.move(headBox.x + 60, headBox.y + 12, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      const dropped = await cutState();
      check("dropping it away from the cut ends the drag and changes nothing",
        !dropped.caret && dropped.dur === beforeOff.dur,
        `${beforeOff.dur} → ${dropped.dur}`);
      await shot(page, "16b-takes-cut");

      // A shape the fit has to solve differently: tall media in a tall box
      // goes side by side, which is the opposite arrangement.
      await openTakes();
      await setShape("9:16", 3, 9 / 16);
      b = await boxes();
      check("a vertical render gets vertical cells",
        b.cells.length === 3 && b.cells.every((c) => off(c.ar, 9 / 16) < 0.01)
        && off(b.frame.ar, 9 / 16) < 0.01,
        b.cells.map((c) => `${c.w}x${c.h}`).join(" "));
      // Which arrangement three tall cells take depends on the room, so the
      // claim is the invariant rather than a column count: nothing spills, and
      // no other arrangement would have been bigger.
      check("…arranged as large as the column allows, with nothing spilling out",
        b.fits && Math.abs(b.cells[0].w - bestCellW(b.mv, 3, 9 / 16)) < 1.5,
        `${b.cells[0].w} vs best ${bestCellW(b.mv, 3, 9 / 16).toFixed(2)}, fits=${b.fits}`);
      await shot(page, "17-takes-9x16");

      await setShape("2.39:1", 4, 1912 / 800);
      b = await boxes();
      check("scope keeps its shape at four cells",
        b.cells.length === 4 && b.cells.every((c) => off(c.ar, 1912 / 800) < 0.01),
        b.cells.map((c) => c.ar.toFixed(2)).join(" "));
      check("…and none of the four is clipped off the column", b.fits
        && Math.abs(b.cells[0].w - bestCellW(b.mv, 4, 1912 / 800)) < 1.5,
        `${b.cells[0].w} vs best ${bestCellW(b.mv, 4, 1912 / 800).toFixed(2)}, fits=${b.fits}`);
      await shot(page, "18-takes-scope");

      // ---- more takes than cells -----------------------------------------
      // Four cells and six takes, so "the first four" stops being an answer:
      // the take worth watching beside the one in the cut is routinely the
      // seventh. Both claims here are ones a screenshot cannot make — a cell
      // showing the wrong take still plays perfectly well.
      await page.click('[data-takes="6"]');
      await page.waitForFunction(
        () => document.querySelectorAll(".tas-cell").length === 4, null, { timeout: 10000 });
      const names = () => page.$$eval(".tas-cell .tas-nm", (ns) => ns.map((n) => n.textContent.trim()));
      check("more takes than cells fills the cells it has and names the rest",
        (await names()).length === 4
        && (await page.textContent(".tas-mvmore")).includes("+2 more")
        && (await page.$$("[data-pick]")).length === 4,
        (await names()).join(" | "));
      await page.click('[data-pick="0"]');
      await page.waitForSelector(".tas-cellpop");
      await page.click('.tas-cellpop [data-take="take-5"]');
      await page.waitForTimeout(150);
      check("a spare take can be brought up into any cell",
        (await names())[0].includes("Take 5"), (await names()).join(" | "));
      await page.click('[data-pick="1"]');
      await page.waitForSelector(".tas-cellpop");
      await page.click('.tas-cellpop [data-take="take-5"]');
      await page.waitForTimeout(150);
      const traded = await names();
      check("…and picking one already up TRADES the two cells rather than doubling it",
        traded[1].includes("Take 5") && traded[0].includes("Take 2")
        && new Set(traded).size === 4, traded.join(" | "));
      await shot(page, "18b-takes-wall");
    }

    console.log("\n▸ page health");
    check("nothing threw on any desktop screen", thrown.length === 0, thrown.slice(0, 2).join(" | "));
    check("no app resource failed to load", badRequests.length === 0,
      badRequests.slice(0, 3).join(" | "));
  } finally {
    await ctx.close();
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`
    + (skipped ? `, ${skipped} skipped` : ""));
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  ✖ ${f}`);
  }
  console.log(`screenshots: ${SHOTS}`);
  process.exit(failures.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
