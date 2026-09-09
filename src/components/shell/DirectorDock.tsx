import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Film, History, Image as ImageIcon,
  Loader2, MessageSquare, Mic, Music, Paperclip, Pencil, Plus, RotateCcw, Send, Sparkles,
  Trash2, Upload, X,
} from "lucide-react";
import Dropdown from "../ui/Dropdown";
import TieredModelMenu, { TierIcon, type Quality } from "../ui/TieredModelMenu";
import BackendMenu from "../ui/BackendMenu";
import { useLocalEngine, type LocalEngine } from "../../hooks/useLocalEngine";
import { TIER_META, TIER_ORDER, tierOf, type ModelTier } from "../../lib/localModels";
import { useIsAdmin } from "../../lib/auth";
import { useByok } from "../../hooks/useByok";
import { useMarkedCatalog } from "../../hooks/useSheetModels";
import { DockIconBtn, ErrorRow, LlmChip, ModelChip, StaleNotice } from "./DirectorChrome";
import { STALE_UI } from "../../lib/staleBlocks";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import {
  deleteThread, loadBlockIndex, loadMessages, loadThreadSummaries, prepareRetry, renameThread,
  type BlockIndexRow, type ThreadSummary,
} from "../../lib/db/director";
import {
  DIRECTOR_BACKENDS, availableBackends, backendLabel, backendModelName,
  describeDirectorError,
  backendBlocked, queueLocalDirectorTurn,
  type ChatAttachment, type DirectorEvent,
} from "../../lib/director";
import { buildChatContext } from "../../lib/directorContext";
import { loadAssetsByIds, registerAsset } from "../../lib/db/assets";
import { probedUploadMeta } from "../../lib/mediaProbe";
import { enqueueJob } from "../../lib/db/jobs";
import StaleBlocksModal from "../modals/StaleBlocksModal";
import RevertTurnDialog from "../modals/RevertTurnDialog";
import { changesOf } from "../../lib/directorRevert";
import { turnFromRow, unansweredTurnId } from "../../lib/directorRetry";
import { placeBlockPlaceholder } from "../../lib/blockPlaceholder";
import { uploadMedia } from "../../lib/upload";
import { supabase, mediaUrl } from "../../lib/supabase";
import { clipboardMediaFiles } from "../../lib/clipboardMedia";
import { Markdown } from "../../lib/markdown";
import { ago } from "../../lib/time";
import { loadCatalog } from "../../lib/catalog";
import { resolveDefaults, saveProjectSettings, setAppDefaults, type ProjectSettings } from "../../lib/projectSettings";
import { getChatDraft, setChatDraft, clearChatDraft } from "../../lib/draftStore";
import type { Asset, ChatMessage, Episode, ModelCatalogRow, Project } from "../../lib/db/types";
import { blockRef } from "../../../director/refs.js";

const shortModelName = (name?: string | null, fallback = "Auto") => {
  if (!name) return fallback;
  return name
    .replace(/^MiniMax\s+/i, "")
    .replace(/\s+14B$/i, "")
    .replace(/\s+dev$/i, "")
    .replace(/\s+bf16$/i, "")
    .replace(/\s+fp8.*$/i, "");
};

const threadName = (t: ThreadSummary | null | undefined) =>
  t?.title?.trim() || t?.preview?.slice(0, 48) || "Untitled chat";

/** One option the director offered — "which of these three?" — with the call
 *  it would make if picked. Rendered as buttons because a numbered list the
 *  user has to answer in prose is a round trip that carries no information. */
interface ChoiceOption {
  id: string;
  label: string;
  detail?: string;
  tool?: string;
  args?: Record<string, unknown>;
  preview_asset_id?: string;
}

/** Every content block this dock knows how to draw. Anything else is skipped
 *  rather than rendered as `[object Object]`. */
interface Block {
  type: string;
  text?: string;
  name?: string;
  result?: {
    job_id?: string;
    error?: string;
    choice?: { question?: string; options?: ChoiceOption[] };
    assets?: Asset[];
  };
  /** asset_ref */
  asset_id?: string;
  b2_key?: string;
  media?: string;
  label?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  /** block_ref */
  block_id?: string;
  idx?: number;
  /** choice_pick — what the user clicked, recorded as its own turn */
  option_id?: string;
}

const isAssetRef = (b: Block) => b.type === "asset_ref" && !!b.asset_id;
const isBlockRef = (b: Block) => b.type === "block_ref" && !!b.block_id;

/** A registered asset, as a clickable thumbnail. Used by attachments on a
 *  user turn, by `search_assets` results, and by `asset:` markdown. */
function AssetChip({
  assetId, b2Key, media, label, onOpen, size = 46,
}: {
  assetId?: string | null; b2Key?: string | null; media?: string | null;
  label?: string | null; onOpen?: (id: string) => void; size?: number;
}) {
  const url = b2Key ? mediaUrl(b2Key) : null;
  const kind = media ?? "image";
  return (
    <button className="ws-attach-thumb" style={{ width: size, height: size }}
            title={label ?? undefined}
            disabled={!assetId || !onOpen}
            onClick={() => assetId && onOpen?.(assetId)}>
      {/* A poster frame would need a canvas read, and the bucket sends no
          CORS header — so a video reads as its icon, same as everywhere else
          that cannot decode one cheaply. */}
      {kind === "image" || kind === "frame"
        ? <img src={url ?? undefined} alt={label ?? ""} loading="lazy" />
        : kind === "audio" ? <Music size={16} />
        : <Film size={16} />}
    </button>
  );
}

/** Copy a message's prose to the clipboard, and say so for a moment. */
function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button type="button" className={"ws-msg-act" + (done ? " ok" : "")}
            title="Copy this reply"
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(() => setDone(true)).catch(() => {});
            }}>
      {done ? <Check size={11} /> : <Copy size={11} />}
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** One transcript entry. Exported for the `/ui/director` harness, which
 *  renders the REAL component over fixture messages so the per-reply actions
 *  (copy, revert) can be looked at without a session. */
export function DirectorMsg(props: Parameters<typeof Msg>[0]) { return <Msg {...props} />; }

