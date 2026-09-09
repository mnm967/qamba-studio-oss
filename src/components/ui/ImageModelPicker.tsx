// One image-model picker, shared by every surface that spends GPU time on a
// still. Defaults come from the project; the choice is per-generation.
//
// It also warns when the pick cannot do the job asked of it: image_gen swaps a
// reference-incapable model for one that can take references, which is correct
// (anchors beat preference) but reads as the app ignoring your setting unless
// it is said out loud beforehand.
//
// LoRAs ride along here because they are a property of the model, not of the
// prompt: the catalog row lists which keys a model has installed
// (capabilities.styleLoras), the worker maps each key to a file through
// model_map's style_loras. Filenames never reach the browser.
//
// They are a STACK. One slot was wrong for how these models are actually used —
// a checkpoint's companion LoRA plus a concept LoRA plus a style LoRA is the
// ordinary case, and picking a second silently replaced the first. Each entry
// carries its own strength, because that is the only control you have over how
// two adapters share a model.
import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Plus, X } from "lucide-react";
import Dropdown from "./Dropdown";
import TieredModelMenu, { type Quality } from "./TieredModelMenu";
import type { LoraPick } from "../../lib/projectSettings";
import type { ModelCatalogRow } from "../../lib/db/types";

export const refCapacity = (m: ModelCatalogRow | null | undefined) => {
  const c = (m?.capabilities ?? {}) as { refs?: number; multiRef?: number };
  return Number(c.refs ?? c.multiRef ?? 0);
};

/** How many adapters this model will accept at once. Stacking is cheap in VRAM
 *  but not free in coherence, so the catalog gets to set a ceiling. */
export const loraCapacity = (m: ModelCatalogRow | null | undefined) =>
  Number((m?.capabilities as { maxLoras?: number } | undefined)?.maxLoras ?? 3);

/** Does this model actually EVALUATE a negative prompt?
 *
 *  Almost nothing local here does, which is why the control is gated rather
 *  than always shown: every Krea 2 entry is distilled at cfg 1.0, where the
 *  negative branch is never evaluated and the builder feeds a
 *  ConditioningZeroOut; H3 samples through BasicGuider and has no negative
 *  branch at all; the flow models have none either. Anima is the exception —
 *  30-odd steps at cfg 4, so a second CLIPTextEncode is genuinely sampled
 *  against. Offering the field on anything else would be a control that
 *  provably cannot change the picture. */
export const takesNegative = (m: ModelCatalogRow | null | undefined) =>
  Boolean((m?.capabilities as { negativePrompt?: unknown } | undefined)?.negativePrompt);

/** What the worker applies when the field is left EMPTY — model_map's own
 *  `negative` for this entry.
 *
 *  The browser cannot read model_map (`local_files` is withheld from
 *  non-admins), so the catalog carries a copy of the string for display only.
 *  It exists so the placeholder can tell the truth: an empty box is not "no
 *  negative prompt", it is this one. Absent → say nothing rather than imply
 *  the render goes out clean. */
export const defaultNegative = (m: ModelCatalogRow | null | undefined): string => {
  const v = (m?.capabilities as { defaultNegative?: unknown } | undefined)?.defaultNegative;
  return typeof v === "string" ? v : "";
};

/** Can this model render a SECOND, higher-resolution refinement pass?
 *
 *  Same gating rule as `takesNegative`: the control appears only where it can
 *  change the render. Derived from model_map's own `refine` recipe by
 *  `scripts/gen_model_catalog.py`, never hand-written per row — `resolve()`
 *  RAISES on a model with no recipe, so a toggle offered anywhere else is a
 *  button that fails the job.
 *
 *  It is deliberately not a model of its own. Refinement is orthogonal to
 *  checkpoint, style and step-distillation alike, so a twin of each H3 row is
 *  twelve near-identical picker entries — the same explosion `styleLoras`
 *  exists to avoid. Same shape as `motion_ctx`: a render parameter carried on
 *  the block. */
export const takesRefine = (m: ModelCatalogRow | null | undefined) =>
  Boolean((m?.capabilities as { refine?: unknown } | undefined)?.refine);

export type LoraDef = {
  key: string; label: string; hint?: string; trigger?: string;
  /** where the slider starts for this adapter — not every LoRA wants 1.0.
   *  Lenovo UltraReal's own range on a turbo checkpoint is 1.2-2.0. */
  strength?: number;
  /** Set when some of this adapter's tensors cannot be applied to the model and
   *  ComfyUI skips them. It still works — the rest of the LoRA loads — but the
   *  render logs a wall of `ERROR lora …` that reads like a failed job, and
   *  worse, it buries a real one. Saying so on the row is the difference
   *  between "expected" and "something is broken". */
  partial?: string;
};

