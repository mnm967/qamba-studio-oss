# Qamba Studio

A desktop studio for making AI video — write it, storyboard it, render it, cut
it — that runs **entirely on your own machine**. Your projects are files on
your disk, generation happens on your own GPU through your own ComfyUI, and the
only thing that ever leaves the computer is a request to a model provider whose
key you pasted in yourself.

There is no account, no server, no sign-in, and nothing to subscribe to.

---

## What it does

**Plan.** Describe an episode and a staffed planning pipeline works it into a
storyboard: a writer, a story editor, a dialogue pass, a per-character voice
pass, a continuity director who tracks where everyone is standing, and a
cinematographer who turns beats into shots with real camera grammar. Between
each stage sit deterministic checks — a line can never be squeezed below the
time it takes to say, a scene cannot come back as one medium two-shot per beat,
a fight has to carry physical consequences — with one batched re-ask and then a
mechanical fallback, so a lazy model degrades to acceptable rather than to
nonsense.

**A story bible.** Characters, locations and props with identity lines and
reference sheets — face plates, six-view turnarounds, location plates at four
angles. Every later render is anchored on them, which is what keeps a face the
same face from shot to shot.

**Render.** Storyboard blocks, one-off clips, stills, music, sound effects,
speech, and video-to-audio. Local models through ComfyUI (MiniMax H3, LTX 2.5,
Wan, Flux 2, Krea 2, SDXL, Qwen-Image-Edit, HiDream and more), or a hosted
provider on your own API key. The engine window downloads and manages the
weights.

**Edit.** A real timeline: multi-track video and audio, trim, ripple, roll,
speed, reverse, freeze, transform, crop, transitions, and per-clip and per-lane
effect racks with an EQ, a compressor and a convolution reverb — where the mix
you approve by ear is the mix ffmpeg renders, because both engines are held to
the same numbers by tests. A take-assembly bench for cutting between several
renders of one shot. A finishing chain: restore, refine, interpolate, face
refine, colour match, grain.

**A director you can talk to.** A chat with forty-odd tools over the actual
project — it can rewrite a scene, re-time a beat, recast a voice, add a shot,
re-render what drifted, and look at what came out. It runs on a local model
through Ollama, or on your own Anthropic / OpenAI / Google key. Every turn
records what it wrote, and any reply can be reverted.

---

## Requirements

