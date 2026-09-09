# Making a build somebody else can open

`npm run tauri:build` produces a bundle for the platform you are on. Getting
that bundle to open on a *different* machine is a separate problem on macOS and
Windows, and this file is what was learned solving it.

There is no update server in this build — nothing checks for or installs
updates — so a release is a file you hand over, not a channel you publish to.

## macOS

### The floor: ad-hoc signing, which `npm run tauri:build` does for you

With no signing identity set, Tauri leaves the executable linker-signed and
never writes `Contents/_CodeSignature/CodeResources` — so the app's Resources
(the whole bundled `worker/`, `workflows/` and the model map) sit unsealed
while the signature claims they are sealed. `codesign -v` says exactly that:
*"code has no resources but signature indicates they must be present"*.

Such a bundle runs perfectly from the build directory and macOS refuses it with
**"Qamba Studio is damaged and can't be opened"** the moment it carries a
quarantine flag — which is every download. The message names the one cause it
is not.

`scripts/tauri_build.mjs` sets `APPLE_SIGNING_IDENTITY=-` (codesign's own
spelling of ad-hoc) when nothing else is set, and the seal appears. It has to
happen DURING bundling, not after: the `.dmg` is built *from* the `.app`, so a
seal applied afterwards fixes the copy on your disk and leaves the distributable
carrying the broken one. A real identity always wins — the default is skipped
when `APPLE_SIGNING_IDENTITY` or `APPLE_CERTIFICATE` is already set.

Ad-hoc has no identity behind it, so a downloaded build still meets Gatekeeper
— just the recoverable "unverified developer" wall (right-click → Open) rather
than "damaged", which offers no way forward at all.

### The real answer: Developer ID + notarization

Needs paid Apple Developer Program membership. The certificate is **Developer
ID Application** — an `Apple Development` cert cannot be notarized and does not
satisfy Gatekeeper anywhere else. Xcode → Settings → Accounts → Manage
Certificates → +.

Four environment variables, and the names are read out of the Tauri CLI rather
than from documentation:

```
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
APPLE_ID=you@example.com
APPLE_PASSWORD=<an app-specific password>
APPLE_TEAM_ID=TEAMID
```

(or the API-key route: `APPLE_API_KEY` + `APPLE_API_ISSUER` +
`APPLE_API_KEY_PATH`.) The CLI runs `xcrun notarytool submit`, `notarytool log`
and `stapler staple` itself — there is nothing to script.

Four things that cost real time when they go wrong:

- **Prove the credentials BEFORE the build.** Notarization is the LAST step, so
  a bad credential costs the whole build and exits non-zero holding a perfectly
  good signed bundle. `xcrun notarytool history --apple-id … --password …
  --team-id …` answers in a second. `No submission history` is a SUCCESS.
- **A 401 is as likely to be the Apple ID as the password.** The error names
  only the password. Shape is not evidence and neither is the password being
  recent — check both halves.
- **Tauri staples the `.app` and NOT the `.dmg`.** It notarizes, staples the
  app, then builds the DMG *from* the stapled app and merely signs it — so the
  DMG ships with no ticket of its own, which passes on a machine that can reach
  Apple and fails closed on one that cannot. Submit and staple it separately
  after the build:

  ```bash
  xcrun notarytool submit "…_aarch64.dmg" --apple-id … --password … \
    --team-id … --wait
  xcrun stapler staple "…_aarch64.dmg"
  ```

- **Check it the way a downloader gets it.** `spctl -a -vvv -t install` on a
  copy carrying `com.apple.quarantine` is the only check that reproduces what
  somebody downloading it sees.

### `bundle_dmg.sh` is intermittently flaky and says nothing useful

The whole error is `failed to run bundle_dmg.sh`, with the script's own output
swallowed. It drives Finder over AppleScript to lay the window out, which is
the flaky part — three failures in a row followed by a success with nothing
changed is a real observation. **Re-run before investigating.**

What IS a real blocker is a mounted volume of the product's own name, since
`hdiutil` will not attach a second one; `scripts/tauri_build.mjs` refuses up
front for that and names the `hdiutil detach` to run. A stale `dmg.XXXXXX`
scratch volume from a crashed run is litter, not a blocker.

## Windows

`npm run tauri:build` produces both an NSIS setup and an MSI. Signing needs a
code-signing certificate and is not set up here; an unsigned installer shows
SmartScreen's "unrecognised app" warning, which is recoverable (More info →
Run anyway).

Two things that only bite on Windows and are already handled in the source, so
do not "fix" them again: every console-subsystem child process is given
`CREATE_NO_WINDOW`, because the release binary has no console of its own and
each child would otherwise open a visible one; and Vite's watcher must keep
ignoring `src-tauri/`, because Cargo holds an exclusive lock on a build
script's `.exe` while it runs and chokidar raises `EBUSY` as an unhandled
error — which kills the dev server that `tauri dev` is running as its
`beforeDevCommand`.

## Linux

Not yet built by anyone. `npm run tauri:build` should produce a `.deb`, an
`.rpm` and an AppImage; you need the usual Tauri v2 prerequisites
(`webkit2gtk`, `libappindicator`, `librsvg`). The `.deb` declares `ffmpeg` as a
dependency, and the app's own static-ffmpeg fallback covers the other formats.

If it works, or if it does not, please open an issue with the output — see the
Platforms table in the README for what is already known to be in place.

## Before you hand a build to anybody

- `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml --lib`, and
  `cd worker && python3 -m pytest tests/`.
- Open the built app from a COPY carrying a quarantine flag, not from
  `target/`. A bundle that is broken for downloaders runs fine from the build
  directory — that is the whole failure mode above.
- Check the bundle really carries the resources: the pipeline, the workflows,
  the model map and `director/knowledge/`. A missing resource is silent —
  `plan_cli` refuses a render for want of a model map, and the planner quietly
  loses its craft guides.