/** Ceiling of the strength slider. 1.4 was too low to express what some LoRAs
 *  are documented to need; 2.0 covers every adapter shipped here. */
const MAX_STRENGTH = 2;

/** Copy for keys whose catalog row predates the object form. Unknown keys fall
 *  back to the key itself, so adding one to model_map + the catalog needs no
 *  frontend change. */
const LORA_COPY: Record<string, { label: string; hint: string }> = {
  shinkai: { label: "Shinkai", hint: "Makoto Shinkai colour, light and cloud rendering." },
};

export const styleLoras = (m: ModelCatalogRow | null | undefined): LoraDef[] => {
  const raw = (m?.capabilities as { styleLoras?: unknown } | undefined)?.styleLoras;
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => {
    const o = (typeof v === "object" && v ? v : {}) as
      { key?: string; label?: string; hint?: string; trigger?: string;
        strength?: number; partial?: string };
    const key = typeof v === "string" ? v : String(o.key ?? "");
    if (!key) return null;
    const copy = LORA_COPY[key];
    return {
      key,
      label: o.label || copy?.label || key,
      hint: o.hint || copy?.hint,
      trigger: o.trigger,
      strength: typeof o.strength === "number" ? o.strength : undefined,
      partial: o.partial,
    };
  }).filter(Boolean) as LoraDef[];
};

/** Drop any pick the model doesn't declare — switching models must not carry a
 *  LoRA that isn't installed for the new one into the job payload. */
export const validLoras = (m: ModelCatalogRow | null | undefined, picks: LoraPick[]): LoraPick[] => {
  const have = new Set(styleLoras(m).map((l) => l.key));
  return (picks ?? []).filter((p) => have.has(p.key)).slice(0, loraCapacity(m));
};

/** The LoRA stack editor on its own — settings panels want it without a model
 *  dropdown above it. */
export function LoraStack({
  model, value, onChange, compact = false,
}: {
  model: ModelCatalogRow | null | undefined;
  value: LoraPick[];
  onChange: (v: LoraPick[]) => void;
  compact?: boolean;
}) {
  const available = styleLoras(model);
  const max = loraCapacity(model);
  const picks = value ?? [];

  // Backstop for callers that keep the picker mounted (the bible/scene modals
  // render it inline): drop picks the newly chosen model doesn't have. Callers
  // whose picker lives inside a menu must prune at the model change themselves
  // — this effect cannot run while the menu is shut. Either way `validLoras`
  // runs again at submit, so an invalid key can never reach a job payload.
  const lastModel = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = model?.id ?? null;
    const prev = lastModel.current;
    lastModel.current = id;
    if (prev === undefined || prev === id) return;   // first render / no change
    const kept = validLoras(model, picks);
    if (kept.length !== picks.length) onChange(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.id]);

  if (!available.length) return null;
  const byKey = new Map(available.map((l) => [l.key, l]));
  const unused = available.filter((l) => !picks.some((p) => p.key === l.key));

  const set = (key: string, patch: Partial<LoraPick>) =>
    onChange(picks.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span className="mono" style={{ fontSize: 10, letterSpacing: ".1em",
                                        textTransform: "uppercase", color: "#5e6678" }}>
          LoRAs
        </span>
        <span className="mono" style={{ fontSize: 10, color: "#5e6678" }}>
          {picks.length}/{max}
        </span>
        <span style={{ flex: 1 }} />
        {picks.length > 0 && (
          <button type="button" className="ws-microbtn ghost" onClick={() => onChange([])}
                  style={{ height: 20, fontSize: 10, padding: "0 7px" }}>
            clear
          </button>
        )}
      </div>

      {picks.map((p) => {
        const def = byKey.get(p.key);
        return (
          <div key={p.key} className="ws-lorarow">
            <span className="k" title={def?.hint}>{def?.label ?? p.key}</span>
            <input type="range" min={0.1} max={MAX_STRENGTH} step={0.05} value={p.strength}
                   title={`${def?.label ?? p.key} strength`}
                   onChange={(e) => set(p.key, { strength: +e.target.value })} />
            <span className="mono v">{p.strength.toFixed(2)}</span>
            <button type="button" className="ws-microbtn sq" title="Remove this LoRA"
                    onClick={() => onChange(picks.filter((x) => x.key !== p.key))}>
              <X size={10} />
            </button>
          </div>
        );
      })}

      {unused.length > 0 && picks.length < max && (
        <Dropdown width={286}
          trigger={({ toggle }) => (
            <button type="button" className="ws-microbtn" onClick={toggle}
                    style={{ width: "100%", justifyContent: "center", gap: 6,
                             height: compact ? 24 : 26, fontSize: 11 }}>
              <Plus size={11} />add a LoRA
            </button>
          )}>
          {(close) => (
            <>
              <div className="ws-menu-label">Installed for {model?.display_name ?? "this model"}</div>
              {unused.map((l) => (
                // title carries the untruncated guidance — the row clamps it to
                // two lines so a twelve-adapter list stays scannable.
                <button type="button" key={l.key} className="ws-menu-row ws-lorapick"
                        title={[l.hint, l.partial && `Partial: ${l.partial}`]
                          .filter(Boolean).join("\n\n") || l.label}
                        onClick={() => {
                          close();
                          onChange([...picks, { key: l.key, strength: l.strength ?? 1 }]);
                        }}>
                  <span className="top">
                    <span className="nm">{l.label}</span>
                    {/* a non-default starting strength is a decision the author
                        made for you (UltraReal's 1.2 on turbo); say so up front
                        rather than leaving it to be discovered on the slider */}
                    {l.strength != null && l.strength !== 1 && (
                      <span className="str">×{l.strength}</span>
                    )}
                    {l.trigger && <span className="trig">{l.trigger}</span>}
                    {/* the render will log `ERROR lora …` and still succeed —
                        without this the log reads like a broken job */}
                    {l.partial && <span className="part">partial</span>}
                  </span>
                  {l.hint && <span className="hint">{l.hint}</span>}
                </button>
              ))}
            </>
          )}
        </Dropdown>
      )}

      {picks.some((p) => byKey.get(p.key)?.trigger) && (
        <div className="mono" style={{ fontSize: 10, lineHeight: 1.5, color: "#5e6678" }}>
          Trigger word{picks.filter((p) => byKey.get(p.key)?.trigger).length === 1 ? "" : "s"}{" "}
          {picks.map((p) => byKey.get(p.key)?.trigger).filter(Boolean).join(", ")}{" "}
          — the worker prepends {picks.filter((p) => byKey.get(p.key)?.trigger).length === 1 ? "it" : "them"} if your prompt doesn't.
        </div>
      )}
    </div>
  );
}

