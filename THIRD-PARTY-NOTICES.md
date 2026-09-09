# Third-party notices

Qamba Studio is licensed under the GNU Affero General Public License v3.0 or
later — see [LICENSE](LICENSE). This file covers everything that is *not* the
project's own work: what is copied into this repository, what is adapted from
somebody else's published work, and what the app downloads onto your machine
after you install it.

Three separate questions, and they have different answers, so they are kept
apart below. If you are here because you want to know what you are allowed to
do with a render you made, the section that matters is **Model weights** — the
app's licence has nothing to say about it.

---

## 1. Why this project is AGPL

Not only as a preference. `worker/comfy_nodes/vrgdg_audiodrive/` is third-party
source vendored into this repository under the **AGPL-3.0**, and it is part of
what the app ships and runs. A combined work containing it is AGPL, so that is
what this one is.

| what | where | licence |
|---|---|---|
| `VRGDG_MiniMaxH3AudioDrive.py` | `worker/comfy_nodes/vrgdg_audiodrive/` | AGPL-3.0 — Jean Thompson / vrgamegirl19, [comfyui-vrgamedevgirl](https://github.com/vrgamegirl19/comfyui-vrgamedevgirl) |

It is vendored unmodified, with the author's own `LICENSE` and `NOTICE` beside
it. It locks a supplied audio track into MiniMax H3's joint audio+video latent
so the picture is generated against that exact track — the music-video
mechanism, and the only third-party *code* copied into this tree.

The other two ComfyUI nodes under `worker/comfy_nodes/` — `neon_h3_preview`
and `neon_h3_refine` — were written for this project and are covered by
`LICENSE` like the rest of it. Their headers say what they exist for and which
upstream gap they fill.

---

## 2. Adapted, not copied

The ComfyUI graphs in `workflows/` and the graph builders in
`worker/graphs.py` / `worker/resolve.py` were in several cases worked out
from a published workflow rather than invented here. No file was copied; what
was taken is which nodes go together and what the numbers are, and in each
case the source is named in the comment beside the code, with the measurement
that made it worth taking. The ones worth naming here:

- **vrgamedevgirl** — the two-pass audio-driven H3 refine (`resolve.py`
  `_splice_h3_refine`), and the reference-mode graph the r2v templates started
  from.
- **larryvrh** — the H3 turbo step distillation and the sampler it needs.
- **iiTzMYUNG** (civitai 2910804) — the H3 → LTX 2.5 refine sizing.
- **The Combat Base V2 author** (civitai 2869434) — the low-sigma second-pass
  split, and the sampler advice that turned out to be load-bearing.
- **liconstudio** — the LTX 2.5 multi-subject reference guide's own workflow.
- **Carasibana** — the H3 face-refine template the finishing pass follows.

Model **recipes** (step counts, samplers, sigma schedules, LoRA strengths) come
from the model authors' own published guidance. Where this project measured
something different, the comment says so and says what was measured.

---

## 3. Downloaded when you install the engine

None of this is in this repository or in the installer. The app fetches it into
its own folder when you use the engine window, from the addresses below, and
each piece stays under its own licence.

| component | source | licence |
|---|---|---|
| CPython (a private interpreter for the pipeline and ComfyUI) | [astral-sh/python-build-standalone](https://github.com/astral-sh/python-build-standalone) | MPL-2.0 (and the licences of the CPython build it packages) |
| ComfyUI | [comfyanonymous/ComfyUI](https://github.com/comfyanonymous/ComfyUI) | GPL-3.0 |
| ffmpeg (static build, only when your machine has none) | [eugeneware/ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | GPL-3.0 (the build's own configuration decides which ffmpeg licence applies) |
| ComfyUI-GGUF | [city96](https://github.com/city96/ComfyUI-GGUF) | Apache-2.0 |
| ComfyUI-LTX2.5-MSR | [liconstudio](https://github.com/liconstudio/ComfyUI-LTX2.5-MSR) | Apache-2.0 (declared in `pyproject.toml`; the repository ships no `LICENSE` file) |
| ComfyUI-MMAudio | [kijai](https://github.com/kijai/ComfyUI-MMAudio) | MIT |
| ComfyUI-VideoHelperSuite | [Kosinkadink](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | GPL-3.0 |
| ComfyUI-MiniMax-H3-PDD-Acc | [Jalen-Brunson](https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc) | Apache-2.0 |
| ComfyUI-KJNodes | [kijai](https://github.com/kijai/ComfyUI-KJNodes) | GPL-3.0 |
| ComfyUI-H3-FaceRefine | [Carasibana](https://github.com/Carasibana/ComfyUI-H3-FaceRefine) | MIT |
| Ollama (optional, for the local director and the vision query) | [ollama/ollama](https://github.com/ollama/ollama) | MIT |

Each pack's Python dependencies are installed by the app against a constraints
file built from what is already there, so a pack cannot replace the PyTorch
build everything else renders on. A pack whose dependencies are refused is
reported and its capability is switched off rather than the engine being
quietly downgraded.

**npm and Cargo dependencies** are declared in `package.json` and
`src-tauri/Cargo.toml` and travel with their own licences; `npm ci` and
`cargo build` fetch them. They are not enumerated here because the manifests
are the authoritative list and a copy of one goes stale.

---

## 4. Model weights

**The app's licence does not cover them and cannot.** Every checkpoint, LoRA,
text encoder and VAE is downloaded from its publisher — Hugging Face or
Civitai — at the moment you ask for it, under whatever terms that publisher
sets, and those terms are what govern what you may do with what you render.

**Every family in the catalogue carries its own `license` and `licenseUrl`**
(`src/lib/engineCatalog.ts`), and the engine window shows them on the card
before you download anything. That field is the authoritative list; a copy of
it in this file would go stale the week a model is added. What it says today
spans Apache-2.0 and MIT (Wan 2.1/2.2, HiDream O1, Flux 2 Klein 4B), community
licences with commercial thresholds or conditions (Krea 2, MiniMax H3,
LTX 2.x), CreativeML Open RAIL-M with its use restrictions travelling attached
to the weights (Stable Diffusion 1.5, SDXL base), and several that are
outright **non-commercial**:

- **Flux 2 dev**, **Flux 2 Klein 9B** — FLUX non-commercial licence.
- **SDXL Turbo** — non-commercial, unlike the SDXL base it sits beside.
- **Anima** — CircleStone Labs derivative licence.
- **Breeze TTS 2** — BreezeBlue Research licence, non-commercial, and it says
  so of the weights *and* of what they produce.

Two consequences worth stating plainly. A model being reachable from this app
is not a statement that you may use its output commercially — several of them
say you may not. And a single project can mix them: the family that drew your
character sheets and the one that spoke the dialogue may have completely
different terms.

**Read the licence of anything you are going to publish or sell, at its
source.** This project does not host, mirror or redistribute weights.

---

## 5. What is deliberately absent

- **MiniMax's own H3 prompt-writing guides.** `director/prompt_guides.js` names
  `h3_official_base_modes.md` and `h3_official_ref_mode.md`, and the loader
  reads them if they are there — but they are thousands of words of MiniMax's,
  and this project has no licence to redistribute them, so they are neither in
  this repository nor in the installer. Everything degrades to `""` without
  them; see `director/knowledge/README.md` for what that costs and how to put
  them back on your own machine.
- **Any model weights.** As above: fetched from the publisher, never mirrored.

---

If you believe something here is attributed wrongly, or that something of
yours is in this repository and should not be, please open an issue — it will
be fixed or removed.
