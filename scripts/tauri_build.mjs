#!/usr/bin/env node
// `npm run tauri:build` — `tauri build`, plus the one macOS fact that decides
// whether the bundle opens or is called "damaged".
//
// AD-HOC IS NOT THE SAME AS UNSIGNED, AND TAURI'S DEFAULT IS NEITHER. With no
// signing identity configured, the bundler leaves the executable
// LINKER-SIGNED and never writes `Contents/_CodeSignature/CodeResources` — so
// the app's Resources (the whole bundled worker/, workflows/ and the desktop
// model map) sit unsealed while the signature claims they are sealed.
// `codesign -v` says it exactly: "code has no resources but signature
// indicates they must be present". That bundle runs fine from the build
// directory and macOS reports it as **"Qamba Studio is damaged and can't be
// opened. You should move it to the Trash."** the moment it arrives anywhere
// carrying a quarantine flag — which is every download, including a DMG handed
// to a tester. Measured 2026-09-03 on a build that was otherwise perfect.
//
// Passing `-` is codesign's own spelling of "ad-hoc", and Tauri hands it
// straight through: the log then reads `Signing with identity "-"` twice, once
// for the executable and once for the BUNDLE, and the seal appears. Doing it
// HERE rather than afterwards is the whole point — Tauri builds the .dmg FROM
// the .app, so a seal applied after the fact fixes the copy on this disk and
// leaves the distributable carrying the broken one. Verified by mounting the
// built .dmg: the app inside it passes `codesign -v --strict --deep`.
//
// IT IS A FLOOR, NOT A FIX. An ad-hoc signature has no identity behind it, so
// a downloaded build still meets Gatekeeper — it just meets the recoverable
// "unverified developer" wall (right-click -> Open) instead of "damaged, move
// to Trash", which offers no way forward at all. The real answer is a
// Developer ID Application certificate plus notarization, which needs a paid
// Apple Developer account; see docs/RELEASING.md. A real identity ALWAYS
// WINS: this only fills in a value nobody set.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const mac = process.platform === "darwin";

/** The product name, read from the config rather than written down, because it
 *  is what names the volume `bundle_dmg.sh` will try to create. */
function productName() {
  try {
    return JSON.parse(fs.readFileSync(
      path.join(import.meta.dirname, "..", "src-tauri", "tauri.conf.json"),
      "utf8")).productName ?? null;
  } catch {
    return null;
  }
}

/**
 * A volume of the PRODUCT'S OWN NAME blocks the .dmg step, and it never says
 * so — the failure is a bare `failed to run bundle_dmg.sh` with the script's
 * output swallowed.
 *
 * `hdiutil` will not attach a second volume of the same name, so a DMG of this
 * app that somebody double-clicked (a tester's copy, or the one you are about
 * to replace) stops the build. Checked because it is cheap and the error is
 * otherwise unreadable.
 *
 * NOT a general theory of that failure, and the difference is measured: a run
 * with a stale `dmg.XXXXXX` scratch volume mounted SUCCEEDED, so those are
 * litter from a crashed run rather than a cause. `bundle_dmg.sh` is
 * independently flaky — it drives Finder over AppleScript to lay out the
 * window — and failed 3 runs in a row here before succeeding with nothing
 * changed. If the .dmg step fails and no volume is named below, just run it
 * again.
 *
 * REPORTED, NEVER EJECTED: unmounting a volume out from under whatever is
 * using it is a worse surprise than the failure it fixes.
 */
function conflictingVolume() {
  if (!mac) return null;
  const name = productName();
  if (!name) return null;
  try {
    return fs.readdirSync("/Volumes").includes(name) ? `/Volumes/${name}` : null;
  } catch {
    return null;
  }
}

const clash = conflictingVolume();
if (clash) {
  console.error(
    `\n! ${clash} is mounted. hdiutil cannot create a second volume of that\n`
    + "  name, so the .dmg step will fail with a bare \"failed to run\n"
    + "  bundle_dmg.sh\". Eject it and re-run:\n\n"
    + `      hdiutil detach ${JSON.stringify(clash)} -force\n`);
  process.exit(1);
}

const env = { ...process.env };
// `APPLE_CERTIFICATE` is the CI route (a base64 .p12 Tauri imports and then
// selects from). Defaulting the identity while one is present would ad-hoc
// sign a build that has a real certificate sitting right there.
if (mac && !env.APPLE_SIGNING_IDENTITY && !env.APPLE_CERTIFICATE) {
  env.APPLE_SIGNING_IDENTITY = "-";
  console.log("• no APPLE_SIGNING_IDENTITY set — signing AD-HOC so the bundle is sealed.");
  console.log("  Shareable builds want a Developer ID certificate; see docs/RELEASING.md.\n");
}

const r = spawnSync("tauri", ["build", ...process.argv.slice(2)],
  { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(r.status ?? 1);
