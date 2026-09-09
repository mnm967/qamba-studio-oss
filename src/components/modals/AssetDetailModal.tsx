// Asset detail (design: 1000px) — player with scrub, place-on-timeline /
// use-as-reference / grab-a-frame, provenance, prompt, references, tags,
// where-used with the ripple count. Opened from library cards and clips.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera, Crop, Download, Film, Image as ImageIcon, Maximize2, Music, Pause, Play,
  Plus, Sparkles, Trash2, Wand2, X,
} from "lucide-react";
import { createPortal } from "react-dom";
import ModalShell from "./ModalShell";
import PanelRegenModal from "./PanelRegenModal";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import { assetUrl, loadGenerationSource, trashAssets } from "../../lib/db/assets";
import { enqueueJob, USER_PRIORITY } from "../../lib/db/jobs";
import { invalidateTables } from "../../hooks/useLiveQuery";
import Dropdown from "../ui/Dropdown";
import { POST_PROCESS } from "../../lib/engineCatalog";
import { postRecipe } from "../../lib/localGraphs";
import { useLocalEngine } from "../../hooks/useLocalEngine";
import type { Clip } from "../../lib/db/types";
import { blockRef } from "../../../director/refs.js";

const fmtS = (ms?: number | null) => (ms ? `${(ms / 1000).toFixed(1)}s` : null);
const fmtMB = (b?: number | null) => (b ? `${(b / 1048576).toFixed(1)} MB` : null);

function Row({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
      <span>{k}</span><span style={{ color: tone ?? "#eaeef6", textAlign: "right" }}>{v}</span>
    </div>
  );
}

