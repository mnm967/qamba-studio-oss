// RenderSettingsModal on its own, for /ui/render.
//
// Here for the reason `panel` and `replan` are: the real one is behind a
// sign-in, a project, an episode and a timeline with clips on it, and the
// claims this screen makes are ones only a picture can check —
//
//  * the quality control CHANGES SHAPE with the format (a CRF slider for the
//    three compressed codecs, a named-profile row for ProRes), and "ProRes 3"
//    never reads as a CRF;
//  * the audio row is rebuilt from the container's own legality, so switching
//    to VP9 replaces AAC with Opus in front of you rather than correcting it
//    silently at render time;
//  * the Hardware switch is ABSENT, not disabled, where the format has no
//    NVENC path;
//  * the post card says how much of the cut it actually governs;
//  * the tuning rows APPEAR AND DISAPPEAR with the passes they belong to —
//    `?post=upscale,ltx_refine` is the state to look at. Five sigma pills in a
//    modal column have to wrap without the pills themselves wrapping their
//    labels, which is a layout claim no assertion about state can make.
//  * WHERE IT RUNS lists both planes with the reason a blocked one cannot be
//    picked, and every one of those states needs a different machine to
//    produce: `?where=member` is a desktop account the studio's cloud is not
//    open to yet, `?where=noengine` is one with nothing installed,
//    `?where=localproj` is a project whose rows are a file on this computer,
//    and `?where=nowhere` is both at once — the case where Render itself has
//    to refuse. Which chip is lit, whether the reasons are readable without
//    hovering, and whether the fix is a button are all claims only a picture
//    can check.
//
// It reads no Supabase and needs no session: every prop is passed in,
// `placeFacts` states the machine rather than being one, and `onRender` logs
// instead of queueing.
import React, { useState } from "react";
import RenderSettingsModal from "./RenderSettingsModal";
import { normalizeOutput, type RenderOutput } from "../../lib/renderOutput";
import { normalizePostOptions, type PostChain } from "../../lib/postChain";
import type { RenderFacts } from "../../lib/renderReadiness";
import { postLocalGaps } from "../../lib/postLocal";
import { POST_PROCESS } from "../../lib/engineCatalog";
import type { PostOpId } from "../../lib/postChain";