function Msg({ m, onOpenAsset, onOpenBlock, onPickChoice, onRevert, onRetry }: {
  m: ChatMessage;
  onOpenAsset: (id: string) => void;
  onOpenBlock: (id: string) => void;
  onPickChoice: (o: ChoiceOption, question: string) => void;
  /** Offered on a reply that WROTE something: the journal the toolset kept
   *  of every row the turn changed (director/changes.js). */
  onRevert?: (ops: Record<string, unknown>[]) => void;
  /** Offered on a USER message nothing has answered — a turn whose failure
   *  the tab has forgotten, which is every failure after a reload. */
  onRetry?: () => void;
}) {
  const blocks = (Array.isArray(m.content) ? m.content : []) as Block[];
  const refs = blocks.filter((b) => isAssetRef(b) || isBlockRef(b));

  if (m.role === "user") {
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return (
      <>
      <div className="ws-umsg">
        {text}
        {/* What was attached rides WITH the words, so a reloaded transcript
            still shows what the turn was about. */}
        {!!refs.length && (
          <div className="ws-attach-row in-msg">
            {refs.map((b, i) => (isAssetRef(b) ? (
              <AssetChip key={i} assetId={b.asset_id} b2Key={b.b2_key} media={b.media}
                         label={b.label} onOpen={onOpenAsset} size={40} />
            ) : (
              <button key={i} className="ws-blockchip" title={b.label ?? "Open takes"}
                      onClick={() => b.block_id && onOpenBlock(b.block_id)}>
                <Film size={11} />{b.label ?? (b.idx != null ? blockRef(b.idx) : "block")}
              </button>
            )))}
          </div>
        )}
      </div>
      {/* NOTHING ANSWERED THIS. The turn is persisted — both transports write
          this row before they stream, which is why its pictures are still
          here — so a failure the tab has forgotten (a reload, another
          machine) is still one click from running again. */}
      {onRetry && (
        <div className="ws-msg-acts end">
          <button type="button" className="ws-msg-act" onClick={onRetry}
                  title="Nothing answered this — ask again with the same words and pictures">
            <RotateCcw size={11} /> Retry
          </button>
        </div>
      )}
      </>
    );
  }
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text" && b.text?.trim()) {
          return (
            <div key={i} className="ws-amsg">
              <Markdown text={b.text}
                        asset={(id, alt) => <AssetById id={id} alt={alt} onOpen={onOpenAsset} />} />
            </div>
          );
        }
        if (isAssetRef(b)) {
          return (
            <div key={i} className="ws-attach-row">
              <AssetChip assetId={b.asset_id} b2Key={b.b2_key} media={b.media}
                         label={b.label} onOpen={onOpenAsset} size={64} />
            </div>
          );
        }
        if (isBlockRef(b)) {
          return (
            <button key={i} className="ws-blockchip" title="Open this block's takes"
                    onClick={() => b.block_id && onOpenBlock(b.block_id)}>
              <Film size={11} />{b.label ?? (b.idx != null ? blockRef(b.idx) : "block")}
            </button>
          );
        }
        if (b.type === "tool_use") {
          return <div key={i} className="ws-tool-row"><Check size={12} style={{ color: "#6fd08c" }} /> {b.name}</div>;
        }
        if (b.type === "tool_result") {
          if (b.result?.error) {
            return <div key={i} className="ws-tool-row"><X size={12} style={{ color: "#ff8080" }} /> {b.name}</div>;
          }
          // A question with its own answers attached. Clicking one posts the
          // pick as an ordinary user turn, so both backends see it in history.
          const choice = b.result?.choice;
          if (choice?.options?.length) {
            const q = choice.question ?? "";
            return (
              <div key={i} className="ws-choice">
                {q && <div className="q">{q}</div>}
                {choice.options.map((o) => (
                  <button key={o.id} className="ws-choice-opt"
                          title={o.tool ? `runs ${o.tool}` : undefined}
                          onClick={() => onPickChoice(o, q)}>
                    <span className="t">{o.label}</span>
                    {o.detail && <span className="d">{o.detail}</span>}
                  </button>
                ))}
              </div>
            );
          }
          // search_assets and friends hand back whole asset rows. They were
          // being thrown away, so "find me the rooftop plates" answered with a
          // count and nothing to look at.
          const found = b.result?.assets;
          if (Array.isArray(found) && found.length) {
            return (
              <div key={i} className="ws-attach-row">
                {found.slice(0, 12).map((a) => (
                  <AssetChip key={a.id} assetId={a.id} b2Key={a.b2_key}
                             media={a.kind} label={a.b2_key?.split("/").pop()}
                             onOpen={onOpenAsset} size={46} />
                ))}
                {found.length > 12 && (
                  <span className="ws-attach-more mono">+{found.length - 12}</span>
                )}
              </div>
            );
          }
          if (b.result?.job_id) {
            return <div key={i} className="ws-receipt">queued · job {b.result.job_id.slice(0, 8)}</div>;
          }
        }
        return null;
      })}
      {m.streaming && <Loader2 size={13} className="ns-spin" style={{ color: "#5e6678" }} />}
      {/* Copy always; Revert only where the turn wrote something. The
          journal rides on the message, so a turn made in another tab or by
          the pod's own director is revertable here too. */}
      {!m.streaming && (() => {
        const prose = blocks.filter((b) => b.type === "text" && b.text?.trim())
          .map((b) => b.text!.trim()).join("\n\n");
        const ops = changesOf(m.content);
        if (!prose && !ops) return null;
        return (
          <div className="ws-msg-acts">
            {prose && <CopyBtn text={prose} />}
            {ops && onRevert && (
              <button type="button" className="ws-msg-act danger"
                      title="Put back everything this turn changed"
                      onClick={() => onRevert(ops)}>
                <RotateCcw size={11} /> Revert
              </button>
            )}
          </div>
        );
      })()}
    </>
  );
}

/** Assets named by id in model output (`![alt](asset:<uuid>)`) — resolved
 *  lazily and cached for the session, because the same face sheet gets named in
 *  a dozen turns and each one would otherwise be its own query. `inFlight`
 *  dedupes the concurrent case: one message can name the same id five times and
 *  every copy mounts on the same tick. */
const assetCache = new Map<string, Asset | null>();
const inFlight = new Map<string, Promise<void>>();

function AssetById({ id, alt, onOpen }: {
  id: string; alt: string; onOpen: (id: string) => void;
}) {
  const [asset, setAsset] = useState<Asset | null | undefined>(() => assetCache.get(id));
  useEffect(() => {
    if (assetCache.has(id)) { setAsset(assetCache.get(id)); return; }
    let live = true;
    let p = inFlight.get(id);
    if (!p) {
      p = loadAssetsByIds([id])
        .then((m) => { assetCache.set(id, m.get(id) ?? null); })
        .catch(() => { assetCache.set(id, null); })
        .finally(() => { inFlight.delete(id); });
      inFlight.set(id, p);
    }
    void p.then(() => { if (live) setAsset(assetCache.get(id) ?? null); });
    return () => { live = false; };
  }, [id]);
  // An id that resolves to nothing renders as its alt text rather than a
  // broken frame — the model invents ids, and a hole in the prose is worse
  // than the sentence it was standing in for.
  if (!asset) return <span className="md-code">{alt || (asset === undefined ? "…" : id.slice(0, 8))}</span>;
  return (
    <AssetChip assetId={asset.id} b2Key={asset.b2_key} media={asset.kind}
               label={alt || asset.b2_key.split("/").pop()} onOpen={onOpen} size={56} />
  );
}

/** The three things a desktop model list has to say that the ROWS cannot.
 *
 *  Silence about any of them reads as a failed download: a variant that is on
 *  disk and undriveable is a THIRD state next to installed and absent, and an
 *  engine with no models at all is a different problem from an engine that
 *  is not installed. Lifted from the library's generate dock so the two
 *  pickers answer identically. */