- **macOS 12+, Windows 10+, or Linux.** See *Platforms* below.
- **A Rust toolchain** ([rustup](https://rustup.rs)) and **Node 20+** to build.
- **ffmpeg** — or let the engine window fetch a static build into its own
  folder.
- **A GPU worth rendering on**, if you want to render locally. The setup screen
  reads your machine and recommends what actually fits; a 16GB Apple Silicon
  laptop runs the small video models and the image models, and the large video
  checkpoints want considerably more.
- **Nothing else.** No account, no API key, no network — until you ask for
  something that needs one.

## Build and run

```bash
npm ci
npm run tauri:dev          # the desktop app, against a dev server
npm run tauri:build        # a bundle for this platform
```

`npm run dev` alone opens the web build in a browser, which is useful for
working on the UI. It is not the product: every local feature — your own
ComfyUI, the model downloads, the keychain, the pipeline — needs the desktop
shell.

### Tests

```bash
npm test                                              # the shared JS + TS modules
cd worker && python3 -m pytest tests/                 # the pipeline (run it FROM worker/)
cargo test --manifest-path src-tauri/Cargo.toml --lib # the desktop shell
npm run test:ui                                       # the UI harness (needs a Chrome)
```

About 4,500 of them, and they pass. A good number are not unit tests of a
function but pins on a DECISION — that two implementations of one rule in two
languages still agree, that a control the user can see still reaches the render
behind it, that a refusal still names the fix. Those are the ones worth reading
when you want to know why something is the way it is.

> The pipeline tests must be run **from `worker/`**. Several read source files
> by relative path, so from the repository root a dozen of them fail on
> `FileNotFoundError` and look like a broken package. If your `python3` is
> older than 3.10 the pipeline will not even import — make a virtualenv on a
> newer one.

---

## How it is put together

```
  React + TypeScript  ──►  a project is a JSON file on your disk
   (the whole UI)              media is a folder beside it
         │
         ├──►  Tauri (Rust)  ──►  your ComfyUI on :8188        (renders)
         │      the shell         the OS keychain               (your API keys)
         │                        a loopback PostgREST proxy    (see below)
         │
         └──►  Python pipeline  ──►  planning, prompts, ffmpeg, assembly
                (bundled, one process per job)
```

**A project is a file.** `src/lib/localStore.ts` holds a project's rows —
scenes, beats, blocks, takes, clips, the bible, the queue — as one JSON
document the app writes atomically, with its media in a directory beside it.
Nothing is uploaded anywhere.

**The pipeline is Python and it speaks PostgREST.** The planning and block
pipeline is several thousand lines of Python; rewriting it in TypeScript would
have been a twin of the most rule-dense code in the project. Instead the app
answers PostgREST for the open project on a loopback port
(`src-tauri/src/dbproxy.rs` + `src/lib/localRest.ts`) and hands the pipeline a
random token good for that one run, so `worker/sb.py` talks to a file on your
disk without knowing it. The interpreter is a private CPython the engine window
installs, so nothing is added to your system Python.

**Your keys stay in the OS keychain and never enter the web view.** Rust holds
them, checks the destination host against that provider's own list, and injects
the key into the outgoing request — so a compromised page cannot read a key and
cannot spend one anywhere but the vendor it belongs to. See
`src-tauri/src/secrets.rs`.

**Generation is a queue.** Everything is a job row on one lane, claimed by the
app's own worker, so a render survives closing the window it was started from
and every surface that reports progress is reading the same rows.

Deeper notes live next to the code. Nearly every module opens with what it is
for, what went wrong before it looked like this, and what was measured — the
comments are the documentation, and they are worth more than a wiki.

---

## Platforms

| | status |
|---|---|
| macOS (Apple Silicon, Intel) | built and used |
| Windows 11 | built and used |
| Linux (x86_64, aarch64) | **should build and run — not yet verified** |

Tauri targets Linux and the pieces this app needs on the way there are in
place: every platform-specific branch in the Rust has a Linux arm, the private
CPython and the static ffmpeg both publish `x86_64-unknown-linux-gnu` and
`aarch64-unknown-linux-gnu` builds at the versions this pins (checked), the GPU
probe reads `lspci` and `nvidia-smi`, and the keychain goes through the Secret
Service — so a desktop session running `gnome-keyring` or KWallet is what your
API keys are kept in. The `.deb` declares `ffmpeg` as a dependency.

What has NOT happened is somebody running `npm run tauri:build` on a Linux box
and opening the result, so the row above says what it says. Building it needs
the usual Tauri v2 Linux prerequisites (`webkit2gtk`, `libappindicator`,
`librsvg` and friends) — see
[Tauri's prerequisites page](https://tauri.app/start/prerequisites/). If you
get it working, or it fails, an issue with the output would be genuinely
useful.

---

## Licence

**AGPL-3.0-or-later** — see [LICENSE](LICENSE).

Not merely a preference: a third-party ComfyUI node vendored into
`worker/comfy_nodes/` is AGPL, so the combined work is too.

**Model weights are not covered by it and cannot be.** Every checkpoint is
downloaded from its own publisher under its own licence, and several of the
ones this app can fetch are non-commercial. The engine window shows each
family's licence on its card before you download it. Read it before you sell
anything you render.

[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) has the rest: what is
vendored, what is adapted from published work, what the app downloads, and what
is deliberately absent.

## Contributing

Issues and pull requests are welcome. Two things worth knowing before a PR:

- **Say what you measured.** This codebase's comments record what was tried,
  what it cost and what came back. A change that ships a number should say
  where the number came from.
- **Run the tests, and add the one that would have caught you.** The most
  useful tests here pin a rule that two implementations have to agree on —
  which is where this project's bugs have historically lived.
