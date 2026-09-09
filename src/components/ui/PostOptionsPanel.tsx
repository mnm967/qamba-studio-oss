// How the two GENERATIVE post passes are tuned — the refine's size, schedule
// and guidance, and which SeedVR2 checkpoint the restore loads.
//
// It exists because both passes shipped with their interesting decisions
// hard-coded. The refine could sample at the take's own size or at a fixed 2x
// and nothing else, so "refine at the size this cut delivers" — the one that
// costs the same and survives the chain's 1080 cap — was unsayable; its sigma
// schedule was two constants picked by a boolean; and `apply_upscale` has
// always taken a `model=`, with nothing in the app able to pass one, so
// fetching SeedVR2 7B onto the pod would have changed nothing.
//
// SHOWN ONLY FOR PASSES THAT ARE ON, which is this codebase's standing rule:
// a control that cannot reach the render is worse than no control. Turning the
// refine off hides its rows rather than leaving three settings that do nothing.
//
// SHARED, for PostChainToggles' reason: two surfaces edit the project default
// and a setting you can change in one but not the other is the same gap one
// level in.
import React from "react";
import {
  GRADE_METHODS, H3_FACE_CANVASES, H3_FACE_DENOISE_MAX, H3_FACE_DENOISE_MIN,
  REFINE_CFG_MAX, REFINE_CFG_MIN, REFINE_SIGMA_PRESETS, REFINE_SIZES,
  UPSCALE_MODELS, tunableOps,
  type PostChain, type PostOptions,
} from "../../lib/postChain";

function Row({ label, hint, showHint, children }: {
  label: string; hint?: string; showHint?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="pox-row">
      <span className="pox-label">{label}</span>
      <div className="pox-pills">{children}</div>
      {showHint && hint && <span className="prf-sub">{hint}</span>}
    </div>
  );
}

