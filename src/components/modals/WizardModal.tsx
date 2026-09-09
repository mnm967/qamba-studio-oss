// One-shot wizard (design: 1180px, full height, 4 steps with green-check
// stepper). Real mechanics = the M5 pipeline: the brief conversation feeds an
// llm_task plan_storyboard (tier 2 — approve first) at "Draft cast & world";
// the plan writes scenes/beats + draft bible entries and queues ref sheets;
// "Queue the episode" approves the storyboard and enqueues launch_render.
// Tier 1 (full auto) skips both approvals by auto-launching from the plan job.
//
// Step 1 is a real agent turn, not a canned prompt list: /api/director/brief
// (an llm_task the browser queues, for a local model) runs the director as an
// interviewer with the note_brief tool, and everything it establishes lands in
// chat_threads.brief. The panel under the transcript renders that row, so what
// you see picked up is literally what gets handed to the planner.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Ban, Check, ChevronDown, ChevronRight, Clapperboard, Clock, Cpu, File,
  FileText, Film, GripVertical, HardDrive, Image as ImageIcon, ImagePlus, Loader2, Maximize2, Mic, MicOff,
  Minimize2, Music, Paperclip, Pause, Play, Plus, RefreshCw, Send, Sparkles, Trash2, Upload, X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { useIsAdmin } from "../../lib/auth";
import { useVideoLoras } from "../../hooks/useVideoLoras";
import { planHere, planLanesHere, plannerInstalled,
         podStillNeeded, speechProvidersHere } from "../../lib/desktopPlanner";
import { isLocalId, type ModelTier } from "../../lib/localModels";
import { breezeStatus, type BreezeStatus } from "../../lib/breezeLocal";
import { qwenStatus, type QwenStatus } from "../../lib/qwenLocal";
import { LOCAL_ENGINES, type DialogueProvider } from "../../lib/speechProviders";
import { isDesktop } from "../../lib/desktop";
import { byIds, useDragReorder } from "../../hooks/useDragReorder";
import { supabase, mediaUrl } from "../../lib/supabase";
import { assetUrl, registerAsset } from "../../lib/db/assets";
import { probedUploadMeta } from "../../lib/mediaProbe";
import { cancelJob, enqueueJob } from "../../lib/db/jobs";
import { isLocalProject } from "../../lib/localPlane";
import { modelKeyOf, resolveDefaults } from "../../lib/projectSettings";
import { useSheetModels } from "../../hooks/useSheetModels";
import { useLocalEngine } from "../../hooks/useLocalEngine";
import { useByok } from "../../hooks/useByok";
import { providersFor } from "../../lib/byokProviders";
import WizardModelPicker from "./WizardModelPicker";
import {
  VIDEO_CHOICES, VOICE_BLURBS, VOICE_CHOICES, defaultChoice, localReason,
  parsePick, pickOf, pickedOffer, videoOffers, voiceOffers, type WizardFacts,
} from "../../lib/wizardModels";
import { loadCatalog } from "../../lib/catalog";
import ImageModelPicker, { styleLoras, takesRefine, validLoras } from "../ui/ImageModelPicker";
import CastWorldRefsBar, { type RefEntry } from "./CastWorldRefsBar";
import RedrawSheetsDialog from "./RedrawSheetsDialog";
import CastWorldVoiceBar from "./CastWorldVoiceBar";
import PlanAutoCard from "./PlanAutoCard";
import { autoForTier, planAutoFlags, toggleAuto, type AutoKey } from "../../lib/planAuto";
import {
  assignVoices, pickTtsVoice, providerForEntry, speakingRoles, voiceRefPayload, type SpeakingRole,
} from "../../lib/voiceRefs";
import { EL_VOICES } from "../../lib/elVoices";
import BackendMenu from "../ui/BackendMenu";
import {
  confirmDraftSession, deleteDraftEntry, deleteThread, detachRef,
  discardDraftSession, loadBible, loadBibleAssets,
  loadMessages, loadStoryboardFull, loadWizardSessions, reorderScenes, saveWizardState,
  storyboardsForEpisode, type ThreadSummary,
} from "../../lib/db/director";
import {
  MEDIA, castWorldContext, pickResumeSession, sessionStatus,
  sessionTitle, storyboardContext, wizardStateFrom, wizardStateTo,
} from "../../../director/wizard_session.js";
import { mainEpisode } from "../../lib/db/projects";
import { uploadMedia } from "../../lib/upload";
import { beatImageId, panelDefaults, queueScenePanels, queueSceneStill } from "../../lib/panels";
import ScenePanelGrid from "../shell/ScenePanelGrid";
import type { ProjectSettings } from "../../lib/projectSettings";
import { buildPersona } from "../../../director/personas.js";
import {
  EXPERTS, briefIsEmpty, briefReadiness, briefToPlan, openingLine,
} from "../../../director/brief.js";
import {
  DIRECTOR_BACKENDS, backendLabel, describeDirectorError,
  pipelineBackendId, queueLocalBriefTurn, queueLocalDirectorTurn,
  type ChatAttachment, type DirectorEvent,
} from "../../lib/director";
import {
  getWizardDraft, setWizardDraft, clearWizardDraft,
  getWizardSideDraft, setWizardSideDraft, clearWizardSideDraft,
} from "../../lib/draftStore";
import { Markdown } from "../../lib/markdown";
import { ago } from "../../lib/time";
import Dropdown from "../ui/Dropdown";
import Lightbox, { stepIndex } from "../ui/Lightbox";
import BibleEntryModal from "./BibleEntryModal";
import NewEntryModal from "./NewEntryModal";
import ReplanModal, { type ReplanChoice } from "./ReplanModal";
import { replanBlocker, replanJob } from "../../lib/replan";
import SceneEditorModal from "./SceneEditorModal";
import { estimateBatchSeconds, fmtEta, loadTimings } from "../../lib/eta";
import { ST } from "../shell/ContextPanel";
import type { Asset, BibleEntry, ChatMessage, Episode, Job, JobLane, Project, Scene } from "../../lib/db/types";

function formatFileSize(bytes?: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function docBadge(name?: string | null, ct?: string | null): { label: string; color: string; bg: string } {
  const ext = (name?.split(".").pop() || "").toLowerCase();
  if (ext === "pdf" || ct === "application/pdf") return { label: "PDF", color: "#ff8080", bg: "rgba(255,128,128,.14)" };
  if (ext === "doc" || ext === "docx") return { label: "DOC", color: "#5aa2ff", bg: "rgba(90,162,255,.14)" };
  if (ext === "md" || ext === "markdown") return { label: "MD", color: "#c97aff", bg: "rgba(201,122,255,.14)" };
  if (ext === "txt" || ext === "text") return { label: "TXT", color: "#6fd08c", bg: "rgba(111,208,140,.14)" };
  if (ext === "json") return { label: "JSON", color: "#ffb454", bg: "rgba(255,180,84,.14)" };
  if (ext === "csv") return { label: "CSV", color: "#79e2f2", bg: "rgba(121,226,242,.14)" };
  return { label: ext.toUpperCase() || "DOC", color: "#9aa4b6", bg: "rgba(154,164,182,.14)" };
}

function isImageAttachment(a: { media?: string | null; b2_key?: string | null; label?: string | null }): boolean {
  if (a.media === "image" || a.media === "frame") return true;
  const key = a.b2_key || a.label || "";
  return /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(key);
}

/** The reference the USER supplied for an entry, if any.
 *
 *  `assets.origin` is what separates a sheet they attached in the interview
 *  from one the planner drew, and nothing on the link row records provenance —
 *  nor needs to: an uploaded asset sitting in a bible slot got there because
 *  someone put it there. Worth surfacing because the card otherwise looks
 *  identical either way, and "did it use my sheet?" is the whole question. */
const userSupplied = (
  links: { asset_id: string }[],
  assets?: Map<string, { origin?: string | null }>,
) => links.find((l) => assets?.get(l.asset_id)?.origin === "uploaded") ?? null;

/** What the model is doing while it thinks, in the user's language. */
const TOOL_LABEL: Record<string, string> = {
  note_brief: "writing it down",
  get_project_state: "reading the project",
  search_lore: "reading your lore",
};

interface Brief {
  title?: string; logline?: string; premise?: string; turn?: string; ending?: string;
  tone?: string; palette?: string; audience?: string;
  cast?: { name: string; role?: string; look?: string; want?: string }[];
  world?: { name: string; look?: string; when?: string }[];
  props?: { name: string; look?: string; why?: string }[];
  motifs?: string[]; references?: string[]; constraints?: string[]; open_questions?: string[];
  shape?: { length_s?: number; structure?: string; sections?: string[] };
  expert_notes?: Record<string, string>;
  ready?: boolean;
}

function Stepper({ step, setStep, maxStep }: { step: number; setStep: (n: number) => void; maxStep: number }) {
  const items = ["Brief", "Cast & world", "Storyboard", "Models & render"];
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 0 }}>
      {items.map((label, i) => {
        const n = i + 1;
        const done = n < step;
        const on = n === step;
        const reachable = n <= maxStep;
        return (
          <React.Fragment key={label}>
            {i > 0 && (
              <span style={{ flex: 1, height: 1,
                             background: done || on
                               ? "linear-gradient(90deg, rgba(111,208,140,.4), rgba(90,162,255,.4))"
                               : "rgba(255,255,255,.1)" }} />
            )}
            <button onClick={() => reachable && setStep(n)}
                    style={{ display: "flex", alignItems: "center", gap: 7, height: 28, padding: "0 12px",
                             borderRadius: 11, cursor: reachable ? "pointer" : "default",
                             border: on ? "1px solid rgba(90,162,255,.4)" : "1px solid transparent",
                             background: on ? "rgba(90,162,255,.11)" : "none",
                             color: done ? "#6fd08c" : on ? "#5aa2ff" : reachable ? "#9aa4b6" : "#5e6678",
                             fontSize: 13, fontWeight: 600 }}>
              <span style={{ width: 17, height: 17, borderRadius: "50%", display: "grid", placeItems: "center",
                             ...(done ? { background: "rgba(111,208,140,.16)", border: "1px solid rgba(111,208,140,.45)" }
                                      : { border: on ? "1px solid rgba(90,162,255,.6)" : "1px solid rgba(255,255,255,.15)" }) }}
                    className="mono">
                {done ? <Check size={10} /> : <span style={{ fontSize: 10.5, fontWeight: 700 }}>{n}</span>}
              </span>
              {label}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

const Bubble = ({ children }: { children: React.ReactNode }) => (
  <div style={{ alignSelf: "flex-end", maxWidth: "78%", padding: "11px 14px",
                borderRadius: "19px 14px 5px 14px", background: "rgba(90,162,255,.11)",
                border: "1px solid rgba(90,162,255,.2)", fontSize: 14.5, lineHeight: 1.55,
                wordBreak: "break-word" }}>
    {children}
  </div>
);

const Says = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "flex", gap: 10, maxWidth: "82%" }}>
    <span style={{ width: 22, height: 22, flexShrink: 0, borderRadius: 10, marginTop: 2,
                   background: "rgba(90,162,255,.14)", border: "1px solid rgba(90,162,255,.35)",
                   display: "grid", placeItems: "center", color: "#5aa2ff" }}>
      <Film size={12} />
    </span>
    <div style={{ minWidth: 0, fontSize: 14.5, lineHeight: 1.65, color: "#dfe4ec" }}>{children}</div>
  </div>
);

const ToolRow = ({ name, status }: { name: string; status: string }) => (
  <div className="mono" style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 32,
                                 fontSize: 11, color: status === "err" ? "#ff8080" : "#5e6678" }}>
    {status === "run" ? <Loader2 size={11} className="ns-spin" />
      : status === "err" ? <X size={11} /> : <Check size={11} style={{ color: "#6fd08c" }} />}
    {TOOL_LABEL[name] ?? name}
  </div>
);

/** A persisted turn. Tool blocks show as receipts so "writing it down" is
 *  visible work rather than something the panel does by magic. */
function Turn({ m }: { m: ChatMessage }) {
  const blocks = (Array.isArray(m.content) ? m.content : []) as
    { type?: string; text?: string; name?: string; result?: { error?: string };
      asset_id?: string; b2_key?: string; media?: string; label?: string }[];
  if (m.role === "user") {
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const refs = blocks.filter((b) => b.type === "asset_ref" || b.type === "block_ref");
    return (
      <Bubble>
        {text && <div style={{ whiteSpace: "pre-wrap" }}>{text}</div>}
        {!!refs.length && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: text ? 8 : 0 }}>
            {refs.map((b, i) => {
              if (b.type === "asset_ref") {
                const isImg = isImageAttachment(b);
                const url = b.b2_key ? mediaUrl(b.b2_key) : null;
                const badge = docBadge(b.label, b.media);
                if (isImg) {
                  return (
                    <div key={i} style={{ position: "relative", width: 56, height: 56, borderRadius: 12,
                                          overflow: "hidden", border: "1px solid rgba(255,255,255,.15)",
                                          background: "#080a0f", flexShrink: 0 }}
                         title={b.label ?? undefined}>
                      {url ? (
                        <img src={url} alt={b.label ?? ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "#5aa2ff" }}>
                          <ImageIcon size={20} />
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                  <div key={i} style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 10px",
                                        borderRadius: 11, background: "rgba(13,17,25,.8)",
                                        border: "1px solid rgba(255,255,255,.14)", fontSize: 12 }}
                       title={b.label ?? undefined}>
                    <span style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 5px", borderRadius: 4,
                                   color: badge.color, background: badge.bg, fontFamily: "var(--font-mono)" }}>
                      {badge.label}
                    </span>
                    <span style={{ color: "#dfe4ec", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {b.label ?? "Document"}
                    </span>
                  </div>
                );
              }
              if (b.type === "block_ref") {
                return (
                  <div key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 8px",
                                        borderRadius: 8, background: "rgba(201,122,255,.12)",
                                        border: "1px solid rgba(201,122,255,.3)", color: "#d2a6ff", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                    <Film size={11} /> {b.label ?? "block"}
                  </div>
                );
              }
              return null;
            })}
          </div>
        )}
      </Bubble>
    );
  }
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text" && b.text?.trim()) {
          return <Says key={i}><Markdown text={b.text} /></Says>;
        }
        if (b.type === "tool_result" && b.name) {
          return <ToolRow key={i} name={b.name} status={b.result?.error ? "err" : "ok"} />;
        }
        return null;
      })}
      {m.streaming && (
        <div style={{ marginLeft: 32 }}><Loader2 size={13} className="ns-spin" style={{ color: "#5e6678" }} /></div>
      )}
    </>
  );
}

function LiveTurn({ live }: { live: { text: string; tools: { name: string; status: string }[] } }) {
  return (
    <>
      {live.text ? <Says><Markdown text={live.text} /></Says>
        : !live.tools.length && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 32, fontSize: 13,
                        color: "#5e6678" }}>
            <Loader2 size={13} className="ns-spin" />thinking…
          </div>
        )}
      {live.tools.map((t, i) => <ToolRow key={i} name={t.name} status={t.status} />)}
    </>
  );
}

/** The three kinds this step drafts, and the words each one wants. Cast, world
 *  and props keep the same hues here that step 1's "picked up so far" gives
 *  them, so a card means the same thing on both screens. */
const ADD_KIND = {
  character: { tone: "#5aa2ff", noun: "character", minHeight: 104 },
  environment: { tone: "#6fd08c", noun: "location", minHeight: 96 },
  prop: { tone: "#ffb454", noun: "prop", minHeight: 96 },
} as const;

type AddKind = keyof typeof ADD_KIND;

/**
 * A scene's prose, and the one thing CSS cannot answer about it: whether it
 * fits.
 *
 * The box's height is no longer a clamp this file chose — it is whatever the
 * storyboard column beside it leaves over (`.ws-scenefill`), which changes per
 * scene with the shot count and again when a panel lands mid-render. So "is
 * there more text than room" is a measurement, not a class, and the fade that
 * says so is drawn from it. Painted unconditionally, as it was while the clamp
 * was fixed, it is a dark band across the bottom of every row whose prose fits
 * — most of them — because the gradient ends at the row's own background
 * rather than at the text.
 *
 * Measured once on mount BEFORE observing, for `useBox`'s reason: a
 * ResizeObserver callback is delivered in the rendering steps, so a document
 * that is not painting never gets one and anything waiting on it stays at its
 * initial value forever.
 */
function SceneDesc({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Flipping the flag draws a pseudo-element and changes no layout, so this
    // cannot feed itself — and React bails on an unchanged boolean.
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div ref={ref} className="ws-scenedesc" data-clipped={clipped || undefined}
         style={{ fontSize: 13, lineHeight: 1.55, color: "#9aa4b6" }}>
      {text}
    </div>
  );
}

/** The tile that adds one. It OPENS the real modal rather than being a form
 *  of its own: this used to be two inline fields, on the reasoning that the
 *  identity line is the only field that changes what renders — true, and it
 *  left the three things this step is the right moment for unreachable
 *  (uploading your own reference sheet, generating one, and a voice sample),
 *  each of which then had to be found again on the Bible page.
 *
 *  It cannot route through `ws.openModal`: the store holds ONE modal and the
 *  wizard is it, so opening the ordinary way would close the wizard. The
 *  caller nests `NewEntryModal` instead — see `addKind` below. */
function AddEntryCard({ kind, onOpen }: { kind: AddKind; onOpen: () => void }) {
  const copy = ADD_KIND[kind];
  const tone = copy.tone;
  return (
    <button onClick={onOpen}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                     minHeight: copy.minHeight, borderRadius: 18, cursor: "pointer",
                     border: `1px dashed ${tone}55`, background: `${tone}0a`, color: tone,
                     fontSize: 13, fontWeight: 600 }}>
      <Plus size={14} />Add {copy.noun}
    </button>
  );
}


/** The wizard's right-hand column: the director, and the step's one action.
 *  Step 2 and step 3 used to spend it on a continuity list and a block-plan
 *  strip that repeated what the cards already said. */
function ChatSidebar({
  subtitle, messages, live, draft, setDraft, onSend, busy,
  notice, err, hint, children, inputRef,
}: {
  subtitle: string;
  messages: ChatMessage[] | null;
  live: { text: string; tools: { name: string; status: string }[] } | null;
  draft: string; setDraft: (v: string) => void;
  onSend: () => void; busy: boolean;
  notice: string | null; err: string | null;
  /** the session lapsed — a notice, not an input: there is nothing to paste */
  hint: string;
  children?: React.ReactNode;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const sideTaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [messages, live]);

  useEffect(() => {
    const el = inputRef?.current ?? sideTaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(130, Math.max(36, el.scrollHeight))}px`;
  }, [draft, inputRef]);

  return (
    <aside style={{ ...Aside, width: 372, padding: 0, gap: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px",
                    borderBottom: "1px solid rgba(255,255,255,.07)" }}>
        <span style={{ width: 22, height: 22, borderRadius: 10, display: "grid", placeItems: "center",
                       background: "rgba(90,162,255,.14)", border: "1px solid rgba(90,162,255,.35)",
                       color: "#5aa2ff", flexShrink: 0 }}>
          <Film size={12} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Director</div>
          <div className="mono" style={{ fontSize: 10.5, color: "#5e6678" }}>{subtitle}</div>
        </div>
      </div>
      <div ref={scroll} className="ns-scroll"
           style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 14px",
                    display: "flex", flexDirection: "column", gap: 11 }}>
        {(messages ?? []).slice(-8).map((m) => <Turn key={m.id} m={m} />)}
        {live && <LiveTurn live={live} />}
        {!messages?.length && !live && (
          <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "#5e6678" }}>{hint}</div>
        )}
      </div>
      <div style={{ padding: "10px 14px 14px", borderTop: "1px solid rgba(255,255,255,.07)",
                    display: "flex", flexDirection: "column", gap: 9 }}>
        {notice && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#e8c268" }}>
            <AlertTriangle size={11} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                           whiteSpace: "nowrap" }}>{notice}</span>
          </div>
        )}
        {err && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#ff8080" }}>
            <AlertTriangle size={11} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                           whiteSpace: "nowrap" }} title={err}>{err}</span>
          </div>
        )}
        <div style={{ display: "flex", gap: 7, alignItems: "flex-end" }}>
          <textarea className="ws-input ns-scroll" ref={(inputRef as React.RefObject<HTMLTextAreaElement>) || sideTaRef} value={draft} disabled={busy}
                 placeholder={busy ? "working…" : "Ask for a change… (⇧↵ for new line)"}
                 rows={1}
                 style={{ flex: 1, minWidth: 0, minHeight: 36, maxHeight: 130, fontSize: 12.5, lineHeight: 1.5, resize: "none", padding: "8px 11px", borderRadius: 12 }}
                 onChange={(e) => setDraft(e.target.value)}
                 onKeyDown={(e) => {
                   if (e.key === "Enter" && !e.shiftKey) {
                     e.preventDefault();
                     if (draft.trim() && !busy) onSend();
                   }
                 }} />
          <button className="ws-send" style={{ width: 36, height: 36, borderRadius: 12, flexShrink: 0 }}
                  disabled={!draft.trim() || busy} onClick={onSend} title="Send">
            {busy ? <Loader2 size={14} className="ns-spin" /> : <Send size={14} />}
          </button>
        </div>
        {children}
      </div>
    </aside>
  );
}

/** One captured fact. Nothing renders when the model hasn't got it yet. */
function Field({ label, value, tone }: { label: string; value?: string; tone?: string }) {
  if (!value?.trim()) return null;
  return (
    <div style={{ minWidth: 0 }}>
      <div className="ws-mlabel" style={{ fontSize: 9.5, color: "#5e6678", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: tone ?? "#dfe4ec" }}>{value}</div>
    </div>
  );
}

function Chips({ label, items, tone, onDrop }:
  { label: string; items?: string[]; tone: string; onDrop?: (name: string) => void }) {
  if (!items?.length) return null;
  return (
    <div style={{ minWidth: 0 }}>
      <div className="ws-mlabel" style={{ fontSize: 9.5, color: "#5e6678", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {items.map((s) => (
          <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 8px",
                                 borderRadius: 9, fontSize: 11.5, lineHeight: 1.4,
                                 background: `${tone}14`, border: `1px solid ${tone}40`, color: tone }}>
            {s}
            {onDrop && (
              <button title="Drop this" onClick={() => onDrop(s)}
                      style={{ display: "grid", placeItems: "center", cursor: "pointer", color: "inherit",
                               opacity: .55, background: "none", border: "none", padding: 0 }}>
                <X size={9} />
              </button>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Every picture attached anywhere in this thread, by asset id.
 *
 *  The brief itself records only IDS (that is all the model can see), and a
 *  card that shows the name of a file the user is looking at is no better than
 *  no card. The thumbnails are free: the `asset_ref` blocks on the thread's own
 *  user rows already carry `b2_key`, and an id in the brief can only have come
 *  from one of them — so no query, and correct by construction. */
function attachedPictures(messages: ChatMessage[] | null) {
  const map = new Map<string, { url: string | null; label: string | null }>();
  for (const m of messages ?? []) {
    for (const b of (Array.isArray(m.content) ? m.content : []) as
         { type?: string; asset_id?: string; b2_key?: string; media?: string; label?: string }[]) {
      if (b.type !== "asset_ref" || !b.asset_id || map.has(b.asset_id)) continue;
      if (!isImageAttachment(b)) continue;
      map.set(b.asset_id, { url: b.b2_key ? mediaUrl(b.b2_key) : null, label: b.label ?? null });
    }
  }
  return map;
}

function NamedCards({ label, items, tone, onDrop, pictures }:
  { label: string; items?: { name: string; [k: string]: unknown }[]; tone: string;
    onDrop: (name: string) => void;
    pictures?: Map<string, { url: string | null; label: string | null }> }) {
  if (!items?.length) return null;
  return (
    <div style={{ minWidth: 0 }}>
      <div className="ws-mlabel" style={{ fontSize: 9.5, color: "#5e6678", marginBottom: 4 }}>
        {label} · {items.length}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {items.map((it) => {
          const detail = ["role", "when", "look", "want", "why"]
            .map((k) => (typeof it[k] === "string" ? (it[k] as string).trim() : ""))
            .filter(Boolean).join(" · ");
          const refs = (Array.isArray(it.ref_asset_ids) ? it.ref_asset_ids as string[] : [])
            .map((id) => ({ id, ...(pictures?.get(id) ?? { url: null, label: null }) }));
          return (
            <div key={it.name} style={{ position: "relative", maxWidth: 260, padding: "6px 9px",
                                        borderRadius: 12, background: `${tone}0d`,
                                        border: `1px solid ${tone}38`,
                                        display: "flex", gap: 8, alignItems: "flex-start" }}>
              {!!refs.length && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3, flexShrink: 0,
                              marginTop: 1 }}>
                  {refs.slice(0, 2).map((r) => (
                    <div key={r.id}
                         title={`${r.label ?? "attached reference"} — the planner uses this as ` +
                                `${it.name}'s reference sheet instead of drawing one`}
                         style={{ width: 34, height: 34, borderRadius: 8, overflow: "hidden",
                                  background: "#080a0f", border: `1px solid ${tone}55` }}>
                      {r.url
                        ? <img src={r.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        : <div style={{ width: "100%", height: "100%", display: "grid",
                                        placeItems: "center", color: tone }}>
                            <ImageIcon size={13} />
                          </div>}
                    </div>
                  ))}
                  {refs.length > 2 && (
                    <span className="mono" style={{ fontSize: 9, textAlign: "center", color: tone, opacity: .7 }}>
                      +{refs.length - 2}
                    </span>
                  )}
                </div>
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: tone }}>{it.name}</span>
                  <button title="Drop this — it won't reach the planner" onClick={() => onDrop(it.name)}
                          style={{ display: "grid", placeItems: "center", cursor: "pointer", color: tone,
                                   opacity: .5, background: "none", border: "none", padding: 0 }}>
                    <X size={10} />
                  </button>
                </div>
                {detail && (
                  <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "#9aa4b6", marginTop: 2,
                                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                                overflow: "hidden" }}>
                    {detail}
                  </div>
                )}
                {!!refs.length && (
                  <div className="mono" style={{ fontSize: 9.5, marginTop: 3, color: tone, opacity: .8 }}>
                    YOUR SHEET{refs.length > 1 ? `S · ${refs.length}` : ""}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The brief as the model currently holds it — chat_threads.brief, live.
 *  Every entry is droppable: a weaker model writes down a character twice
 *  under two names, and the user shouldn't have to argue it out of that. */
interface ScoreSpec {
  prompt: string; lyrics: string; instrumental: boolean; model: string; bpm: number;
}

/** The "write me a track" panel in the wizard's Duration column.
 *
 *  Deliberately five controls and no more. Everything else the two music models
 *  take has a sane default, and the ONE field that matters most is the one you
 *  are encouraged to leave empty: with no prompt the planner uses the writer's
 *  own `music` field — a score description for this episode, written by the
 *  same pass that wrote the scenes — which is a better brief than most people
 *  would type and costs nothing to get. */
function ScoreCard({ score, setScore, isMV }: {
  score: ScoreSpec; setScore: (s: ScoreSpec | null) => void; isMV: boolean;
}) {
  const set = (patch: Partial<ScoreSpec>) => setScore({ ...score, ...patch });
  const ace = score.model.startsWith("acestep");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, padding: "9px 10px",
                  borderRadius: 12, border: "1px solid rgba(90,162,255,.24)",
                  background: "rgba(90,162,255,.05)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <Music size={12} style={{ color: "#5aa2ff", flexShrink: 0 }} />
        <span className="ws-mlabel" style={{ fontSize: 10.5, color: "#9aa4b6", flex: 1 }}>
          {isMV ? "Original master track" : "Original score"}
        </span>
        <button style={{ color: "#5e6678" }} title="Don't generate a track"
                onClick={() => setScore(null)}><X size={11} /></button>
      </div>
      <textarea className="ws-input ns-scroll" rows={2} value={score.prompt}
                placeholder="Leave empty to use the score the writer plans for this episode"
                onChange={(e) => set({ prompt: e.target.value })}
                style={{ fontSize: 11.5, lineHeight: 1.5 }} />
      <div style={{ display: "flex", gap: 6 }}>
        {[["minimax-music3", "Music 3"], ["acestep-1.5", "ACE-Step"]].map(([id, label]) => (
          <button key={id} className={"gd-chip" + (score.model === id ? " on" : "")}
                  style={{ flex: 1 }}
                  title={id === "minimax-music3"
                    ? "Sings written lyrics almost verbatim. Slower."
                    : "~4x faster, better for beds. Takes tempo and key as real inputs."}
                  onClick={() => set({ model: id })}>{label}</button>
        ))}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5,
                      color: "#9aa4b6", cursor: "pointer" }}>
        <input type="checkbox" checked={score.instrumental}
               onChange={(e) => set({ instrumental: e.target.checked })} />
        Instrumental
      </label>
      {!score.instrumental && (
        <textarea className="ws-input ns-scroll" rows={3} value={score.lyrics}
                  placeholder={"[Verse]\nthe words it sings\n\n[Chorus]\n…"}
                  onChange={(e) => set({ lyrics: e.target.value })}
                  style={{ fontSize: 11.5, lineHeight: 1.5 }} />
      )}
      {ace && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono" style={{ fontSize: 10, color: "#5e6678", width: 54 }}>
            {score.bpm} BPM
          </span>
          <input type="range" min={50} max={180} step={1} value={score.bpm}
                 onChange={(e) => set({ bpm: +e.target.value })} style={{ flex: 1 }} />
        </div>
      )}
      <span className="mono" style={{ fontSize: 10, lineHeight: 1.5, color: "#5e6678" }}>
        {isMV
          ? (ace
              ? "Renders while the episode plans; the blocks are then cut to its beat grid."
              : "Renders while the episode plans. Music 3 has no BPM input, so blocks "
                + "are not beat-locked — pick ACE-Step if you want them cut to the beat.")
          : "Renders in the background and lands on the storyboard page."}
      </span>
    </div>
  );
}

