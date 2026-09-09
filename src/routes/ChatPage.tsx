import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Loader2, Mic, MicOff, Plus, Send, Wrench } from "lucide-react";
import V2Shell from "../design/V2Shell";
import { useLiveQuery } from "../hooks/useLiveQuery";
import { loadMessages, loadThreads } from "../lib/db/director";
import { loadProject, mainEpisode } from "../lib/db/projects";
import {
  DIRECTOR_BACKENDS, availableBackends, queueLocalDirectorTurn, type DirectorEvent,
} from "../lib/director";
import { useIsAdmin } from "../lib/auth";
import { useByok } from "../hooks/useByok";
import { getChatDraft, setChatDraft, clearChatDraft } from "../lib/draftStore";
import { mediaUrl } from "../lib/supabase";
import type { ChatMessage } from "../lib/db/types";
import "../styles/director.css";
import { blockRef } from "../../director/refs.js";

interface Block {
  type: string; text?: string; name?: string; result?: { job_id?: string; error?: string };
  /** asset_ref / block_ref — the chat's attachment blocks */
  b2_key?: string; media?: string; label?: string; idx?: number;
}

function MessageBody({ msg }: { msg: ChatMessage }) {
  const blocks = (Array.isArray(msg.content) ? msg.content : []) as Block[];
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "text" && b.text?.trim()) {
          return <div key={i} className="chatmsg-text">{b.text}</div>;
        }
        // Read-only here, deliberately: this page is the v1 chat route and has
        // no modal layer to open an asset into. Showing the thumbnail is still
        // worth the six lines — a transcript that silently drops what a turn
        // was about reads as the attachment never having been sent.
        if (b.type === "asset_ref" && b.b2_key) {
          return (b.media ?? "image") === "image"
            ? <img key={i} className="chatmsg-thumb" src={mediaUrl(b.b2_key) ?? undefined}
                   alt={b.label ?? ""} loading="lazy" />
            : <span key={i} className="toolchip">{b.label ?? b.media}</span>;
        }
        if (b.type === "block_ref") {
          return <span key={i} className="toolchip">{b.label ?? (b.idx != null ? blockRef(b.idx) : "block")}</span>;
        }
        if (b.type === "tool_use") {
          return (
            <span key={i} className="toolchip">
              <Wrench size={11} /> {b.name}
            </span>
          );
        }
        if (b.type === "tool_result") {
          const jid = b.result?.job_id;
          const err = b.result?.error;
          return (
            <span key={i} className={"toolchip result" + (err ? " err" : "")}>
              {err ? `⚠ ${b.name}` : jid ? <Link to="/queue">→ job queued</Link> : `✓ ${b.name}`}
            </span>
          );
        }
        return null;
      })}
      {msg.streaming && <Loader2 className="spin" size={13} />}
    </>
  );
}

// Minimal typings for the vendor-prefixed Web Speech API.
interface SpeechRecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>>; resultIndex: number }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
}

