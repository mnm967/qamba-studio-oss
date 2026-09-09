// The grade reference the Color Match pass matches every clip to.
//
// It exists because the pass shipped without it: `settings.post_ref_asset_id`
// was read by the worker, named in the toggle's own tooltip, and written by
// nothing at all — so Color Match was a switch whose only possible outcome was
// a failed render. That is the exact shape this codebase keeps naming, and a
// tooltip pointing at a setting with no control is the worst version of it,
// because it reads like the user missed something.
//
// TWO MODES NOW, and "source" is the default because the other one was
// measured doing harm: with one project-wide still, every scene in a real cut
// was distribution-matched onto that still's histogram — a bright shot pulled
// down 24 luma points, a dark forest lifted 13, saturation -29% — which the
// user reported as "washed out compared to the timeline, and I gave it a
// color match ref". In source mode the worker matches each clip back to a
// frame of ITS OWN take, so the pass restores the look the editor showed
// after the generative passes (SeedVR2, LTX) move it. "Asset" survives for
// deliberately unifying a cut's grade on one still.
//
// SHARED, for the reason PostChainToggles is shared: two surfaces edit the
// project default (the context panel and the render settings modal), and a
// reference you can set in one but not the other is the same gap one level in.
//
// ONE FRAME, NOT A CLIP. mkl / hm / reinhard / mvgd are global colour-transfer
// algorithms: they fit this clip's colour distribution onto the reference's,
// and one representative frame IS that distribution. A video is allowed and
// the worker samples its MIDDLE — frame 0 of a shot is routinely a fade, and
// matching a cut to black is not a grade.
import React, { useEffect, useState } from "react";
import { ImageOff, Palette, X } from "lucide-react";
import AssetPickerModal from "../modals/AssetPickerModal";
import { mediaUrl, supabase } from "../../lib/supabase";
import { isStill } from "../../lib/assetKind";
import type { Asset } from "../../lib/db/types";

export type GradeMode = "source" | "asset";

/** How hard the grade is applied. The worker has read
 *  `settings.post_ref_strength` since the pass shipped and NOTHING EVER WROTE
 *  IT — the same shape as the reference above, one field along — so every
 *  grade this studio has ever rendered ran at 1.0.
 *
 *  1.0 is what those renders did, so it stays the default and nothing changes
 *  for a project that leaves it alone. Below it is the useful direction, and
 *  the reason is measured: at full strength a transfer lands the shot ON the
 *  reference's distribution, so against a warm reference a daylight exterior
 *  becomes a sunset and a face becomes orange.
 *
 *  0..1 and not the nodes' own ceilings (ColorMatch takes 10, the VCG LUT
 *  takes 2, both extrapolating past the reference). Every failure measured on
 *  this footage is a transfer being too STRONG; the worker clamps to 1.0 too,
 *  so widening it is a change on both sides and wants a measurement first. */
export const GRADE_STRENGTH_MIN = 0;
export const GRADE_STRENGTH_MAX = 1;
export const GRADE_STRENGTH_DEFAULT = 1;