export default function RenderSettingsDemo() {
  const q = new URLSearchParams(window.location.search);
  // `?format=prores` lands straight on the shape-changing case; `?clips=` and
  // `?overrides=` move the post card's "N of M" without needing a real cut.
  const format = q.get("format") ?? "h264";
  const nClips = Number(q.get("clips") ?? 12);
  // `?w=1080&h=1920` is the case the short-edge rule exists for: on a vertical
  // cut "1080p" has to mean 1080 WIDE, and scaling by height instead would
  // deliver a 1920-wide portrait frame — four times the pixels nobody asked
  // for. Only a picture shows that the label still reads correctly.
  const tlW = Number(q.get("w") ?? 1280);
  const tlH = Number(q.get("h") ?? 704);
  const nOverrides = Number(q.get("overrides") ?? 3);

  const [last, setLast] = useState<string>("");
  const [open, setOpen] = useState(true);

  // THE MACHINE, STATED. `renderPlaceFacts` asks a Tauri bridge, an engine and
  // a ComfyUI, none of which exist here — and the states worth looking at are
  // ones this reviewer's own laptop cannot be put into anyway.
  const where = q.get("where") ?? "admin";
  const placeFacts: RenderFacts = {
    // `?where=web` is the WEB build seen from inside the desktop harness —
    // the harness itself refuses to mount without a mocked bridge, so the one
    // state it cannot reach by its own URL is stated here instead. What it
    // buys is the claim that the card is absent rather than disabled there.
    desktop: where !== "web",
    planner: where !== "noengine" && where !== "nowhere",
    ffmpeg: where !== "noffmpeg",
    engineUp: where !== "enginedown",
    // Set by the modal from the chain it resolved, not by this — but the
    // harness has to state something, and `?post=upscale` is what makes the
    // engine a precondition either way.
    needsEngine: (q.get("post") ?? "grain").includes("upscale"),
    // WHAT THIS MACHINE IS MISSING FOR THE CHAIN. Computed from the real
    // requirement table against a stated inventory, so the list, the sizes and
    // the download-vs-cannot-run split are the ones a real machine would
    // produce rather than a hand-written fixture.
    //   ?where=nomodels   nothing downloaded
    //   ?where=nonodes    the weights are there and the node packs are not
    postGaps: where === "nomodels" || where === "nonodes"
      ? postLocalGaps(
          [...new Set((q.get("post") ?? "grain").split(",").filter(Boolean))] as PostOpId[],
          normalizePostOptions({}),
          {
            files: where === "nonodes"
              ? new Set(POST_PROCESS.flatMap((t) => t.files.map((f) => f.filename)))
              : new Set<string>(),
            // The classes an engine installed BEFORE the finishing-chain packs
            // were added reports. Two states in one: a machine that has not
            // been reinstalled since (KJNodes and the H3 tracker are added
            // now), and Face Detailer, which stays absent on ANY of our
            // engines because that pass is retired and Impact is deliberately
            // not installed.
            nodes: new Set(["SeedVR2Preprocess", "SeedVR2Conditioning",
                            "SeedVR2PostProcessing", "LTXVConcatAVLatent",
                            "LTXVAudioVAEEncode", "FrameInterpolationModelLoader",
                            "FrameInterpolate"]),
            // Every key the requirement table can ask for, because `krea2`
            // ABSENT and `krea2` not-downloaded are different screens — one is
            // "this build cannot download it" and the other is a Get button —
            // and the desktop map carries all three now.
            models: new Map([
              ["ltx-25", { ready: where === "nonodes",
                           missing: where === "nonodes" ? [] : ["ltx-2.5-dit.safetensors", "x", "y"] }],
              ["krea2", { ready: where === "nonodes",
                          missing: where === "nonodes" ? [] : ["krea2_turbo_fp8_scaled.safetensors", "e"] }],
              ["minimax-h3", { ready: true, missing: [] }],
            ]),
          })
      : [],
  };

  // A plausible cut: most clips inherit, a few carry their own chain, and one
  // of those has turned everything off — which is the `{}` case that must not
  // read as "inherit".
  const clips = Array.from({ length: nClips }, (_, i) => ({
    id: `clip-${i}`,
    post: i < nOverrides ? (i === 0 ? {} : { upscale: true, grain: true }) : null,
  }));

  // `?post=color_match,grain` reaches the state that matters most here: Color
  // Match is the one pass that is UNSATISFIABLE without a further setting, so
  // "the picker appears, and Render is blocked until it is filled" is the
  // claim worth being able to look at. `?ref=1` fakes one already chosen.
  const projectChain: PostChain = Object.fromEntries(
    (q.get("post") ?? "grain").split(",").filter(Boolean).map((k) => [k, true]),
  ) as PostChain;
  const output: RenderOutput = normalizeOutput({ format });

  return (
    <div style={{ position: "fixed", inset: 0, background: "#07090e" }}>
      {!open && (
        <div style={{ position: "absolute", top: 20, left: 20, display: "flex",
                      flexDirection: "column", gap: 10 }}>
          <button className="ws-primary" onClick={() => { setOpen(true); setLast(""); }}>
            Reopen
          </button>
          <pre className="ws-mono" style={{ fontSize: 11, color: "#9aa4b6" }}>{last}</pre>
        </div>
      )}
      {open && (
        <RenderSettingsModal
          timeline={{ width: tlW, height: tlH, fps: 24, duration_ms: 80_500 }}
          clips={clips}
          output={output}
          projectChain={projectChain}
          postRefAssetId={q.get("ref") ? "00000000-0000-0000-0000-000000000001" : null}
          postRefMode={q.get("mode") === "asset" || q.get("ref") ? "asset" : "source"}
          postRefStrength={q.get("strength") ? Number(q.get("strength")) : undefined}
          // `?size=fit&sigmas=faithful&cfg=1.5&sv2=7b&canvas=1024&faced=0.6`
          // opens on a tuned project rather than on the defaults.
          postOptions={normalizePostOptions({
            post_refine_size: q.get("size"), post_refine_sigmas: q.get("sigmas"),
            post_refine_cfg: q.get("cfg"), post_upscale_model: q.get("sv2"),
            post_h3face_canvas: q.get("canvas"), post_h3face_denoise: q.get("faced"),
            // `?grade=vcg` reaches the grade row, which only appears with
            // `?post=color_match` — the pass has to be ON for its tuning to show.
            post_grade_method: q.get("grade"),
          })}
          projectId={null}
          placeFacts={placeFacts}
          onRender={(o, chain, ref, mode, opts, strength) => {
            setLast(JSON.stringify(
              { output: o, chain, ref, mode, opts, strength }, null, 2));
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