export default function AssetDetailModal({ assetId }: { assetId: string }) {
  const ws = useWorkspaceStore();
  const tl = useTimelineStore();
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const fullRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [full, setFull] = useState(false);
  const [pos, setPos] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const [regen, setRegen] = useState(false);
  const [tagDraft, setTagDraft] = useState<string | null>(null);

  const { data, error: loadError, reload } = useLiveQuery(
    async () => {
      // The prompt + references half is shared with every other surface that
      // offers a redraw (lib/db/assets.ts) — it resolves late-bound anchors
      // the way the worker does, which is the only way to report what a panel
      // was actually conditioned on.
      const [src, { data: used }] = await Promise.all([
        loadGenerationSource(assetId),
        supabase.from("clips").select("id,track_id,t_start_ms,label").eq("asset_id", assetId),
      ]);
      if (!src) return null;
      const { asset: a, job, prompt, refs } = src;
      const payload = (job?.payload ?? {}) as Record<string, unknown>;
      let blockLabel: string | null = null;
      const blockId = (a.meta?.block_id as string) ?? (payload.block_id as string) ?? null;
      if (blockId) {
        const { data: b } = await supabase.from("generation_blocks")
          .select("idx").eq("id", blockId).maybeSingle();
        if (b) blockLabel = blockRef(b.idx);
      }
      return { a, job, prompt, used: (used ?? []) as Pick<Clip, "id" | "track_id" | "t_start_ms" | "label">[], refs, blockLabel };
    },
    ["assets", "clips"], [assetId]
  );

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    const t = setInterval(() => setPos(el.currentTime), 100);
    return () => clearInterval(t);
  }, [data?.a.id, playing]);

  /** Hand the playhead to the big player, and take it back on close. */
  const openFull = () => {
    const el = mediaRef.current;
    if (el) { el.pause(); setPlaying(false); }
    setFull(true);
  };
  const closeFull = () => {
    const big = fullRef.current, el = mediaRef.current;
    if (big && el) { el.currentTime = big.currentTime; setPos(big.currentTime); }
    setFull(false);
  };

  // Esc closes the viewer, not the modal behind it — the scrim has no key
  // handler of its own, so capture here and stop it there.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeFull();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [full]);

  // Every hook has to run on the LOADING render too, and the early return
  // below is what a fetching modal spends its first renders in — so anything
  // hook-shaped lives above it. `isVideo` comes off `data?` for that reason.
  const isVideo = data?.a.kind === "video" || data?.a.kind === "render";
  /**
   * A POST PASS over a finished clip, on this machine.
   *
   * Video post has no cloud equivalent reachable from here — the pod runs its
   * passes inside `tl_render`, over a whole timeline — so these are offered
   * only where they can actually run: a desktop engine with the tool's weights
   * on disk. A button that queues a job nothing will claim is the failure this
   * codebase keeps naming, so the absent case is a REASON rather than a
   * disabled control with no explanation.
   */
  const engine = useLocalEngine();
  const postPasses = useMemo(() => {
    if (!isVideo || !engine.desktop) return [];
    const have = new Set(engine.status?.files ?? []);
    return POST_PROCESS
      .map((t) => ({ tool: t, recipe: postRecipe(t.id) }))
      .filter((x) => x.recipe && x.tool.files.every((f) => have.has(f.filename)))
      .map((x) => ({ tool: x.tool, recipe: x.recipe! }));
  }, [isVideo, engine.desktop, engine.status]);

  if (!data) {
    return (
      <ModalShell width={1000} z={94}
                  icon={<ImageIcon size={16} />} title="Media"
                  loading loadingLabel="Loading media…" loadError={loadError} />
    );
  }
  const { a, job, used, refs, blockLabel, prompt } = data;
  const isAudio = a.kind === "audio";
  const url = assetUrl(a) ?? undefined;
  const durS = (a.duration_ms ?? 0) / 1000;
  const name = a.b2_key.split("/").pop() ?? a.b2_key;
  // A storyboard panel identifies itself by the target it was written to —
  // the same `as: "panel"` that decides whether the render reads it as this
  // shot's framing.
  const target = (a.meta?.target ?? (job?.payload as Record<string, unknown>)?.target) as
    { beat_id?: string; as?: string } | undefined;
  // The opener's beat wins: it always knows, while the target only exists on
  // panels the pipeline wrote one onto (a hand-queued render has none).
  const openedFrom = ws.modal?.kind === "asset" ? ws.modal.fromBeat : undefined;
  const panelBeatId = openedFrom
    ?? (target?.as === "panel" && target.beat_id ? target.beat_id : null);

  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) { void el.play().catch(() => {}); setPlaying(true); }
    else { el.pause(); setPlaying(false); }
  };

  const placeOnTimeline = async () => {
    const vt = tl.tracks.find((t) => t.kind === "video");
    const at = usePlaybackStore.getState().nowMs();
    if (!vt) { setNote("Open an episode timeline first, then place from here."); return; }
    await tl.insertAsset(a, vt.id, at);
    setNote(`Placed on ${vt.name ?? "V1"} at ${(at / 1000).toFixed(1)}s.`);
  };
  const useAsReference = async () => {
    const tags = [...new Set([...(a.tags ?? []), "ref"])];
    await supabase.from("assets").update({ tags }).eq("id", a.id);
    setNote("Tagged as a reference — pickable in ref slots.");
    reload();
  };
  const grabFrame = async () => {
    const el = mediaRef.current as HTMLVideoElement | null;
    const at = Math.round((el?.currentTime ?? 0) * 1000);
    await enqueueJob({
      kind: "frame_extract", lane: "cpu", priority: 20, project_id: a.project_id ?? undefined,
      payload: { asset_id: a.id, at_ms: at },
    });
    setNote(`Frame at ${(at / 1000).toFixed(2)}s queued — lands in the library as a still.`);
  };
  /** Tile-refine upscale: an ESRGAN enlarge then a low-denoise diffusion pass
   *  per tile through Qwen-Edit. GPU lane and USER_PRIORITY, because a human
   *  clicked it — it should preempt an episode queue at the next boundary. */
  const upscale = async () => {
    await enqueueJob({
      kind: "image_upscale", lane: "gpu", priority: USER_PRIORITY,
      project_id: a.project_id ?? undefined,
      payload: { asset_id: a.id, scale: 2, denoise: 0.2,
                 label: `${name} · upscale 2x` },
    });
    setNote("Upscale queued — 2x, lands in the library as a new still.");
  };
  const runPost = async (tool: string, jobKind: string, factor: number, label: string) => {
    await enqueueJob({
      // `lane: "local"` is the whole reason this is claimable: the pod filters
      // by lane and has never heard of a post job over one library asset.
      kind: jobKind, lane: "local", priority: USER_PRIORITY,
      project_id: a.project_id ?? undefined,
      payload: { post: { tool, asset_id: a.id, factor }, label: `${name} · ${label}` },
    });
    invalidateTables(["jobs"]);
    setNote(`${label} queued on this machine — it lands in the library as a new clip.`);
  };

  const commitTag = async (keepOpen = false) => {
    const t = (tagDraft ?? "").trim();
    setTagDraft(keepOpen && t ? "" : null);
    if (!t || (a.tags ?? []).includes(t)) return;
    await supabase.from("assets").update({ tags: [...new Set([...(a.tags ?? []), t])] }).eq("id", a.id);
    reload();
  };
  /** Into the recycle bin, not off B2. Clips can still reference this asset
   *  (`used` counts them), and a delete that took the bytes with it made that
   *  ripple unrecoverable; the library's bin is where purging now happens. */
  const removeAsset = async () => {
    await trashAssets([a.id]);
    ws.closeModal();
  };

  return (
    <ModalShell
      width={1000} z={94}
      icon={isVideo ? <Film size={16} /> : isAudio ? <Music size={16} /> : <ImageIcon size={16} />}
      title={name}
      context={<>{a.b2_key} · {[fmtS(a.duration_ms), a.width ? `${a.width}×${a.height}` : null, fmtMB(a.bytes)].filter(Boolean).join(" · ")}</>}
      footer={<>
        <span className="sum">Public B2 read URL · signed writes only</span>
        {/* The picture goes with the question. `askDirector` alone handed the
            director a sentence about an image it could not see — which is the
            whole gap the chat's attachments close, so the two are one click. */}
        <button className="ws-ghost" title="Attach this to the director chat and ask about it"
                onClick={() => {
                  ws.shelfChat(a.id);
                  ws.askDirector(`About ${name}: `);
                }}>
          <Sparkles size={14} /> Ask the director
        </button>
        <button className="ws-ghost" onClick={ws.closeModal}>Close</button>
      </>}
    >
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 18, padding: "0 22px 4px" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ position: "relative", aspectRatio: "16/9", borderRadius: 20, overflow: "hidden",
                        background: "#000", border: "1px solid rgba(255,255,255,.09)" }}>
            {isVideo && (
              <video ref={mediaRef as React.RefObject<HTMLVideoElement>} src={url} playsInline
                     onEnded={() => setPlaying(false)}
                     style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
            )}
            {isAudio && (
              <>
                <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} src={url}
                       onEnded={() => setPlaying(false)} />
                <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#5e6678" }}>
                  <Music size={44} />
                </div>
              </>
            )}
            {!isVideo && !isAudio && (
              <img src={url} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
            )}
            <button className="ws-lb-open" title="Full screen" onClick={openFull}>
              <Maximize2 size={14} />
            </button>
            {(isVideo || isAudio) && (
              <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "12px 14px",
                            background: "linear-gradient(0deg, rgba(4,6,10,.9), transparent)",
                            display: "flex", alignItems: "center", gap: 11 }}>
                <button onClick={togglePlay}
                        style={{ width: 34, height: 34, borderRadius: 17, border: "none",
                                 background: "rgba(234,238,246,.94)", color: "#07090e",
                                 display: "grid", placeItems: "center", cursor: "pointer" }}>
                  {playing ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <span style={{ flex: 1, height: 4, borderRadius: 2, background: "rgba(255,255,255,.2)",
                               position: "relative", cursor: "pointer" }}
                      onClick={(e) => {
                        const el = mediaRef.current;
                        if (!el || !durS) return;
                        const r = e.currentTarget.getBoundingClientRect();
                        el.currentTime = ((e.clientX - r.left) / r.width) * durS;
                        setPos(el.currentTime);
                      }}>
                  <span style={{ position: "absolute", left: 0, top: 0, bottom: 0,
                                 width: `${durS ? Math.min(100, (pos / durS) * 100) : 0}%`,
                                 borderRadius: 2, background: "#5aa2ff" }} />
                </span>
                <span className="mono" style={{ fontSize: 11.5, fontWeight: 500, color: "#eaeef6" }}>
                  {pos.toFixed(1)} / {durS.toFixed(1)}
                </span>
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <button className="ws-primary" style={{ height: 38 }} onClick={placeOnTimeline}>
              <Plus size={14} />Place on timeline
            </button>
            <button className="ws-ghost" style={{ height: 38 }} onClick={useAsReference}>
              <Wand2 size={14} />Use as reference
            </button>
            {isVideo && (
              <button className="ws-ghost" style={{ height: 38 }} onClick={grabFrame}>
                <Crop size={14} />Grab a frame
              </button>
            )}
            {!isVideo && !isAudio && (
              <button className="ws-ghost" style={{ height: 38 }} onClick={upscale}
                      title="2x enlarge, then a low-denoise refine pass in tiles through Qwen-Edit">
                <Maximize2 size={14} />Upscale 2x
              </button>
            )}
            {/* One button per pass whose weights are actually here. The factor
                is the pass's own vocabulary — a SCALE for the restore, a
                MULTIPLIER for interpolation — so the menu says what the number
                means rather than offering a bare "2". */}
            {postPasses.map(({ tool, recipe }) => (
              <Dropdown key={tool.id} width={230}
                        trigger={({ toggle }) => (
                          <button className="ws-ghost" style={{ height: 38 }}
                                  title={tool.blurb} onClick={toggle}>
                            <Maximize2 size={14} />{recipe.label}
                          </button>
                        )}>
                {(close) => (
                  <>
                    <div className="ws-menu-label">{recipe.factorLabel}</div>
                    {recipe.factors.map((f) => (
                      <button key={f} className="ws-menu-row"
                              onClick={() => {
                                close();
                                void runPost(tool.id, recipe.jobKind, f, `${recipe.label} ${f}x`);
                              }}>
                        <span style={{ flex: 1 }}>{f}x</span>
                      </button>
                    ))}
                  </>
                )}
              </Dropdown>
            ))}
            <span style={{ flex: 1 }} />
            {armedDelete ? (
              <span className="ws-confirm" style={{ height: 38, borderRadius: 16, padding: "0 6px 0 12px" }}>
                <span>move to the recycle bin{used.length ? ` — ${used.length} clip${used.length === 1 ? "" : "s"} use it` : ""}?</span>
                <button className="yes" onClick={() => void removeAsset()}>bin it</button>
                <button onClick={() => setArmedDelete(false)}>keep</button>
              </span>
            ) : (
              <button title="Move to the recycle bin — purge it there" onClick={() => setArmedDelete(true)}
                      style={{ width: 38, height: 38, borderRadius: 16, border: "1px solid rgba(255,90,90,.35)",
                               background: "rgba(255,90,90,.08)", color: "#ff8080", display: "grid",
                               placeItems: "center", cursor: "pointer" }}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
          {note && <div className="mono" style={{ fontSize: 11.5, color: "#6fd08c" }}>{note}</div>}
        </div>

        <div className="ns-scroll" style={{ flex: "0 0 auto", width: 300, overflowY: "auto",
                                            display: "flex", flexDirection: "column", gap: 12, paddingBottom: 14 }}>
          <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <span className="ws-mlabel">Provenance</span>
            <div className="mono" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12, lineHeight: 1.65, color: "#9aa4b6" }}>
              {blockLabel && <Row k="block" v={blockLabel} tone="#5aa2ff" />}
              <Row k="origin" v={a.origin} />
              {job?.model_id && <Row k="model" v={job.model_id} />}
              {job && <Row k="job" v={`${job.kind} · ${job.status}`} />}
              {(job?.payload as Record<string, unknown>)?.seed != null && (
                <Row k="seed" v={String((job!.payload as Record<string, unknown>).seed)} />
              )}
              <Row k="created" v={new Date(a.created_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} />
            </div>
          </div>
          {prompt && (
            <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="ws-mlabel">Prompt</span>
                <span style={{ flex: 1 }} />
                {/* A storyboard panel is the one image you routinely want to
                    argue with: the render copies its framing, so a wrong panel
                    becomes a wrong shot. Redraw is offered here, on the zoomed
                    panel, because that is where you notice. */}
                {panelBeatId && (
                  <button className="ws-microbtn accent" style={{ padding: "0 10px" }}
                          title="Edit this panel's prompt and references, then redraw it"
                          onClick={() => setRegen(true)}>
                    <Wand2 size={12} /> Redraw panel
                  </button>
                )}
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.7, color: "#9aa4b6" }}>{prompt.slice(0, 600)}</div>
            </div>
          )}
          {!!refs.length && (
            <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <span className="ws-mlabel">References used</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                {refs.map((r) => (
                  <span key={r.id} style={{ aspectRatio: "1", borderRadius: 12, overflow: "hidden",
                                            border: "1px solid #2a3346", background: "#0b0e14" }}>
                    <img src={assetUrl(r) ?? undefined} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span className="ws-mlabel">Tags</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(a.tags ?? []).map((t) => (
                <span key={t} className="ws-pill" style={t === "kept" || t === "ref"
                  ? { borderColor: "rgba(90,162,255,.4)", background: "rgba(90,162,255,.1)", color: "#8fc2ff" } : undefined}>
                  {t}
                </span>
              ))}
              {tagDraft == null ? (
                <button className="ws-pill" onClick={() => setTagDraft("")}>+ add</button>
              ) : (
                <input className="ws-input ws-lookinput" autoFocus value={tagDraft}
                       placeholder="e.g. hero-shot"
                       onChange={(e) => setTagDraft(e.target.value)}
                       onBlur={() => void commitTag()}
                       onKeyDown={(e) => {
                         if (e.key === "Enter") { e.preventDefault(); void commitTag(true); }
                         if (e.key === "Escape") { e.stopPropagation(); setTagDraft(null); }
                       }} />
              )}
            </div>
          </div>
          <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <span className="ws-mlabel">Used in</span>
            <div style={{ fontSize: 12.5, lineHeight: 1.7, color: "#9aa4b6" }}>
              {used.length
                ? <>{used.map((c) => <div key={c.id}>timeline · {c.label ?? "clip"} at {(c.t_start_ms / 1000).toFixed(1)}s</div>)}
                    Replacing this clip ripples to {used.length} place{used.length === 1 ? "" : "s"}.</>
                : "Not on any timeline yet."}
            </div>
          </div>
          {isVideo && blockLabel && (
            <button className="ws-ghost" style={{ height: 36 }}
                    onClick={() => {
                      const bid = (a.meta?.block_id as string) ?? ((job?.payload as Record<string, unknown>)?.block_id as string);
                      if (bid) ws.openModal({ kind: "takes", blockId: bid });
                    }}>
              <Camera size={13} />Compare takes for {blockLabel}
            </button>
          )}
        </div>
      </div>

      {/* Portalled: `.ns-l3`'s backdrop-filter makes the modal a containing
          block, so a fixed overlay rendered inside it opens *within* the panel. */}
      {full && createPortal(
        <div className="ws-lightbox" onClick={closeFull}>
          {isVideo ? (
            <video ref={fullRef as React.RefObject<HTMLVideoElement>} src={url} controls autoPlay playsInline
                   onClick={(e) => e.stopPropagation()}
                   onLoadedMetadata={(e) => { e.currentTarget.currentTime = pos; }} />
          ) : isAudio ? (
            <div className="ws-lb-audio" onClick={(e) => e.stopPropagation()}>
              <Music size={64} />
              <audio ref={fullRef as React.RefObject<HTMLAudioElement>} src={url} controls autoPlay
                     onLoadedMetadata={(e) => { e.currentTarget.currentTime = pos; }} />
            </div>
          ) : (
            <img src={url} alt="" onClick={(e) => e.stopPropagation()} />
          )}
          <button className="ws-lb-close" onClick={closeFull} title="Close (Esc)"><X size={18} /></button>
          <div className="ws-lb-meta mono" onClick={(e) => e.stopPropagation()}>
            {[a.width ? `${a.width}×${a.height}` : null, fmtS(a.duration_ms), name].filter(Boolean).join(" · ")}
            <a href={url ?? "#"} target="_blank" rel="noreferrer" title="Open the original">
              <Download size={12} />
            </a>
          </div>
        </div>,
        document.body)}

      {regen && panelBeatId && (
        <PanelRegenModal
          asset={a}
          prompt={prompt ?? ""}
          refs={refs}
          beatId={panelBeatId}
          projectId={a.project_id}
          label={((job?.payload as Record<string, unknown>)?.label as string) ?? null}
          onClose={() => { setRegen(false); reload(); }}
        />
      )}
    </ModalShell>
  );
}