function EngineNote({ engine }: { engine: LocalEngine }) {
  if (!engine.desktop) return null;
  return (
    <>
      {engine.blocked.map((b) => (
        <div key={b.name} className="ws-menu-empty" style={{ fontSize: 10.5 }}>
          {b.name} is on disk but {b.why}.
        </div>
      ))}
      {!engine.rows.length && (
        <div className="ws-menu-empty" style={{ fontSize: 10.5 }}>
          {engine.status?.installed || engine.status?.models_linked
            ? "No local models yet — download one in the engine window."
            : "No local engine installed yet."}
        </div>
      )}
    </>
  );
}

/** A turn that failed, kept whole so the Retry button can run it again. */
interface PendingTurn {
  text: string;
  attachments: ChatAttachment[];
  /** the situational block as it read when the turn was sent */
  context: string;
  pick: Record<string, unknown> | null;
}

/** An asset's `kind` as the chat contract's coarser `media`. */
const mediaOf = (k: Asset["kind"]): ChatAttachment["media"] =>
  k === "video" || k === "render" ? "video" : k === "audio" ? "audio" : "image";

interface SpeechRecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
}

export default function DirectorDock({
  project, episode,
}: {
  project: Project | null;
  episode: Episode | null;
}) {
  const ws = useWorkspaceStore();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => getChatDraft(project?.id, threadId));
  const activeKeyRef = useRef(`${project?.id}:${threadId}`);

  // Restore draft whenever project or threadId changes
  useEffect(() => {
    const key = `${project?.id}:${threadId}`;
    activeKeyRef.current = key;
    setDraft(getChatDraft(project?.id, threadId));
  }, [project?.id, threadId]);

  // Persist draft to storage whenever draft changes
  useEffect(() => {
    const key = `${project?.id}:${threadId}`;
    if (activeKeyRef.current !== key) return;
    setChatDraft(project?.id, threadId, draft);
  }, [draft, project?.id, threadId]);

  const [backend, setBackend] = useState(DIRECTOR_BACKENDS[0].id);
  const isAdmin = useIsAdmin();
  const { keyed: byokKeys } = useByok();
  /** The session lapsed mid-turn. Named for what it now is — there is no key
   *  to supply any more, so the panel offers the two things that can help:
   *  sign in again, or run the turn on the pod. */
  /** THE TURN HELD FOR A RETRY — the same words, the same pictures and the
   *  same screen. Not the live composer: a retry re-runs what was ASKED, and
   *  the context especially has to be the one it was asked with, or
   *  "regenerate this block" resolves against whatever happens to be selected
   *  by the time the button is pressed. Held until the turn lands. */
  const pendingRef = useRef<PendingTurn | null>(null);
  const [live, setLive] = useState<{ text: string; tools: { name: string; status: string }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** true right after "New chat": suppresses the auto-select below so the blank
   *  thread survives until the first turn actually creates a row. */
  const [fresh, setFresh] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [listening, setListening] = useState(false);
  /** What the next turn carries besides words. Cleared once the turn lands,
   *  never on an error — a rejected studio key must not also eat the pictures
   *  you attached. */
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  /** the structured record of a clicked choice, held for the one turn that
   *  reports it — see pickChoice */
  const pickRef = useRef<Record<string, unknown> | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: catalog } = useLiveQuery(() => loadCatalog(), [], []);
  /** What THIS machine can render, as catalog-shaped rows. The same source the
   *  library's generate dock reads, so both pickers offer the same three
   *  planes — a flat catalog list could not say whether a pick costs GPU time
   *  on the shared pod, nothing at all here, or money per render at a
   *  provider, and this one named the provider and stopped. */
  const engine = useLocalEngine();
  /** …AND THE ROWS A KEY OF YOURS RE-ENABLES, which these chips did not carry.
   *  They write `settings.image_model` / `video_model` — the very fields
   *  project settings and the new-project form write, and both of those offer
   *  the byok plane — so a model picked there on your own key came back here
   *  filed under STUDIO CLOUD, which a member reads as "coming soon" and
   *  cannot pick: the picker calling your own working model unavailable. */
  const marked = useMarkedCatalog(catalog);

  const videoModels = useMemo(() => {
    return [...marked, ...engine.rows]
      .filter((m) => m.kind === "video")
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.sort - b.sort);
  }, [marked, engine.rows]);

  const imageModels = useMemo(() => {
    return [...marked, ...engine.rows]
      .filter((m) => m.kind === "image")
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.sort - b.sort);
  }, [marked, engine.rows]);

  const resolvedDefaults = useMemo(
    () => resolveDefaults((project?.settings ?? null) as ProjectSettings | null),
    [project?.settings]);

  const [localVideoModel, setLocalVideoModel] = useState<string | null>(null);
  const [localImageModel, setLocalImageModel] = useState<string | null>(null);

  const activeVideoModel = localVideoModel ?? resolvedDefaults.video_model;
  const activeImageModel = localImageModel ?? resolvedDefaults.image_model;

  useEffect(() => {
    setLocalVideoModel(null);
    setLocalImageModel(null);
  }, [project?.id]);

  const selectedVideoObj = useMemo(
    () => videoModels.find((m) => m.id === activeVideoModel) ?? videoModels.find((m) => m.enabled),
    [videoModels, activeVideoModel]);

  const selectedImageObj = useMemo(
    () => imageModels.find((m) => m.id === activeImageModel) ?? imageModels.find((m) => m.enabled),
    [imageModels, activeImageModel]);

  const onSelectVideoModel = async (id: string) => {
    setLocalVideoModel(id);
    setAppDefaults({ video_model: id });
    if (project?.id) {
      await saveProjectSettings(project.id, { video_model: id }).catch(console.error);
    }
  };

  const onSelectImageModel = async (id: string) => {
    setLocalImageModel(id);
    setAppDefaults({ image_model: id });
    if (project?.id) {
      await saveProjectSettings(project.id, { image_model: id }).catch(console.error);
    }
  };

  /** Render quality, for the hosted rows that expose one — the same project
   *  field the settings modal and the context panel write. Only images have
   *  it (`qualityTiers` answers for OpenAI's rows), which is why the video
   *  chip's menu is given no knob rather than an inert one. */
  const onSelectImageQuality = async (q: Quality) => {
    setAppDefaults({ image_quality: q });
    if (project?.id) {
      await saveProjectSettings(project.id, { image_quality: q }).catch(console.error);
    }
  };

  // Project switches are handled by remounting this whole component (see the
  // `key={project?.id}` at the call site in Workspace.tsx) rather than by
  // resetting state in an effect here: `threads` below is a useLiveQuery that
  // keeps its previous project's data on screen until the new fetch resolves,
  // so a same-instance reset raced that staleness and re-selected the old
  // project's most recent thread out from under itself.
  const { data: threads, reload: reloadThreads } = useLiveQuery(
    () => (project ? loadThreadSummaries(project.id) : Promise.resolve([] as ThreadSummary[])),
    ["chat_threads", "chat_messages"], [project?.id]);
  useEffect(() => {
    if (!threadId && !fresh && threads?.length) setThreadId(threads[0].id);
  }, [threads, threadId, fresh]);
  const { data: messages, reload } = useLiveQuery(
    () => (threadId ? loadMessages(threadId) : Promise.resolve([] as ChatMessage[])),
    ["chat_messages"], [threadId]);
  // A turn on a *new* chat resolves in a closure made before the thread
  // existed, so the reload it captured re-runs "no thread → no messages" and
  // empties the transcript it was supposed to refresh. Call the current one.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, live]);

  // Grow the composer with its content, up to about eight lines, then scroll.
  // The floor is ONE line (20px), not the 40px the old bordered box needed —
  // the field has no frame of its own any more, so a floor above its content
  // is just dead space between the placeholder and the control row.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(184, Math.max(20, el.scrollHeight))}px`;
  }, [draft, ws.chatOpen]);

  const thread = threads?.find((t) => t.id === threadId) ?? null;

  const newChat = () => {
    setThreadId(null); setFresh(true); setDraft(getChatDraft(project?.id, null)); setErr(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const openThread = (id: string) => {
    setThreadId(id); setFresh(false); setDraft(getChatDraft(project?.id, id)); setErr(null);
  };
  const removeThread = async (id: string) => {
    clearChatDraft(project?.id, id);
    await deleteThread(id).catch((e: Error) => setErr(e.message));
    if (id === threadId) { setThreadId(null); setFresh(false); }
    reloadThreads();
  };
  const commitRename = async (id: string) => {
    const title = renameDraft.trim();
    setRenaming(null);
    if (title) await renameThread(id, title).catch((e: Error) => setErr(e.message));
    reloadThreads();
  };

  // "Ask the director …" affordances elsewhere prefill the composer
  useEffect(() => {
    if (ws.dockDraft != null) {
      setDraft(ws.dockDraft);
      ws.set("dockDraft", null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.dockDraft]);

  /* ── attachments ────────────────────────────────────────────────────────
     A director you can only describe things to is a director working blind.
     Three ways in — drag a card or a block onto the composer, paste, or the
     `chatShelf` handoff from elsewhere in the app — and they all end at
     `attach`. */
  const attach = (a: Asset) =>
    setAttachments((cur) => cur.some((x) => x.kind === "asset" && x.id === a.id) ? cur : [...cur, {
      kind: "asset", id: a.id, b2_key: a.b2_key, media: mediaOf(a.kind),
      label: a.b2_key.split("/").pop() ?? undefined,
      ...(a.width ? { width: a.width } : {}),
      ...(a.height ? { height: a.height } : {}),
      ...(a.duration_ms ? { duration_ms: a.duration_ms } : {}),
    }]);

  const attachIds = async (ids: string[]) => {
    const fresh = ids.filter((id) => !attachments.some((x) => x.kind === "asset" && x.id === id));
    if (!fresh.length) return;
    try {
      const rows = await loadAssetsByIds(fresh);
      for (const id of fresh) { const a = rows.get(id); if (a) attach(a); }
    } catch (e) {
      setErr(`Could not attach that: ${String((e as Error).message).slice(0, 90)}`);
    }
  };

  const attachBlock = async (id: string) => {
    if (attachments.some((x) => x.kind === "block" && x.id === id)) return;
    // The label is what the chip and the stored `block_ref` read, and "b6" is
    // how every other surface (and the director's own tools) name a block.
    const { data } = await supabase.from("generation_blocks")
      .select("id,idx,t_start_ms,t_end_ms").eq("id", id).maybeSingle();
    const b = data as { idx: number; t_start_ms: number; t_end_ms: number } | null;
    setAttachments((cur) => cur.some((x) => x.kind === "block" && x.id === id) ? cur : [...cur, {
      kind: "block", id, idx: b?.idx,
      label: b ? blockRef(b.idx) : "block",
      ...(b ? { duration_ms: b.t_end_ms - b.t_start_ms } : {}),
    }]);
  };

  /** OS files: the canonical three-step rail — B2, then the registry
   *  (invariant #2), then the probe job that fills in dimensions. */
  const onUpload = async (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []).filter((f) => /^(image|video|audio)\//.test(f.type));
    if (!list.length) return;
    for (const file of list) {
      setUploading(0);
      try {
        const key = `library/${Date.now()}_${file.name.replace(/[^\w.-]+/g, "_")}`;
        await uploadMedia(file, key, (p: number) => setUploading(p));
        const asset = await registerAsset({
          b2_key: key,
          kind: file.type.startsWith("video/") ? "video"
            : file.type.startsWith("audio/") ? "audio" : "image",
          project_id: project?.id ?? null, content_type: file.type, bytes: file.size,
          origin: "uploaded", tags: ["library"], meta: { original_name: file.name },
          ...(await probedUploadMeta(file)),   // don't wait on the pod for a length
        });
        await enqueueJob({ kind: "asset_ingest", lane: "cpu", priority: 60,
                           payload: { asset_id: asset.id } });
        attach(asset);
      } catch (e) {
        setErr(`Upload failed: ${String((e as Error).message).slice(0, 100)}`);
      } finally { setUploading(null); if (fileRef.current) fileRef.current.value = ""; }
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) { void onUpload(e.dataTransfer.files); return; }
    const blockId = e.dataTransfer.getData("application/x-qamba-block");
    if (blockId) { void attachBlock(blockId); return; }
    const raw = e.dataTransfer.getData("application/x-qamba-asset");
    if (!raw) return;
    // Two payload shapes exist in the wild: the workspace grid and the refs
    // panel set a bare id, the legacy library page sets {"id":…}.
    let id = raw;
    try { id = (JSON.parse(raw) as { id: string }).id ?? raw; } catch { /* bare id */ }
    await attachIds([id]);
  };

  /** The store handoff, for surfaces that would rather push than be dragged
   *  from (see `shelfChat`). One-shot: consumed and cleared, like genPreset. */
  useEffect(() => {
    const ids = ws.chatShelf;
    if (!ids.length) return;
    ws.clearChatShelf();
    void attachIds(ids);
    requestAnimationFrame(() => inputRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.chatShelf]);

  /* ── situational context ────────────────────────────────────────────────
     One line per block of the open episode, live rather than cached-forever:
     block status is exactly what changes under you mid-render, and an index
     that says "planned" about a block you just watched finish is worse than
     no index.

     EVERY ROW CARRIES THE EPISODE IT WAS LOADED FOR, because `useLiveQuery`
     keeps the PREVIOUS deps' data on screen until the new fetch resolves — the
     same staleness the `key={project?.id}` remount exists to dodge one level
     up. Switch episode and type immediately and the context block named the
     NEW episode over the OLD one's blocks; worse, the stale-blocks bar below
     would have offered to re-render them, spending GPU time on an episode
     nobody was looking at. Compared rather than cleared, so nothing flickers
     empty on a refetch. */
  const { data: indexed } = useLiveQuery(
    () => (episode
      ? loadBlockIndex(episode.id).then((rows) => ({ episodeId: episode.id, rows }))
      : Promise.resolve({ episodeId: null as string | null, rows: [] as BlockIndexRow[] })),
    ["generation_blocks", "scenes"], [episode?.id], 1000);
  const blockIndex = indexed?.episodeId === (episode?.id ?? null) ? indexed.rows : null;

  /** How many cuts the episode has — the count alone, not the list. An
   *  episode holds several timelines and the director assumed one, so it read
   *  the block plan's total as "the timeline". The names of the OTHER cuts are
   *  `list_timelines`' job; carrying six of them in every turn's context would
   *  be noise around the one that is actually on screen. */
  const { data: cuts } = useLiveQuery(
    async () => {
      if (!episode) return { episodeId: null as string | null, count: 0 };
      const { count } = await supabase.from("timelines")
        .select("id", { count: "exact", head: true }).eq("episode_id", episode.id);
      return { episodeId: episode.id, count: count ?? 0 };
    },
    ["timelines"], [episode?.id], 1000);
  // Same provenance check as the index above: a count carried over from the
  // previous episode is a sentence about cuts this one does not have.
  const cutCount = cuts?.episodeId === (episode?.id ?? null) ? cuts.count : null;

  const situation = () => {
    const tl = useTimelineStore.getState();
    const pb = usePlaybackStore.getState();
    // The timeline store is only ever loaded by TimelineView and it is never
    // torn down, so on any other view — or after switching episode — it holds
    // somebody else's clips. Report it only when it is demonstrably THIS
    // episode's.
    const mine = !!episode && tl.timeline?.episode_id === episode.id;
    return buildChatContext({
      view: ws.view,
      project: project ? { title: project.title, medium: project.medium } : null,
      episode: episode ? { title: episode.title, idx: episode.idx } : null,
      clips: mine ? tl.clips.map((c) => ({
        id: c.id, block_id: c.block_id, label: c.label,
        t_start_ms: c.t_start_ms, duration_ms: c.duration_ms,
      })) : [],
      // Gated on the same `mine` check as the clips: naming a cut the store is
      // holding for another episode would be worse than saying nothing, since
      // `render_timeline` would then be handed a real id for the wrong film.
      timeline: mine && tl.timeline
        ? { id: tl.timeline.id, name: tl.timeline.name, cutCount: cutCount ?? null }
        : null,
      selectedClipId: mine ? tl.selectedClipId : null,
      // nowMs(), NOT playheadMs — the latter only commits on pause and seek,
      // so mid-playback it is wherever you last stopped.
      playheadMs: mine ? pb.nowMs() : null,
      playing: pb.playing,
      openSceneId: ws.openSceneId,
      editingBeatId: ws.editingBeatId,
      blocks: blockIndex ?? [],
      generationModels: {
        video: selectedVideoObj?.display_name ?? activeVideoModel,
        image: selectedImageObj?.display_name ?? activeImageModel,
      },
    });
  };

  /* ── stale blocks ───────────────────────────────────────────────────────
     OFF. `STALE_UI` is false (lib/staleBlocks says why), so the list below is
     empty, the notice bar hides itself at zero and the review popup is never
     reachable. Everything here is left wired rather than deleted: flipping the
     flag back brings the bar, its seconds estimate and the popup back exactly
     as they were.

     What it was: the notice bar's whole data source, off the block index this
     dock already keeps live for the situational context — no query of its own —
     with the queueing in StaleBlocksModal, because what to re-render is a
     per-block decision the fan-out spends real GPU time on and a bar has no
     room to name the blocks it would spend it on. */
  /** Run a turn read back off the transcript — the retry a reload survives.
   *  `pendingRef` is seeded so a second failure has the in-session path, and
   *  the context is the CURRENT screen: the one it was asked against went
   *  with the tab (see `StoredTurn`). */
  const retryFromRow = (m: ChatMessage) => {
    if (live) return;
    const turn = turnFromRow(m.content);
    if (!turn.text && !turn.attachments.length) return;
    pendingRef.current = {
      text: turn.text, attachments: turn.attachments as ChatAttachment[],
      context: situation(), pick: null,
    };
    void send({ retry: true, sawFailure: false });
  };

  /** The one message a retry is offered on: a trailing user turn nothing has
   *  answered. Suppressed while this dock is mid-turn — the hosted reply row
   *  is only written at the end, so every running turn looks unanswered. */
  const unansweredId = useMemo(
    () => (live ? null : unansweredTurnId(messages ?? [])),
    [messages, live]);

  /** The last message in the thread — a Revert takes the conversation back
   *  only when its reply IS the last thing said. */
  const lastId = messages?.length ? messages[messages.length - 1].id : null;

  /** A reverted turn's own message, handed back to be edited and sent again.
   *  The draft is persisted the way typing persists it, so this survives a
   *  reload the same way anything else in the composer does. */
  const restoreTurn = (turn: { text: string; attachments: unknown[] }) => {
    setDraft(turn.text);
    if (project) setChatDraft(project.id, threadId, turn.text);
    setAttachments(turn.attachments as ChatAttachment[]);
    setNotice("Reverted — your message is back in the composer.");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Empty while `STALE_UI` is off (see lib/staleBlocks): `StaleNotice` hides
  // itself at zero and the review popup is gated on the same list, so this one
  // line takes both off the dock. The block index is untouched — the director
  // still reads a block's real status, and `rerender_stale` still works when it
  // is asked for by name.
  const staleBlocks = useMemo(
    () => (STALE_UI ? (blockIndex ?? []).filter((b) => b.status === "stale") : []),
    [blockIndex]);
  const staleSeconds = useMemo(
    () => staleBlocks.reduce((t, b) => t + Math.max(0, b.t_end_ms - b.t_start_ms) / 1000, 0),
    [staleBlocks]);
  const [staleOpen, setStaleOpen] = useState(false);
  /** The reply whose Revert was pressed, while its dialog is up: the journal
   *  to replay, which message it was, and whether it is the last exchange —
   *  only then does the conversation go back with the writes. */
  const [reverting, setReverting] = useState<
    { ops: Record<string, unknown>[]; messageId: string; isLast: boolean } | null>(null);
  // The popup takes its rows BY VALUE, so it closes itself once the list it was
  // opened for is empty — every one of them queued, or somebody re-rendered
  // them from the storyboard while it sat open.
  useEffect(() => {
    if (staleOpen && !staleBlocks.length) setStaleOpen(false);
  }, [staleOpen, staleBlocks.length]);

  const canSend = useMemo(
    () => !!project && (draft.trim().length > 0 || attachments.length > 0) && !live,
    [project, draft, live, attachments.length]);

  /** `opts.text` is a turn nobody typed (a clicked choice); `opts.retry`
   *  re-runs the turn that just failed, held whole in `pendingRef`. */
  const send = async (
    opts: { text?: string; retry?: boolean; sawFailure?: boolean } = {},
  ) => {
    if (!project || live) return;
    const held = opts.retry ? pendingRef.current : null;
    if (opts.retry && !held) return;
    if (!held && !opts.text && !canSend) return;
    // A turn can be pictures with no words ("what's wrong with this?"), so the
    // attachments count as content — but the wire still wants a sentence.
    const typed = held?.text ?? opts.text ?? draft.trim();
    const text = typed || (attachments.length ? "Take a look at this." : "");
    if (!text) return;
    const sending = held?.attachments ?? attachments;
    const pick = held?.pick ?? pickRef.current;
    // Where the user is, compiled fresh per turn — it describes the screen at
    // the moment of asking, and a stale one is worse than none. A RETRY keeps
    // the one it was asked with: same words, same screen, same answer.
    const context = held?.context ?? situation();
    pendingRef.current = { text, attachments: sending, context, pick };
    if (!held && !opts.text) {
      setDraft("");
      clearChatDraft(project.id, threadId);
    }
    setErr(null); setNotice(null); setLive({ text: "", tools: [] });
    // A RETRY ANSWERS THE MESSAGE THAT IS ALREADY THERE, and clears the failed
    // reply left in front of it — see `prepareRetry`, which is also what
    // decides whether this turn's row was ever written. Best effort: a
    // transcript that could not be tidied is a duplicated turn, which is
    // better than a retry that refuses to run.
    let resume = false;
    if (held) {
      try {
        // `sawFailure` is the difference between the two retries and it
        // decides what the rows after the user's message MEAN. In session the
        // error is on screen, so they are a failure marker and clearing them
        // is right; from the transcript after a reload the tab knows nothing,
        // so the same rows are a real reply — which this must refuse to
        // delete. See `retryPlan`.
        const r = await prepareRetry(threadId, text, { failed: opts.sawFailure !== false });
        if (r.answered) {
          setLive(null);
          setNotice("That turn was answered while you were away — nothing to retry.");
          reloadRef.current();
          return;
        }
        resume = r.resume;
      } catch (e) {
        console.warn("retry: could not tidy the transcript", e);
      }
    }
    // A STREAM THAT REPORTS AN ERROR IS NOT A TURN THAT SUCCEEDED. The hosted
    // handler has its headers out by the time a backend chain is exhausted, so
    // a rate limit arrives as {t:"error"} and the promise below RESOLVES —
    // which used to run the clear-on-success path and eat the pictures the
    // turn was carrying, leaving nothing to retry with.
    let failed = false;
    try {
      const req = {
        project_id: project.id, episode_id: episode?.id, thread_id: threadId, text, backend,
        context,
        // What the VIDEO chip says right now. The pick is saved to the project
        // too, but a turn sent in the same breath would read the row before
        // that landed — and the picker deciding nothing is the bug this fixes.
        ...(activeVideoModel ? { video_model: activeVideoModel } : {}),
        ...(resume ? { resume: true } : {}),
        ...(sending.length ? { attachments: sending } : {}),
      };
      const onEv = (ev: DirectorEvent) => {
          if (ev.t === "thread") {
            clearChatDraft(project.id, null);
            setThreadId(ev.id);
            setFresh(false);
          }
          else if (ev.t === "delta") setLive((s) => s && { ...s, text: s.text + ev.text });
          else if (ev.t === "tool") {
            setLive((s) => s && {
              ...s,
              tools: ev.status === "run"
                ? [...s.tools, { name: ev.name, status: "run" }]
                : s.tools.map((t) => (t.name === ev.name ? { ...t, status: ev.status } : t)),
            });
            // A block the turn just added or re-rendered holds its place on
            // the open cut right away — the pre-insert the timeline's own
            // extend/chain perform — so "it queued a block but the timeline
            // shows nothing" stops being true for the minutes a render takes.
            // Only for a NEW block: a re-render's clip is already on the lane
            // and the sync repoints it when the take lands.
            if (ev.status === "ok" && ev.block_id && ev.name === "add_block") {
              void placeBlockPlaceholder(ev.block_id).then((r) => {
                if (r === "failed") setNotice("The new block is queued, but its placeholder could not be drawn — it lands on the cut when the render finishes.");
              });
            }
          } else if (ev.t === "fallback") {
            // The turn is still running on the next provider — a notice, not
            // an error, and worth saying because the tools may have gone with it.
            setNotice(`${backendLabel(ev.from)} was ${ev.reason} — continuing on ${
              backendLabel(ev.to)}${ev.note ? ` (${ev.note})` : ""}.`);
          } else if (ev.t === "error") { failed = true; setErr(describeDirectorError(ev.message)); }
      };
      // ONE PATH. The turn is answered on this machine — the picked backend's
      // own key, or the Ollama on loopback — and refused with a reason when
      // neither can. The rows it writes are the same rows either way, which is
      // what makes the transcript below render without branching.
      await queueLocalDirectorTurn({ ...req, project }, onEv,
        pick ? { extraBlocks: [pick] } : {});
      // Only once the turn is away, and only if it did not report an error on
      // the way: clearing regardless is what left a failed turn with its words
      // gone and its pictures gone, so the only way back was to type it again.
      if (!failed) {
        setAttachments([]);
        pickRef.current = null;
        pendingRef.current = null;
      }
    } catch (e) {
      setErr(describeDirectorError(String((e as Error).message || e)));
    } finally {
      setLive(null); reloadRef.current(); reloadThreads();
    }
  };

  /** The director asked a question and offered its own answers. Clicking one
   *  is an ordinary user turn — the text is what both backends read in
   *  history, and the structured block beside it is what a tool-driving
   *  worker can act on without re-parsing English. Deliberately NOT a direct
   *  tool call from the browser: invariant #1 says work is a jobs row, and the
   *  director is the thing that decides to queue one. */
  const pickChoice = (o: ChoiceOption, question: string) => {
    if (live) return;
    pickRef.current = {
      type: "choice_pick", option_id: o.id, label: o.label,
      ...(question ? { question } : {}),
      ...(o.tool ? { tool: o.tool } : {}),
      ...(o.args ? { args: o.args } : {}),
    };
    // Passed explicitly rather than staged in the composer: setState is not
    // synchronous, so writing the draft and sending on the same tick would
    // send whatever was in the box before the click.
    void send({ text: `I pick: ${o.label}${o.detail ? ` — ${o.detail}` : ""}` });
  };

  const toggleMic = () => {
    if (listening) { recRef.current?.stop(); return; }
    const w = window as unknown as Record<string, unknown>;
    const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | undefined;
    if (!Ctor) { setErr("Voice input needs Chrome or Edge"); return; }
    const rec = new Ctor();
    rec.lang = "en-US"; rec.continuous = true; rec.interimResults = true;
    rec.onresult = (ev) => {
      let t = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) t += ev.results[i][0].transcript;
      setDraft((d) => (d ? d + " " : "") + t.trim());
    };
    rec.onend = () => setListening(false);
    recRef.current = rec; rec.start(); setListening(true);
  };

  if (!ws.chatOpen) {
    return (
      <aside className={"ws-dock closed" + (ws.dockLifted ? " lifted" : "")}>
        <button className="ws-send" title="Open the director" onClick={() => ws.toggle("chatOpen")}>
          <MessageSquare size={16} />
        </button>
        <span className="ws-vert">Director</span>
      </aside>
    );
  }

  // A BYOK row is only offered where its key exists — picking one without a
  // key would fail on the first turn naming a credential the picker never
  // mentioned. `currentBackend` still resolves against the FULL list: a thread
  // may have been started on a key that has since been removed, and showing
  // its real name beats showing the first row's.
  const backends = availableBackends(byokKeys, { admin: isAdmin });
  const currentBackend = DIRECTOR_BACKENDS.find((b) => b.id === backend) ?? DIRECTOR_BACKENDS[0];

  return (
    <aside className={"ws-dock" + (ws.dockLifted ? " lifted" : "")}>
      {/* HEADER — identity, then the two RENDER-model pickers.
          The organising rule of the handoff: what the studio renders WITH is
          decided at the top, and the LLM that answers this message is decided
          at the bottom next to the message. Before it, all three pickers sat
          in two bars here and nothing said which of them decided what. */}
      <div className="ws-dock-head">
        <div className="ws-dock-id">
          <span className="ws-avatar"><Sparkles size={17} /></span>
          <div className="ws-dock-who">
            <div className="ws-dock-t">Creative Director</div>
            {/* The handoff puts the agent's own state here. Ours carries the
                THREAD, because the history bar that used to name it is now an
                icon button — and "which conversation am I in" is the one fact
                that would otherwise have no surface at all. */}
            <div className="ws-dock-s" title={fresh || !thread ? "New chat" : threadName(thread)}>
              {fresh || !thread ? "New chat" : threadName(thread)} · RAG on
            </div>
          </div>
          <DockIconBtn title="New chat" disabled={!project} onClick={newChat}>
            <Plus size={15} />
          </DockIconBtn>
          <Dropdown width={318} align="right" maxHeight={420}
            trigger={({ toggle }) => (
              <DockIconBtn title={`History · ${threads?.length ?? 0} chat${threads?.length === 1 ? "" : "s"}`}
                           disabled={!project} onClick={toggle}>
                <History size={15} />
              </DockIconBtn>
            )}>
            {(close) => (
              <>
                <button className="ws-menu-row" onClick={() => { close(); newChat(); }}>
                  <Plus size={13} style={{ color: "#58a6ff", flex: "none" }} />
                  <span style={{ flex: 1, fontSize: 12.5 }}>New chat</span>
                </button>
                <div className="ws-menu-sep" />
                <div className="ws-menu-label">History · {threads?.length ?? 0}</div>
                {(threads ?? []).map((t) => (
                  <div key={t.id} className={"ws-threadrow" + (t.id === threadId ? " on" : "")}>
                    {renaming === t.id ? (
                      <input className="ws-input" autoFocus value={renameDraft}
                             style={{ flex: 1, height: 28, fontSize: 12, padding: "0 9px" }}
                             onChange={(e) => setRenameDraft(e.target.value)}
                             onBlur={() => void commitRename(t.id)}
                             onKeyDown={(e) => {
                               e.stopPropagation();
                               if (e.key === "Enter") void commitRename(t.id);
                               if (e.key === "Escape") setRenaming(null);
                             }} />
                    ) : (
                      <>
                        <button className="body" onClick={() => { close(); openThread(t.id); }}>
                          <span className="t">{threadName(t)}</span>
                          <span className="mono s">
                            {ago(t.updated_at)} · {t.turns} msg{t.turns === 1 ? "" : "s"}
                            {t.backend ? ` · ${backendModelName(t.backend)}` : ""}
                          </span>
                        </button>
                        <button className="act" title="Rename"
                                onClick={() => { setRenaming(t.id); setRenameDraft(threadName(t)); }}>
                          <Pencil size={11} />
                        </button>
                        <button className="act danger" title="Delete this chat and its messages"
                                onClick={() => void removeThread(t.id)}>
                          <Trash2 size={11} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
                {threads && !threads.length && (
                  <div className="ws-menu-empty">No chats yet — the first message starts one.</div>
                )}
              </>
            )}
          </Dropdown>
          {/* Not in the handoff — the prototype is a standalone card and has
              no concept of the rail collapsing. The dock does, and this is
              the only way back out of it. */}
          <DockIconBtn title="Collapse the director" onClick={() => ws.toggle("chatOpen")}>
            <ChevronRight size={15} />
          </DockIconBtn>
        </div>

        <div className="ws-dock-models">
          <Dropdown width={310} align="left"
            trigger={({ toggle }) => (
              <ModelChip kind="video" onClick={toggle}
                         value={shortModelName(selectedVideoObj?.display_name ?? activeVideoModel, "H3 Turbo")}
                         tier={selectedVideoObj ? tierOf(selectedVideoObj) : null}
                         title={selectedVideoObj
                           ? `Video model: ${selectedVideoObj.display_name} — runs on ${
                               TIER_META[tierOf(selectedVideoObj)].where}`
                           : `Video model: ${activeVideoModel}`} />
            )}>
            {(close) => (
              <TieredModelMenu models={videoModels} value={activeVideoModel} close={close}
                               onPick={(id) => void onSelectVideoModel(id)}>
                <EngineNote engine={engine} />
              </TieredModelMenu>
            )}
          </Dropdown>

          <Dropdown width={310} align="right"
            trigger={({ toggle }) => (
              <ModelChip kind="image" onClick={toggle}
                         value={shortModelName(selectedImageObj?.display_name ?? activeImageModel, "Krea 2")}
                         tier={selectedImageObj ? tierOf(selectedImageObj) : null}
                         title={selectedImageObj
                           ? `Image model: ${selectedImageObj.display_name} — runs on ${
                               TIER_META[tierOf(selectedImageObj)].where}`
                           : `Image model: ${activeImageModel}`} />
            )}>
            {(close) => (
              <TieredModelMenu models={imageModels} value={activeImageModel} close={close}
                               onPick={(id) => void onSelectImageModel(id)}
                               quality={resolvedDefaults.image_quality}
                               onQuality={(q) => void onSelectImageQuality(q)}>
                <EngineNote engine={engine} />
              </TieredModelMenu>
            )}
          </Dropdown>
        </div>
      </div>

      <div className="ws-thread ns-scroll" ref={scrollRef}>
        {!project && <div className="ws-amsg" style={{ color: "#5e6678" }}>Open a project to talk to the director.</div>}
        {project && !messages?.length && !live && (
          <div className="ws-amsg" style={{ color: "#8b93a7" }}>
            Brief me like a director. I can plan storyboards, design VFX frames,
            evolve the bible, and queue retakes or renders.
          </div>
        )}
        {(messages ?? []).map((m) => (
          <Msg key={m.id} m={m}
               onOpenAsset={(assetId) => ws.openModal({ kind: "asset", assetId })}
               onOpenBlock={(blockId) => ws.openModal({ kind: "takes", blockId })}
               onPickChoice={pickChoice}
               onRevert={live ? undefined
                 : (ops) => setReverting({ ops, messageId: m.id, isLast: m.id === lastId })}
               onRetry={m.id === unansweredId ? () => retryFromRow(m) : undefined} />
        ))}
        {live && (
          <>
            {live.tools.map((t, i) => (
              <div key={i} className={"ws-tool-row" + (t.status === "run" ? " run" : "")}>
                {t.status === "run" ? <Loader2 size={12} className="ns-spin" />
                  : t.status === "err" ? <X size={12} style={{ color: "#ff8080" }} />
                  : <Check size={12} style={{ color: "#6fd08c" }} />}
                {t.name}
              </div>
            ))}
            {live.text && <div className="ws-amsg"><Markdown text={live.text} /></div>}
            {!live.text && <Loader2 size={14} className="ns-spin" style={{ color: "#5e6678" }} />}
          </>
        )}
        {notice && (
          <div className="ws-tool-row" style={{ color: "#e8c268" }}>
            <AlertTriangle size={12} /> {notice}
            <button style={{ marginLeft: "auto", color: "inherit", opacity: .6, cursor: "pointer" }}
                    onClick={() => setNotice(null)}>
              <X size={11} />
            </button>
          </div>
        )}
        {/* The turn is still here — the words, the pictures and the screen it
            was asked against — so a rate limit costs a click rather than
            retyping it. */}
        {err && (
          <ErrorRow message={err} busy={!!live}
                    onRetry={pendingRef.current ? () => void send({ retry: true }) : undefined} />
        )}
      </div>

      {/* Blocks whose plan moved on since they last rendered. It reads the
          block index this dock already keeps live for the situational context,
          so it costs no query of its own — and it answers, from the graph, the
          question the director used to have to ASK in prose and wait for a
          typed reply to. */}
      <StaleNotice count={staleBlocks.length} seconds={staleSeconds}
                   onReview={() => setStaleOpen(true)} />

      {staleOpen && !!staleBlocks.length && (
        <StaleBlocksModal blocks={staleBlocks}
                          projectId={project?.id} episodeId={episode?.id}
                          onClose={() => setStaleOpen(false)}
                          onQueued={(msg) => { setErr(null); setNotice(msg); }} />
      )}
      {reverting && (
        <RevertTurnDialog ops={reverting.ops} threadId={threadId}
                          messageId={reverting.messageId} isLast={reverting.isLast}
                          onCancel={() => setReverting(null)}
                          onRestore={restoreTurn}
                          onDone={() => { setReverting(null); reloadRef.current(); }} />
      )}

      {/* Multi-line: a director's brief is a paragraph, and a single-line input
          hid everything but the tail of it while you were writing. Enter still
          sends (that is the muscle memory); Shift+Enter breaks the line. */}
      <div className={"ws-composer" + (dragOver ? " over" : "")}
           onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
           onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
           onDrop={(e) => void onDrop(e)}>
        {/* What this turn is carrying. Above the input rather than inside it,
            so a long brief still scrolls past a fixed row of evidence. */}
        {(!!attachments.length || uploading != null) && (
          <div className="ws-attach-shelf ns-scroll">
            {attachments.map((a) => (
              <div key={`${a.kind}:${a.id}`}
                   className={"ws-attach" + (a.kind === "block" ? " blk" : "")}
                   title={a.label ?? a.id}>
                {a.kind === "block"
                  ? <span className="ws-attach-blk"><Film size={13} />{a.label ?? "block"}</span>
                  : a.media === "image"
                    ? <img src={a.b2_key ? mediaUrl(a.b2_key) ?? undefined : undefined} alt="" loading="lazy" />
                    : <span className="ws-attach-icon">
                        {a.media === "audio" ? <Music size={14} /> : <Film size={14} />}
                      </span>}
                <button className="x" title="Remove"
                        onClick={() => setAttachments((cur) =>
                          cur.filter((x) => !(x.kind === a.kind && x.id === a.id)))}>
                  <X size={10} />
                </button>
              </div>
            ))}
            {uploading != null && (
              <span className="ws-attach-up mono">{Math.round(uploading * 100)}%</span>
            )}
          </div>
        )}
        {/* The words get the full width and no field border of their own —
            the panel edge already carries one, and a rounded box inside a
            rounded box is two frames around one sentence. */}
        <textarea ref={inputRef} rows={1} className="ws-compose-in ns-scroll"
                  placeholder={project
                    ? "Direct me…  (⇧↵ for a new line · drop or paste media)"
                    : "Open a project first"}
                  value={draft} disabled={!project}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={(e) => {
                    const files = clipboardMediaFiles(e.clipboardData);
                    if (!files.length) return;   // ordinary text paste
                    e.preventDefault();
                    void onUpload(files);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
                  }} />
        <div className="row">
          <button className="ws-cbtn" title="Attach an image, clip or audio file"
                  aria-label="Attach an image, clip or audio file"
                  disabled={!project} onClick={() => fileRef.current?.click()}>
            {uploading != null ? <Loader2 size={14} className="ns-spin" /> : <Paperclip size={14} />}
          </button>

          {/* Which model answers THIS message — beside the message, not up in
              the header with the checkpoints that render pictures. */}
          <Dropdown width={312} align="left"
            trigger={({ toggle }) => (
              <LlmChip model={currentBackend.model} level={currentBackend.connection}
                       title={currentBackend.label} onClick={toggle} />
            )}>
            {(close) => (
              <>
                <BackendMenu value={backend} onPick={setBackend} close={close} />
              </>
            )}
          </Dropdown>

          <span className="sp" />
          <button className={"ws-cbtn mic" + (listening ? " on" : "")} onClick={toggleMic}
                  title="Push-to-talk" aria-label="Push-to-talk"
                  aria-pressed={listening}>
            <Mic size={14} />
          </button>
          <button className="ws-cbtn send" disabled={!canSend} onClick={() => void send()}
                  title="Send" aria-label="Send">
            <Send size={14} />
          </button>
        </div>
        {dragOver && (
          <div className="ws-dropnote mono">
            <Upload size={12} /> drop to attach — library cards, blocks, or files
          </div>
        )}
      </div>

      <input ref={fileRef} type="file" hidden multiple accept="image/*,video/*,audio/*"
             onChange={(e) => void onUpload(e.target.files)} />
    </aside>
  );
}