function BriefPanel({ brief, open, setOpen, onDrop, pictures }:
  { brief: Brief; open: boolean; setOpen: (b: boolean) => void;
    onDrop: (key: keyof Brief, name: string) => void;
    pictures?: Map<string, { url: string | null; label: string | null }> }) {
  const [fullSize, setFullSize] = useState(false);
  const r = briefReadiness(brief);
  const empty = briefIsEmpty(brief);
  const notes = Object.entries(brief.expert_notes ?? {});
  const shape = [
    brief.shape?.length_s ? `${brief.shape.length_s}s` : "",
    brief.shape?.structure ?? "",
    (brief.shape?.sections ?? []).join(" / "),
  ].filter(Boolean).join(" — ");

  return (
    <div
      style={fullSize ? {
        position: "absolute", inset: 0, zIndex: 25,
        background: "rgba(10,13,20,.98)", backdropFilter: "blur(14px)",
        display: "flex", flexDirection: "column",
      } : {
        flexShrink: 0, borderTop: "1px solid rgba(255,255,255,.07)",
        background: "rgba(7,9,14,.35)",
      }}
    >
      <div
        onClick={() => {
          if (fullSize) {
            setFullSize(false);
          } else {
            setOpen(!open);
          }
        }}
        style={{
          display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 28px",
          cursor: "pointer", color: "inherit", background: "none", border: "none", userSelect: "none",
          borderBottom: fullSize ? "1px solid rgba(255,255,255,.08)" : undefined,
        }}
      >
        <span className="ws-mlabel" style={{ fontSize: 10.5, color: empty ? "#5e6678" : "#9aa4b6" }}>
          Picked up so far
        </span>
        <span style={{ display: "flex", gap: 3 }}>
          {r.checks.map((c: { key: string; ok: boolean }) => (
            <span key={c.key} title={c.key}
                  style={{ width: 14, height: 4, borderRadius: 2,
                           background: c.ok ? "#6fd08c" : "rgba(255,255,255,.12)" }} />
          ))}
        </span>
        {r.ready ? (
          <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, color: "#6fd08c" }}>
            READY TO DRAFT
          </span>
        ) : !empty ? (
          <span style={{ fontSize: 11.5, color: "#5e6678", overflow: "hidden", textOverflow: "ellipsis",
                         whiteSpace: "nowrap" }}>
            still need {r.missing.join(", ")}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className={"ws-icobtn" + (fullSize ? " on" : "")}
          title={fullSize ? "Exit full size" : "Full size"}
          onClick={(e) => {
            e.stopPropagation();
            if (!open) setOpen(true);
            setFullSize(!fullSize);
          }}
          style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0 }}
        >
          {fullSize ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button
          type="button"
          className="ws-icobtn"
          title={open || fullSize ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            if (fullSize) {
              setFullSize(false);
              setOpen(false);
            } else {
              setOpen(!open);
            }
          }}
          style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0 }}
        >
          <ChevronDown
            size={14}
            style={{
              color: "#5e6678",
              flexShrink: 0,
              transform: open || fullSize ? "none" : "rotate(-90deg)",
              transition: "transform .15s",
            }}
          />
        </button>
      </div>
      {(open || fullSize) && (
        <div
          className="ns-scroll"
          style={fullSize ? {
            flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 28px 28px",
          } : {
            maxHeight: 232, overflowY: "auto", padding: "2px 28px 14px",
          }}
        >
          {empty ? (
            <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "#5e6678", padding: fullSize ? "24px 0" : 0 }}>
              Nothing yet — this fills in as we talk, and it's exactly what gets handed to the planner.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: fullSize ? 18 : 13 }}>
              <div style={{ display: "grid", gridTemplateColumns: fullSize ? "repeat(auto-fit, minmax(280px, 1fr))" : "1fr 1fr", gap: fullSize ? 15 : 13 }}>
                <Field label="Logline" value={brief.logline} />
                <Field label="The turn" value={brief.turn} />
                <Field label="Premise" value={brief.premise} />
                <Field label="Ending" value={brief.ending} />
                <Field label="Tone" value={brief.tone} />
                <Field label="Palette & light" value={brief.palette} />
                <Field label="Shape" value={shape} />
                <Field label="Audience" value={brief.audience} />
              </div>
              <NamedCards label="Cast" items={brief.cast} tone="#5aa2ff" pictures={pictures}
                          onDrop={(n) => onDrop("cast", n)} />
              <NamedCards label="World" items={brief.world} tone="#6fd08c" pictures={pictures}
                          onDrop={(n) => onDrop("world", n)} />
              <NamedCards label="Props" items={brief.props} tone="#ffb454" pictures={pictures}
                          onDrop={(n) => onDrop("props", n)} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 13 }}>
                <Chips label="Motifs" items={brief.motifs} tone="#c97aff"
                       onDrop={(n) => onDrop("motifs", n)} />
                <Chips label="References" items={brief.references} tone="#9aa4b6"
                       onDrop={(n) => onDrop("references", n)} />
                <Chips label="Constraints" items={brief.constraints} tone="#ff8080"
                       onDrop={(n) => onDrop("constraints", n)} />
                <Chips label="Still open" items={brief.open_questions} tone="#e8c268"
                       onDrop={(n) => onDrop("open_questions", n)} />
              </div>
              {!!notes.length && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div className="ws-mlabel" style={{ fontSize: 9.5, color: "#5e6678" }}>The room</div>
                  {notes.map(([id, note]) => {
                    const e = EXPERTS.find((x: { id: string }) => x.id === id);
                    return (
                      <div key={id} style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: 1.5 }}>
                        <span className="mono" style={{ flexShrink: 0, fontSize: 11, fontWeight: 600,
                                                        color: e?.tone ?? "#9aa4b6" }}>
                          {(e?.label ?? id).toUpperCase()}
                        </span>
                        <span style={{ color: "#9aa4b6" }}>{note}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const Aside: React.CSSProperties = {
  flex: "0 0 auto", width: 290, padding: "22px 20px", background: "rgba(7,9,14,.4)",
  borderLeft: "1px solid rgba(255,255,255,.07)", display: "flex", flexDirection: "column", gap: 16,
  maxHeight: "100%", minHeight: 0, overflowY: "auto", boxSizing: "border-box",
};

/** Render size per resolution tier. 480p is 864x480 — an actual entry in
 * H3_NATIVE_DIMS (worker/graphs.py), not a downscale of 720p, so it costs no
 * quality snap; it is simply the smallest native widescreen size H3 has. */
const RES_DIMS: Record<"480p" | "704p" | "720p" | "1080p", { w: number; h: number }> = {
  "480p": { w: 864, h: 480 },
  "704p": { w: 1280, h: 704 },
  "720p": { w: 1280, h: 704 },
  "1080p": { w: 1920, h: 1088 },
};
/** The episode's target length, in seconds, as the Duration slider offers it:
 * 90s to 15 minutes in 30-second steps. It is a TARGET rather than a limit —
 * the writer's beats are what decide the real length, and the measured-dialogue
 * pass only ever GROWS a shot (see "A 5-MINUTE BRIEF CAME BACK AS A 7.8-MINUTE
 * EPISODE" in CLAUDE.md) — so the grid exists to keep the control and the value
 * agreeing, not to constrain the plan.
 *
 * A saved draft can carry a length from before this grid (the old slider ran
 * 15-240s by 5s), and a range input renders an off-grid value happily and then
 * snaps it on the first drag — so the thumb would sit somewhere the number does
 * not. `snapDuration` is applied wherever a stored value comes back in. */
const DUR_MIN_S = 90;
const DUR_MAX_S = 900;
const DUR_STEP_S = 30;
const snapDuration = (s: number) => {
  const clamped = Math.min(DUR_MAX_S, Math.max(DUR_MIN_S, Math.round(s)));
  return DUR_MIN_S + Math.round((clamped - DUR_MIN_S) / DUR_STEP_S) * DUR_STEP_S;
};
/** m:ss. Every value on this grid is over a minute, so "900s" would be
 * arithmetic the reader has to do; the summary rows keep quoting raw seconds
 * because those report the PLAN rather than what was asked for. */
const durLabel = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const RES_HINT: Record<keyof typeof RES_DIMS, string> = {
  "480p": "Fastest and cheapest — good for blocking out a draft before committing to a full pass.",
  "704p": "Generate at 720p, upscale in post — cheaper than native and usually sharper.",
  "720p": "Generate at 720p, upscale in post — cheaper than native and usually sharper.",
  "1080p": "Native 1080p — no upscale pass needed, at H3's own per-second render cost.",
};

/** The pipeline model a queued plan should carry, given the backend it will
 *  run on — and NOTHING when that backend cannot resolve the name.
 *
 *  `llm_model` used to be an openai-compat-only knob, so sending it beside any
 *  backend was harmless. It is not any more: `_complete_backend`'s Claude
 *  branch reads the same argument (`model or ANTHROPIC_MODEL`) so the take
 *  reviewer can run on Haiku — which makes an OpenAI model name sent with a
 *  Claude backend a 404 on the plan's FIRST call, and an absent `backend`
 *  resolves through `pick_backend` to Claude whenever the worker holds an
 *  Anthropic key. That is CLAUDE.md's own "backend and llm_model must be set
 *  TOGETHER" rule, which main's Haiku change made sharper rather than moot.
 *  Ollama ignores it either way (its branch sends `OLLAMA_MODEL`). */
const PIPELINE_MODEL = "gpt-5.6-terra";
const pipelineModel = (id: string | undefined): string | undefined =>
  (id ?? "").startsWith("openai-compat") ? PIPELINE_MODEL : undefined;


export default function WizardModal({ project, episode }: { project: Project; episode: Episode | null }) {
  const ws = useWorkspaceStore();
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => getWizardDraft(project.id, threadId));
  const [sideDraft, setSideDraft] = useState(() => getWizardSideDraft(project.id, threadId));
  const activeWizardKeyRef = useRef(`${project.id}:${threadId}`);
  const activeWizardSideKeyRef = useRef(`${project.id}:${threadId}`);

  // Restore drafts whenever project or threadId changes
  useEffect(() => {
    const key = `${project.id}:${threadId}`;
    activeWizardKeyRef.current = key;
    activeWizardSideKeyRef.current = key;
    setDraft(getWizardDraft(project.id, threadId));
    setSideDraft(getWizardSideDraft(project.id, threadId));
  }, [project.id, threadId]);

  // Persist draft to storage whenever draft changes
  useEffect(() => {
    const key = `${project.id}:${threadId}`;
    if (activeWizardKeyRef.current !== key) return;
    setWizardDraft(project.id, threadId, draft);
  }, [draft, project.id, threadId]);

  // Persist sideDraft to storage whenever sideDraft changes
  useEffect(() => {
    const key = `${project.id}:${threadId}`;
    if (activeWizardSideKeyRef.current !== key) return;
    setWizardSideDraft(project.id, threadId, sideDraft);
  }, [sideDraft, project.id, threadId]);

  const [experts, setExperts] = useState<string[]>(["writing", "directing", "vfx"]);
  // gpt-5.6-terra (openai-compat) is the studio default for pipeline LLM work;
  // the fallback chain still walks Claude and the pod when it is down.
  const [backend, setBackend] = useState("openai-compat");
  /** Where the plan will run — see the effect beside `imageModel`. */
  const [planWhere, setPlanWhere] = useState<{ why: string; pod: string[] } | null>(null);
  /** This project's rows are a file on this machine, so nothing it queues can
   *  reach the pod. Read once — it cannot change while the modal is open. */
  const localProject = useMemo(() => isLocalProject(project.id), [project.id]);
  /** Null until asked: "not installed" and "not asked yet" look identical on
   *  a gate, and showing the refusal on the first frame would flash it at
   *  every desktop user with a local project. */
  const [canPlanHere, setCanPlanHere] = useState<boolean | null>(null);
  useEffect(() => {
    if (!localProject) { setCanPlanHere(true); return; }
    let live = true;
    void plannerInstalled().then((ok) => { if (live) setCanPlanHere(ok); });
    return () => { live = false; };
  }, [localProject]);
  const isAdmin = useIsAdmin();
  // the interview: one wizard thread, its live turn, and the brief it fills in
  const [live, setLive] = useState<{ text: string; tools: { name: string; status: string }[] } | null>(null);
  const [brief, setBrief] = useState<Brief>({});
  const [sent, setSent] = useState(false);
  const [chatErr, setChatErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** which backend actually answered — "auto" and fallbacks both land here */
  const [ranOn, setRanOn] = useState<string | null>(null);
  /** The session lapsed mid-turn — a notice, not a key prompt. */
  const pendingRef = useRef("");
  const [panelOpen, setPanelOpen] = useState(true);
  const [listening, setListening] = useState(false);
  const recRef = useRef<{ stop(): void } | null>(null);
  const [medium, setMedium] = useState<string>(project.medium);
  const [lengthS, setLengthS] = useState(project.medium === "music_video" ? 120 : DUR_MIN_S);
  const [audio, setAudio] = useState<{ id: string; name: string } | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  /** Generate the track instead of bringing one. Null = don't.
   *
   *  `prompt` empty is not "no prompt" — the planner falls back to the WRITER's
   *  own `music` field, a score description for this episode written by the
   *  same pass that wrote the scenes. So the useful default is to leave it
   *  blank, and the placeholder says so. */
  const [score, setScore] = useState<{
    prompt: string; lyrics: string; instrumental: boolean;
    model: string; bpm: number;
  } | null>(null);
  const [planJobId, setPlanJobId] = useState<string | null>(null);
  const [tier, setTier] = useState<1 | 2>(2);
  /**
   * What the plan draws for you the moment it lands — see `src/lib/planAuto.ts`.
   *
   * EMPTY BY DEFAULT, which is a change of position rather than a tweak.
   * `plan_storyboard` queued sheets, panels and a voice per speaking character
   * unconditionally, on the reasoning that the references are cheap against
   * the render — true, and it costs the review: a one-shot whose image model
   * cannot render on this machine spends every one of those jobs before a
   * single sheet has been looked at. The storyboard is what you came to read;
   * the two steps after it already carry the buttons that draw the rest.
   */
  const [auto, setAuto] = useState<Set<AutoKey>>(() => new Set());
  // Turbo by default: measured over 109 master passes (2026-08), 8.2 min/block
  // against plain H3's 14.8 on slightly LARGER frames and the same cold-load
  // rate. An episode is many blocks, so the default is where that compounds —
  // the full 20-step pass is one click away for a final master.
  const [videoModel, setVideoModel] = useState("h3-turbo-local");
  /**
   * WHERE the picked model renders — the other half of a step-4 card.
   *
   * Separate state rather than a composite `videoModel`, because everything
   * downstream wants the MODEL: `episodeParams.model_key`, `modelKeyOf`, the
   * ETA's `model_id`, the session's `video_model`. The plane rides beside it
   * and reaches exactly one place, `planLanesHere`, which is what decides the
   * lane the blocks are queued on.
   */
  const [videoPlane, setVideoPlane] = useState<"local" | "cloud">("cloud");
  /** Where the dialogue is RECORDED — `dialogueProvider`'s other half, and up
   *  here beside its twin because the plan-where effect below reads both in
   *  its dependency list, which a `const` declared later cannot be in.
   *  `local` is this machine's Breeze and `byok` a key of your own — both put
   *  the `tts` jobs on this machine — where `cloud` is the studio's queue on
   *  the studio's bill. */
  const [voicePlane, setVoicePlane] = useState<ModelTier>("cloud");
  /** Which model draws the sheets, panels and stills.
   *
   *  It was the literal string "krea2" — on the plan payload AND on every regen
   *  button here — so a project that had chosen an image model was ignored by
   *  the one screen that draws its whole bible. Measured on a project set to
   *  `h3-image-turbo-local`: all 14 cast sheets, 4 locations and 8 props
   *  rendered on krea2.
   *
   *  Worse on the regen path, and worth keeping in mind if a `model_id` shows
   *  up in another payload: `handle_image_gen` reads `payload.model_key` and
   *  NOTHING reads `payload.model_id`, so those buttons were not overriding
   *  anything — they fell through to the worker's own default, which for a job
   *  carrying anchors is qwen-edit. So "regenerate this sheet" quietly redrew
   *  on a different family from the one that drew the set. */
  const [imageModel, setImageModel] = useState(
    () => resolveDefaults(project.settings as never).image_model);
  // WHERE THE PLAN WILL RUN, resolved when step 4 opens rather than at queue
  // time: the answer decides what the card there promises, and a promise made
  // after the click is not one.
  useEffect(() => {
    if (step !== 4) return;
    let live = true;
    void (async () => {
      const here = await planHere(backend);
      const key = modelKeyOf(videoModel);
      if (!live) return;
      setPlanWhere(here
        ? {
          why: here.why,
          pod: podStillNeeded(await planLanesHere(
            imageModel, project.id, key,
            { render: videoPlane, speech: voicePlane === "cloud" ? "cloud" : "local" })),
        }
        : null);
    })();
    return () => { live = false; };
    // THE PLANES ARE DEPS. `podStillNeeded` reports which kinds still wait for
    // the studio's box, and both of them move that answer — a card switched to
    // the cloud puts the blocks back on the pod, and the sentence has to say
    // so before the queue does.
  }, [step, backend, imageModel, videoModel, videoPlane, voicePlane]);
  const [res, setRes] = useState<keyof typeof RES_DIMS>("720p");
  // The project's video LoRA stack, pruned to what the CHOSEN model declares.
  // Set in the project panel; the wizard only carries it onto the render, the
  // same way it carries the model key — an episode must not gain or lose an
  // adapter shot to shot. Pruning here rather than trusting the saved value
  // because the wizard's model choice is independent of the project default.
  const { data: catalogRows } = useLiveQuery(() => loadCatalog(), ["model_catalog"], []);
  const engine = useLocalEngine();
  const sheetModels = useSheetModels(catalogRows, imageModel, engine.rows);
  // Wrapped so a hub-downloaded adapter on this machine survives `validLoras`,
  // which drops any key the row does not declare — see `useVideoLoras`.
  const videoRow = useVideoLoras(
    useMemo(() => (catalogRows ?? []).find((m) => m.id === videoModel), [catalogRows, videoModel]));
  const episodeLoras = useMemo(() => {
    const want = resolveDefaults(project.settings as never).video_loras ?? [];
    if (!videoRow) return [];
    const kept = validLoras(videoRow, want);
    // A HUB PICK CARRIES ITS OWN TRIGGER. The studio's adapters declare theirs
    // in model_map's `lora_triggers`, keyed by an adapter name; a filename key
    // is in no map, so the token can only travel on the pick — which is what
    // `resolve.lora_triggers` reads it off. Without it the adapter loads,
    // logs nothing and does nothing.
    const defs = new Map(styleLoras(videoRow).map((d) => [d.key, d]));
    return kept.map((p) => {
      const t = defs.get(p.key)?.trigger;
      return t && p.key.endsWith(".safetensors") ? { ...p, trigger: t } : p;
    });
  }, [videoRow, project.settings]);
  // Does the chosen video model declare a refine recipe? Read off the catalog
  // row rather than a list of ids here: `resolve()` RAISES on a model with no
  // recipe, so a hardcoded set that fell behind model_map would fail every
  // block of an episode. Today that means the two local H3 rows on this
  // picker — not the hosted one (a different adapter entirely) and not LTX.
  const refineOk = useMemo(
    () => takesRefine((catalogRows ?? []).find((m) => m.id === videoModel)),
    [catalogRows, videoModel]);
  const [post, setPost] = useState<string[]>([]);
  /** Second, higher-resolution sampler pass per block. Off by default: it is
   *  extra GPU time on EVERY block of the episode, and it is only offered on
   *  models that declare a recipe (`takesRefine`) because `resolve()` raises
   *  otherwise. Rides `params` like every other block flag, so an episode
   *  refines consistently or not at all. */
  const [refine, setRefine] = useState(false);
  /** Which engine RECORDS the dialogue — the plan casts every character on it
   *  and floors each shot to its recorded lines. Breeze (the pod's own model)
   *  designs a voice per character from the writer's description and performs
   *  the "(sigh)" a line carries; ElevenLabs v3 casts from a curated table.
   *  Rides the PLAN job: casting happens before a single beat is written. */
  const [dialogueProvider, setDialogueProvider] =
    useState<DialogueProvider>("breeze");
  // WHERE BREEZE WOULD ACTUALLY SPEAK, on THIS machine.
  const [breezeSvc, setBreezeSvc] = useState<BreezeStatus | null | undefined>(undefined);
  const [qwenSvc, setQwenSvc] = useState<QwenStatus | null | undefined>(undefined);
  // ONE POLL PER ENGINE, because they install, start and fail separately — a
  // machine routinely has one and not the other, and the row's whole job is to
  // say which. `undefined` until the answer lands, which `localVoiceReason`
  // reads as "not asked" rather than as "absent".
  useEffect(() => {
    if (!isDesktop()) return;
    void breezeStatus().then(setBreezeSvc);
    void qwenStatus().then(setQwenSvc);
  }, []);
  const byok = useByok();
  /**
   * WHERE EACH PICK WOULD ACTUALLY RUN, on this machine and this account.
   *
   * Gathered in ONE place and handed to both pickers, because the answer is
   * one question asked twice and answering it at each call site is how the
   * video list came to say "studio cloud" on three rows this machine renders
   * itself. `wizardModels.ts` is the decision; this is only its inputs, and
   * every one of them is already polled or already in hand.
   */
  const facts: WizardFacts = useMemo(() => ({
    desktop: engine.desktop,
    models: engine.videoModels,
    planner: engine.planner,
    ffmpeg: !!engine.status?.ffmpeg,
    // WEIGHTS ON DISK IS NOT AVAILABILITY: a quantised rung with no
    // `ComfyUI-GGUF`, or PDD with no accelerator pack, reads as ready off the
    // model map and dies inside ComfyUI on a missing node — after the episode
    // is planned and the block claimed.
    nodes: engine.status?.nodes ?? null,
    nodesBroken: engine.status?.nodes_broken ?? null,
    admin: isAdmin,
    localProject,
    breeze: breezeSvc,
    qwen: qwenSvc,
    // Only the keys that can RECORD: an OpenAI key says nothing about an
    // ElevenLabs row. Read off the registry rather than listed here —
    // `unlocks: ["speak"]` is the declaration, and `speechProvidersHere`
    // filters the same way for the plan this picker is choosing for.
    speechKeys: providersFor("speak").map((p) => p.id).filter((id) => byok.keyed.has(id)),
  }), [engine.desktop, engine.videoModels, engine.planner, engine.status?.ffmpeg,
       engine.status?.nodes, engine.status?.nodes_broken,
       isAdmin, localProject, breezeSvc, qwenSvc, byok.keyed]);
  const videoRows = useMemo(() => videoOffers(VIDEO_CHOICES, facts), [facts]);
  const voiceRows = useMemo(() => voiceOffers(VOICE_CHOICES, facts), [facts]);
  const videoValue = pickOf(videoModel, videoPlane);
  const voiceValue = pickOf(dialogueProvider, voicePlane);
  const videoPick = pickedOffer(videoRows, videoValue);
  const voicePick = pickedOffer(voiceRows, voiceValue);
  /**
   * Will THIS machine claim the blocks?
   *
   * The picker's own question, asked of the picked row — so the sections, the
   * card below them and the ETA cannot disagree about where an episode is a
   * click away from rendering. NOT the row's tier: a row is LISTED under "on
   * this machine" from the first launch, weights or no weights, and what
   * decides where it renders today is whether anything is still missing.
   */
  const whyNotHere = videoPick ? localReason(videoPick, facts) : { why: "" };
  const renderHere = videoPlane === "local" && !!videoPick && !videoPick.blocked;
  /** A VIDEO pick that cannot be queued at all — a member on the studio's
   *  cloud, a project on this disk the pod cannot see, weights that are not
   *  down. Every one of those is an episode whose blocks each fail a minute
   *  apart, so the button refuses rather than the queue discovering it. */
  const queueBlocked = videoPick?.blocked ?? null;
  /**
   * A VOICE pick that cannot be queued DEGRADES rather than failing, so it
   * warns and the button stays live.
   *
   * `dialogue_synth` synthesises every line at plan time to floor its shot —
   * the measurement that replaced the words-per-second guess behind
   * DIALOGUE_CUTOFF — and with no engine and no key the planner simply keeps
   * the guess. A worse storyboard is not a reason to refuse the episode, and
   * refusing one over it would stop a member with a local model and no speech
   * engine from queueing anything at all.
   */
  const voiceBlocked = voicePick?.blocked ?? null;
  /**
   * A PICK THAT CANNOT BE QUEUED MOVES, ONCE THE ANSWER IS IN.
   *
   * The stored default is Turbo, which needs a node pack the desktop
   * installer does not add — so on a member's machine (no pod) it is the one
   * row that can never render, chosen by nobody. Same rule `defaultPlace`
   * follows: a preference is honoured only while it names something that
   * still works, and everything blocked leaves the value alone so the picker
   * shows it refused rather than substituting a model silently.
   */
  useEffect(() => {
    const next = defaultChoice(videoRows, videoValue);
    if (!next || next === videoValue) return;
    const { id, tier } = parsePick(next);
    setVideoModel(id);
    setVideoPlane(tier === "local" ? "local" : "cloud");
  }, [videoRows, videoValue]);
  useEffect(() => {
    const next = defaultChoice(voiceRows, voiceValue);
    if (!next || next === voiceValue) return;
    const { id, tier } = parsePick(next);
    setDialogueProvider(id as DialogueProvider);
    setVoicePlane(tier);
  }, [voiceRows, voiceValue]);
  /** Segment storyboards: one numbered board per block, composed by the
   *  worker from the block's own panels and staged INTO the render as a
   *  single reference (measured: 4-14deg of hue spread across a block against
   *  95 for loose panels, and every shot composed rather than two). Rides the
   *  plan job AND the launch, because blocks exist only once launch_render has
   *  planned them. */
  const [boards, setBoards] = useState(true);
  // The block-shaping flags, in ONE place. They have to reach two different
  // enqueues (the plan job, which tier 1 forwards to its own launch_render,
  // and the wizard's own launch_render), and keeping two hand-written spread
  // lists in step is exactly how a flag comes to be a no-op on one path.
  // Only non-defaults are sent: an absent key means the worker's own default.
  const blockParams: Record<string, unknown> = {
    // Gated on the MODEL as well as the switch. The card hides itself when the
    // chosen model declares no recipe, but the state survives a model change —
    // and here that is not a harmless no-op the way an unread payload key
    // usually is: `resolve()` raises, so it would fail every block.
    ...(refine && refineOk ? { refine: true } : {}),
  };
  /** Everything `launch_render` copies onto every generation_block: the
   *  checkpoint, its concept LoRAs, and the block flags.
   *
   *  Built ONCE because there are two launch paths and they had already
   *  drifted. Tier 2 queues `launch_render` from "Queue episode" below; TIER 1
   *  queues its own on the pod out of the PLAN job's payload — and that
   *  payload carried `params: blockParams` and nothing else, so a one-shot
   *  ignored the Video model picker entirely (`_block_model` falls back to
   *  plain `H3_MODEL`, 20 steps) and, with no `dims`, ignored the Resolution
   *  picker too (`handle_master_pass` falls through to its 1280x720 default).
   *  Both are silent: the episode renders, on the wrong checkpoint, at a
   *  resolution nobody chose — the same failure CLAUDE.md records under
   *  "A RE-RENDER USED TO CHANGE THE RESOLUTION", arriving from the other end.
   *
   *  The hosted option has no model_map entry, so it must not send a key the
   *  worker would fail to resolve — hence the `-local` test. `refine` sits
   *  OUTSIDE that branch, because it is a property of the block rather than of
   *  the checkpoint's id space. */
  //  A HUB ADAPTER IS A FILE ON THIS MACHINE, so it cannot ride to the cloud.
  //  `withDesktopVideoLoras` offers this machine's downloaded LoRAs by
  //  FILENAME, which `resolve.lora_stack` resolves against whatever
  //  `models/loras` the engine reading the graph has. That is this machine
  //  when the blocks render here, and the studio's box when they do not —
  //  where the file does not exist and ComfyUI fails the block on an enum.
  //  So they are dropped when the render is not local, and SAID rather than
  //  dropped quietly: a silently weaker episode is the downgrade this codebase
  //  keeps naming.
  const hubLoras = episodeLoras.filter((l) => l.key.endsWith(".safetensors"));
  const sentLoras = renderHere ? episodeLoras
    : episodeLoras.filter((l) => !l.key.endsWith(".safetensors"));
  const droppedLoras = renderHere ? 0 : hubLoras.length;

  const episodeParams: Record<string, unknown> = {
    ...(videoModel.endsWith("-local")
      ? { model_key: modelKeyOf(videoModel),
          ...(sentLoras.length ? { loras: sentLoras } : {}) }
      : {}),
    ...blockParams,
  };

  const [launching, setLaunching] = useState(false);
  /** set when the episode is queued — the session is finished, not resumable */
  const [queuedAt, setQueuedAt] = useState<string | null>(null);
  const [eta, setEta] = useState("…");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const sideInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMV = medium === "music_video";

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(160, Math.max(44, el.scrollHeight))}px`;
  }, [draft]);

  const { data: plan } = useLiveQuery(
    async () => {
      if (!planJobId) return null;
      const { data } = await supabase.from("jobs").select("*").eq("id", planJobId).maybeSingle();
      return data as Job | null;
    },
    ["jobs"], [planJobId]);
  const planDone = plan?.status === "done";
  // A canceled plan is a STOPPED plan, and until this existed the wizard read it
  // as one that had not started yet: `request_job_cancel` flips a queued row
  // straight to `canceled`, nothing else ever writes to it again, and step 2's
  // only terminal branch was `error` — so cancelling from the queue popover left
  // the spinner saying "waiting for the worker — the studio's cloud must be up"
  // forever, on a job no worker will ever claim. The row is also what a saved
  // session restores, so reopening the draft resumed the same dead spinner.
  const planCanceled = plan?.status === "canceled";
  // Cancelling a RUNNING job only sets the flag; the worker flips the status at
  // its next checkpoint. Say so rather than showing the department list ticking
  // along through a run that is on its way out.
  const planCanceling = plan?.status === "running" && plan.cancel_requested;
  const planStopped = plan?.status === "error" || planCanceled;

  // ---- re-planning ------------------------------------------------------
  // A SECOND plan job, tracked apart from `planJobId` on purpose. `planDone`
  // gates the whole of steps 2-4, so re-using that state would take the wizard
  // back to "the storyboard isn't planned yet" and hide the plan the user is
  // deciding about for the length of the run.
  const [replanOpen, setReplanOpen] = useState(false);
  const [replanJobId, setReplanJobId] = useState<string | null>(null);
  const [replanBusy, setReplanBusy] = useState(false);
  const [replanErr, setReplanErr] = useState<string | null>(null);
  // The board on screen when the re-plan was queued. `plan_storyboard` inserts
  // its storyboards row at the "writing storyboard" stage and fills the scenes
  // and beats AFTER — so for a second or two the newest board is an empty one,
  // and the step-3 list (which always reads the newest) would blank itself
  // mid-write. Pinning holds this version until the job says done.
  const [pinnedBoard, setPinnedBoard] = useState<string | null>(null);
  const { data: replan } = useLiveQuery(
    async () => {
      if (!replanJobId) return null;
      const { data } = await supabase.from("jobs").select("*").eq("id", replanJobId).maybeSingle();
      return data as Job | null;
    },
    ["jobs"], [replanJobId]);
  const replanRunning = replan?.status === "queued" || replan?.status === "running";
  const maxStep = planDone ? 4 : 1;
  // Local to the waiting panel: `chatErr` renders in the side chat, which is
  // only mounted once the plan is done — i.e. never while this button exists.
  const [canceling, setCanceling] = useState<false | true | string>(false);

  // Opened from a project route there is no episode prop, and step 2 then
  // rendered "Cast · 0" — an empty bible rather than an unloaded one, which
  // reads as "the planner produced nothing".
  const { data: resolvedEp } = useLiveQuery(
    () => (episode ? Promise.resolve(episode) : mainEpisode(project.id)),
    ["episodes"], [episode?.id, project.id]);
  const ep = episode ?? resolvedEp;

  // Set from the previous pass of the same query — enough to keep the poll on
  // while sheets render, and off the moment they land.
  const [sheetsInFlight, setSheetsInFlight] = useState(false);
  /** the open reference viewer: every ref of one entry, or one scene still */
  const [viewing, setViewing] = useState<{ assets: Asset[]; i: number } | null>(null);
  /** A cast or world card opened as its full bible entry. Kept as local state
   *  rather than `ws.openModal`, because the store holds ONE modal and that
   *  slot is the wizard — routing through it would close the wizard to show a
   *  character. BibleEntryModal takes an `onClose` for exactly this. */
  const [entryModal, setEntryModal] = useState<string | null>(null);
  /** Same story for a scene on step 3 — see `entryModal`. */
  const [sceneModal, setSceneModal] = useState<string | null>(null);
  /** Scenes whose shot list is open on step 3. A set rather than one id: the
   *  reason to open them is to compare, and the storyboard chat edits a beat at
   *  a time — collapsing the scene you are not looking at would hide the change
   *  you just asked for. `beats` is in the realtime publication, so an open list
   *  updates in place when the director writes to it. */
  const [openShots, setOpenShots] = useState<Set<string>>(new Set());
  const toggleShots = (id: string) => setOpenShots((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  // Disables "generate storyboard panels" for the length of the batch insert
  // (one enqueueJob per SHOT, so a whole board is dozens in flight at once) —
  // without it a slow connection invites a second click that doubles every job.
  const [panelsQueuing, setPanelsQueuing] = useState(false);
  /** A scene currently having its panels enqueued, for instant redraw feedback */
  const [queuingSceneId, setQueuingSceneId] = useState<string | null>(null);
  // Same, for the missing reference sheets — see `generateMissingRefs`, where
  // a second press is a second sheet per entry rather than a no-op.
  const [refsQueuing, setRefsQueuing] = useState(false);
  /** The redraw-everything confirmation. It is a pop-up rather than an inline
   *  chip because what it spends is not small — a sheet per character, per
   *  location and per prop, each one a render — and because it UNLINKS what is
   *  already there, which is the kind of thing that should be said before
   *  rather than discovered after. */
  const [redrawAsk, setRedrawAsk] = useState(false);
  // Which kind the nested "new bible entry" modal is open for, or null. Nested
  // rather than routed: `ws.openModal` REPLACES the one modal the store holds,
  // and that modal is this wizard — so opening it the ordinary way would close
  // the wizard and lose the draft. See the render at the bottom of this file.
  const [addKind, setAddKind] = useState<AddKind | null>(null);

  const { data: world, reload: reloadWorld } = useLiveQuery(
    async () => {
      if (!planDone || !ep) return null;
      const sbs = await storyboardsForEpisode(ep.id);
      // Newest, unless a re-plan is mid-write — see `pinnedBoard`. A pin that
      // names a board this episode no longer has falls back rather than
      // rendering nothing.
      const sb = (pinnedBoard && sbs.find((b) => b.id === pinnedBoard)) || sbs[0];
      if (!sb) return null;
      // Six sequential round trips put the cast on screen about eight seconds
      // after the step opened. Only the asset fetch genuinely depends on the
      // other two.
      const [full, bible, sheetJobsRes] = await Promise.all([
        loadStoryboardFull(sb.id),
        loadBible(project.id),
        // 200, not the 60 this shared with the sheet bar: one press of
        // "generate storyboard panels" queues a job per SHOT, so a board of
        // eight scenes is comfortably past sixty in flight at once — and a
        // truncated read is not a cosmetic one. `scenesNeedingPanels` asks
        // this list whether a scene is already drawing, so a scene whose jobs
        // fell off the end reads as blank, keeps the button on screen, and a
        // second press is a second render of every shot in it.
        // `tts` rides along rather than in a query of its own: the voices bar
        // asks the same question the sheets bar does — is one already in
        // flight — and a second round trip on a step that already made six
        // buys nothing. Split by `kind` below.
        // `orbit_sheet` rides along for the SAME reason `tts` does: the bar
        // asks "is one already in flight" and a take is a sheet in flight. It
        // outlives its anchor by minutes (it waits on `depends_on`, then
        // renders a whole take), so a query that could not see it would report
        // a character mid-draw as un-drawn and a second press would queue a
        // second take of everybody.
        supabase.from("jobs").select("id,kind,status,payload")
          .in("kind", ["image_gen", "tts", "orbit_sheet"]).eq("project_id", project.id)
          .in("status", ["queued", "running"]).limit(200),
      ]);
      const links = await loadBibleAssets(bible.map((b) => b.id));
      // The scene column is the storyboard PANELS now, one per shot, so the
      // pictures a beat resolves to have to be in this map — `beatImageId`'s
      // two slots, exactly as the storyboard page fetches them. Without the
      // beat ids here every panel renders as an empty tile on a scene that
      // has already been drawn.
      const beatPics = [...full.beats.values()].flat()
        .flatMap((b) => [b.meta?.still_asset_id as string | undefined,
                         b.meta?.panel_asset_id as string | undefined]);
      const ids = [...new Set([
        ...links.map((l) => l.asset_id),
        ...full.scenes.map((s) => s.still_asset_id),
        ...beatPics,
        // The cast's timbre clips. The voices bar reads the PRESET off each
        // one's meta to seed `assignVoices` — without them here that set is
        // empty and a newly recorded character can be handed a voice a
        // returning one already speaks in, which is the collision `taken`
        // exists for and which nothing on screen would show.
        ...bible.map((b) => b.voice_ref_asset_id),
      ].filter(Boolean) as string[])];
      const { data: assets } = ids.length
        ? await supabase.from("assets").select("*").in("id", ids) : { data: [] };
      const inFlight = (sheetJobsRes.data ?? []) as Job[];
      const sheetJobs = inFlight.filter(
        (j) => j.kind === "image_gen" || j.kind === "orbit_sheet");
      const voiceJobs = inFlight.filter((j) => j.kind === "tts");
      setSheetsInFlight(!!inFlight.length);
      return { ...full, bible, links, sheetJobs, voiceJobs,
               assets: new Map(((assets ?? []) as Asset[]).map((a) => [a.id, a])) };
    },
    ["bible_entries", "bible_assets", "scenes", "beats", "jobs", "assets"],
    [planDone, ep?.id, pinnedBoard], 400,
    // Realtime is the fast path, not the only one: a sheet landing while the
    // socket is asleep otherwise leaves the card saying "generating" forever.
    // Costs nothing when nothing is rendering.
    sheetsInFlight ? 4000 : 0);

  // The pin comes off when the re-plan SETTLES, not when the new board row
  // appears — the row is inserted with no scenes in it. A finished run clears
  // the job too: the new version on screen is the receipt. A failed one keeps
  // it, because the strip is the only thing that says why.
  useEffect(() => {
    if (!replan || replanRunning) return;
    setPinnedBoard(null);
    if (replan.status === "done") setReplanJobId(null);
  }, [replan, replanRunning]);
  // Which board to hold is read off the RUNNING job, not remembered — so a
  // draft reopened mid-revision pins the same version this session pinned, and
  // there is no second copy of the answer to go stale.
  useEffect(() => {
    if (!replanRunning) return;
    const of = (replan?.payload as { revise_of?: string } | null)?.revise_of;
    if (of) setPinnedBoard(of);
  }, [replanRunning, replan]);

  // ---- saved sessions --------------------------------------------------
  // Every wizard thread is a saved draft, whether it reached the planner or
  // stopped after one sentence. The modal restores one on open so closing it
  // (or reloading while cast & world generate) costs nothing.
  const { data: sessions, error: sessionsErr, reload: reloadSessions } = useLiveQuery(
    () => loadWizardSessions(project.id), ["chat_threads", "chat_messages"], [project.id]);

  const hydrate = (t: ThreadSummary) => {
    const s = wizardStateFrom(t);
    setThreadId(t.id);
    setDraft(getWizardDraft(project.id, t.id));
    setSideDraft(getWizardSideDraft(project.id, t.id));
    setBrief((t.brief ?? {}) as Brief);
    setPlanJobId(s.planJobId);
    setReplanJobId(s.replanJobId);
    setStep(s.step);
    if (s.medium) setMedium(s.medium);
    setSent(true);
    if (s.tier) setTier(s.tier === 1 ? 1 : 2);
    if (s.lengthS) setLengthS(snapDuration(s.lengthS));
    if (s.experts) setExperts(s.experts);
    if (s.backend) setBackend(s.backend);
    if (s.res) setRes(s.res);
    if (s.post) setPost(s.post);
    // Null is "saved before this switch existed", which takes the default
    // (draw nothing) rather than reading as a deliberate empty set — and an
    // empty ARRAY is a real answer somebody gave, so the two cannot collapse.
    if (s.auto) setAuto(new Set(s.auto as AutoKey[]));
    if (s.refine != null) setRefine(s.refine);
    if (s.videoModel) setVideoModel(s.videoModel);
    if (s.videoPlane) setVideoPlane(s.videoPlane);
    if (s.dialogueProvider) setDialogueProvider(s.dialogueProvider as DialogueProvider);
    if (s.voicePlane) setVoicePlane(s.voicePlane as ModelTier);
    if (s.imageModel) setImageModel(s.imageModel);
    setAudio(s.audio);
    setScore(s.score ?? null);
    setChatErr(null); setNotice(null); setLive(null);
  };

  /** The interview's song becomes the score card, once.
   *
   *  Without this the two halves never met: `note_brief` could write down a
   *  whole lyric sheet and the wizard would still queue no track, because the
   *  planner reads `brief.music` and only the score card wrote it. "Okay,
   *  generate it for me" in the interview then produced an apology and a saved
   *  note — the exact failure this closes.
   *
   *  One-shot and non-destructive: seeded only while the card is untouched, so
   *  a later turn refining the lyric updates it and a user who edited the card
   *  by hand keeps their version. */
  const songSeeded = useRef<string | null>(null);
  useEffect(() => {
    const song = (brief as Brief & { song?: {
      lyrics?: string; style?: string; instrumental?: boolean;
      length_s?: number; bpm?: number;
    } }).song;
    if (!song || (!song.lyrics && !song.style)) return;
    const sig = JSON.stringify(song);
    if (songSeeded.current === sig) return;
    songSeeded.current = sig;
    setScore((cur) => ({
      // The style prose IS the caption/tags — it is what the interview and the
      // user actually agreed the record sounds like, so it beats the writer's
      // later one-line `music` field that an empty prompt would fall back to.
      prompt: cur?.prompt?.trim() ? cur.prompt : (song.style ?? ""),
      lyrics: cur?.lyrics?.trim() ? cur.lyrics : (song.lyrics ?? ""),
      instrumental: song.instrumental ?? cur?.instrumental ?? !song.lyrics,
      model: cur?.model ?? "minimax-music3",
      bpm: song.bpm ?? cur?.bpm ?? 100,
    }));
    if (song.length_s && song.length_s > 0) setLengthS(song.length_s);
  }, [brief]);   // eslint-disable-line react-hooks/exhaustive-deps

  const startFresh = () => {
    clearWizardDraft(project.id, threadId);
    clearWizardSideDraft(project.id, threadId);
    clearWizardDraft(project.id, null);
    clearWizardSideDraft(project.id, null);
    setThreadId(null); setBrief({}); setPlanJobId(null); setReplanJobId(null); setStep(1);
    setSent(false); setDraft(""); setSideDraft(""); setAttachments([]); setChatErr(null); setNotice(null); setRanOn(null);
    setAudio(null); setScore(null); setMedium(project.medium);
  };

  const onUploadFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const fileList = Array.from(files);
    if (!fileList.length) return;

    for (const file of fileList) {
      setUploading(0);
      try {
        const isImg = file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(file.name);
        const folder = isImg ? "wizard/images" : "wizard/docs";
        const cleanName = file.name.replace(/[^\w.-]+/g, "_");
        const key = `${folder}/${project.id}/${Date.now()}_${cleanName}`;

        await uploadMedia(file, key, (p: number) => setUploading(p));

        let docText = "";
        if (/\.(md|markdown|txt|text|json|csv|yaml|yml|tsv|xml|html|js|ts|py)$/i.test(file.name) || file.type.startsWith("text/")) {
          try {
            docText = await file.text();
          } catch { /* ignore text read fail */ }
        }

        const asset = await registerAsset({
          b2_key: key,
          kind: isImg ? "image" : "file",
          project_id: project.id,
          content_type: file.type || (isImg ? "image/jpeg" : "application/octet-stream"),
          bytes: file.size,
          origin: "uploaded",
          tags: ["wizard-attachment"],
          meta: {
            original_name: file.name,
            size: file.size,
            ...(docText ? { text_content: docText.slice(0, 100000), text_preview: docText.slice(0, 3000) } : {}),
          },
        });

        if (isImg) {
          await enqueueJob({
            kind: "asset_ingest", lane: "cpu", priority: 60,
            payload: { asset_id: asset.id },
          }).catch(() => {});
        }

        const newAttachment: ChatAttachment = {
          kind: "asset",
          id: asset.id,
          b2_key: asset.b2_key,
          media: isImg ? "image" : "file",
          label: file.name,
          ...(docText ? { text_content: docText } : {}),
          ...(asset.width ? { width: asset.width } : {}),
          ...(asset.height ? { height: asset.height } : {}),
          ...(file.size ? { bytes: file.size } : {}),
        };

        setAttachments((cur) => [...cur, newAttachment]);
      } catch (e) {
        setChatErr(`Upload failed for ${file.name}: ${String((e as Error).message || e).slice(0, 100)}`);
      } finally {
        setUploading(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);
    if (e.dataTransfer.files?.length) {
      void onUploadFiles(e.dataTransfer.files);
      return;
    }
    const raw = e.dataTransfer.getData("application/x-qamba-asset");
    if (raw) {
      let id = raw;
      try { id = (JSON.parse(raw) as { id: string }).id ?? raw; } catch { /* bare id */ }
      try {
        const { data: asset } = await supabase.from("assets").select("*").eq("id", id).maybeSingle();
        if (asset) {
          const isImg = asset.kind === "image";
          setAttachments((cur) => cur.some((x) => x.id === asset.id) ? cur : [...cur, {
            kind: "asset",
            id: asset.id,
            b2_key: asset.b2_key,
            media: isImg ? "image" : "file" as never,
            label: asset.b2_key.split("/").pop() ?? asset.id,
            ...(asset.width ? { width: asset.width } : {}),
            ...(asset.height ? { height: asset.height } : {}),
            ...(asset.bytes ? { bytes: asset.bytes } : {} as never),
          }]);
        }
      } catch { /* ignore */ }
    }
  };

  // Resume once, on open. After that the user's choice wins — re-running this
  // would yank them out of a session they deliberately started. The same goes
  // for a *slow* resume: the sessions query is a round trip, and if the user
  // has started typing by the time it lands, restoring the old draft over the
  // top of them is worse than not restoring at all.
  const resumed = useRef(false);
  const restoring = !sessions && !threadId && !resumed.current;
  useEffect(() => {
    if (resumed.current || !sessions) return;
    resumed.current = true;
    if (threadId || sent || draft.trim()) return;   // they got here first
    const t = pickResumeSession(sessions);
    if (t) hydrate(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  // Write the session back whenever it moves. Nothing to save before the first
  // turn creates the thread — and nothing worth saving either.
  useEffect(() => {
    if (!threadId) return;
    const id = setTimeout(() => {
      void saveWizardState(threadId, wizardStateTo({
        step, planJobId, replanJobId, medium, tier, lengthS, experts, backend, res, post,
        auto: [...auto],
        refine, videoModel, videoPlane, imageModel, audio, score, queuedAt,
        dialogueProvider, voicePlane,
      })).catch(() => { /* a lost autosave is not worth interrupting the draft */ });
    }, 400);
    return () => clearTimeout(id);
  }, [threadId, step, planJobId, replanJobId, medium, tier, lengthS, experts, backend,
      res, post, auto, refine, videoModel, videoPlane, imageModel, audio, score, queuedAt,
      dialogueProvider, voicePlane]);

  // The transcript is the thread's own rows, so the local backend (which
  // pseudo-streams into chat_messages from the pod) and the hosted stream land
  // in the same place.
  const { data: messages, reload: reloadMessages } = useLiveQuery(
    () => (threadId ? loadMessages(threadId) : Promise.resolve([] as ChatMessage[])),
    ["chat_messages"], [threadId]);
  // The turn resolves in a closure created before `thread` came back, so the
  // reload it captured still loads "no thread → no messages" and blanks the
  // transcript it was meant to refresh. Always call the current one.
  const reloadRef = useRef(reloadMessages);
  reloadRef.current = reloadMessages;
  const { data: threadRow } = useLiveQuery(
    async () => {
      if (!threadId) return null;
      const { data } = await supabase.from("chat_threads")
        .select("id,brief").eq("id", threadId).maybeSingle();
      return data as { id: string; brief: Brief } | null;
    },
    ["chat_threads"], [threadId]);

  /** Thumbnails for the brief's `ref_asset_ids`, off the thread's own rows. */
  const briefPictures = useMemo(() => attachedPictures(messages), [messages]);

  // chat_threads.brief is the source of truth; the SSE `brief` event is just
  // the same write arriving sooner. Only take the row between turns, so a
  // realtime message that predates the current turn can't roll the panel back.
  useEffect(() => {
    if (!live && threadRow?.brief && Object.keys(threadRow.brief).length) setBrief(threadRow.brief);
  }, [threadRow, live]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, live]);

  const readiness = briefReadiness(brief);
  // Local flag first: the hosted path writes the user row server-side, so
  // waiting for chat_messages to come back left the draft button dead for a
  // second after every turn — exactly when people reach for it.
  const hasSaid = sent || !!messages?.some((m) => m.role === "user");

  /** `retry` re-runs the turn already posted (after a provider failure);
   *  `studioKey` re-runs the one held back while we asked for a key. */
  const sendTurn = async (studioKey?: string, retry = false) => {
    const held = studioKey || retry;
    const text = held ? pendingRef.current : draft.trim();
    if ((!text && !attachments.length) || (live && !held)) return;
    const sendingText = text || (attachments.length === 1
      ? `I've attached ${attachments[0].label || "a file"} for this project.`
      : `I've attached ${attachments.length} files for this project.`);
    pendingRef.current = sendingText;
    if (!held) {
      setDraft("");
      clearWizardDraft(project.id, threadId);
    }
    const curAttachments = attachments;
    if (!held) setAttachments([]);
    setSent(true);
    setChatErr(null); setNotice(null); setLive({ text: "", tools: [] });
    const req = {
      project_id: project.id, episode_id: episode?.id, thread_id: threadId, text: sendingText,
      backend,
      experts, length_s: lengthS,
      // A retry answers the message already in the thread rather than posting
      // it again — nobody said it twice.
      resume: retry && !!threadId,
      persona: { medium, extra: "" },
      attachments: curAttachments,
    };
    const onEv = (ev: DirectorEvent) => {
      if (ev.t === "thread") {
        clearWizardDraft(project.id, null);
        setThreadId(ev.id);
      }
      else if (ev.t === "delta") setLive((s) => s && { ...s, text: s.text + ev.text });
      else if (ev.t === "tool") {
        setLive((s) => s && {
          ...s,
          tools: ev.status === "run"
            ? [...s.tools, { name: ev.name, status: "run" }]
            : s.tools.map((t) => (t.name === ev.name ? { ...t, status: ev.status } : t)),
        });
      } else if (ev.t === "brief") setBrief(ev.brief as Brief);
      else if (ev.t === "fallback") {
        // The turn is still running on the next provider — a notice, not an error.
        setNotice(`${backendLabel(ev.from)} was ${ev.reason} — continuing on ${backendLabel(ev.to)}.`);
        setRanOn(ev.to);
      } else if (ev.t === "done") { if (ev.backend) setRanOn(ev.backend); }
      else if (ev.t === "error") setChatErr(describeDirectorError(ev.message));
    };
    try {
      await queueLocalBriefTurn({ ...req, project }, onEv);
    } catch (e) {
      setChatErr(describeDirectorError(String((e as Error).message || e)));
    } finally {
      setLive(null); reloadRef.current();
    }
  };

  // ---- cast & world side chat -------------------------------------------
  // The same thread as the interview, so the director already remembers what
  // the piece is; what it cannot see is what the planner wrote into the bible
  // afterwards, which is this whole step — that goes in as persona.extra.
  const castWorldState = () => {
    const refsOf = (id: string) => (world?.links ?? []).filter((l) => l.entry_id === id).length;
    const asRow = (b: { id: string; name: string; identity_line: string | null; status: string }) => ({
      name: b.name, identity_line: b.identity_line, status: b.status, refs: refsOf(b.id),
    });
    return {
      brief, medium, lengthS,
      cast: (world?.bible ?? []).filter((b) => b.kind === "character").map(asRow),
      world: (world?.bible ?? []).filter((b) => b.kind === "environment").map(asRow),
      props: (world?.bible ?? []).filter((b) => b.kind === "prop").map(asRow),
    };
  };

  const askDirectorHere = async (contextFor: () => string, studioKey?: string) => {
    const text = studioKey ? pendingRef.current : sideDraft.trim();
    if (!text || (live && !studioKey)) return;
    pendingRef.current = text;
    if (!studioKey) {
      setSideDraft("");
      clearWizardSideDraft(project.id, threadId);
    }
    setChatErr(null); setLive({ text: "", tools: [] });
    const req = {
      project_id: project.id, episode_id: episode?.id, thread_id: threadId, text,
      backend,
      persona: { medium, extra: contextFor() },
    };
    const onEv = (ev: DirectorEvent) => {
      if (ev.t === "thread") {
        clearWizardSideDraft(project.id, null);
        setThreadId(ev.id);
      }
      else if (ev.t === "delta") setLive((s) => s && { ...s, text: s.text + ev.text });
      else if (ev.t === "tool") {
        setLive((s) => s && {
          ...s,
          tools: ev.status === "run"
            ? [...s.tools, { name: ev.name, status: "run" }]
            : s.tools.map((t) => (t.name === ev.name ? { ...t, status: ev.status } : t)),
        });
      } else if (ev.t === "fallback") {
        setNotice(`${backendLabel(ev.from)} was ${ev.reason} — continuing on ${backendLabel(ev.to)}.`);
      } else if (ev.t === "error") setChatErr(describeDirectorError(ev.message));
    };
    try {
      // The full director toolset, not the interview's: this is where
      // "add a costume" has to become a bible row.
      await queueLocalDirectorTurn({ ...req, project }, onEv);
    } catch (e) {
      setChatErr(describeDirectorError(String((e as Error).message || e)));
    } finally {
      setLive(null); reloadRef.current(); reloadWorld();
    }
  };

  const askAboutCast = (studioKey?: string) =>
    askDirectorHere(() => castWorldContext(castWorldState()), studioKey);

  /** The storyboard, with the ids update_scene/update_beat need. */
  const askAboutStoryboard = (studioKey?: string) =>
    askDirectorHere(() => storyboardContext({
      blocks: blockCount, totalS, medium,
      scenes: (world?.scenes ?? []).map((sc) => ({
        id: sc.id, idx: sc.idx, slug: sc.slug, duration_ms: sc.duration_ms,
        scene_prompt: sc.scene_prompt,
        environment: world?.bible.find((b) => b.id === sc.environment_id)?.name ?? null,
        cast: (sc.cast_ids ?? []).map((id) => world?.bible.find((b) => b.id === id)?.name)
          .filter(Boolean) as string[],
        beats: (world?.beats.get(sc.id) ?? []).map((b) => ({
          id: b.id, idx: b.idx, action: b.action, camera: b.camera,
          duration_ms: b.duration_ms,
          dialogue: (b.dialogue ?? []).map((d) => ({
            speaker: world?.bible.find((x) => x.id === d.speaker_id)?.name ?? d.speaker,
            line: d.line,
          })),
        })),
      })),
    }), studioKey);

  // Dropping an entry writes the row, not just local state: the next turn reads
  // chat_threads.brief for its context, so a correction the model can't see
  // would come straight back.
  const dropFromBrief = async (key: keyof Brief, name: string) => {
    const list = brief[key];
    if (!Array.isArray(list)) return;
    const kept = (list as (string | { name?: string })[]).filter(
      (x) => (typeof x === "string" ? x : x?.name ?? "").toLowerCase() !== name.toLowerCase());
    const next = { ...brief, [key]: kept } as Brief;
    setBrief(next);
    if (threadId) await supabase.from("chat_threads").update({ brief: next }).eq("id", threadId);
  };

  // Dictation straight into the composer — the wizard used to punt "voice mode"
  // at the dock, which meant leaving the brief you were in the middle of.
  const toggleMic = () => {
    if (listening) { recRef.current?.stop(); return; }
    const w = window as unknown as Record<string, unknown>;
    const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
      (new () => { lang: string; continuous: boolean; interimResults: boolean;
                   onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>>;
                                    resultIndex: number }) => void) | null;
                   onend: (() => void) | null; start(): void; stop(): void }) | undefined;
    if (!Ctor) { setChatErr("Voice input needs Chrome or Edge"); return; }
    const rec = new Ctor();
    rec.lang = "en-US"; rec.continuous = true; rec.interimResults = false;
    rec.onresult = (ev) => {
      let t = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) t += ev.results[i][0].transcript;
      setDraft((d) => (d ? `${d} ` : "") + t.trim());
    };
    rec.onend = () => setListening(false);
    recRef.current = rec; rec.start(); setListening(true);
  };
  useEffect(() => () => recRef.current?.stop(), []);

  const blockCount = useMemo(() => {
    if (world?.blocks.length) return world.blocks.length;
    const dur = world?.scenes.reduce((s, x) => s + x.duration_ms, 0) ?? lengthS * 1000;
    return Math.max(1, Math.ceil(dur / 13000));
  }, [world, lengthS]);
  const totalS = (world?.scenes.reduce((s, x) => s + x.duration_ms, 0) ?? lengthS * 1000) / 1000;
  // Which family is rendering — a turbo model samples 6 steps instead of 20,
  // and LTX 2.5 measured 79s warm for a 6.4s shot where H3 turbo took ~220s.
  // Both feed the ETA below (and its fallback strings); the dollar figure they
  // used to scale is gone with the rest of the estimate card.
  const isTurbo = videoModel.includes("turbo");
  const isLtx = videoModel.startsWith("ltx");

  useEffect(() => {
    if (step !== 4) return;
    loadTimings().then((ts) => {
      // estimateSeconds scales its measured rate by frames x pixels x STEPS and
      // falls back to the all-model pool when a model has no samples yet, so a
      // turbo estimate is right from the first render rather than after twenty.
      // LTX's step count is a fixed distillation recipe (its ManualSigmas
      // schedules), so a `steps` override is inert there — 6 keeps the
      // estimator from scaling it like a 20-step pass until real samples land.
      const s = estimateBatchSeconds(ts, Array.from({ length: blockCount }, () => ({
        modelId: videoModel, width: RES_DIMS[res].w, height: RES_DIMS[res].h,
        frames: 328, steps: isTurbo || isLtx ? 6 : 20,
      })));
      setEta(s ? fmtEta(s) : isLtx ? "~8m" : isTurbo ? "~18m" : "~45m");
    }).catch(() => setEta(isLtx ? "~8m" : isTurbo ? "~18m" : "~45m"));
  }, [step, blockCount, res, videoModel, isTurbo, isLtx]);

  const launchPlan = async () => {
    const target = ep ?? (await mainEpisode(project.id));
    if (!target) return;
    // Hand over the structured brief, not a transcript: the planner reads
    // logline + notes, and briefToPlan is what keeps every fact the interview
    // established (cast looks, palette, expert calls) from evaporating here.
    const said = (messages ?? []).filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []) as { type?: string; text?: string }[])
      .filter((b) => b.type === "text").map((b) => b.text?.trim()).filter(Boolean).join("\n");
    const compiled = briefToPlan(brief, { lengthS, experts, medium });
    const logline = compiled.logline || said || project.logline || project.title;
    const notes = [compiled.notes, said && `In the user's own words:\n${said}`]
      .filter(Boolean).join("\n\n");
    // WHERE THE PLAN RUNS, decided before the row is written.
    //
    // `lane: "llm"` is the POD's queue and was unconditional, which made the
    // pod mandatory for the one thing a first-time user does first. `planHere`
    // answers whether THIS machine can run the same Python instead — engine
    // Python on disk, pipeline source bundled, and a backend it can serve — and
    // the row then lands on `local`, which only this machine claims.
    //
    // The LANES the plan emits are a separate question and are answered per
    // KIND: sheets and panels render here when the wizard picked a model this
    // machine has, voice references when there is a speech key of the user's
    // own, and a LOCAL project routes both regardless because the pod cannot
    // see its rows at all. `podStillNeeded` is what the step-4 copy says out
    // loud rather than leaving a job kind queued for a box nobody started.
    const here = await planHere(backend);
    // THE PLANE IS THE USER'S NOW, so it is passed rather than re-derived:
    // the picker offers a model on each plane that could serve it, and a lane
    // computed from `renderableHere` alone would overrule the card they chose.
    const lanes = here
      ? await planLanesHere(imageModel, project.id, modelKeyOf(videoModel),
                            { render: videoPlane,
                              speech: voicePlane === "cloud" ? "cloud" : "local" })
      : {};
    // A SPEECH KEY IS SPENT BY THE PLAN ITSELF, not only by the voice jobs it
    // queues: `dialogue_synth` synthesizes every line here to floor its shot's
    // duration, which is the measurement that replaced the words-per-second
    // guess behind DIALOGUE_CUTOFF. Without it the plan keeps the guess — a
    // worse storyboard, silently — so it is unioned into the spendable set
    // rather than left to the backend picker, which is about text.
    const providers = here
      ? [...new Set([...here.providers, ...(await speechProvidersHere())])] : [];
    const planBackend = pipelineBackendId(backend);
    const planModel = pipelineModel(planBackend);
    // WHAT THIS PLAN DRAWS ON ITS OWN. Split across the payload and the brief
    // because that is where the worker reads each one — see `planAutoFlags`,
    // which is pinned against `llm.py` precisely because a flag on the wrong
    // object is not an error: the default is TRUE, so it generates anyway and
    // nothing says so. Tier 1 overrides: it launches the render from this job
    // and never reaches a step whose buttons would draw these.
    const autoFlags = planAutoFlags(autoForTier(tier, auto));
    const j = await enqueueJob({
      kind: "llm_task", lane: here ? "local" : "llm", priority: 20,
      project_id: project.id, episode_id: target.id,
      payload: {
        task: "plan_storyboard", project_id: project.id, episode_id: target.id,
        ...(here ? { lanes, byok_providers: providers } : {}),
        brief: {
          logline, notes, medium,
          duration_target_ms: (brief.shape?.length_s ?? lengthS) * 1000,
          audio_asset_id: audio?.id ?? null,
          // Generated in the BACKGROUND, alongside the sheets and voices, and
          // depended on by launch_render — so a music video's blocks are still
          // planned against a real track and its beat grid rather than against
          // silence. See llm.py's score section.
          ...(score ? {
            music: {
              generate: true,
              prompt: score.prompt.trim() || undefined,
              lyrics: score.instrumental ? undefined : score.lyrics.trim() || undefined,
              instrumental: score.instrumental,
              model_key: score.model,
              // ACE-Step only — Music 3 has no BPM input, and sending one
              // would be a payload key nothing reads.
              ...(score.model.startsWith("acestep") ? { bpm: score.bpm } : {}),
            },
          } : {}),
          experts,
          structured: brief,
          thread_id: threadId,
          ...autoFlags.brief,
        },
        ...autoFlags.payload,
        tier, auto_launch: tier === 1,
        // Tier 1 queues its own launch_render from the pod once the sheets
        // land, forwarding these verbatim — so everything that shapes the
        // render has to ride the PLAN job as well as the wizard's own launch,
        // or the one path that never passes through "Queue the episode"
        // renders an episode with none of the choices the user made. All
        // three were missing: `params.model_key` (so a one-shot rendered on
        // plain H3 whatever the picker said), `dims` (so it rendered at the
        // 1280x720 default whatever the Resolution card said), and
        // `video_model`. Inert on tier 2, which launches from queueEpisode.
        ...(Object.keys(episodeParams).length ? { params: episodeParams } : {}),
        dims: RES_DIMS[res],
        video_model: videoModel,
        dialogue_provider: dialogueProvider,
        ...(boards ? { block_sheets: true } : {}),
        // The planner runs on whatever model ran the interview — picking a
        // backend for the brief and then having the plan land on a different
        // one (with different limits and a different bill) is a surprise.
        // A specific CHAT model (Sonnet, Sol, Terra, …) has no counterpart in
        // the worker's own backend selection — `pipelineBackendId` collapses
        // it to the provider the job can actually resolve, so the plan spends
        // the same credential the interview ran on rather than a re-guessed
        // default. See src/lib/director.ts.
        backend: planBackend,
        ...(planModel ? { llm_model: planModel } : {}),
        // sheet_job puts this straight on `payload.model_key`, which the worker
        // resolves against model_map — so it has to be the map key, not the
        // catalog id the picker holds.
        image_model: modelKeyOf(imageModel),
        persona: buildPersona({
          medium, genre: project.genre, style: project.style,
          extra: `Experts in the room: ${experts.map(
            (id) => EXPERTS.find((e: { id: string }) => e.id === id)?.label ?? id).join(", ")}.`,
        }),
      },
    });
    setPlanJobId(j.id);
    setStep(2);
  };

  // ---- re-plan: the two routes out of the popup ---------------------------
  //
  // Route 1, the cheap one, is what the Re-plan button did on its own: hand the
  // note to the director in the side chat, where `update_scene`/`update_beat`
  // edit these scenes in place. Nothing is thrown away and nothing is queued.
  const replanInChat = (note: string) => {
    setReplanOpen(false);
    setSideDraft("Rewrite these scenes yourself (edit them directly, don't queue "
                 + `a new plan) in this direction: ${note.trim()}`);
    requestAnimationFrame(() => sideInputRef.current?.focus());
  };

  // Route 2: the full staged studio, as version N+1. Every decision that can
  // silently produce a wrong-but-plausible job lives in `lib/replan.ts` — what
  // of the stored brief is the planner's INPUT, dropping the score spec,
  // refusing to auto-launch, keeping the draft-session stamp.
  const replanOnPod = async (choice: ReplanChoice) => {
    if (!world || !ep) return;
    setReplanBusy(true);
    setReplanErr(null);
    try {
      const compiled = briefToPlan(brief, { lengthS, experts, medium });
      const planBackend = pipelineBackendId(backend);
      const planModel = pipelineModel(planBackend);
      const j = await enqueueJob(replanJob({
        note: choice.note,
        previousStoryboardId: world.storyboard.id,
        withPrevious: choice.withPrevious,
        panels: choice.panels,
        stored: (world.storyboard.brief ?? null) as Record<string, unknown> | null,
        fallbackBrief: {
          logline: compiled.logline || project.logline || project.title,
          notes: compiled.notes, medium,
          duration_target_ms: (brief.shape?.length_s ?? lengthS) * 1000,
          experts, structured: brief,
        },
        projectId: project.id, episodeId: ep.id, threadId,
        imageModel: modelKeyOf(imageModel),
        // A specific CHAT model (Sonnet, Sol, Terra, …) has no counterpart in
        // the worker's own backend selection — `pipelineBackendId` collapses
        // it to the provider the job can actually resolve, so the plan spends
        // the same credential the interview ran on rather than a re-guessed
        // default. See src/lib/director.ts.
        backend: planBackend,
        ...(planModel ? { llmModel: planModel } : {}),
        dims: { width: RES_DIMS[res].w, height: RES_DIMS[res].h },
        persona: buildPersona({
          medium, genre: project.genre, style: project.style,
          extra: `Experts in the room: ${experts.map(
            (id) => EXPERTS.find((e: { id: string }) => e.id === id)?.label ?? id).join(", ")}.`,
        }),
      }));
      // Hold this version on screen until the new one is written, not merely
      // inserted. See `pinnedBoard`.
      setPinnedBoard(world.storyboard.id);
      setReplanJobId(j.id);
      setReplanOpen(false);
    } catch (e) {
      setReplanErr((e as Error).message);
    } finally {
      setReplanBusy(false);
    }
  };

  const queueEpisode = async () => {
    if (!world || !ep) return;
    setLaunching(true);
    try {
      // THIS is the commit. Everything the plan invented has been a stamped
      // draft until now — invisible to the Bible page and the pickers, and
      // removable in one operation — because a wizard run that came back wrong
      // used to leave its phantom cast in a bible the whole series shares.
      // Pressing Queue is what makes it canon.
      if (threadId) {
        await confirmDraftSession(project.id, threadId)
          .catch((e: Error) => setChatErr(`Could not confirm the draft: ${e.message}`));
      }
      await supabase.from("storyboards").update({
        status: "approved",
        brief: { post, resolution: res, video_model: videoModel, tier },
      }).eq("id", world.storyboard.id);
      await enqueueJob({
        kind: "launch_render", lane: "cpu", priority: 30,
        project_id: project.id, episode_id: ep.id,
        payload: {
          storyboard_id: world.storyboard.id, dims: RES_DIMS[res],
          model_id: videoModel,
          ...(boards ? { block_sheets: true } : {}),
          // `launch_render` copies these onto every generation_block it plans,
          // and the block is what each render reads its model from — so the
          // choice made here is fixed for the whole episode, including a later
          // repair pass on one block. The SAME object rides the plan job for
          // tier 1; see `episodeParams`, which is where the reasoning lives
          // now. Two copies of this rule is exactly what let the one-shot path
          // drift and render on a checkpoint nobody picked.
          params: episodeParams,
        },
      });
      // Stamp the session done before leaving, so reopening the wizard starts a
      // new brief instead of resuming an episode that is already rendering.
      const at = new Date().toISOString();
      setQueuedAt(at);
      if (threadId) {
        await saveWizardState(threadId, wizardStateTo({
          step: 4, planJobId, medium, tier, lengthS, experts, backend, res, post,
          refine, videoModel, imageModel, audio, score, queuedAt: at,
        })).catch(() => { /* the render is queued either way */ });
      }
      ws.closeModal();
      nav(`/project/${project.id}/ep/${ep.id}/timeline`);
    } finally { setLaunching(false); }
  };

  /** Every reference of one entry, in slot order — what the viewer opens. */
  const refsOfEntry = (entryId: string): Asset[] =>
    (world?.links ?? [])
      .filter((l) => l.entry_id === entryId)
      .map((l) => world?.assets.get(l.asset_id))
      .filter(Boolean) as Asset[];

  // Dragging a scene into a new position. The order is the storyboard's, so it
  // is written in one RPC (see reorderScenes) rather than a PATCH per row, and
  // that call marks the block plan stale exactly as an edit through the chat
  // would — a reorder changes what every block after it covers.
  const sceneIds = useMemo(() => (world?.scenes ?? []).map((s) => s.id), [world?.scenes]);
  const sbId = world?.storyboard.id;
  const drag = useDragReorder(sceneIds, useCallback(async (ids: string[]) => {
    if (!sbId) return;
    await reorderScenes(sbId, ids);
    reloadWorld();
  }, [sbId, reloadWorld]));

  /** A still already queued for this scene — one is plenty. */
  const stillInFlight = (sceneId: string) =>
    world?.sheetJobs.some((j) =>
      ((j.payload as Record<string, unknown>)?.target as { scene_id?: string })?.scene_id === sceneId);

  /**
   * The key still for a scene. One generator, shared with the storyboard page
   * and built on the panel machinery — see lib/panels.ts `sceneStillSpec` for
   * why this stopped picking its own references: the old lookup was "lowest
   * slot, first row wins" over a bible where every role sits at slot 0, so a
   * character's anchor was as likely to be her six-view turnaround grid as her
   * face plate, and a location's as likely to be a `detail` close-up as its
   * master.
   *
   * No reload here — the bulk "queue all" action fires one of these per scene
   * and reloads once at the end, rather than once per job inserted.
   */
  const enqueueStillJob = (scene: Scene) =>
    queueSceneStill(scene, {
      projectId: project.id, episodeId: ep?.id ?? null, bible: world!.bible,
      ...panelDefaults(project.settings as ProjectSettings | null, project.style),
      // …but the wizard's own pick outranks the project default, for the same
      // reason `panelDefaults` prefers `projects.style` over the style guide: a
      // still has to match the sheets it is anchored on, and in this session
      // those were drawn by whatever is selected HERE.
      imageModel,
    });

  const generateStill = async (scene: Scene) => {
    if (!world || stillInFlight(scene.id)) return;
    await enqueueStillJob(scene);
    reloadWorld();
  };

  /** Shots with a panel already in flight, so a scene mid-draw does not offer
   *  to draw itself again — a second press is a second render per shot, not a
   *  no-op. `sheetJobs` is every queued/running `image_gen` of this project,
   *  so it carries the panel jobs beside the sheet ones; the target is what
   *  tells them apart (`{beat_id}` vs `{bible_entry_id}` vs `{scene_id}`).
   *  A `panel_alt` roll counts too — that shot is busy either way. */
  const panelsPending = useMemo(() => {
    const map = new Map<string, { status: string }>();
    for (const j of world?.sheetJobs ?? []) {
      const t = (j.payload as Record<string, unknown> | null)?.target as
        { beat_id?: string } | undefined;
      if (t?.beat_id) {
        const prev = map.get(t.beat_id);
        if (!prev || (prev.status === "queued" && j.status === "running")) {
          map.set(t.beat_id, { status: j.status });
        }
      }
    }
    return map;
  }, [world?.sheetJobs]);

  /** The scene's storyboard: one panel per shot, through the same generator
   *  the storyboard page and the planner use (lib/panels.ts). A breath beat is
   *  deliberately skipped there — it stages the place alone and its panel was
   *  measured as the line-up artifact — so `queueScenePanels` returns how many
   *  it actually drew rather than the beat count.
   *
   *  No reload here, for `enqueueStillJob`'s reason: the bulk action fires one
   *  of these per scene and reloads once at the end. */
  const enqueuePanelJobs = (scene: Scene) =>
    queueScenePanels(scene, world!.beats.get(scene.id) ?? [], {
      projectId: project.id, episodeId: ep?.id ?? null, bible: world!.bible,
      ...panelDefaults(project.settings as ProjectSettings | null, project.style),
      // The wizard's own pick outranks the project default, exactly as it does
      // for a still: a panel is anchored on the sheets this session drew.
      imageModel,
    });

  const generatePanels = async (scene: Scene) => {
    if (!world) return;
    setQueuingSceneId(scene.id);
    try {
      const n = await enqueuePanelJobs(scene);
      setNotice(n ? `${n} panel${n === 1 ? "" : "s"} queued for ${scene.slug ?? "the scene"}`
                  : "That scene has no shots to draw yet.");
      reloadWorld();
    } finally {
      setQueuingSceneId(null);
    }
  };

  /** Every scene whose storyboard is still blank — nothing drawn, nothing in
   *  flight. Drawing redraws a whole scene, so the bulk action deliberately
   *  skips a scene that already has panels rather than rolling them again. */
  const scenesNeedingPanels = (world?.scenes ?? []).filter((s) => {
    const shots = (world?.beats.get(s.id) ?? []).filter((b) => !b.meta?.breath);
    return shots.length > 0
      && shots.every((b) => !beatImageId(b).id && !panelsPending.has(b.id));
  });

  const queueAllPanels = async () => {
    if (!world || !scenesNeedingPanels.length) return;
    await Promise.all(scenesNeedingPanels.map((s) => enqueuePanelJobs(s)));
    reloadWorld();
  };

  /** Something is already drawing for this entry — an anchor plate, or the
   *  coverage take behind it. THE TWO NAME THE ENTRY DIFFERENTLY: `image_gen`
   *  puts it in `target.bible_entry_id` and `orbit_sheet` takes a bare
   *  `entry_id`, so reading only the first reports an entry whose anchors have
   *  landed and whose take is still queued as idle — and every press of the
   *  bar would queue another take of it. */
  const sheetInFlight = (entryId: string) =>
    world?.sheetJobs.some((j) => {
      const p = (j.payload ?? {}) as Record<string, unknown>;
      return (p.target as { bible_entry_id?: string } | undefined)?.bible_entry_id === entryId
        || p.entry_id === entryId;
    });

  /** A character sheet is two shots (face, full body) at slot/slot+1 — "More
   * refs" appends past whatever is already there, so callers pass where to
   * start: `refs.length` to add on, or 0 after a regen has cleared the set. */
  /** Era and palette, exactly as `llm.sheet_job` puts them on every plate the
   *  PLANNER draws. Without it a regenerated sheet is composed from a shorter
   *  prompt than its siblings and drifts out of the set — which reads as "the
   *  one I re-rolled doesn't match", and is the same class of inconsistency as
   *  redrawing characters and leaving the locations alone. The planner writes
   *  it onto the storyboard's brief, so this is that row, not a second copy. */
  const worldBible = useMemo(() => {
    const w = ((world?.storyboard.brief as { world?: Record<string, unknown> } | null)
      ?.world) ?? null;
    if (!w) return undefined;
    const keep = ["era", "palette", "style_notes"]
      .filter((k) => typeof w[k] === "string" && (w[k] as string).trim());
    return keep.length ? Object.fromEntries(keep.map((k) => [k, w[k]])) : undefined;
  }, [world?.storyboard.brief]);

  /** The two lanes a sheet can be claimed from — this machine, or the pod. */
  type SheetLane = "local" | "gpu";

  /** Where a coverage take runs. Resolved ONCE per user action and threaded
   *  down: `sheetsHere` walks the desktop model map, and asking it per entry
   *  is nineteen invokes to answer one question that cannot change mid-click. */
  const resolveSheetLane = async (): Promise<SheetLane> => {
    try {
      const { sheetsHere } = await import("../../lib/desktopPlanner.ts");
      return (await sheetsHere()) ? "local" : "gpu";
    } catch { return "gpu"; }
  };

  /**
   * Every remaining view of an entry, as ONE H3 take conditioned on the plates
   * just queued (`orbit_sheet`, `sheet_mode: "coverage"`).
   *
   * WHAT IT ADDS, per kind — this is the whole reason the step's Generate
   * stopped being N independent renders:
   *   character   full_body, face, side and the six-view contact sheet that
   *               fills `turnaround`, which `ref_plan_for` stages IN PLACE OF
   *               full_body: six agreeing views at one slot's cost.
   *   environment master, alt_angle, atmosphere and detail — all four plates
   *               `plate_plan` rotates through, from one pass — plus the
   *               eight-view contact sheet that fills `coverage`, the
   *               location's twin of the turnaround. `ref_plan_for` stages
   *               THAT in place of the master, so a block is handed every
   *               placement at the one slot a location gets.
   * A PROP gets none: it is one flat product shot, which is not a thing to
   * take eight views of, and `handle_orbit_sheet` refuses the kind outright.
   *
   * It DEPENDS on the anchor rather than racing it — `_sheet_refs` reads live
   * plates and a take queued beside its own anchor would find none and raise
   * "has no reference plates to build a sheet from". A failed anchor takes it
   * down with it through `fail_dependents`, which is right: the take exists to
   * reconcile pictures that were never drawn.
   *
   * NOT fatal to the caller. The anchor plates are already in by the time this
   * runs, so an entry whose take could not be queued is exactly as drawn as it
   * was before this existed — and a thrown error here would take the whole
   * bulk action down with it and leave the rest of the bible untouched.
   */
  const enqueueSheetTake = async (entry: BibleEntry, deps: string[],
                                  lane?: SheetLane) => {
    if (entry.kind !== "character" && entry.kind !== "environment") return;
    try {
      await enqueueJob({
        kind: "orbit_sheet", lane: lane ?? (await resolveSheetLane()),
        priority: 20, project_id: project.id,
        ...(deps.length ? { depends_on: deps } : {}),
        payload: {
          entry_id: entry.id, sheet_mode: "coverage",
          label: `${entry.name.split(" — ")[0].slice(0, 44)} · `
               + `${entry.kind === "character" ? "turnaround" : "coverage"} sheet`,
        },
      });
    } catch (e) {
      // A LOCAL project on a build whose Python cannot claim the kind is the
      // one that lands here, and its message already says so.
      setChatErr(`Sheet views for ${entry.name}: `
                 + String((e as Error).message || e).slice(0, 140));
    }
  };

  const enqueueCharacterRefs = async (c: BibleEntry, atSlot: number):
      Promise<string[]> => {
    const anchors: string[] = [];
    for (let i = 0; i < 2; i++) {
      // THE BODY SHEET IS COMPOSED OVER THE FACE PLATE, which this bar did not
      // do and `llm.sheet_job` always has. Drawn independently, the two are
      // two text-to-image renders of the same sentence at different random
      // seeds — so the face and the figure came back as different people often
      // enough to be reported as one, and neither is wrong on its own terms.
      // The face is the identity anchor EVERY other sheet derives from (the
      // turnaround, the outfit variants, the panels), so a body that does not
      // match it is a second face loose in the bible.
      //
      // The anchor is the LATE-BOUND `{entry_id, roles}` form because the
      // plate it names is still queued at this point — `_resolve_anchor` reads
      // it at run time — and `depends_on` is what makes sure it has landed by
      // then. `lateBound` keeps the prompt composition on the pod for the same
      // reason: the reference set is not known here, and `from_ref` is what
      // swaps the descriptive framing for an instruction that uses it.
      const derived = i === 1;
      anchors.push((await enqueueJob({
        kind: "image_gen", lane: "gpu", priority: 20, project_id: project.id,
        ...(derived && anchors.length ? { depends_on: [anchors[0]] } : {}),
        payload: {
          ...(derived
            ? { anchor_entry_id: c.id, anchor_roles: ["face"] }
            : {}),
          // Facts, not a sentence: the pipeline's Python writes the prompt in
          // the order the model that actually runs it reads best
          // (worker/image_prompt.py). The literal `prompt` beside it is the
          // fallback for a build whose worker predates `prompt_spec`.
          prompt_spec: {
            kind: "character", role: i === 0 ? "face" : "full_body",
            name: c.name, identity: c.identity_line ?? c.summary, style: project.style,
            ...(worldBible ? { world: worldBible } : {}),
          },
          prompt: `character reference, ${i === 0 ? "face portrait" : "full body"}: ${c.identity_line ?? c.name}`,
          width: 1024, height: 1024, model_key: modelKeyOf(imageModel),
          // handle_image_gen defaults an absent seed to a fixed 0 — every
          // unseeded job with the same prompt/dims renders the same frame.
          // "Regen" only changes anything if this varies from the last call.
          seed: Math.floor(Math.random() * 1e9),
          target: { bible_entry_id: c.id, role: i === 0 ? "face" : "full_body", slot: atSlot + i },
          auto_accept: true,
        },
      })).id);
    }
    // The take that draws every OTHER view is queued by `enqueueRefsFor`, not
    // here — see its own note. These two plates are still their own renders
    // because `_sheet_refs` picks the face plate AND the body sheet where
    // `_anchor` would pick one, and reconciling those two is the take's whole
    // job; if it never runs (no pod, no 32GB checkpoint) the character is left
    // with exactly what this bar drew before rather than a face and nothing.
    return anchors;
  };

  // Both of these AWAIT their inserts: the bulk "generate the missing sheets"
  // action has to know when its jobs are actually IN before it re-enables its
  // own button, and the coverage take below needs the anchor's id to depend
  // on. Callers that want fire-and-forget still `void` them.
  const enqueueEnvironmentRef = async (e: BibleEntry, atSlot: number):
      Promise<string[]> => {
    const master = await enqueueJob({
      kind: "image_gen", lane: "gpu", priority: 20, project_id: project.id,
      payload: {
        prompt_spec: {
          kind: "environment", role: "master", name: e.name,
          identity: e.identity_line ?? e.summary, style: project.style,
          ...(worldBible ? { world: worldBible } : {}),
        },
        prompt: `environment reference: ${e.identity_line ?? e.summary ?? e.name}`,
        width: 1280, height: 720, model_key: modelKeyOf(imageModel),
        seed: Math.floor(Math.random() * 1e9),
        target: { bible_entry_id: e.id, role: "master", slot: atSlot },
        auto_accept: true,
      },
    });
    // The other three plates the ring rotates through (`plate_plan`:
    // alt_angle, atmosphere, detail) come from the take `enqueueRefsFor`
    // queues next — which is also the only way to get them RIGHT on H3, since
    // drawn as three more independent renders anchored on the master they come
    // back as three crops of the same frontal view (why `llm.sheet_job` forces
    // them onto krea2). One take cannot drift between its own views.
    return [master.id];
  };

  /** A prop sheet is one picture, and the fields that decide what it shows live
   *  in `doc` — so this mirrors the planner's own `_prop_sheet_extra`
   *  (worker/llm.py) rather than sending a bare name. Two of them change the
   *  render outright and both have burned this project before:
   *
   *  * `reads` is the exact text printed on a readable. Left out, the model
   *    typesets its own words and every block that stages the sheet inherits
   *    the wrong document.
   *  * who it DEPICTS has to be an anchor, not an adjective — a sketchbook full
   *    of drawings OF Haru came back full of drawings of Aki, because her
   *    sheets are what the model had seen most of.
   *
   *  Anchors are the late-bound `{entry_id, roles}` form, so they resolve
   *  against whatever that character's / location's current sheet is at run
   *  time rather than pinning today's asset id. */
  const enqueuePropRef = async (p: BibleEntry, atSlot: number) => {
    const doc = (p.doc ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof doc[k] === "string" ? (doc[k] as string).trim() : "");
    const reads = str("reads"), depicts = str("depicts"), fixedTo = str("fixed_to");
    const text = [p.identity_line, p.summary, reads, depicts].filter(Boolean).join(" ");
    const byName = (kind: string, name: string) => (world?.bible ?? []).find(
      (b) => b.kind === kind && b.name.toLowerCase() === name.toLowerCase());

    const anchors: { entry_id: string; roles: string[] }[] = [];
    // Longest name first, so "Aki Minase" wins over a stray "Aki" inside it.
    const who = depicts ? byName("character", depicts) : [...(world?.bible ?? [])]
      .filter((b) => b.kind === "character")
      .sort((a, b) => b.name.length - a.name.length)
      .find((b) => new RegExp(`\\b${b.name.split(" — ")[0]
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
    if (who) anchors.push({ entry_id: who.id, roles: ["face", "full_body"] });
    // ONLY an explicit `fixed_to` counts as sited: a prop that merely appears
    // in one location is being carried, and photographing it as a fixture of
    // the room is the common case going wrong.
    const where = fixedTo ? byName("environment", fixedTo) : undefined;
    if (where) anchors.push({ entry_id: where.id, roles: ["master"] });

    return enqueueJob({
      kind: "image_gen", lane: "gpu", priority: 20, project_id: project.id,
      payload: {
        // `anchors` are LATE-BOUND — the sheets they name may not have
        // rendered yet — so the reference set is resolved at run time by
        // `_resolve_anchor`, which is also where the prompt is composed.
        // Resolving either here would stage nothing and quietly draw the
        // sketchbook full of the wrong person, which is the exact failure the
        // anchors exist to prevent.
        prompt_spec: {
          kind: "prop", role: "ref", name: p.name,
          identity: p.identity_line ?? p.summary, style: project.style,
          ...(worldBible ? { world: worldBible } : {}),
          ...(reads ? { reads } : {}), ...(depicts ? { depicts } : {}),
          ...(where ? { sited: true } : {}),
        },
        prompt: `prop reference: ${p.identity_line ?? p.summary ?? p.name}`,
        width: 1024, height: 1024, model_key: modelKeyOf(imageModel),
        seed: Math.floor(Math.random() * 1e9),
        ...(anchors.length ? { anchors } : {}),
        target: { bible_entry_id: p.id, role: "ref", slot: atSlot },
        auto_accept: true,
      },
    });
  };

  /** Clear an entry's current sheet and generate a fresh one from slot 0 — a
   * re-roll, not an addition. Unlinks rather than deletes (`detachRef` only
   * touches `bible_assets`): the old images stay in the library exactly like
   * any other asset, the recycle bin is the deliberate place to actually
   * discard them, and this is a "these aren't the refs anymore" action, not
   * a "destroy these images" one. */
  const regenRefs = async (entry: BibleEntry) => {
    const links = (world?.links ?? []).filter((l) => l.entry_id === entry.id);
    if (!world || !links.length || sheetInFlight(entry.id)) return;
    await Promise.all(links.map((l) => detachRef(entry.id, l.asset_id)));
    // Through the same funnel as the bulk action, so a re-roll of one card
    // draws exactly what redrawing all of them would — the anchor AND the
    // take. Its own three-way branch is what let the two drift.
    await enqueueRefsFor(entry, undefined);
    reloadWorld();
  };

  /** Everything in the bible with no sheet at all. Each kind fails the same
   *  way and the failure is a picture, not an error: without a plate the model
   *  invents the room, without a prop sheet the object degrades mid-shot —
   *  AFTERLIGHT's polaroid was a blank white rectangle by 4.6s, and a warning
   *  sign named only in prose never appeared at all — and without a face plate
   *  a character is a different person in every block.
   *
   *  CHARACTERS ARE IN THIS LIST NOW. They were excluded on the reasoning that
   *  a face plate is the identity anchor everything else derives from, so the
   *  plan queues it rather than offering it as a catch-up. That held while the
   *  plan ALWAYS queued it; it is a choice now (`planAuto.ts`), and the bar
   *  that is supposed to say what has not been drawn would have reported a
   *  bible with no faces in it as complete. */
  const reflessEntries = (world?.bible ?? []).filter(
    (b) => (b.kind === "character" || b.kind === "environment" || b.kind === "prop")
      && !(world?.links ?? []).some((l) => l.entry_id === b.id));

  /** …and the half of that list nothing is already drawing.
   *
   *  A QUEUED SHEET DOES NOT CREATE ITS LINK UNTIL IT LANDS, so an entry stays
   *  `refless` for the whole render — which made the bulk action a button that
   *  looked like it had done nothing, over a notice that did not change, and
   *  then queued a SECOND sheet for every entry on the next press. Doubling the
   *  spend is a poor reward for pressing the one control whose own copy is
   *  about spending it wisely. What is in flight is reported instead of being
   *  re-queued. */
  const pendingRefs = reflessEntries.filter((e) => !sheetInFlight(e.id));
  const drawingRefs = reflessEntries.length - pendingRefs.length;

  /**
   * Everything one entry needs: its anchor plate(s), then the take that draws
   * every other view.
   *
   * THE TAKE IS QUEUED HERE, IN ONE PLACE, and that is the point rather than
   * tidiness. It used to be queued inside each kind's own enqueuer, and a
   * measured Redraw All came back with all six location masters and NOT ONE
   * location take while every character got theirs — two call sites doing the
   * same thing, one of them silently not. There is one now, so a kind cannot
   * differ from another kind: the shape below decides the ANCHORS and nothing
   * else, and whether a take follows is decided by `enqueueSheetTake` from the
   * entry's own kind.
   *
   * A PROP gets no take: it is one flat product shot, and `handle_orbit_sheet`
   * refuses the kind outright.
   */
  const enqueueRefsFor = async (e: RefEntry | BibleEntry, lane?: SheetLane) => {
    const entry = e as BibleEntry;
    const anchors = entry.kind === "character" ? await enqueueCharacterRefs(entry, 0)
      : entry.kind === "prop" ? (await enqueuePropRef(entry, 0), [])
        : await enqueueEnvironmentRef(entry, 0);
    await enqueueSheetTake(entry, anchors, lane);
  };

  const generateMissingRefs = async () => {
    if (!pendingRefs.length || refsQueuing) return;
    setRefsQueuing(true);
    // Held until the INSERTS land, not until the refetch that sees them — the
    // reload is fire-and-forget (`useLiveQuery`'s `run` returns nothing to
    // await). What closes the rest of the gap is the refetch itself: a
    // `jobs` insert is a realtime event this query is subscribed to, so
    // `sheetInFlight` turns true and the button is GONE rather than merely
    // disabled, well inside a second. `finally`, so a failed insert can never
    // leave it stuck.
    try {
      const lane = await resolveSheetLane();
      await Promise.all(pendingRefs.map((e) => enqueueRefsFor(e, lane)));
      reloadWorld();
    } catch (e) { setChatErr((e as Error).message); }
    finally { setRefsQueuing(false); }
  };

  /* ── redraw the whole set ────────────────────────────────────────────────
   *
   * `regenRefs` is this one entry at a time, and on a real bible that is
   * nineteen presses — which is exactly the case that matters, because the
   * reason to redraw is almost never one card: the style changed, the image
   * model changed, or (measured, and the reason this exists) a plan's whole
   * sheet pass died on a missing node pack and what survived was drawn by the
   * catch-up bar with no turnarounds and one plate per location.
   *
   * REGENERATING ONE KIND AND NOT THE OTHERS LEAVES THE BIBLE INTERNALLY
   * INCONSISTENT, and the reference encoder resolves that in favour of
   * whatever holds image1 — an anime cast over photoreal plates came back as
   * generic environments with perfect faces. So this is deliberately all of
   * them, in one action, rather than a per-kind filter.
   */
  const redrawableRefs = (world?.bible ?? []).filter(
    (b) => (b.kind === "character" || b.kind === "environment" || b.kind === "prop")
      && !sheetInFlight(b.id));

  const redrawAllRefs = async () => {
    if (!world || !redrawableRefs.length || refsQueuing) return;
    setRedrawAsk(false);
    setRefsQueuing(true);
    try {
      const lane = await resolveSheetLane();
      // UNLINK, don't delete — `detachRef` only touches `bible_assets`, so the
      // old pictures stay in the library like any other asset and the recycle
      // bin stays the deliberate place to discard them. This is a "these
      // aren't the refs anymore" action, not a "destroy these images" one.
      //
      // It also has to happen BEFORE the queue rather than being left to the
      // take's own archive pass: `image_gen` writes its plate at slot 0
      // without retiring what is already there, so an un-cleared role ends up
      // with two rows at slot 0 and `order=slot&limit=1` picks between them
      // arbitrarily — which is the anchor the take then conditions on.
      const links = (world.links ?? []).filter(
        (l) => redrawableRefs.some((e) => e.id === l.entry_id));
      await Promise.all(links.map((l) => detachRef(l.entry_id, l.asset_id)));
      await Promise.all(redrawableRefs.map((e) => enqueueRefsFor(e, lane)));
      setNotice(`Redrawing ${redrawableRefs.length} reference sheet`
                + `${redrawableRefs.length === 1 ? "" : "s"} — the cards fill in as they land.`);
      reloadWorld();
    } catch (e) { setChatErr((e as Error).message); }
    finally { setRefsQueuing(false); }
  };

  /* ── voices ──────────────────────────────────────────────────────────────
   *
   * The sheets bar's twin, and it exists for the same reason one step later:
   * a character's timbre clip used to be synthesized by `plan_storyboard` the
   * moment the plan landed, in whatever engine `resolve_provider` settled on,
   * and the only way to get a different one was to re-plan the episode. The
   * clip is what every block hears that character as, so it is exactly the
   * kind of decision this step exists to put in front of you.
   */

  /** Everyone the storyboard gives a line to, in the order they first speak.
   *  Scene order, not `beats.values()` order — a Map iterates insertion order
   *  and the loader fills it per scene, so it happens to agree today and
   *  would stop agreeing the first time a scene is inserted. */
  const voiceRoles = useMemo(() => (world
    ? speakingRoles(world.bible,
                    world.scenes.flatMap((sc) => world.beats.get(sc.id) ?? []))
    : []), [world]);

  const voiceInFlight = (entryId: string) => !!world?.voiceJobs.some(
    (j) => (j.payload as { bible_entry_id?: string } | null)?.bible_entry_id === entryId);

  /** Speaks, has no clip, and has nothing queued — what the button records.
   *  A QUEUED CLIP DOES NOT SET `voice_ref_asset_id` UNTIL IT LANDS, so a
   *  character stays "no voice" for the whole synthesis; counting the ones in
   *  flight separately is what stops a second press recording everybody
   *  twice, the same trap `pendingRefs` documents one bar up. */
  const pendingVoices = voiceRoles.filter((r) => !r.have && !voiceInFlight(r.entry.id));
  const drawingVoices = voiceRoles.filter((r) => !r.have && voiceInFlight(r.entry.id)).length;
  const doneVoices = voiceRoles.filter((r) => r.have).length;
  const [voicesQueuing, setVoicesQueuing] = useState(false);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [voiceQueuingId, setVoiceQueuingId] = useState<string | null>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);

  const toggleVoicePreview = (entryId: string, url: string) => {
    if (playingVoiceId === entryId) {
      voiceAudioRef.current?.pause();
      voiceAudioRef.current = null;
      setPlayingVoiceId(null);
      return;
    }
    voiceAudioRef.current?.pause();
    const audio = new Audio(url);
    audio.onended = () => {
      setPlayingVoiceId(null);
      voiceAudioRef.current = null;
    };
    audio.onerror = () => {
      setPlayingVoiceId(null);
      voiceAudioRef.current = null;
    };
    voiceAudioRef.current = audio;
    void audio.play().catch(() => {
      setPlayingVoiceId(null);
      voiceAudioRef.current = null;
    });
    setPlayingVoiceId(entryId);
  };

  useEffect(() => () => {
    voiceAudioRef.current?.pause();
  }, []);

  /** Record one character's timbre clip.
   *
   *  `assignVoices` is seeded from the presets ALREADY in use in this episode
   *  rather than from an empty set — two characters on one preset is the
   *  collision `llm.py`'s own `taken` exists for, and nothing on screen would
   *  show it. It only bites the OpenAI chain (Breeze designs from the prose
   *  and ElevenLabs casts from the entry), which is exactly the chain a
   *  machine with no speech engine and no ElevenLabs key falls back to.
   */
  const enqueueVoiceRef = async (role: SpeakingRole, voice: string | null,
                                 lane: string) =>
    enqueueJob({
      kind: "tts", lane: lane as JobLane, priority: 20, project_id: project.id,
      payload: voiceRefPayload(role, { provider: dialogueProvider, voice }),
    });

  const generateMissingVoices = async () => {
    if (!pendingVoices.length || voicesQueuing) return;
    setVoicesQueuing(true);
    try {
      // THE SAME ROUTING THE PLAN USES, asked once per press rather than
      // hardcoded: with a speech key or a Breeze of your own these record HERE,
      // and `cpu` is the studio's queue. Hardcoding it would leave a desktop
      // with a key waiting on a pod nobody started — the failure this whole
      // step is a reaction to, one kind over.
      const lanes = await planLanesHere(
        imageModel, project.id, modelKeyOf(videoModel),
        { render: videoPlane, speech: voicePlane === "cloud" ? "cloud" : "local" })
        .catch(() => ({} as Record<string, string>));
      const lane = lanes.tts ?? "cpu";
      const presetOf = (r: SpeakingRole): string => {
        const a = world?.assets.get(r.entry.voice_ref_asset_id ?? "");
        const meta = (a?.meta ?? {}) as Record<string, unknown>;
        return typeof meta.voice === "string" ? meta.voice : "";
      };
      const used = new Set(voiceRoles.filter((r) => r.have)
        .map(presetOf).filter(Boolean));
      const picks = assignVoices(pendingVoices, used);
      await Promise.all(pendingVoices.map(
        (r) => enqueueVoiceRef(r, picks.get(r.entry.id) ?? null, lane)));
      reloadWorld();
    } catch (e) { setChatErr((e as Error).message); }
    finally { setVoicesQueuing(false); }
  };

  /** Regenerate or record the timbre reference clip for a single character. */
  const regenVoiceRef = async (entry: BibleEntry) => {
    if (voiceInFlight(entry.id) || voiceQueuingId === entry.id) return;
    if (playingVoiceId === entry.id) {
      voiceAudioRef.current?.pause();
      voiceAudioRef.current = null;
      setPlayingVoiceId(null);
    }
    setVoiceQueuingId(entry.id);
    try {
      const doc = (entry.doc ?? {}) as Record<string, unknown>;
      const prov = (typeof doc.voice_provider === "string" ? doc.voice_provider.toLowerCase() : null)
        || dialogueProvider
        || (providerForEntry(doc) as string)
        || "breeze";

      const lanes = await planLanesHere(
        imageModel, project.id, modelKeyOf(videoModel),
        { render: videoPlane, speech: voicePlane === "cloud" ? "cloud" : "local" })
        .catch(() => ({} as Record<string, string>));
      const lane = (lanes.tts ?? "cpu") as JobLane;

      // RE-RECORDING A LOCAL ENGINE'S VOICE MUST CLEAR ITS DESIGNED CLIP, and
      // it has to name the engine being re-recorded rather than Breeze: the
      // clip lives at `doc.<engine>_voice` and `design_voice` is cached
      // forever by (engine, name, description), so a stale one left in place
      // is re-used and the re-record silently returns the same voice.
      if ((LOCAL_ENGINES as readonly string[]).includes(prov) && doc[`${prov}_voice`]) {
        await supabase.from("bible_entries").update({
          doc: { ...doc, [`${prov}_voice`]: null }
        }).eq("id", entry.id);
      }

      const role = voiceRoles.find((r) => r.entry.id === entry.id) ?? {
        entry,
        line: "",
        descriptor: String(doc.voice ?? ""),
        have: Boolean(entry.voice_ref_asset_id),
      };

      let activeVoice: string | null = null;
      if (prov === "elevenlabs") {
        activeVoice = (typeof doc.el_voice_id === "string" && doc.el_voice_id) || EL_VOICES[0].id;
      } else if (prov === "openai") {
        const presetOf = (r: SpeakingRole): string => {
          const a = world?.assets.get(r.entry.voice_ref_asset_id ?? "");
          const meta = (a?.meta ?? {}) as Record<string, unknown>;
          return typeof meta.voice === "string" ? meta.voice : "";
        };
        const used = new Set(voiceRoles.filter((r) => r.have && r.entry.id !== entry.id)
          .map(presetOf).filter(Boolean));
        activeVoice = (typeof doc.openai_voice === "string" && doc.openai_voice)
          || pickTtsVoice(String(doc.voice ?? ""), used);
      }

      await enqueueJob({
        kind: "tts", lane, priority: 20, project_id: project.id,
        payload: voiceRefPayload(role, { provider: prov, voice: activeVoice }),
      });
      reloadWorld();
    } catch (e) {
      setChatErr((e as Error).message);
    } finally {
      setVoiceQueuingId(null);
    }
  };

  /**
   * A LOCAL PROJECT USED TO BE REFUSED AT THE DOOR, and it no longer is.
   *
   * The refusal was correct when it was written: one-shot is a `jobs` row, a
   * local project's rows are a file the pod cannot see, and the failure would
   * otherwise have landed on `void launchPlan()` as an unhandled rejection
   * three screens in — the interview typed, the brief written, and then a
   * button that does nothing.
   *
   * What changed is that the STUDIO'S OWN PYTHON runs here now: the planner
   * over a loopback PostgREST proxy, the sheets through the local renderer,
   * the blocks through a desktop model map. So the gate asks the machine
   * instead of the plane — and when the machine cannot, it says WHICH half is
   * missing rather than "move it to the cloud".
   */
  if (localProject && canPlanHere === false) {
    return (
      <div className="ws-scrim" style={{ zIndex: 95, background: "rgba(4,6,10,.88)", padding: 34 }}
           onClick={(e) => e.target === e.currentTarget && ws.closeModal()}>
        <div className="ns-rise ws-card" style={{ maxWidth: 460, margin: "auto", padding: 22,
                                                  background: "rgba(13,17,25,.96)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 15, fontWeight: 600 }}>
            <HardDrive size={15} /> This project is on this computer
          </div>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: "#c8cfdb", margin: "12px 0 16px" }}>
            One-shot can plan an episode here — the writer, the cinematographer, the character
            sheets — but it runs as Python, and this build has not installed one yet. A project
            on this computer renders on this computer.
            <br /><br />
            Planning needs the interpreter and nothing else — no ComfyUI, no PyTorch. The
            engine window has it as <b>Utilities only</b>, which adds ffmpeg for cutting and
            audio while it is there. Take that if you render in your own ComfyUI, or the full
            install if you want ours too.
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="ws-ghost" onClick={ws.closeModal}>Close</button>
            {/* One click to the thing that fixes it. A dialog that names a
                window without opening it is a dialog that has to be read
                twice. */}
            <button className="ws-primary"
                    onClick={() => ws.openModal({ kind: "engine", tab: "engine" })}>
              Open the engine window
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ws-scrim" style={{ zIndex: 95, background: "rgba(4,6,10,.88)", padding: 34 }}
         onClick={(e) => e.target === e.currentTarget && ws.closeModal()}>
      <div className="ns-rise" style={{ width: "100%", maxWidth: 1180, height: "100%", display: "flex",
                                        flexDirection: "column", borderRadius: 26, overflow: "hidden",
                                        background: "rgba(13,17,25,.94)", border: "1px solid rgba(255,255,255,.1)",
                                        boxShadow: "0 40px 110px -30px rgba(0,0,0,.95)" }}>
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 16, padding: "15px 20px",
                      borderBottom: "1px solid rgba(255,255,255,.07)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 600 }}>
            <Sparkles size={15} style={{ color: "#c97aff" }} />One-shot
          </span>
          <Stepper step={step} setStep={setStep} maxStep={maxStep} />
          <Dropdown width={330} align="right" maxHeight={420}
            trigger={({ toggle }) => (
              <button className="ws-icobtn" onClick={toggle}
                      title={sessions?.length ? `${sessions.length} saved draft${sessions.length > 1 ? "s" : ""}`
                                              : "Saved drafts"}
                      style={{ position: "relative" }}>
                <Clock size={15} />
                {!!sessions?.length && (
                  <span className="mono" style={{ position: "absolute", top: -3, right: -3, minWidth: 13,
                                                  height: 13, padding: "0 3px", borderRadius: 7,
                                                  background: "rgba(90,162,255,.9)", color: "#07090e",
                                                  fontSize: 8.5, fontWeight: 700, lineHeight: "13px" }}>
                    {sessions.length}
                  </span>
                )}
              </button>
            )}>
            {(close) => (
              <>
                <button className="ws-menu-row" onClick={() => { close(); startFresh(); }}>
                  <Plus size={13} style={{ color: "#5aa2ff", flex: "none" }} />
                  <span style={{ flex: 1, fontSize: 12.5 }}>New brief</span>
                </button>
                {/* "no drafts" and "couldn't load your drafts" look identical
                    from here, and one of them means don't start over. */}
                {sessionsErr ? (
                  <div style={{ padding: "9px 12px", fontSize: 12, lineHeight: 1.5, color: "#ff8080" }}>
                    Couldn't load your drafts ({sessionsErr.message}) — they're safe, this is
                    just the list.
                  </div>
                ) : !sessions ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 12px",
                                fontSize: 12, color: "#5e6678" }}>
                    <Loader2 size={12} className="ns-spin" />loading…
                  </div>
                ) : !sessions.length ? (
                  <div style={{ padding: "9px 12px", fontSize: 12, lineHeight: 1.5, color: "#5e6678" }}>
                    Drafts save themselves from your first message — close the wizard whenever,
                    they'll be here.
                  </div>
                ) : null}
                {(sessions ?? []).map((t) => {
                  const st = sessionStatus(t);
                  const on = t.id === threadId;
                  return (
                    <div key={t.id} className="ws-menu-row"
                         style={{ alignItems: "flex-start", gap: 9,
                                  ...(on ? { background: "rgba(90,162,255,.09)" } : {}) }}>
                      <button onClick={() => { close(); hydrate(t); }}
                              style={{ flex: 1, minWidth: 0, textAlign: "left", cursor: "pointer",
                                       color: "inherit", background: "none", border: "none", padding: 0 }}>
                        <span style={{ display: "block", fontSize: 12.5, lineHeight: 1.45,
                                       color: on ? "#eaeef6" : "#c8cfdb" }}>
                          {sessionTitle(t)}
                        </span>
                        <span className="mono" style={{ display: "flex", gap: 7, marginTop: 3,
                                                        fontSize: 10.5, color: "#5e6678" }}>
                          <span style={{ color: st.tone }}>{st.label}</span>
                          <span>·</span><span>{ago(t.updated_at)}</span>
                          {t.turns > 0 && <><span>·</span><span>{t.turns} turns</span></>}
                        </span>
                      </button>
                      <button title="Delete this draft — including any cast and locations it invented"
                              style={{ flex: "none", color: "#5e6678", cursor: "pointer", marginTop: 2 }}
                              onClick={async () => {
                                clearWizardDraft(project.id, t.id);
                                clearWizardSideDraft(project.id, t.id);
                                // The bible entries this session invented go with
                                // it. Scoped to its stamp, so a returning
                                // character it merely cast is untouched, and an
                                // already-queued episode's canon is unstamped and
                                // therefore safe.
                                await discardDraftSession(project.id, t.id).catch(() => {});
                                await deleteThread(t.id).catch(() => {});
                                if (t.id === threadId) startFresh();
                                reloadSessions();
                                reloadWorld();
                              }}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </Dropdown>
          <button className="ws-icobtn" onClick={ws.closeModal}><X size={15} /></button>
        </div>

        {/* ─── step 1: brief ─── */}
        {step === 1 && (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <div
              style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}
              onDragEnter={(e) => {
                e.preventDefault();
                dragCounter.current++;
                setDragOver(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                if (!dragOver) setDragOver(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                dragCounter.current--;
                if (dragCounter.current <= 0) {
                  dragCounter.current = 0;
                  setDragOver(false);
                }
              }}
              onDrop={(e) => void onDrop(e)}
            >
              {dragOver && (
                <div
                  style={{
                    position: "absolute", inset: 12, borderRadius: 20,
                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                    gap: 12, color: "#8fc2ff",
                    background: "rgba(8,12,20,.90)", border: "2px dashed rgba(90,162,255,.75)",
                    zIndex: 50, backdropFilter: "blur(8px)", pointerEvents: "none",
                    boxShadow: "0 0 50px rgba(90,162,255,.15)",
                  }}
                >
                  <div style={{
                    width: 56, height: 56, borderRadius: "50%",
                    background: "rgba(90,162,255,.15)", border: "1px solid rgba(90,162,255,.4)",
                    display: "grid", placeItems: "center", color: "#5aa2ff",
                  }}>
                    <Upload size={26} />
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 16, fontWeight: 600, color: "#eaeef6", marginBottom: 4 }}>
                      Drop files or images to attach to your brief
                    </div>
                    <div style={{ fontSize: 12.5, color: "#8b93a7" }}>
                      PDF, TXT, MD, DOCX, CSV, JSON, and images
                    </div>
                  </div>
                </div>
              )}
              <div ref={scrollRef} className="ns-scroll"
                   style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 28px",
                            display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ maxWidth: 560, fontSize: 21, fontWeight: 600, letterSpacing: "-.015em", lineHeight: 1.45 }}>
                  {openingLine({ ...project, medium })}
                </div>
                {restoring && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#5e6678" }}>
                    <Loader2 size={13} className="ns-spin" />looking for your last draft…
                  </div>
                )}
                {(messages ?? []).map((m) => <Turn key={m.id} m={m} />)}
                {live && <LiveTurn live={live} />}
              </div>
              <BriefPanel brief={brief} open={panelOpen} setOpen={setPanelOpen}
                          pictures={briefPictures}
                          onDrop={(k, n) => void dropFromBrief(k, n)} />
              <div style={{ flexShrink: 0, padding: "12px 28px 18px", borderTop: "1px solid rgba(255,255,255,.07)" }}>
                {notice && (
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8,
                                padding: "5px 9px", borderRadius: 10, fontSize: 12,
                                border: "1px solid rgba(232,194,104,.3)", background: "rgba(232,194,104,.08)",
                                color: "#e8c268" }}>
                    <AlertTriangle size={12} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                                   whiteSpace: "nowrap" }}>{notice}</span>
                    <button onClick={() => setNotice(null)} style={{ color: "inherit", opacity: .6,
                                                                     cursor: "pointer" }}>
                      <X size={11} />
                    </button>
                  </div>
                )}
                {chatErr && (
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8,
                                padding: "5px 9px", borderRadius: 10, fontSize: 12,
                                border: "1px solid rgba(255,90,90,.3)", background: "rgba(255,90,90,.07)",
                                color: "#ff8080" }}>
                    <AlertTriangle size={12} style={{ flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                                   whiteSpace: "nowrap" }} title={chatErr}>{chatErr}</span>
                    <button onClick={() => void sendTurn(undefined, true)} disabled={!!live}
                            style={{ color: "inherit", fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>
                      retry
                    </button>
                    <button onClick={() => setChatErr(null)} style={{ color: "inherit", opacity: .6,
                                                                      cursor: "pointer" }}>
                      <X size={11} />
                    </button>
                  </div>
                )}
                {(!!attachments.length || uploading != null) && (
                  <div className="ws-wizard-attach-shelf ns-scroll">
                    {attachments.map((a) => {
                      const isImg = isImageAttachment(a);
                      const url = a.b2_key ? mediaUrl(a.b2_key) : a.url || null;
                      const badge = docBadge(a.label, a.media);
                      if (isImg) {
                        return (
                          <div key={a.id} className="ws-wizard-attach-img" title={a.label ?? undefined}>
                            {url ? (
                              <img src={url} alt={a.label ?? ""} loading="lazy" />
                            ) : (
                              <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", color: "#5aa2ff" }}>
                                <ImageIcon size={18} />
                              </div>
                            )}
                            <button
                              type="button"
                              className="ws-wizard-attach-remove"
                              title="Remove attachment"
                              onClick={() => setAttachments((cur) => cur.filter((x) => x.id !== a.id))}
                            >
                              <X size={10} />
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div key={a.id} className="ws-wizard-doc-chip" title={a.label ?? undefined}>
                          <span className="ws-wizard-doc-tag" style={{ color: badge.color, background: badge.bg }}>
                            {badge.label}
                          </span>
                          <div className="ws-wizard-doc-info">
                            <span className="ws-wizard-doc-name">{a.label ?? "Document"}</span>
                            {a.bytes ? <span className="ws-wizard-doc-size">{formatFileSize(a.bytes)}</span> : null}
                          </div>
                          <button
                            type="button"
                            className="ws-wizard-attach-remove"
                            title="Remove attachment"
                            onClick={() => setAttachments((cur) => cur.filter((x) => x.id !== a.id))}
                          >
                            <X size={11} />
                          </button>
                        </div>
                      );
                    })}
                    {uploading != null && (
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 12, background: "rgba(90,162,255,.1)", border: "1px solid rgba(90,162,255,.3)", fontSize: 11.5, color: "#8fc2ff" }}>
                        <Loader2 size={12} className="ns-spin" />
                        <span className="mono">{Math.round(uploading * 100)}%</span>
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: "flex", gap: 9, alignItems: "flex-end" }}>
                  <div style={{ flex: 1, minWidth: 0, position: "relative", display: "flex", alignItems: "center" }}>
                    <textarea
                      ref={composerRef}
                      className="ws-input ns-scroll"
                      value={draft}
                      disabled={!!live}
                      rows={1}
                      placeholder={live ? "the director is thinking…" : "Keep talking, or just say the whole idea… (⇧↵ for new line)"}
                      style={{ width: "100%", minHeight: 44, maxHeight: 160, fontSize: 14, lineHeight: 1.5, padding: "10px 42px 10px 14px", resize: "none", borderRadius: 16 }}
                      onChange={(e) => setDraft(e.target.value)}
                      onPaste={(e) => {
                        const files = Array.from(e.clipboardData?.files || []);
                        if (files.length) {
                          e.preventDefault();
                          void onUploadFiles(files);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void sendTurn();
                        }
                      }}
                    />
                    <button
                      type="button"
                      title="Attach images or documents (PDF, TXT, MD, DOCX, CSV, JSON)"
                      disabled={!!live || uploading != null}
                      style={{ position: "absolute", right: 8, bottom: 7, width: 30, height: 30, borderRadius: 10, display: "grid", placeItems: "center", cursor: "pointer", background: "none", border: "none", color: "#8b93a7", transition: "color .15s" }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "#5aa2ff")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "#8b93a7")}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Paperclip size={16} />
                    </button>
                  </div>

                  <button
                    type="button"
                    className="ws-send"
                    style={{ width: 44, height: 44, borderRadius: 16, flexShrink: 0 }}
                    disabled={(!draft.trim() && !attachments.length) || !!live}
                    onClick={() => void sendTurn()}
                    title="Send message (Enter)"
                  >
                    {live ? <Loader2 size={16} className="ns-spin" /> : <Send size={16} />}
                  </button>

                  {/* Voice option hidden for now
                  <button title={listening ? "Stop dictation" : "Dictate into the composer"}
                          style={{ display: "flex", alignItems: "center", gap: 8, height: 44, padding: "0 15px",
                                   borderRadius: 16, cursor: "pointer", fontSize: 13.5, fontWeight: 600, flexShrink: 0,
                                   border: `1px solid rgba(255,90,90,${listening ? ".7" : ".4"})`,
                                   background: `rgba(255,90,90,${listening ? ".2" : ".1"})`, color: "#ff8080" }}
                          onClick={toggleMic}>
                    {listening ? <MicOff size={15} /> : <Mic size={15} />}
                    {listening ? "Listening…" : "Voice"}
                  </button>
                  */}
                  <button className="ws-primary"
                          style={{ height: 44, padding: "0 17px", fontSize: 13.5, flexShrink: 0,
                                   ...(readiness.ready
                                     ? { border: "1px solid rgba(111,208,140,.55)",
                                         background: "rgba(111,208,140,.16)", color: "#6fd08c" }
                                     : {}) }}
                          title={readiness.ready ? "The brief holds — plan it"
                                                 : `Still thin on: ${readiness.missing.join(", ")}`}
                          disabled={!hasSaid && !project.logline && !attachments.length}
                          onClick={() => void launchPlan()}>
                    Draft cast & world<ChevronRight size={14} />
                  </button>
                </div>
                <div style={{ marginTop: 7, display: "flex", alignItems: "center", gap: 12,
                              fontSize: 11.5, color: "#5e6678" }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {readiness.ready
                      ? "Enough to plan — keep refining if you like, the button won't move."
                      : `You can draft any time; the more we settle, the less it invents${
                          readiness.missing.length ? ` (still missing ${readiness.missing.join(", ")})` : ""}.`}
                  </span>
                  {/* Named where it is spent. Every face, location, prop and
                      still of this episode is drawn by this one model and each
                      is then the anchor for everything after it, so a model
                      chosen once in project settings and never shown again is
                      the most consequential invisible default in the wizard. */}
                  <span style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
                    <span>Sheets on</span>
                    <span style={{ width: 168 }}>
                      <ImageModelPicker compact width={330}
                                        models={sheetModels}
                                        value={imageModel} onPick={setImageModel} />
                    </span>
                  </span>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.pdf,.txt,.md,.markdown,.doc,.docx,.json,.csv,.rtf,.yaml,.yml,text/*,application/pdf"
                  hidden
                  onChange={(e) => void onUploadFiles(e.target.files)}
                />
              </div>
            </div>
            <aside className="ns-scroll" style={{ ...Aside, width: 288 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="ws-mlabel" style={{ fontSize: 10.5, color: "#5e6678" }}>Director model</span>
                <Dropdown width={300} align="left"
                  trigger={({ toggle }) => (
                    <button className="ws-threadbtn" onClick={toggle}
                            title="Which model runs the interview">
                      <span className="t">
                        {ranOn && ranOn !== backend ? `${backendLabel(ranOn)} (fell back)`
                          : backendLabel(backend)}
                      </span>
                      <ChevronDown size={12} style={{ flex: "none", color: "#5e6678" }} />
                    </button>
                  )}>
                  {/* THE DOCK'S OWN MENU, not a second copy of it. This list
                      was flat — every backend in one column, "your Anthropic
                      key" beside the studio's subscription — and because it
                      was its own code it never grew the tiers, never grew the
                      blocked states, and went on offering rows that answer 403
                      long after the dock stopped. */}
                  {(close) => (
                    <BackendMenu value={backend} onPick={setBackend} close={close} />
                  )}
                </Dropdown>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="ws-mlabel" style={{ fontSize: 10.5, color: "#5e6678" }}>Duration</span>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <input type="range" min={DUR_MIN_S} max={DUR_MAX_S} step={DUR_STEP_S} value={lengthS}
                         title={`Target length — ${lengthS}s`}
                         onChange={(e) => setLengthS(+e.target.value)} style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: 12, color: "#9aa4b6", width: 44, textAlign: "right" }}>{durLabel(lengthS)}</span>
                </div>
                {/* The soundtrack. Bring one, or have the studio write one —
                    and the second is not MV-only: a film or a series episode
                    gets a score bed the same way, which is why this sits
                    outside the isMV gate that the upload keeps. */}
                {score ? (
                  <ScoreCard score={score} setScore={setScore} isMV={isMV} />
                ) : isMV && audio ? null : (
                  <button className="ws-dashbtn" style={{ height: 36, fontSize: 12 }}
                          title="Generate an original track while the episode plans"
                          onClick={() => setScore({
                            prompt: "", lyrics: "", instrumental: !isMV,
                            model: isMV ? "minimax-music3" : "acestep-1.5", bpm: 100,
                          })}>
                    <Music size={13} /> {isMV ? "…or write me one" : "Add an original score"}
                  </button>
                )}
                {isMV && !score && (
                  audio ? (
                    <div className="ws-pill" style={{ justifyContent: "space-between" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}><Music size={11} /> {audio.name}</span>
                      <button style={{ color: "#5e6678" }} onClick={() => setAudio(null)}><X size={11} /></button>
                    </div>
                  ) : (
                    <label className="ws-dashbtn" style={{ height: 36, fontSize: 12, cursor: "pointer" }}>
                      <Upload size={13} />
                      {uploadPct != null ? `Uploading ${Math.round(uploadPct * 100)}%…` : "Drop the master track"}
                      <input type="file" accept="audio/*" hidden onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        setUploadPct(0);
                        try {
                          const key = `audio/${project.id}/${Date.now()}_${f.name.replace(/[^\w.-]+/g, "_")}`;
                          await uploadMedia(f, key, setUploadPct);
                          const a = await registerAsset({
                            b2_key: key, kind: "audio", project_id: project.id,
                            content_type: f.type || "audio/mpeg", bytes: f.size, tags: ["master-track"],
                            ...(await probedUploadMeta(f)),   // don't wait on the pod
                          });
                          await enqueueJob({ kind: "asset_ingest", lane: "cpu", priority: 60, payload: { asset_id: a.id } });
                          setAudio({ id: a.id, name: f.name });
                        } finally { setUploadPct(null); }
                      }} />
                    </label>
                  )
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="ws-mlabel" style={{ fontSize: 10.5, color: "#5e6678" }}>Making a</span>
                {/* The medium decides how the director thinks — a music video
                    asks about the track and cuts to sections, a series honours
                    the show bible — so it is a choice here, not a label. The
                    project row is only the default. */}
                <div className="ws-seg">
                  {(MEDIA as { id: string; label: string }[]).map((m) => (
                    <button key={m.id} className={medium === m.id ? "on" : ""}
                            style={{ fontSize: 12.5 }}
                            disabled={!!planJobId}
                            title={planJobId ? "the storyboard is already planned for this one"
                                             : `Direct this as a ${m.label.toLowerCase()}`}
                            onClick={() => {
                              setMedium(m.id);
                              // Only nudge the length when it is still a default:
                              // a chosen 90s must survive switching medium.
                              setLengthS((s) => (s === 64 || s === 120
                                ? (m.id === "music_video" ? 120 : 64) : s));
                            }}>
                      {m.label}
                    </button>
                  ))}
                </div>
                {medium !== project.medium && (
                  <span style={{ fontSize: 11.5, lineHeight: 1.45, color: "#e8c268" }}>
                    This project is a {project.medium.replace("_", " ")} — just this one is
                    a {MEDIA.find((m: { id: string }) => m.id === medium)?.label.toLowerCase()}.
                  </span>
                )}
                {!!(project.style || project.genre?.length) && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {[project.style, ...(project.genre ?? [])].filter(Boolean).map((g) => (
                      <span key={g} style={{ padding: "4px 9px", borderRadius: 10, background: "rgba(90,162,255,.1)",
                                             border: "1px solid rgba(90,162,255,.28)", fontSize: 12.5, color: "#8fc2ff" }}>
                        {g}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {/* Above the experts, because it is about what the plan SPENDS
                  rather than how it writes — and because it is the one control
                  on this screen that cannot be reached again once the plan has
                  run. */}
              <PlanAutoCard on={auto} tier={tier} disabled={!!planJobId}
                            onToggle={(k) => setAuto((cur) => toggleAuto(cur, k))} />
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="ws-mlabel" style={{ fontSize: 10.5, color: "#5e6678" }}>Experts on this brief</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {(EXPERTS as { id: string; label: string; tone: string }[]).map((e) => {
                    const on = experts.includes(e.id);
                    const note = brief.expert_notes?.[e.id];
                    return (
                      <label key={e.id} title={note || undefined}
                             onClick={() => setExperts((x) => on ? x.filter((y) => y !== e.id) : [...x, e.id])}
                             style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", borderRadius: 12,
                                      cursor: "pointer",
                                      border: on ? `1px solid ${e.tone}4d` : "1px solid rgba(255,255,255,.07)",
                                      background: on ? `${e.tone}12` : "rgba(255,255,255,.03)" }}>
                        <span style={{ width: 14, height: 14, borderRadius: 4, display: "grid", placeItems: "center",
                                       ...(on ? { border: `1px solid ${e.tone}`, background: `${e.tone}4d`, color: e.tone }
                                              : { border: "1px solid #222a39" }) }}>
                          {on && <Check size={10} />}
                        </span>
                        <span style={{ fontSize: 13, flex: 1, color: on ? "#eaeef6" : "#9aa4b6" }}>{e.label}</span>
                        {note && <Check size={11} style={{ color: e.tone, flexShrink: 0 }} />}
                      </label>
                    );
                  })}
                </div>
              </div>
            </aside>
          </div>
        )}

        {/* ─── step 2: cast & world ─── */}
        {step === 2 && (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            {!planDone ? (
              <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
                  {planStopped ? (
                    <>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: 520,
                                    color: planCanceled ? "#9aa4b6" : "#ff8080", fontSize: 14, lineHeight: 1.5 }}>
                        {planCanceled
                          ? <Ban size={15} style={{ flexShrink: 0 }} />
                          : <AlertTriangle size={15} style={{ flexShrink: 0 }} />}
                        {planCanceled
                          ? "Planning canceled — this run stopped before the storyboard was finished."
                          : `Planning failed — ${describeDirectorError(plan?.error_msg ?? "unknown error")}`}
                      </div>
                      <div className="dir-row" style={{ display: "flex", gap: 9 }}>
                        {/* The brief is intact, so the cheap move is to run the
                            planner again rather than retype anything. A cancel
                            queues a FRESH job — the row is terminal, and the
                            worker only ever claims `queued`. */}
                        <button className="ws-primary" style={{ height: 34, padding: "0 15px" }}
                                onClick={() => void launchPlan()}>
                          {planCanceled ? "Plan again" : "Try again"}
                        </button>
                        <button className="ws-ghost" onClick={() => { setPlanJobId(null); setStep(1); }}>
                          Back to brief
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <Loader2 size={22} className="ns-spin" style={{ color: "#5aa2ff" }} />
                      {/* The studio, staffed: each pipeline stage owns one
                          artifact, and the note's prefix says whose desk the
                          plan is on right now. */}
                      {plan?.status === "running" && !planCanceling && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 300 }}>
                          {(() => {
                            const note = plan.progress_note ?? "";
                            const depts = [
                              ["Writer", "Writer"],
                              ["Story editor", "Story editor"],
                              ["Cinematographer", "Cinematographer"],
                              ["Continuity", "Continuity"],
                              ["Production", "Production"],
                            ] as const;
                            const active = depts.findIndex(([p]) => note.startsWith(p));
                            return depts.map(([prefix, label], i) => {
                              const state = active < 0 ? (i === 0 ? "on" : "wait")
                                : i < active ? "done" : i === active ? "on" : "wait";
                              return (
                                <div key={prefix} style={{ display: "flex", alignItems: "center", gap: 8,
                                  fontSize: 12.5,
                                  color: state === "on" ? "#dfe5f1" : state === "done" ? "#6fd08c" : "#5e6678" }}>
                                  {state === "done" ? <Check size={12} />
                                    : state === "on" ? <Loader2 size={12} className="ns-spin" />
                                    : <span style={{ width: 12, textAlign: "center" }}>·</span>}
                                  <span style={{ minWidth: 118 }}>{label}</span>
                                  {state === "on" && (
                                    <span className="mono" style={{ fontSize: 11, color: "#9aa4b6" }}>
                                      {note.includes(":") ? note.slice(note.indexOf(":") + 1).trim() : "working…"}
                                    </span>
                                  )}
                                </div>
                              );
                            });
                          })()}
                        </div>
                      )}
                      <div style={{ fontSize: 13, color: "#9aa4b6" }}>
                        {planCanceling
                          ? "canceling — waiting for the worker to stop this run"
                          : plan?.status === "running"
                            ? (plan.progress_note && !/^(Writer|Story editor|Cinematographer|Continuity|Production)/.test(plan.progress_note)
                                ? plan.progress_note : null)
                            : "waiting for the worker — the studio cloud must be up"}
                      </div>
                      {!planCanceling && plan?.progress != null && plan.progress > 0 && (
                        <div style={{ width: 260, height: 4, borderRadius: 2, background: "rgba(255,255,255,.08)" }}>
                          <div style={{ width: `${Math.round(plan.progress * 100)}%`, height: "100%",
                                        borderRadius: 2, background: "#5aa2ff" }} />
                        </div>
                      )}
                      {/* Stopping the run was only ever possible from the queue
                          popover — a surface the wizard covers. The button is
                          here so the cancel and the screen that reports it are
                          the same screen. */}
                      {plan && !planCanceling && (plan.status === "queued" || plan.status === "running") && (
                        <button className="ws-ghost" disabled={canceling === true}
                                onClick={async () => {
                                  setCanceling(true);
                                  try { await cancelJob(plan.id); setCanceling(false); }
                                  catch (e) { setCanceling(String((e as Error).message || e)); }
                                }}>
                          {canceling === true ? "canceling…" : "Cancel planning"}
                        </button>
                      )}
                      {typeof canceling === "string" && (
                        <div style={{ fontSize: 12.5, color: "#ff8080", maxWidth: 420, textAlign: "center" }}>
                          Could not cancel — {canceling}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="ns-scroll" style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "22px 24px",
                                                    display: "flex", flexDirection: "column", gap: 20 }}>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 14 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-.02em" }}>Who's in it, where, and with what</div>
                      <div style={{ fontSize: 13, lineHeight: 1.6, color: "#9aa4b6", marginTop: 6, maxWidth: 520 }}>
                        Pulled from the bible where they exist, drafted where they don't. Every identity line
                        here is what gets repeated verbatim into every shot — fix them now, not after {blockCount} blocks render.
                      </div>
                    </div>
                  </div>
                  {!world && (
                    // The plan is done but its storyboard hasn't come back yet.
                    // Saying so beats rendering an empty cast, which reads as
                    // "the planner produced nobody".
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#5e6678" }}>
                      <Loader2 size={13} className="ns-spin" />loading the cast the planner drafted…
                    </div>
                  )}
                  {/* The sheets bar — see the component for why it is at the
                      top and why it carries the model picker. Guarded on
                      `world`: with the bible still loading every list here is
                      empty, and the calm state says every location has a
                      reference, which would be a lie about a bible nobody has
                      read yet. */}
                  {world && (
                    <CastWorldRefsBar
                      pending={pendingRefs} drawing={drawingRefs}
                      models={sheetModels} model={imageModel} onModel={setImageModel}
                      queuing={refsQueuing} onGenerate={() => void generateMissingRefs()}
                      redrawable={redrawableRefs.length}
                      onRedrawAll={() => setRedrawAsk(true)}
                      onOpen={setEntryModal} />
                  )}
                  {redrawAsk && (
                    <RedrawSheetsDialog
                      characters={redrawableRefs.filter((e) => e.kind === "character").length}
                      environments={redrawableRefs.filter((e) => e.kind === "environment").length}
                      props={redrawableRefs.filter((e) => e.kind === "prop").length}
                      busy={refsQueuing}
                      onCancel={() => setRedrawAsk(false)}
                      onConfirm={() => void redrawAllRefs()} />
                  )}
                  {/* Directly under the sheets bar and above the cast grid: the
                      two are the same chore about the same people, and a voice
                      is the other half of what a block is handed about a
                      character. It renders nothing when nobody speaks. */}
                  {world && (
                    <CastWorldVoiceBar
                      pending={pendingVoices} drawing={drawingVoices} done={doneVoices}
                      engine={voiceValue} engineName={voicePick?.name ?? dialogueProvider}
                      blocked={voiceBlocked?.why ?? null}
                      offers={voiceRows}
                      onPick={(p) => {
                        const { id, tier: t } = parsePick(p);
                        setDialogueProvider(id as DialogueProvider);
                        setVoicePlane(t);
                      }}
                      onFix={(tab) => ws.openModal({ kind: "engine", tab })}
                      admin={isAdmin} blurbs={VOICE_BLURBS}
                      queuing={voicesQueuing}
                      onGenerate={() => void generateMissingVoices()}
                      onOpen={setEntryModal} />
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className="ws-mlabel">Cast · {world?.bible.filter((b) => b.kind === "character").length ?? 0}</span>
                      <span style={{ height: 1, flex: 1, background: "linear-gradient(90deg, rgba(255,255,255,.12), transparent)" }} />
                    </div>
                    {/* `stretch`, not `start`: with `start` every card sizes to
                        its own identity line and the row comes out staggered.
                        The cards below push their button row to the bottom with
                        `marginTop: auto`, so stretching lines those up too. */}
                    <div style={{ display: "grid", gap: 12, alignItems: "stretch",
                                  gridTemplateColumns: "repeat(auto-fill, minmax(248px, 1fr))" }}>
                      {(world?.bible.filter((b) => b.kind === "character") ?? []).map((c) => {
                        const refs = (world?.links ?? []).filter((l) => l.entry_id === c.id);
                        const own = userSupplied(refs, world?.assets);
                        // Show the picture the USER supplied, not whichever
                        // slot-0 row came back first — it is the one they are
                        // looking for, and it is the one the render will use.
                        const a = (own ?? refs[0]) ? world?.assets.get((own ?? refs[0]).asset_id) : null;
                        const inflight = sheetInFlight(c.id);
                        const ready = refs.length >= 2 && !inflight;
                        const vAsset = c.voice_ref_asset_id ? world?.assets.get(c.voice_ref_asset_id) : null;
                        const vUrl = vAsset ? assetUrl(vAsset) : null;
                        const vInflight = voiceInFlight(c.id) || voiceQueuingId === c.id;
                        const isPlayingVoice = playingVoiceId === c.id;
                        return (
                          <div key={c.id} className="ws-card"
                               style={{ display: "flex", gap: 13,
                                        borderColor: ready ? "rgba(111,208,140,.28)" : inflight ? "rgba(232,194,104,.3)" : "rgba(201,122,255,.3)",
                                        background: ready ? "rgba(111,208,140,.05)" : inflight ? "rgba(232,194,104,.05)" : "rgba(201,122,255,.04)" }}>
                            <div style={{ width: 74, flexShrink: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                              <button title={`Open ${c.name} — every reference, and the fields that drive them`}
                                      onClick={() => setEntryModal(c.id)}
                                      style={{ position: "relative", aspectRatio: "1", borderRadius: 15,
                                               overflow: "hidden",
                                               background: "#0b0e14", padding: 0, width: "100%",
                                               cursor: "pointer",
                                               border: own ? "1px solid rgba(90,162,255,.5)" : "1px solid rgba(255,255,255,.08)" }}>
                                {a && <img src={assetUrl(a) ?? undefined} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                                {own && (
                                  <span className="mono"
                                        style={{ position: "absolute", left: 4, top: 4, padding: "2px 5px",
                                                 borderRadius: 7, background: "rgba(90,162,255,.9)",
                                                 fontSize: 8, fontWeight: 700, color: "#07090e" }}>
                                    YOURS
                                  </span>
                                )}
                              </button>
                              <span className="mono" style={{ fontSize: 10, fontWeight: 500, textAlign: "center",
                                                              color: ready ? "#6fd08c" : inflight ? "#e8c268" : "#c97aff" }}>
                                {ready ? `ready · ${refs.length} refs` : inflight ? "generating sheet" : "needs refs"}
                              </span>
                            </div>
                            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                              <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
                                <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: "-.01em" }}>{c.name}</span>
                                <span className="mono" style={{ fontSize: 11.5, color: "#5e6678" }}>
                                  {c.status === "confirmed" ? `bible v${c.version}` : "new"}
                                </span>
                              </div>
                              <textarea rows={3} className="ws-noborder" defaultValue={c.identity_line ?? ""}
                                        onBlur={(e) => e.target.value !== (c.identity_line ?? "") &&
                                          supabase.from("bible_entries").update({ identity_line: e.target.value })
                                            .eq("id", c.id).then(() => reloadWorld())} />
                              {/* The card is a summary you click INTO — "more
                                  refs" spent a render from a surface that
                                  cannot show you what it drew, and the entry
                                  modal has the same action next to every
                                  existing sheet, the slots and the fields the
                                  render reads. What stays here is the pair that
                                  is about this card: redraw the set, drop the
                                  draft. */}
                              <div style={{ display: "flex", gap: 7, marginTop: "auto", flexWrap: "wrap", alignItems: "center" }}>
                                {vUrl ? (
                                  <>
                                    <button
                                      type="button"
                                      className={`ws-microbtn${isPlayingVoice ? " accent" : ""}`}
                                      style={{ height: 28, padding: "0 8px", gap: 5, opacity: vInflight ? 0.6 : 1 }}
                                      disabled={vInflight}
                                      title={vInflight ? "Voice is regenerating..." : isPlayingVoice ? `Pause voice clip for ${c.name}` : `Play voice clip for ${c.name}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleVoicePreview(c.id, vUrl);
                                      }}
                                    >
                                      {isPlayingVoice ? <Pause size={11} /> : <Play size={11} />}
                                      <span>Voice</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="ws-microbtn sq"
                                      title={vInflight ? "Voice is regenerating..." : `Regenerate voice reference for ${c.name}`}
                                      disabled={vInflight}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void regenVoiceRef(c);
                                      }}
                                    >
                                      {vInflight ? <Loader2 size={11} className="ns-spin" /> : <RefreshCw size={11} />}
                                    </button>
                                  </>
                                ) : vInflight ? (
                                  <span
                                    className="ws-microbtn ghost"
                                    style={{ height: 28, padding: "0 8px", gap: 5, color: "#e8c268", borderColor: "rgba(232,194,104,.3)", cursor: "default" }}
                                    title="Voice reference is generating..."
                                  >
                                    <Loader2 size={11} className="ns-spin" />
                                    <span>Voice</span>
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    className="ws-microbtn"
                                    style={{ height: 28, padding: "0 8px", gap: 5 }}
                                    title={`Record voice reference for ${c.name}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void regenVoiceRef(c);
                                    }}
                                  >
                                    <RefreshCw size={11} />
                                    <span>Voice</span>
                                  </button>
                                )}
                                {refs.length > 0 && (
                                  <button className="ws-microbtn sq" title="Clear these refs and generate a new variation"
                                          disabled={!!inflight}
                                          onClick={() => void regenRefs(c)}>
                                    <RefreshCw size={11} />
                                  </button>
                                )}
                                {c.status !== "confirmed" && (
                                  <button className="ws-microbtn" title="Drop this draft"
                                          style={{ height: 28, padding: "0 9px", fontSize: 11.5, color: "#5e6678" }}
                                          onClick={async () => {
                                            await deleteDraftEntry(c.id).catch((e: Error) => setChatErr(e.message));
                                            reloadWorld();
                                          }}>
                                    <Trash2 size={11} />
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      <AddEntryCard kind="character" onOpen={() => setAddKind("character")} />
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className="ws-mlabel">World · {world?.bible.filter((b) => b.kind === "environment").length ?? 0}</span>
                      <span style={{ height: 1, flex: 1, background: "linear-gradient(90deg, rgba(255,255,255,.12), transparent)" }} />
                    </div>
                    <div style={{ display: "grid", gap: 12, alignItems: "stretch",
                                  gridTemplateColumns: "repeat(auto-fill, minmax(158px, 1fr))" }}>
                      {(world?.bible.filter((b) => b.kind === "environment") ?? []).map((e) => {
                        const refs = (world?.links ?? []).filter((l) => l.entry_id === e.id);
                        const own = userSupplied(refs, world?.assets);
                        const a = (own ?? refs[0]) ? world?.assets.get((own ?? refs[0]).asset_id) : null;
                        const isNew = !refs.length;
                        return (
                          <div key={e.id} style={{ display: "flex", flexDirection: "column", gap: 8,
                                                   height: "100%" }}>
                            <button title={`Open ${e.name} — every plate, and the fields that drive them`}
                                    onClick={() => setEntryModal(e.id)}
                                    style={{ position: "relative", aspectRatio: "16/10", borderRadius: 16,
                                             overflow: "hidden", background: "#0b0e14", padding: 0, width: "100%",
                                             cursor: "pointer",
                                             border: own ? "1px solid rgba(90,162,255,.5)"
                                               : isNew ? "1px solid rgba(201,122,255,.3)" : "1px solid rgba(255,255,255,.08)" }}>
                              {a && <img src={assetUrl(a) ?? undefined} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                              {(own || isNew) && (
                                <span className="mono" style={{ position: "absolute", left: 8, top: 8, padding: "3px 8px",
                                                                borderRadius: 10,
                                                                background: own ? "rgba(90,162,255,.9)" : "rgba(201,122,255,.85)",
                                                                fontSize: 9, fontWeight: 700, color: "#07090e" }}>
                                  {own ? "YOURS" : "NEW"}
                                </span>
                              )}
                            </button>
                            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600,
                                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {e.name}
                                </span>
                                {e.status !== "confirmed" && (
                                  <button title="Drop this draft" style={{ color: "#5e6678", cursor: "pointer", flexShrink: 0 }}
                                          onClick={async () => {
                                            await deleteDraftEntry(e.id).catch((err: Error) => setChatErr(err.message));
                                            reloadWorld();
                                          }}>
                                    <Trash2 size={11} />
                                  </button>
                                )}
                              </div>
                              {/* The line renders, so it has to be editable here — sending
                                  someone to another page to fix six words is how wrong
                                  identity lines end up in every block. */}
                              <textarea rows={2} className="ws-noborder" defaultValue={e.identity_line ?? e.summary ?? ""}
                                        style={{ fontSize: 11.5, lineHeight: 1.5, color: "#9aa4b6", marginTop: 2, width: "100%" }}
                                        placeholder="What it looks like — materials, light, weather"
                                        onBlur={(ev) => ev.target.value !== (e.identity_line ?? "") &&
                                          supabase.from("bible_entries").update({ identity_line: ev.target.value })
                                            .eq("id", e.id).then(() => reloadWorld())} />
                              <div style={{ display: "flex", gap: 6, marginTop: "auto", paddingTop: 4 }}>
                                {refs.length > 0 && (
                                  <button className="ws-microbtn sq" style={{ height: 26, width: 26 }}
                                          title="Clear this ref and generate a new variation"
                                          disabled={!!sheetInFlight(e.id)}
                                          onClick={() => void regenRefs(e)}>
                                    <RefreshCw size={11} />
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      <AddEntryCard kind="environment"
                                    onOpen={() => setAddKind("environment")} />
                    </div>
                  </div>
                  {/* Props draft here exactly like cast and locations do, and
                      until now this step showed none of them — so the one place
                      built for reviewing what the planner invented hid a third
                      of it. They are worth the room: a prop sheet stages into
                      blocks as a `look` ref, and an unanchored prop is what
                      turned a polaroid into a blank white rectangle mid-shot.
                      Duplicates land here too ("Cloudy Glass Marbles" beside
                      "Contained Black Hole Marble"), and dropping one is a
                      click that was previously only available on the Bible
                      page — after the draft had been committed. */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className="ws-mlabel">Props · {world?.bible.filter((b) => b.kind === "prop").length ?? 0}</span>
                      <span style={{ height: 1, flex: 1, background: "linear-gradient(90deg, rgba(255,255,255,.12), transparent)" }} />
                    </div>
                    <div style={{ display: "grid", gap: 12, alignItems: "stretch",
                                  gridTemplateColumns: "repeat(auto-fill, minmax(142px, 1fr))" }}>
                      {(world?.bible.filter((b) => b.kind === "prop") ?? []).map((p) => {
                        const refs = (world?.links ?? []).filter((l) => l.entry_id === p.id);
                        const own = userSupplied(refs, world?.assets);
                        const a = (own ?? refs[0]) ? world?.assets.get((own ?? refs[0]).asset_id) : null;
                        const isNew = !refs.length;
                        // The exact printed text is the one field that renders
                        // ON the sheet, so it is captioned ON the sheet —
                        // reading "Remember this love, Rei." across the picture
                        // is how you catch the model typesetting its own words.
                        // Overlaid rather than stacked under the name because
                        // only some props have one, and a row that appears on
                        // one card in eight is what makes a grid staggered.
                        // Editing it stays in the entry modal, like every other
                        // doc field.
                        const reads = typeof (p.doc as Record<string, unknown>)?.reads === "string"
                          ? ((p.doc as Record<string, string>).reads).trim() : "";
                        return (
                          <div key={p.id} style={{ display: "flex", flexDirection: "column", gap: 8,
                                                   height: "100%" }}>
                            <button title={`Open ${p.name} — its sheet, and the text and anchors that drive it`}
                                    onClick={() => setEntryModal(p.id)}
                                    style={{ position: "relative", aspectRatio: "1", borderRadius: 16,
                                             overflow: "hidden", background: "#0b0e14", padding: 0, width: "100%",
                                             cursor: "pointer",
                                             border: own ? "1px solid rgba(90,162,255,.5)"
                                               : isNew ? "1px solid rgba(201,122,255,.3)" : "1px solid rgba(255,255,255,.08)" }}>
                              {a && <img src={assetUrl(a) ?? undefined} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                              {(own || isNew) && (
                                <span className="mono" style={{ position: "absolute", left: 7, top: 7, padding: "3px 7px",
                                                                borderRadius: 10,
                                                                background: own ? "rgba(90,162,255,.9)" : "rgba(201,122,255,.85)",
                                                                fontSize: 9, fontWeight: 700, color: "#07090e" }}>
                                  {own ? "YOURS" : "NEW"}
                                </span>
                              )}
                              {!!reads && (
                                <span className="mono" title={reads}
                                      style={{ position: "absolute", left: 0, right: 0, bottom: 0,
                                               padding: "5px 7px", textAlign: "left", fontSize: 9.5,
                                               lineHeight: 1.35, color: "#ffcf8a",
                                               background: "linear-gradient(transparent, rgba(6,8,12,.9) 55%)",
                                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  “{reads}”
                                </span>
                              )}
                            </button>
                            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600,
                                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                      title={p.name}>
                                  {p.name}
                                </span>
                                {p.status !== "confirmed" && (
                                  <button title="Drop this draft" style={{ color: "#5e6678", cursor: "pointer", flexShrink: 0 }}
                                          onClick={async () => {
                                            await deleteDraftEntry(p.id).catch((err: Error) => setChatErr(err.message));
                                            reloadWorld();
                                          }}>
                                    <Trash2 size={11} />
                                  </button>
                                )}
                              </div>
                              <textarea rows={2} className="ws-noborder" defaultValue={p.identity_line ?? p.summary ?? ""}
                                        style={{ fontSize: 11.5, lineHeight: 1.5, color: "#9aa4b6", marginTop: 2, width: "100%" }}
                                        placeholder="What it is — material, size, wear"
                                        onBlur={(ev) => ev.target.value !== (p.identity_line ?? p.summary ?? "") &&
                                          supabase.from("bible_entries").update({ identity_line: ev.target.value })
                                            .eq("id", p.id).then(() => reloadWorld())} />
                              <div style={{ display: "flex", gap: 6, marginTop: "auto", paddingTop: 4 }}>
                                {refs.length > 0 && (
                                  <button className="ws-microbtn sq" style={{ height: 26, width: 26 }}
                                          title="Clear this ref and generate a new variation"
                                          disabled={!!sheetInFlight(p.id)}
                                          onClick={() => void regenRefs(p)}>
                                    <RefreshCw size={11} />
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      <AddEntryCard kind="prop" onOpen={() => setAddKind("prop")} />
                    </div>
                  </div>
                </div>
                <ChatSidebar
                  subtitle="knows the brief · can add cast, locations, refs"
                  messages={messages} live={live}
                  draft={sideDraft} setDraft={setSideDraft}
                  onSend={() => void askAboutCast()} busy={!!live}
                  notice={notice} err={chatErr}
                  hint={'Ask for what\'s missing — "give Leon a costume change for the docks", ' +
                        '"add the reactor corridor", "who else should be in this?"'}>
                  <button className="ws-primary" style={{ height: 38, justifyContent: "center" }}
                          onClick={() => setStep(3)}>
                    Review the storyboard<ChevronRight size={14} />
                  </button>
                  {!!world?.sheetJobs.length && (
                    <div className="mono" style={{ fontSize: 10.5, color: "#e8c268", textAlign: "center" }}>
                      {world!.sheetJobs.length} sheet{world!.sheetJobs.length > 1 ? "s" : ""} generating
                    </div>
                  )}
                </ChatSidebar>
              </>
            )}
          </div>
        )}

        {/* ─── step 3: storyboard review ─── */}
        {/* A session restored onto step 3 arrives before the storyboard query
            does — and an empty modal reads as a lost draft. */}
        {step === 3 && !world && (
          <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 14, color: "#9aa4b6" }}>
              <Loader2 size={16} className="ns-spin" style={{ color: "#5aa2ff" }} />
              {planDone ? "loading the storyboard…" : "the storyboard isn't planned yet"}
            </div>
          </div>
        )}
        {step === 3 && world && (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <div className="ns-scroll" style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "20px 24px 24px" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-.015em" }}>Here's the episode. Change anything.</div>
                  <div style={{ fontSize: 13.5, color: "#9aa4b6", marginTop: 5 }}>
                    {world.scenes.length} scenes · ~{blockCount} blocks · {totalS.toFixed(1)}s ·
                    drag a scene by its grip to re-order; every field is editable in the
                    scene editor, and edits re-plan the blocks.
                  </div>
                </div>
                <span style={{ flex: 1 }} />
                {/* The storyboard is the PANELS — one per shot — so the bulk
                    action draws them, not the single key still it used to
                    queue. A scene that already has panels is skipped rather
                    than rolled again: drawing redraws a whole scene, and this
                    button is "fill in what is blank", not "do it all over".
                    Re-drawing one scene is its own button in the column. */}
                {scenesNeedingPanels.length > 0 && (
                  <button className="ws-pillbtn" style={{ height: 28 }} disabled={panelsQueuing}
                          title={`Draw one panel per shot for ${scenesNeedingPanels.length} `
                            + `scene${scenesNeedingPanels.length === 1 ? "" : "s"} with none yet, `
                            + "anchored on each scene's cast and location sheets"}
                          onClick={() => void (async () => {
                            setPanelsQueuing(true);
                            try { await queueAllPanels(); } finally { setPanelsQueuing(false); }
                          })()}>
                    {panelsQueuing ? <Loader2 size={12} className="ns-spin" /> : <ImagePlus size={12} />}
                    Generate storyboard panels
                  </button>
                )}
                {/* Both meanings of "re-plan", behind one button. The popup
                    takes the note once and then asks which route it should
                    take: the director editing these scenes in the chat (free,
                    instant, keeps the panels) or the full planning studio
                    writing version N+1 on the pod. Steering straight into
                    either one is what made this button wrong in both
                    directions — first it queued a plan that discarded the
                    scenes on screen, then it could only ever edit them. */}
                <button className="ws-pillbtn" style={{ height: 28 }} disabled={replanRunning}
                        title={replanRunning
                          ? "a new version is already being written"
                          : "Rewrite the storyboard — edit these scenes, or plan a new version"}
                        onClick={() => { setReplanErr(null); setReplanOpen(true); }}>
                  <RefreshCw size={12} />Re-plan
                </button>
              </div>
              {/* A re-plan takes minutes on the pod, and the list underneath is
                  deliberately still the version being replaced — so without
                  this the button just goes quiet and the page looks unchanged.
                  `progress_note` is the department the plan is with. */}
              {replan && (replanRunning || replan.status === "error" || replan.status === "canceled") && (
                <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10,
                              padding: "7px 11px", borderRadius: 12, fontSize: 12,
                              border: `1px solid ${replan.status === "error" ? "rgba(255,90,90,.3)" : "rgba(90,162,255,.3)"}`,
                              background: replan.status === "error" ? "rgba(255,90,90,.07)" : "rgba(90,162,255,.07)",
                              color: replan.status === "error" ? "#ff8080" : "#9dc4ff" }}>
                  {replanRunning
                    ? <Loader2 size={12} className="ns-spin" style={{ flexShrink: 0 }} />
                    : <AlertTriangle size={12} style={{ flexShrink: 0 }} />}
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden",
                                 textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {replan.status === "error"
                      ? `The new version failed — ${describeDirectorError(replan.error_msg ?? "unknown error")}`
                      : replan.status === "canceled"
                        ? "The new version was canceled — this storyboard is unchanged."
                        : replan.cancel_requested
                          ? "stopping…"
                          : replan.progress_note
                            || (replan.status === "queued"
                                ? "waiting for the worker — the studio cloud must be up"
                                : "writing a new version…")}
                  </span>
                  {replanRunning
                    ? (
                      <button className="ws-ghost" style={{ height: 24 }}
                              disabled={!!replan.cancel_requested}
                              onClick={() => void cancelJob(replan.id)}>
                        Cancel
                      </button>
                    ) : (
                      <button onClick={() => setReplanJobId(null)}
                              style={{ color: "inherit", opacity: .6, cursor: "pointer" }}>
                        <X size={11} />
                      </button>
                    )}
                </div>
              )}
              {drag.error && (
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10,
                              padding: "5px 9px", borderRadius: 10, fontSize: 12,
                              border: "1px solid rgba(255,90,90,.3)", background: "rgba(255,90,90,.07)",
                              color: "#ff8080" }}>
                  <AlertTriangle size={12} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis",
                                 whiteSpace: "nowrap" }} title={drag.error}>
                    couldn't re-order: {drag.error}
                  </span>
                  <button onClick={drag.clearError} style={{ color: "inherit", opacity: .6, cursor: "pointer" }}>
                    <X size={11} />
                  </button>
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }} {...drag.listProps}>
                {byIds(world.scenes, drag.ids).map((s, i) => {
                  const still = s.still_asset_id ? world.assets.get(s.still_asset_id) : null;
                  const beats = world.beats.get(s.id) ?? [];
                  // The scene's storyboard, in shot order. A breath beat is a
                  // wordless hold the panel queue deliberately skips (it stages
                  // the place alone), so it is not a tile that will never fill.
                  const shots = beats.filter((b) => !b.meta?.breath);
                  const drawn = shots.filter((b) => beatImageId(b).id).length;
                  const firstDlg = beats.flatMap((b) => b.dialogue ?? [])[0];
                  const speaker = firstDlg ? world.bible.find((b) => b.id === firstDlg.speaker_id) : null;
                  const stillJob = stillInFlight(s.id);
                  const panelJob = shots.some((b) => panelsPending.has(b.id));
                  const shotsOpen = openShots.has(s.id);
                  const nameOf = (d: { speaker_id: string; speaker?: string }) =>
                    world.bible.find((b) => b.id === d.speaker_id)?.name ?? d.speaker ?? "?";
                  // One drop line per gap: the row below a gap owns it, and the
                  // last row owns the one under the list. Marking both sides of
                  // a gap draws two lines 10px apart.
                  const last = i === drag.ids.length - 1;
                  return (
                    // CLICKING THE SCENE OPENS THE SCENE — anywhere on the
                    // row, not only on the picture. The row IS the scene, and
                    // the editor is the one surface that holds every field of
                    // it; two small targets (the thumbnail and the slug) in a
                    // row this wide read as the rest of it being inert. The
                    // guard is what keeps that from swallowing the controls
                    // that live inside: every one of them is a <button> and
                    // handles its own click, so anything landing inside one is
                    // left alone rather than opening a modal over it.
                    <div key={s.id} {...drag.rowProps(s.id)}
                         role="button" tabIndex={0}
                         title="Open the scene editor"
                         onClick={(e) => {
                           if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
                           setSceneModal(s.id);
                         }}
                         onKeyDown={(e) => {
                           if (e.target !== e.currentTarget) return;
                           if (e.key === "Enter" || e.key === " ") {
                             e.preventDefault();
                             setSceneModal(s.id);
                           }
                         }}
                         className={"ws-dragrow"
                           + (drag.dragId === s.id ? " dragging" : "")
                           + (drag.dragId && drag.gap === i ? " dropbefore" : "")
                           + (drag.dragId && last && drag.gap === drag.ids.length ? " dropafter" : "")}
                         style={{ display: "flex", gap: 12, padding: 11, borderRadius: 16,
                                  textAlign: "left", color: "inherit", cursor: "pointer",
                                  border: "1px solid rgba(255,255,255,.08)", background: "rgba(255,255,255,.025)" }}>
                      <button className="ws-grip" {...drag.handleProps(s.id)}
                              title="Drag to re-order — or focus and press ↑ / ↓">
                        <GripVertical size={13} />
                      </button>
                      {/* THE SCENE'S STORYBOARD — one panel per shot, in
                          reading order, the same column the storyboard page
                          draws and through the same generator (lib/panels.ts).
                          It used to be a single "key still": one arbitrary
                          frame standing in for the whole scene, which says
                          nothing about coverage. A storyboard IS the panels.
                          `.sb-panelgrid` / `.sb-panel` are shared with that
                          page rather than restyled — the tiles have to read
                          identically in both, and the classes carry the
                          absolutely-positioned image that keeps a grid of
                          frames from depending on when each one loads. The
                          wrapper is inline-styled rather than `.sb-stillcol`,
                          which flips to a ROW under 900px for the storyboard
                          card's own layout. */}
                      <div style={{ width: 176, flexShrink: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                        {/* No `onOpen`: an inert tile lets the click reach the
                            ROW, which opens the scene editor — the page's own
                            grid opens a lightbox instead, which is why the
                            handler is the caller's. `sceneNo` is the position
                            on screen rather than the stored idx: for the round
                            trip after a drag they disagree, and the number the
                            user just moved has to be the one that moved. */}
                        <ScenePanelGrid beats={shots} sceneNo={i + 1}
                                        assetOf={(id) => (id ? world.assets.get(id) : null)}
                                        busy={(b) => panelsPending.get(b.id) ?? (queuingSceneId === s.id ? { status: "queued" } : null)} />
                        <div style={{ display: "flex", gap: 6 }}>
                          {/* One click, and the cast and location sheets go in
                              as references — that is what makes the panels match
                              the people the blocks will render. */}
                          <button className="ws-microbtn accent"
                                  style={{ height: 26, fontSize: 10.5, flex: 1, justifyContent: "center" }}
                                  disabled={panelJob || queuingSceneId === s.id || !shots.length}
                                  title={shots.length
                                    ? "One panel per shot, anchored on this scene's cast and location sheets"
                                    : "This scene has no shots to draw yet"}
                                  onClick={() => void generatePanels(s)}>
                            {panelJob || queuingSceneId === s.id
                              ? <Loader2 size={10} className="ns-spin" />
                              : drawn ? "Re-draw" : "Draw panels"}
                          </button>
                          {/* The key still is display-only material (the scene
                              card's thumbnail, the collapsed storyboard row), so
                              it keeps its generator and loses the width — the
                              panels are what this column is for now. */}
                          <button className="ws-microbtn sq" style={{ height: 26, width: 26 }}
                                  disabled={!!stillJob}
                                  title={still
                                    ? "Draw a new key still — the one frame that stands for this scene on a card"
                                    : "Draw the key still — the one frame that stands for this scene on a card"}
                                  onClick={() => void generateStill(s)}>
                            {stillJob ? <Loader2 size={10} className="ns-spin" /> : <ImagePlus size={11} />}
                          </button>
                        </div>
                        {/* No "· key still kept" tail here, unlike the page's
                            200px column: at 176px it wraps the 9px note onto a
                            second line, and the still's own button already says
                            what it is. */}
                        {shots.length > 0 && (
                          <div className="sb-stillnote">{drawn} of {shots.length} shots drawn</div>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <button style={{ fontSize: 14.5, fontWeight: 600, cursor: "pointer", color: "inherit",
                                           padding: 0, textAlign: "left" }}
                                  title="Open the scene editor"
                                  onClick={() => setSceneModal(s.id)}>
                            {s.slug ?? `Scene ${i + 1}`}
                          </button>
                          <span style={{ flex: 1 }} />
                          {/* The metric was already the shot count, so it is the
                              disclosure — a separate "show beats" control would
                              be a second thing on the row saying the same
                              number. */}
                          <button className="mono" disabled={!beats.length}
                                  title={beats.length
                                    ? shotsOpen ? "Hide the shots" : "Show every shot and its dialogue"
                                    : "No shots planned for this scene"}
                                  onClick={() => toggleShots(s.id)}
                                  style={{ display: "flex", alignItems: "center", gap: 5, padding: 0,
                                           fontSize: 11.5, color: shotsOpen ? "#c8cfdb" : "#5e6678",
                                           cursor: beats.length ? "pointer" : "default" }}>
                            {(s.duration_ms / 1000).toFixed(1)}s · {beats.length} beats
                            {!!beats.length && (
                              <ChevronDown size={12} style={{ transition: "transform .15s ease",
                                                              transform: shotsOpen ? "rotate(180deg)" : "none" }} />
                            )}
                          </button>
                        </div>
                        {/* The prose and the quote take the height the panel
                            column leaves, rather than clamping at two lines
                            beside three rows of storyboard. See `.ws-scenefill`
                            for why the pair is wrapped and why the wrapper is
                            what grows. */}
                        <div className={"ws-scenefill" + (shotsOpen ? " open" : "")}>
                          <SceneDesc text={s.scene_prompt ?? beats[0]?.action ?? ""} />
                          {/* Collapsed, one line of dialogue says the scene has
                              some. Open, the same line is the first row below —
                              so it goes, rather than being printed twice. */}
                          {firstDlg && !shotsOpen && (
                            <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexShrink: 0 }}>
                              <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: "#ffb454", flexShrink: 0 }}>
                                {(speaker?.name ?? firstDlg.speaker ?? "?").toUpperCase()}
                              </span>
                              <span style={{ fontSize: 13, lineHeight: 1.5, color: "#dfe4ec", fontStyle: "italic",
                                             overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                "{firstDlg.line}"
                              </span>
                            </div>
                          )}
                        </div>
                        {shotsOpen && (
                          // The shot list is a READ, and every row opens the
                          // scene editor rather than editing in place: a beat
                          // carries an action, a camera line and its dialogue,
                          // and three inline editors per shot on a review screen
                          // is the panel this step already replaced once. The
                          // two ways to change one are the editor and the chat
                          // beside it — which knows these ids (storyboardContext
                          // sends beat_id) and writes to a published table, so
                          // an edit lands in this list without a reload.
                          <div style={{ marginTop: 2, borderTop: "1px solid rgba(255,255,255,.07)" }}>
                            {beats.map((b, bi) => (
                              <div key={b.id}
                                   style={{ display: "grid", gridTemplateColumns: "34px minmax(0, 1fr)",
                                            gap: 10, padding: "8px 0",
                                            borderTop: bi ? "1px solid rgba(255,255,255,.05)" : undefined }}>
                                <div className="mono" style={{ display: "flex", flexDirection: "column", gap: 3,
                                                               fontSize: 10, color: "#5e6678", paddingTop: 1 }}>
                                  <span style={{ color: "#9aa4b6", fontWeight: 600 }}>{bi + 1}</span>
                                  <span>{(b.duration_ms / 1000).toFixed(1)}s</span>
                                </div>
                                <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                                  {b.camera && (
                                    <div className="mono" style={{ fontSize: 10, letterSpacing: ".04em",
                                                                   color: "#75798c", overflow: "hidden",
                                                                   textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                         title={b.camera}>
                                      {b.camera}
                                    </div>
                                  )}
                                  <button onClick={() => setSceneModal(s.id)}
                                          title="Open the scene editor to change this shot"
                                          style={{ fontSize: 12.5, lineHeight: 1.5, color: "#aeb6c6",
                                                   textAlign: "left", padding: 0, cursor: "pointer" }}>
                                    {b.action}
                                  </button>
                                  {(b.dialogue ?? []).map((d, di) => (
                                    <div key={di} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                                      <span className="mono" style={{ fontSize: 10, fontWeight: 600, color: "#ffb454",
                                                                      flexShrink: 0 }}>
                                        {nameOf(d).toUpperCase()}
                                      </span>
                                      <span style={{ minWidth: 0, fontSize: 12.5, lineHeight: 1.5,
                                                     color: "#dfe4ec", fontStyle: "italic" }}>
                                        "{d.line}"
                                        {d.delivery && (
                                          <span className="mono" style={{ fontStyle: "normal", color: "#5e6678",
                                                                          fontSize: 10 }}> · {d.delivery}</span>
                                        )}
                                      </span>
                                    </div>
                                  ))}
                                  {b.sfx && (
                                    // Dim grey, the colour the storyboard page
                                    // gives sfx: it is ambient detail, and a
                                    // tinted line on a review screen reads as a
                                    // status about the shot.
                                    <div className="mono" style={{ fontSize: 10, color: "#5e6678",
                                                                   overflow: "hidden", textOverflow: "ellipsis",
                                                                   whiteSpace: "nowrap" }} title={b.sfx}>
                                      sfx · {b.sfx}
                                    </div>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <ChatSidebar
              subtitle="reads the scenes · can change them"
              messages={messages} live={live}
              draft={sideDraft} setDraft={setSideDraft}
              onSend={() => void askAboutStoryboard()} busy={!!live}
              notice={notice} err={chatErr}
              inputRef={sideInputRef}
              hint={'Change it by asking — "S3 is too long, cut it to 20s", ' +
                    '"give the mentor the last line", "make S1 a slow push-in".'}>
              <button className="ws-primary" style={{ height: 38, justifyContent: "center" }}
                      onClick={() => setStep(4)}>
                Approve &amp; pick models<ChevronRight size={14} />
              </button>
              <div className="mono" style={{ fontSize: 10.5, color: "#5e6678", textAlign: "center" }}>
                {world.scenes.length} scenes · {blockCount} blocks · {totalS.toFixed(1)}s
              </div>
            </ChatSidebar>
          </div>
        )}

        {/* ─── step 4: models & render ─── */}
        {step === 4 && (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <div className="ns-scroll" style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "22px 26px" }}>
              <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-.015em" }}>What should render this, and how big?</div>
              {/* WHERE THE PLAN WILL RUN, said before it is queued rather than
                  discovered as a stalled queue. `planHere` is what decides,
                  and `podStillNeeded` is honest per KIND: sheets and panels
                  render here when the model is one this machine holds, voice
                  references when there is a speech key of your own, and a
                  LOCAL project routes both because the pod cannot see its
                  rows at all. What is left over is named. */}
              {planWhere && (
                <div className="ws-card" style={{ marginTop: 12, fontSize: 11.5,
                                                  color: "#c7cddb", lineHeight: 1.6 }}>
                  <b>Planning runs on this machine</b> — {planWhere.why}. Nothing of the
                  studio&rsquo;s, and it works offline.
                  {planWhere.pod.length > 0 ? (
                    <> The studio cloud is still needed for{" "}
                    {planWhere.pod.join(", ")}; those jobs wait until it is online.</>
                  ) : (
                    <> Everything it queues runs here too, including the blocks.</>
                  )}
                </div>
              )}
              {/* THE BLOCKS ARE THEIR OWN ANSWER, and it is about the WEIGHTS.
                  A machine can plan an episode perfectly and still not have
                  the 57GB the render needs — or have them and be on a model
                  this build's desktop map does not carry (H3's turbo twin
                  needs a node pack the installer does not add). Said here so
                  the fix is "download it" rather than twenty blocks failing a
                  minute apart. */}
              {!renderHere && !queueBlocked && whyNotHere?.why && (
                <div className="ws-card" style={{ marginTop: 8, fontSize: 11.5,
                                                  color: "#ffb454", lineHeight: 1.6 }}>
                  <b>The blocks will render in the studio cloud</b> — {whyNotHere.why}.
                  {droppedLoras > 0 && (
                    <>
                      {" "}That cloud does not have {droppedLoras} adapter
                      {droppedLoras === 1 ? "" : "s"} you downloaded to this machine,
                      so {droppedLoras === 1 ? "it is" : "they are"} left out of this
                      episode rather than failing every block.
                    </>
                  )}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 18 }}>
                <WizardModelPicker
                  label="Video model" offers={videoRows} value={videoValue}
                  onPick={(p) => {
                    const { id, tier } = parsePick(p);
                    setVideoModel(id);
                    setVideoPlane(tier === "local" ? "local" : "cloud");
                  }}
                  admin={isAdmin}
                  onFix={(tab) => ws.openModal({ kind: "engine", tab })} />
                <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  {/* No "Stills & refs" picker here, deliberately: `imageModel`
                      is a step-1 decision (the real ImageModelPicker lives on
                      the brief step) sent once as the plan job's own
                      `image_model`. Every sheet, turnaround, plate, prop ref
                      and panel this session ever draws is already rendered
                      or in flight by the time step 4 is reachable, so a
                      picker here has nothing left to control. This card used
                      to sit here as a static, non-interactive label that
                      always read "Krea 2" regardless of what was actually
                      picked — dead AND wrong. */}
                  <span className="ws-mlabel" style={{ fontSize: 10.5, color: "#5e6678" }}>Resolution</span>
                  <div className="ws-seg">
                    {(["480p", "704p", "720p", "1080p"] as const).map((r) => (
                      <button key={r} className={"mono" + (res === r ? " on" : "")} style={{ fontSize: 12.5 }}
                              onClick={() => setRes(r)}>
                        {r}
                      </button>
                    ))}
                  </div>
                  <span style={{ fontSize: 12, lineHeight: 1.5, color: "#5e6678" }}>
                    {RES_HINT[res]}
                  </span>
                {/* Dialogue voice. The engine every character is CAST on at
                    plan time, so the recorded lines the shots are floored to
                    come from it. Two rows rather than a hidden default: they
                    sound different, one is free and non-commercial, and a
                    plan cast on the wrong one is a re-plan.

                    TIERED for the same reason the video list is: Breeze runs
                    on the pod AND on this machine, and its own row used to
                    carry the phrase "local or cloud" — true, and no answer to
                    the question being asked. */}
                <div style={{ marginTop: 6 }}>
                  <WizardModelPicker
                    label="Dialogue voice" offers={voiceRows} value={voiceValue}
                    onPick={(p) => {
                      const { id, tier } = parsePick(p);
                      setDialogueProvider(id as DialogueProvider);
                      setVoicePlane(tier);
                    }}
                    admin={isAdmin} blurbs={VOICE_BLURBS}
                    onFix={(tab) => ws.openModal({ kind: "engine", tab })} />
                </div>
                {/* Segment storyboards. One numbered board per block, staged into
                    the render as ONE reference in place of two loose panels. */}
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <span className="ws-mlabel" style={{ fontSize: 10.5, color: "#5e6678", marginTop: 6 }}>Segment storyboards</span>
                  <div style={{ padding: "10px 11px", borderRadius: 14,
                                border: boards ? "1px solid rgba(111,208,140,.32)" : "1px solid rgba(255,255,255,.08)",
                                background: boards ? "rgba(111,208,140,.06)" : "rgba(255,255,255,.025)",
                                display: "flex", flexDirection: "column", gap: 7 }}>
                    <div className="ws-toggrow">
                      <span style={{ color: boards ? "#6fd08c" : "#5e6678", display: "grid", placeItems: "center" }}>
                        <Sparkles size={13} />
                      </span>
                      <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600,
                                     color: boards ? "#eaeef6" : "#9aa4b6" }}>
                        One board per block
                      </span>
                      <button className={"ws-switch-t" + (boards ? " on" : "")}
                              role="switch" aria-checked={boards} aria-label="Segment storyboards"
                              title={boards ? "Boards on — click to stage loose panels" : "Loose panels — click to compose boards"}
                              onClick={() => setBoards((x) => !x)}>
                        <i />
                      </button>
                    </div>
                    <span style={{ fontSize: 12, lineHeight: 1.5, color: "#9aa4b6" }}>
                      {boards
                        ? "Each block's panels are laid into one numbered board and every shot is "
                          + "bound to its panel, so the render sees all of the block's shots in one "
                          + "grade. A board whose panels disagree is refused and the block keeps "
                          + "its panels."
                        : "Each block stages up to two of its panels as loose references."}
                    </span>
                  </div>
                </div>
                {/* Refinement. Only where the chosen video model declares a
                    recipe — `resolve()` raises otherwise, so an ungated switch
                    would fail every block of the episode. It is deliberately not
                    a model row of its own: refinement composes with checkpoint,
                    style and step-distillation alike, so twinning each H3 entry
                    would double a picker that already has six of them. */}
                {refineOk && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <span className="ws-mlabel" style={{ fontSize: 10.5, color: "#5e6678", marginTop: 6 }}>Refinement</span>
                    <div style={{ padding: "10px 11px", borderRadius: 14,
                                  border: refine ? "1px solid rgba(255,180,84,.32)" : "1px solid rgba(255,255,255,.08)",
                                  background: refine ? "rgba(255,180,84,.06)" : "rgba(255,255,255,.025)",
                                  display: "flex", flexDirection: "column", gap: 7 }}>
                      <div className="ws-toggrow">
                        <span style={{ color: refine ? "#ffb454" : "#5e6678", display: "grid", placeItems: "center" }}>
                          <Sparkles size={13} />
                        </span>
                        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600,
                                       color: refine ? "#eaeef6" : "#9aa4b6" }}>
                          Second pass on every block
                        </span>
                        <button className={"ws-switch-t" + (refine ? " on" : "")}
                                role="switch" aria-checked={refine} aria-label="Refine every block"
                                title={refine ? "Two passes — click for one" : "One pass — click to refine"}
                                onClick={() => setRefine((x) => !x)}>
                          <i />
                        </button>
                      </div>
                      <span style={{ fontSize: 12, lineHeight: 1.5, color: "#9aa4b6" }}>
                        {refine
                          ? "Each block renders as usual, then its picture is upscaled 1.25x and "
                            + "sampled again for 4 steps at low denoise. The soundtrack is carried "
                            + "across untouched. Adds GPU time to every block."
                          : "One sampler pass per block, at the resolution above."}
                      </span>
                    </div>
                  </div>
                )}
                </div>
              </div>
            </div>
            <aside className="ns-scroll" style={{ ...Aside, width: 296, padding: 20, gap: 14 }}>
              {/* Render time hidden for now; will revisit with more data later
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <span className="ws-mlabel" style={{ fontSize: 10.5, color: "#5e6678" }}>Render time</span>
                <div style={{ padding: 12, borderRadius: 16, border: "1px solid rgba(255,255,255,.08)",
                              background: "rgba(255,255,255,.025)", display: "flex", flexDirection: "column", gap: 8 }}>
                  <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.02em" }}>{eta}</span>
                  <div className="mono" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, color: "#9aa4b6" }}>
                    <Cpu size={12} />{renderHere ? "on this machine" : "in the studio cloud"}
                  </div>
                  <div style={{ display: "flex", gap: 2, height: 6, borderRadius: 3, overflow: "hidden" }}>
                    <span style={{ width: "72%", background: "#5aa2ff" }} />
                    <span style={{ width: "14%", background: "#c97aff" }} />
                    <span style={{ width: "9%", background: "#6fd08c" }} />
                    <span style={{ width: "5%", background: "#5b6478" }} />
                  </div>
                  <span style={{ fontSize: 12, lineHeight: 1.5, color: "#9aa4b6" }}>
                    Measured from your own renders, not a guess.
                  </span>
                </div>
              </div>
              */}
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <span className="ws-mlabel" style={{ fontSize: 10.5, color: "#5e6678" }}>How much should it decide?</span>
                {([[1, "Full auto", "render everything, tell me when it's done."],
                   [2, "Stop at first pass", "one take per block, then I pick."]] as const).map(([t, name, blurb]) => {
                  const on = tier === t;
                  return (
                    <label key={t} onClick={() => setTier(t)}
                           style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "9px 10px", borderRadius: 14,
                                    cursor: "pointer",
                                    border: on ? "1px solid rgba(90,162,255,.4)" : "1px solid rgba(255,255,255,.08)",
                                    background: on ? "rgba(90,162,255,.07)" : "rgba(255,255,255,.025)" }}>
                      <span style={{ width: 14, height: 14, borderRadius: "50%", marginTop: 2, flexShrink: 0,
                                     display: "grid", placeItems: "center",
                                     border: on ? "1px solid #5aa2ff" : "1px solid #2a3346",
                                     background: on ? "rgba(90,162,255,.25)" : "none" }}>
                        {on && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#5aa2ff" }} />}
                      </span>
                      <span style={{ fontSize: 12.5, lineHeight: 1.5, color: "#9aa4b6" }}>
                        <b style={{ color: on ? "#eaeef6" : "#c8cfdb", fontWeight: 600 }}>{name}</b> — {blurb}
                      </span>
                    </label>
                  );
                })}
              </div>
              <span style={{ flex: 1 }} />
              {/* A PICK THAT CANNOT BE QUEUED REFUSES HERE, not twenty blocks
                  later. Every one of these is an episode that would be planned
                  in full and then fail a block a minute: a member's job is
                  turned away by `_check_owner_allowed`, a local project's rows
                  are invisible to the pod, and weights that are not down die
                  inside `resolve()`. The sentence is the picker's own, so the
                  refusal and the row that caused it read the same. */}
              {queueBlocked && (
                <div style={{ fontSize: 11.5, lineHeight: 1.55, color: "#ffb454" }}>
                  {queueBlocked.why} — pick another above.
                </div>
              )}
              {!queueBlocked && voiceBlocked && (
                <div style={{ fontSize: 11.5, lineHeight: 1.55, color: "#8a93a6" }}>
                  Lines will be timed by estimate rather than recorded —{" "}
                  {voiceBlocked.why}.
                </div>
              )}
              <button disabled={launching || !world || !!queueBlocked}
                      onClick={() => void queueEpisode()}
                      title={queueBlocked?.why}
                      style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, height: 42,
                               borderRadius: 15, border: "1px solid rgba(255,180,84,.5)", background: "rgba(255,180,84,.13)",
                               color: "#ffb454", fontSize: 14.5, fontWeight: 600,
                               cursor: queueBlocked ? "not-allowed" : "pointer",
                               opacity: queueBlocked ? 0.45 : 1 }}>
                {launching ? <Loader2 size={15} className="ns-spin" /> : <Clapperboard size={15} />}
                Queue the episode
              </button>
            </aside>
          </div>
        )}
      </div>
      {replanOpen && (
        <ReplanModal
          scenes={world?.scenes.length ?? 0}
          beats={Array.from(world?.beats.values() ?? []).reduce((n, b) => n + b.length, 0)}
          blocker={replanErr ?? replanBlocker({
            episodeId: ep?.id, storyboardId: world?.storyboard.id, inFlight: replanRunning })}
          busy={replanBusy}
          onEditHere={replanInChat}
          onNewVersion={(c) => void replanOnPod(c)}
          onClose={() => setReplanOpen(false)} />
      )}
      {/* The full "new bible entry" form, nested rather than routed. It offers
          the three things the old inline card could not — upload your own
          reference sheet, generate one, attach a voice sample — at the step
          where they are wanted, instead of sending you to the Bible page.

          `kinds` is limited to what this step RENDERS. NewEntryModal's fourth
          kind is lore, and step 2 has no lore column: saved from here it would
          be a row nothing on screen shows, i.e. a control whose result you
          cannot see. Lore is added from the Bible page's own document shelf. */}
      {addKind && (
        <NewEntryModal
          // `initialKind` is read once, in a useState initializer, so without a
          // key React would reuse the instance if `addKind` ever went from one
          // kind straight to another — opening "add a prop" on the character
          // form, with a half-typed character still in it.
          key={addKind}
          projectId={project.id}
          initialKind={addKind}
          kinds={["character", "environment", "prop"]}
          // The picker on THIS step, not the project row: it is session state
          // seeded from the row and never written back, so the row would draw
          // a sheet on a model the sheets bar above these tiles is not using.
          modelId={imageModel}
          nested
          onCreated={() => void reloadWorld()}
          onClose={() => setAddKind(null)}
          // "Draft it" defaults to the workspace dock, which sits BEHIND the
          // wizard and is a different conversation. This step has a composer
          // of its own and its thread carries the brief, so the prompt lands
          // where it can be read and answered in context.
          onAskDirector={(d) => { setStep(2); setSideDraft(d); }}
        />
      )}
      {entryModal && (
        <BibleEntryModal entryId={entryModal}
                         onClose={() => { setEntryModal(null); void reloadWorld(); }} />
      )}
      {sceneModal && (
        <SceneEditorModal sceneId={sceneModal}
                          onClose={() => { setSceneModal(null); void reloadWorld(); }} />
      )}
      {viewing && (
        <Lightbox assets={viewing.assets} index={viewing.i}
                  onClose={() => setViewing(null)}
                  onStep={(d) => setViewing((v) => v && {
                    ...v, i: stepIndex(v.i, d, v.assets.length) ?? 0 })} />
      )}
    </div>
  );
}
