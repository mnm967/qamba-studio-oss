// The Creative Director panel's CHROME — the two regions around the message
// stream, per `design_handoff_director_chat_panel/`.
//
// The organising rule of that handoff, and the reason these are worth naming:
// **render-model choices (video, image) live at the top; the LLM that answers
// the message lives at the bottom, next to the message.** Before it, all three
// pickers sat in two bars under the title and nothing said which of them
// decided what — the director's own model was a chip on the same row as the
// video checkpoint.
//
// Presentational on purpose. Every piece takes plain data and a callback, so
// the dock composes them with live rows and `/ui/director` composes the same
// components with fixtures — the alternative is a second copy of the design in
// the harness, which is the thing that drifts. None of them reads a store, a
// query or a ref.
//
// Icons: the handoff names Phosphor. This app has no Phosphor package and
// every other surface in it is lucide, so these are lucide's equivalents at the
// handoff's sizes — one panel in a different icon family is a worse
// inconsistency than a slightly different check mark. Type SIZES are the
// handoff's; the FAMILIES stay the app's (Space Grotesk / JetBrains Mono),
// since "recreate this in the target codebase's existing environment" is the
// handoff's own instruction and its Inter/system-mono are the prototype's.
import React from "react";
import { ChevronDown, Image as ImageIcon, RotateCcw, Sparkles, Video, X } from "lucide-react";
import { TierIcon } from "../ui/TieredModelMenu";
import type { ModelTier } from "../../lib/localModels";

/** A 30x30 square icon button — new session, history, collapse. */
export function DockIconBtn({
  title, onClick, disabled, children,
}: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className="ws-dock-ico" title={title}
            aria-label={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/** One of the two render-model chips in the header.
 *
 *  The leading icon's colour is the FAMILY's identity colour and is
 *  load-bearing — it is what distinguishes the two chips at a glance, since
 *  both routinely carry the same value ("H3 · Turbo" on each). So the plane a
 *  pick runs on cannot ride there and gets its own mark beside the value.
 *
 *  That mark appears for `local` and `hosted` and NOT for `cloud`, which is
 *  deliberate rather than an omission: the pod is what nearly every pick is,
 *  and a badge on every chip is a badge nobody reads. What is worth
 *  interrupting for is the exception — this one renders on your laptop, or
 *  this one bills per image — and with the menu shut "Wan 2.2 · Q6_K" and a
 *  pod model are otherwise the same chip. */
export function ModelChip({
  kind, value, tier, onClick, title, disabled,
}: {
  kind: "video" | "image";
  value: string;
  tier?: ModelTier | null;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={`ws-mchip ${kind}`} title={title}
            disabled={disabled} onClick={onClick}>
      {kind === "video" ? <Video size={13} className="ic" /> : <ImageIcon size={13} className="ic" />}
      <span className="lb">{kind}</span>
      <span className="sp" />
      {tier && tier !== "cloud" && <TierIcon tier={tier} />}
      <span className="vl">{value}</span>
      <ChevronDown size={9} className="cr" />
    </button>
  );
}

/** The composer's director-LLM chip: which model answers THIS message.
 *
 *  `level` is the handoff's reasoning-level slot. No backend here exposes one,
 *  and the handoff says to hide it when a model has none — so the dock passes
 *  the backend's CONNECTION instead, which is the fact that slot has to carry
 *  in this app: two rows are both "Opus 5" and differ only by whether they run
 *  on the subscription or on an API key. */
export function LlmChip({
  model, level, onClick, title, disabled,
}: {
  model: string;
  level?: string | null;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="ws-llmchip" title={title}
            disabled={disabled} onClick={onClick}>
      <Sparkles size={13} className="ic" />
      <span className="nm">{model}</span>
      {level ? <span className="lv">{level}</span> : null}
      <ChevronDown size={9} className="cr" />
    </button>
  );
}

/** Blocks whose plan has moved on since they last rendered.
 *
 *  This replaces the earlier pattern of the director ASKING about stale blocks
 *  in chat and waiting for a typed reply — a question the panel can answer by
 *  looking at the block graph should not cost a turn. Hidden entirely at zero,
 *  so the composer sits against the stream in the ordinary case.
 *
 *  It is now the ONLY place outside the storyboard that mentions stale at all
 *  (see lib/staleBlocks for why), and it OPENS THE REVIEW rather than queueing.
 *  The old button queued every stale block on one click: `rerender_stale`
 *  refuses to fan out without a confirmation, and a bar that named none of the
 *  blocks it was about to spend GPU time on was not one — what is being
 *  confirmed has to be on screen, which takes more room than a bar has. */
export function StaleNotice({
  count, seconds, busy, onReview,
}: {
  count: number;
  seconds?: number | null;
  busy?: boolean;
  onReview?: () => void;
}) {
  if (count <= 0) return null;
  const secs = seconds != null && seconds > 0 ? ` · ~${Math.round(seconds)}s of footage` : "";
  return (
    <div className="ws-dock-notice" role="status">
      <span className="dot" />
      <span className="msg">
        {count} block{count === 1 ? " has" : "s have"} drifted from the plan.
      </span>
      <button type="button" className="act" disabled={busy}
              title={`Review ${count} stale block${count === 1 ? "" : "s"}${secs} and pick what to re-render`}
              onClick={onReview}>
        Review
      </button>
    </div>
  );
}

/**
 * A turn that failed, and the one button that gets it back.
 *
 * A failed turn used to be a red line and nothing else: the words were gone
 * from the composer, and on the commonest failure — a rate limit, which the
 * hosted handler reports as a stream EVENT rather than an HTTP error — the
 * attachments were cleared too, so a picture somebody had dragged in had to
 * be found and dragged in again. `onRetry` is offered only while the turn is
 * still held (DirectorDock's `pendingRef`); a failure with nothing to re-run
 * is a message alone.
 */
export function ErrorRow({
  message, onRetry, busy,
}: {
  message: string;
  onRetry?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="ws-tool-row">
      <X size={12} style={{ color: "#ff8080", flex: "none" }} />
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      {onRetry && (
        <button type="button" className="ws-msg-act" disabled={busy}
                title="Run that turn again — the same words, pictures and screen"
                onClick={onRetry}>
          <RotateCcw size={11} /> Retry
        </button>
      )}
    </div>
  );
}