export default function PostOptionsPanel({ chain, value, onChange, disabled, showHints = false }: {
  chain: PostChain;
  value: PostOptions;
  onChange: (patch: Partial<PostOptions>) => void;
  disabled?: boolean;
  showHints?: boolean;
}) {
  const tunable = tunableOps(chain);
  if (!tunable.size) return null;

  const size = REFINE_SIZES.find((s) => s.id === value.post_refine_size);
  const sig = REFINE_SIGMA_PRESETS.find((s) => s.id === value.post_refine_sigmas);
  const model = UPSCALE_MODELS.find((m) => m.id === value.post_upscale_model);
  const cfg = value.post_refine_cfg;
  const canvas = H3_FACE_CANVASES.find((c) => c.id === value.post_h3face_canvas);
  const faceD = value.post_h3face_denoise;
  const grade = GRADE_METHODS.find((m) => m.id === value.post_grade_method);

  return (
    <div className="pox">
      {tunable.has("upscale") && (
        <Row label="Restore checkpoint" hint={model?.hint} showHint={showHints}>
          {UPSCALE_MODELS.map((m) => (
            <button key={m.id} className="ws-microbtn" type="button"
                    data-on={m.id === value.post_upscale_model ? "1" : undefined}
                    disabled={disabled} title={m.hint}
                    onClick={() => onChange({ post_upscale_model: m.id })}>
              {m.label.replace("SeedVR2 ", "")}
            </button>
          ))}
        </Row>
      )}

      {tunable.has("ltx_refine") && (
        <>
          <Row label="Refine at" hint={size?.hint} showHint={showHints}>
            {REFINE_SIZES.map((s) => (
              <button key={s.id} className="ws-microbtn" type="button"
                      data-on={s.id === value.post_refine_size ? "1" : undefined}
                      disabled={disabled} title={s.hint}
                      onClick={() => onChange({ post_refine_size: s.id })}>
                {s.label}
              </button>
            ))}
          </Row>

          <Row label="How far it travels" hint={sig?.hint} showHint={showHints}>
            {REFINE_SIGMA_PRESETS.map((s) => (
              <button key={s.id || "auto"} className="ws-microbtn" type="button"
                      data-on={s.id === value.post_refine_sigmas ? "1" : undefined}
                      disabled={disabled} title={s.hint}
                      onClick={() => onChange({ post_refine_sigmas: s.id })}>
                {s.label}
              </button>
            ))}
          </Row>

          {/* The one control that costs real time rather than trading quality
              for it, so it says so instead of leaving it to be discovered from
              a render's clock. LTX's dual-CFG guider collapses to single-CFG
              while the two scales are equal, and at 1.0 ComfyUI skips the
              uncond pass entirely — which is why the LTX rows declare no
              negative prompt. Moving this one alone makes them DISAGREE: a
              real uncond pass runs, so the sampler holds harder to the take it
              was given and each step costs about twice as much. */}
          <div className="pox-row">
            <span className="pox-label">
              Hold to the original
              <b className="mono pox-num">{cfg.toFixed(1)}</b>
            </span>
            <input type="range" min={REFINE_CFG_MIN} max={REFINE_CFG_MAX} step={0.1}
                   value={cfg} disabled={disabled}
                   onChange={(e) => onChange({ post_refine_cfg: Number(e.target.value) })} />
            {showHints && (
              <span className="prf-sub">
                {cfg <= 1.001
                  ? "1.0 is the distilled recipe: no guidance pass, so the refine is "
                    + "free to drift a little and each step is as cheap as it gets."
                  : "Above 1.0 the refine runs a real guidance pass — it holds harder "
                    + "to the take's faces and wardrobe, and costs roughly twice as "
                    + "much per step. Past about 2.0 it tends to buy contrast rather "
                    + "than detail. Try it on a short clip first."}
              </span>
            )}
          </div>
        </>
      )}

      {tunable.has("h3_facefix") && (
        <>
          <Row label="Face canvas" hint={canvas?.hint} showHint={showHints}>
            {H3_FACE_CANVASES.map((c) => (
              <button key={c.id} className="ws-microbtn" type="button"
                      data-on={c.id === value.post_h3face_canvas ? "1" : undefined}
                      disabled={disabled} title={c.hint}
                      onClick={() => onChange({ post_h3face_canvas: c.id })}>
                {c.label}
              </button>
            ))}
          </Row>

          {/* NOT the detailer's number of the same name, and the panel says so
              rather than leaving it to be discovered from a rewritten face.
              H3 is flow matching with a sigma shift of 12, so the pack's own
              README puts an ordinary detailer's 0.25 at an effective sigma of
              0.800 — deep into rewriting territory. 0.4 is its author's base. */}
          <div className="pox-row">
            <span className="pox-label">
              Face denoise
              <b className="mono pox-num">{faceD.toFixed(2)}</b>
            </span>
            <input type="range" min={H3_FACE_DENOISE_MIN} max={H3_FACE_DENOISE_MAX}
                   step={0.05} value={faceD} disabled={disabled}
                   onChange={(e) => onChange({ post_h3face_denoise: Number(e.target.value) })} />
            {showHints && (
              <span className="prf-sub">
                {faceD <= 0.45
                  ? "Restores the face that is there. 0.40 is the pack author's own "
                    + "base — H3's sigma shift makes these numbers travel much "
                    + "further than the same value on the detailer above."
                  : "Above ~0.45 H3 stops restoring the face and starts inventing "
                    + "one. Reach for it only where the face is genuinely broken, "
                    + "and check identity survived."}
              </span>
            )}
          </div>
        </>
      )}

      {/* Which transfer, not which reference — the reference is PostRefPicker's,
          one panel up. Last, because the mastering canon puts the grade after
          the faces and the only pass after it takes no options. */}
      {tunable.has("color_match") && (
        <Row label="Grade transfer" hint={grade?.hint} showHint={showHints}>
          {GRADE_METHODS.map((m) => (
            <button key={m.id} className="ws-microbtn" type="button"
                    data-on={m.id === value.post_grade_method ? "1" : undefined}
                    disabled={disabled} title={m.hint}
                    onClick={() => onChange({ post_grade_method: m.id })}>
              {m.label}
            </button>
          ))}
        </Row>
      )}
    </div>
  );
}