export default function PostRefPicker({ projectId, value, onChange, mode, onMode,
                                        strength, onStrength, disabled }: {
  projectId: string | null;
  /** assets.id, or null for "not set" — in asset mode that makes the pass fail. */
  value: string | null;
  onChange: (id: string | null) => void;
  /** projects.settings.post_ref_mode — what Color Match matches TO. */
  mode: GradeMode;
  onMode: (m: GradeMode) => void;
  /** projects.settings.post_ref_strength, 0..1. See GRADE_STRENGTH_*. */
  strength: number;
  onStrength: (v: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [asset, setAsset] = useState<Asset | null>(null);
  // `undefined` = still looking, `null` = looked and it is gone. The two have
  // to read differently: a reference whose asset was deleted or binned is a
  // render that will fail, and showing it as an empty slot while the id is
  // still stored would hide that.
  const [missing, setMissing] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let live = true;
    if (!value || mode !== "asset") { setAsset(null); setMissing(undefined); return; }
    void (async () => {
      const { data } = await supabase.from("assets")
        .select("*").eq("id", value).is("deleted_at", null).maybeSingle();
      if (!live) return;
      setAsset((data as Asset) ?? null);
      setMissing(!data);
    })();
    return () => { live = false; };
  }, [value, mode]);

  const src = asset ? mediaUrl(asset.b2_key) : null;

  return (
    <div className="prf">
      <div className="prf-modes" role="radiogroup" aria-label="Grade reference mode">
        <button className="ws-microbtn" data-on={mode === "source" ? "1" : undefined}
                disabled={disabled} onClick={() => onMode("source")}>
          Each shot&apos;s own take
        </button>
        <button className="ws-microbtn" data-on={mode === "asset" ? "1" : undefined}
                disabled={disabled} onClick={() => onMode("asset")}>
          One still for the whole cut
        </button>
      </div>

      {mode === "source" ? (
        <span className="prf-sub">
          Every clip is matched back to a frame of its own take, so the render
          keeps the grade the timeline shows — the generative passes can no
          longer wash it out. Nothing to pick.
        </span>
      ) : (
        <div className="prf-row">
          <div className="prf-slot" data-empty={value ? undefined : "1"}>
            {src && (isStill(asset!) ? (
              <img src={src} alt="" />
            ) : (
              // Muted and preload-metadata: this is a thumbnail of a frame, not a
              // player, and the timeline already has enough decoders on it.
              <video src={src} muted preload="metadata" />
            ))}
            {!src && (
              <span className="prf-ph">
                {missing ? <ImageOff size={15} /> : <Palette size={15} />}
              </span>
            )}
          </div>

          <div className="prf-body">
            <span className="prf-name">
              {missing ? "Reference is missing"
                : asset ? (asset.b2_key.split("/").pop() ?? "Reference")
                : "No reference set"}
            </span>
            <span className="prf-sub">
              {missing
                ? "The asset it pointed at was deleted or binned — pick another, or the render fails."
                : asset
                  ? (isStill(asset) ? "Still — used as-is. Every scene is pulled toward this frame's colour, so pick one that already looks like the film."
                                    : "Video — the worker samples its middle frame. Every scene is pulled toward it.")
                  : "Color Match needs one in this mode. Pick the shot whose grade the rest should follow."}
            </span>
            <div className="prf-actions">
              <button className="ws-microbtn" disabled={disabled} onClick={() => setOpen(true)}>
                {value ? "Change" : "Choose reference"}
              </button>
              {value && (
                <button className="ws-microbtn" disabled={disabled}
                        onClick={() => onChange(null)}>
                  <X size={11} /> Clear
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* THE STRENGTH DRIVES EVERY TRANSFER, the learned LUT included — they
          all lerp between the clip's own picture and the fully graded one, so
          one control is right and a second per method would be two names for
          one number. Shown here rather than with the transfer pills because it
          belongs to the grade (mode / reference / strength), not to the choice
          of algorithm. */}
      <div className="pox-row">
        <span className="pox-label">
          Grade strength
          <b className="mono pox-num">{strength.toFixed(2)}</b>
        </span>
        <input type="range" min={GRADE_STRENGTH_MIN} max={GRADE_STRENGTH_MAX}
               step={0.05} value={strength} disabled={disabled}
               onChange={(e) => onStrength(Number(e.target.value))} />
        <span className="prf-sub">
          {strength >= 0.999
            ? "Full match — the shot lands ON the reference's colour. Measured: "
              + "against a warm reference that turns a daylight exterior into a "
              + "sunset and a face orange. Pull it down if the grade is louder "
              + "than the shot."
            : strength <= 0.001
              ? "Off. The clip renders ungraded — turn the pass off instead if "
                + "that is what you want, so the render skips the work."
              : "Part way. The shot keeps its own look and takes the "
                + "reference's direction, which is usually what a grade means."}
        </span>
      </div>

      {open && (
        <AssetPickerModal
          projectId={projectId}
          title="Grade reference"
          context="One frame. Every clip with Color Match on is matched to its colour."
          // Video allowed as well as stills: the shot you want to match to is
          // usually a take, and asking someone to export a frame first is a
          // step the worker can do itself.
          kindFilter="all"
          onPick={(picks) => {
            if (picks[0]) onChange(picks[0].asset.id);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