export default function ChatPage() {
  const { pid, tid } = useParams<{ pid: string; tid?: string }>();
  const nav = useNavigate();
  const [draft, setDraft] = useState(() => getChatDraft(pid, tid));
  const activeKeyRef = useRef(`${pid}:${tid}`);

  useEffect(() => {
    const key = `${pid}:${tid}`;
    activeKeyRef.current = key;
    setDraft(getChatDraft(pid, tid));
  }, [pid, tid]);

  useEffect(() => {
    const key = `${pid}:${tid}`;
    if (activeKeyRef.current !== key) return;
    setChatDraft(pid, tid, draft);
  }, [draft, pid, tid]);

  const [backend, setBackend] = useState(DIRECTOR_BACKENDS[0].id);
  const isAdmin = useIsAdmin();
  const { keyed: byokKeys } = useByok();
  const backends = availableBackends(byokKeys, { admin: isAdmin });
  const [live, setLive] = useState<{ text: string; tools: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: project } = useLiveQuery(() => loadProject(pid!), ["projects"], [pid]);
  const { data: threads, reload: reloadThreads } = useLiveQuery(
    () => loadThreads(pid!), ["chat_threads"], [pid]);
  const { data: messages, reload: reloadMsgs } = useLiveQuery(
    () => (tid ? loadMessages(tid) : Promise.resolve([] as ChatMessage[])),
    ["chat_messages"], [tid]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, live]);

  const canSend = useMemo(() => draft.trim().length > 0 && !live, [draft, live]);

  const send = async () => {
    if (!canSend || !pid) return;
    const text = draft.trim();
    setDraft("");
    clearChatDraft(pid, tid);
    setErr(null);
    setLive({ text: "", tools: [] });
    try {
      const ep = await mainEpisode(pid);
      const req = { project_id: pid, episode_id: ep?.id, thread_id: tid ?? null, text, backend };
      // Same one path as the dock: answered on this machine by the picked
      // backend's own key or the Ollama on loopback, and refused with a reason
      // when neither can.
      const onEv =
        (ev: DirectorEvent) => {
          if (ev.t === "thread" && !tid) {
            clearChatDraft(pid, null);
            nav(`/project/${pid}/chat/${ev.id}`, { replace: true });
          }
          else if (ev.t === "delta") setLive((s) => s && { ...s, text: s.text + ev.text });
          else if (ev.t === "tool" && ev.status === "run") {
            setLive((s) => s && { ...s, tools: [...s.tools, ev.name] });
          } else if (ev.t === "error") setErr(ev.message);
        };
      const project = await loadProject(pid);
      await queueLocalDirectorTurn({ ...req, project: project ?? undefined }, onEv);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setLive(null);
      reloadMsgs();
      reloadThreads();
    }
  };

  const toggleMic = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const w = window as unknown as Record<string, unknown>;
    const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
      | (new () => SpeechRecognitionLike) | undefined;
    if (!Ctor) {
      setErr("Voice input needs Chrome/Edge (Web Speech API)");
      return;
    }
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      let final = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) final += ev.results[i][0].transcript;
      setDraft((d) => (d ? d + " " : "") + final.trim());
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  return (
    <V2Shell title="Director" eyebrow={project?.title ?? "Chat"} backTo={`/project/${pid}`} wide>
      <div className="chatwrap">
        <aside className="chatside">
          <Link to={`/project/${pid}/chat`} className="dir-ghost chatside-new">
            <Plus size={13} /> New chat
          </Link>
          {(threads ?? []).map((t) => (
            <Link
              key={t.id}
              to={`/project/${pid}/chat/${t.id}`}
              className={"chatside-item" + (t.id === tid ? " on" : "")}
            >
              {t.title ?? "untitled"}
            </Link>
          ))}
        </aside>
        <section className="chatmain">
          <div className="chatscroll" ref={scrollRef}>
            {!tid && !live && (
              <div className="v2-empty">
                Brief me like a director: what are we making, how should it feel?
                <br />I can plan storyboards, evolve the bible, queue retakes and renders.
              </div>
            )}
            {(messages ?? []).map((m) => (
              <div key={m.id} className={"chatmsg " + m.role}>
                <MessageBody msg={m} />
              </div>
            ))}
            {live && (
              <div className="chatmsg assistant">
                {live.tools.map((t, i) => (
                  <span key={i} className="toolchip"><Wrench size={11} /> {t}</span>
                ))}
                <div className="chatmsg-text">{live.text}</div>
                <Loader2 className="spin" size={13} />
              </div>
            )}
            {err && <div className="chatmsg error">{err}</div>}
          </div>
          <div className="composer">
            <select
              className="dir-select"
              value={backend}
              onChange={(e) => setBackend(e.target.value)}
              title="LLM backend"
            >
              {backends.map((b) => (
                <option key={b.id} value={b.id}>{b.label}</option>
              ))}
            </select>
            <textarea
              className="composer-input"
              rows={2}
              placeholder={backend === "ollama-local"
                ? "Uncensored mode — runs on a local model…"
                : "Talk to your director…"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button
              className={"dir-ghost mic" + (listening ? " on" : "")}
              onClick={toggleMic}
              title="Push-to-talk"
            >
              {listening ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
            <button className="dir-cta send" disabled={!canSend} onClick={send}>
              <Send size={14} />
            </button>
          </div>
        </section>
      </div>
    </V2Shell>
  );
}