export default function ImageModelPicker({
  models, value, onPick, withRefs = false, width = 330, compact = false,
  loras, onLoras, quality, onQuality,
}: {
  models: ModelCatalogRow[];
  value: string | null;
  onPick: (id: string) => void;
  /** true when this generation will carry reference images */
  withRefs?: boolean;
  width?: number;
  compact?: boolean;
  /** the LoRA stack for this generation. Omit onLoras to hide the control. */
  loras?: LoraPick[];
  onLoras?: (v: LoraPick[]) => void;
  /** Render quality, for the hosted rows that expose one. Omit onQuality to
   *  hide the control — the knob only exists where it changes the render. */
  quality?: Quality | null;
  onQuality?: (q: Quality) => void;
}) {
  const model = models.find((m) => m.id === value) ?? null;
  const substitutes = withRefs && refCapacity(model) === 0 && models.some((m) => refCapacity(m) > 0);
  const picks = loras ?? [];
  const [why, setWhy] = useState(false);

  return (
    <>
      <Dropdown width={width}
        trigger={({ toggle }) => (
          <button type="button" className="ws-ghost" onClick={toggle} title="Image model for this generation"
                  style={{ height: compact ? 30 : 36, width: "100%",
                           justifyContent: "space-between", padding: "0 11px",
                           fontSize: compact ? 11.5 : undefined }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {model?.display_name ?? value ?? "…"}
              {picks.length > 0 && (
                <span className="mono" style={{ color: "#c97aff" }}> · {picks.length} LoRA{picks.length === 1 ? "" : "s"}</span>
              )}
            </span>
            <ChevronDown size={12} style={{ flex: "none" }} />
          </button>
        )}>
        {(close) => (
          <>
            {/* Grouped by where it runs — the same menu the library uses, so
                a hosted row reads as hosted on every surface. */}
            <TieredModelMenu models={models} value={value} close={close} onPick={onPick}
                             quality={quality} onQuality={onQuality} />
            <div className="ws-menu-empty" style={{ fontSize: 10.5 }}>
              Default comes from Style &amp; models; picking here is for this shot only.
            </div>
          </>
        )}
      </Dropdown>

      {onLoras && <LoraStack model={model} value={picks} onChange={onLoras} compact={compact} />}

      {/* One line, with the reasoning on demand: the paragraph this replaces
          said the same thing on every render of every picker, so it stopped
          being read long before it stopped being true. */}
      {substitutes && (
        <div className="ws-warnline" style={{ marginTop: 5 }}>
          <AlertTriangle size={13} />
          <p>
            {model?.display_name} can't take references — running on a model that can.
            {why && (
              <span className="why">
                Keeping the identity anchor matters more than the model.
                {picks.length > 0 && " The LoRAs are on the model you picked, so they go with it."}
              </span>
            )}
          </p>
          <button type="button" onClick={() => setWhy((v) => !v)}>{why ? "less" : "why"}</button>
        </div>
      )}
    </>
  );
}
