// One Civitai model, in full — the nested screen the hub's grid opens onto.
//
// WHY A NESTED MODAL AND NOT A RAIL. What a 320px sidebar could hold was the
// name, four tags and a version list, which is roughly what the card already
// showed; the things that actually decide whether a workflow is worth
// importing were all missing. Those are the media (and on these model types
// the media are VIDEO, so a still grid of grey placeholders was the common
// case), the author's description — which is where the required node packs,
// the weights and the sampler settings are written down — and the per-version
// changelog. None of that fits beside a search grid, so it gets the screen.
//
// IT PORTALS TO <body>. `.ns-l3` carries a backdrop-filter, which makes the
// hub a containing block for fixed descendants: rendered in place, this
// modal's own scrim would resolve against the hub's box and be clipped by its
// `overflow: hidden` — i.e. the detail view would open INSIDE the panel that
// opened it.
//
// COMMENTS ARE NOT HERE, and that is measured rather than skipped: the v1
// comments route is gone (404, serving 80KB of the site's own HTML) and the
// tRPC route the site itself uses answers 401 with "Please use the public API
// instead". `stats.commentCount` is 0 on every model, including a LoRA with
// 26k thumbs-up, so rendering it would state a falsehood about a busy thread.
// The screen says so in a sentence and links out.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft, ChevronRight, Download, ExternalLink, Eye, Film, Heart,
  Image as ImageIcon, Info, Loader2, Maximize2, MessageSquare, Minimize2, Package,
  Sparkles, Stethoscope,
} from "lucide-react";
import ModalShell from "./ModalShell";
import CompatPanel from "./CompatPanel";
import RichHtml from "../../lib/richHtml";
import {
  canDownload, explicit, getModelDetails, getModelImages, getToken, isVideo, mediaUrl,
  showcaseMedia,
  downloadUrlFor, modelDir, sha256Of, weightFile, workflowFile,
  type CivitaiMedia, type CivitaiModel, type CivitaiVersion,
} from "../../lib/civitai";
import { familyForBaseModel, registerLocalLora } from "../../lib/localLoras";
import { FAMILIES } from "../../lib/engineCatalog";
import { isDesktop, openExternal } from "../../lib/desktop";
import type { CompatReport } from "../../lib/compat";

const INK_MUTE = "#5e6678";
const C_OK = "#6fd08c";
const C_RISK = "#e8a13a";

export function Chip({ color = INK_MUTE, children, title }: {
  color?: string; children: React.ReactNode; title?: string;
}) {
  return (
    <span className="mono" title={title} style={{
      fontSize: 10, padding: "2px 6px", borderRadius: 6, whiteSpace: "nowrap",
      color, background: `${color}1a`, border: `1px solid ${color}3d`,
    }}>{children}</span>
  );
}

export const num = (n?: number) =>
  n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

const date = (s?: string) => (s ? new Date(s).toISOString().slice(0, 10) : null);

/* ── one piece of media ─────────────────────────────────────────────────── */

/**
 * ONLY THE HERO IS EVER A <video>. A thumbnail asks the CDN for the poster
 * frame instead, which is both the bandwidth fix — the videos on one workflow
 * page measured 4MB, 8MB, 25MB and 161MB, and a strip of 36 `preload=
 * "metadata"` elements pulled all of them — and the decoder fix, the same
 * element budget the take filmstrip runs into.
 */
function Media({ m, hero, revealed, onReveal }: {
  m: CivitaiMedia; hero: boolean; revealed: boolean; onReveal: () => void;
}) {
  const blur = !revealed && explicit(m.nsfwLevel);
  const cls = blur ? "ns-cvblur" : undefined;
  // Media is user-uploaded content from a public site: shown, never trusted.
  // `no-referrer` keeps this app's URL out of Civitai's logs, and a video is
  // muted by default so flipping through a strip cannot shout.
  const body = hero && isVideo(m)
    ? <video src={mediaUrl(m, "hero")} poster={mediaUrl(m, "poster")} className={cls}
             muted loop playsInline autoPlay controls={!blur} preload="metadata" />
    : <img src={mediaUrl(m, hero ? "hero" : "thumb")} alt="" className={cls}
           loading={hero ? "eager" : "lazy"} referrerPolicy="no-referrer" />;

  return (
    <>
      {body}
      {blur && (
        <button className="ns-cvreveal" onClick={(e) => { e.stopPropagation(); onReveal(); }}>
          <Eye size={hero ? 18 : 13} />
          {hero && <span>Explicit — click to show</span>}
        </button>
      )}
    </>
  );
}

/* ── the modal ──────────────────────────────────────────────────────────── */

export default function CivitaiDetailModal({
  model, kind, importing, error, compat, checking, engineOk, onCheck, onImport, onClose,
}: {
  model: CivitaiModel;
  /** whether a local engine answered — weights need somewhere to land */
  engineOk?: boolean;
  /** what the hub is searching for — decides whether a version can be imported */
  kind: "workflows" | "loras" | "models";
  importing: boolean;
  /** the hub's import error, shown HERE because this is where the button is —
   *  a gated download fails often (every tokenless one does), and the hub's
   *  own banner would be behind this modal */
  error: string | null;
  /** the result of "will this run here", once it has been asked */
  compat: CompatReport | null;
  checking: boolean;
  onCheck: (m: CivitaiModel, v: CivitaiVersion) => void;
  onImport: (m: CivitaiModel, v: CivitaiVersion) => void;
  onClose: () => void;
}) {
  // The search result is already a complete-enough model (it carries the
  // description and every version), so the screen paints from it immediately
  // and the two fetches only ever ADD. A slow or failed gallery must not hold
  // up a decision the user can already make.
  const [full, setFull] = useState<CivitaiModel>(model);
  const [gallery, setGallery] = useState<CivitaiMedia[]>([]);
  const [loadingMedia, setLoadingMedia] = useState(true);
  const [idx, setIdx] = useState(0);
  const [verIdx, setVerIdx] = useState(0);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [fullscreen, setFullscreen] = useState(false);
  const [dlBusy, setDlBusy] = useState(false);
  const [dlMsg, setDlMsg] = useState<{ bad: boolean; text: string } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    const token = getToken();
    void getModelDetails(model.id, token).then((d) => { if (live) setFull(d); }).catch(() => {});
    void getModelImages(model.id, { limit: 40, token, signal: ctl.signal })
      .then((g) => { if (live) setGallery(g); })
      .catch(() => {})                       // the showcase alone is a fine gallery
      .finally(() => { if (live) setLoadingMedia(false); });
    return () => { live = false; ctl.abort(); };
  }, [model.id]);

  // The author's showcase first — it is the pitch — then community posts.
  // They are disjoint sets, measured: 20 and 16 items with no URL in common.
  const media = useMemo<CivitaiMedia[]>(
    () => [...showcaseMedia(full), ...gallery], [full, gallery]);
  const cur = media[Math.min(idx, media.length - 1)];
  const versions = full.modelVersions ?? [];
  const ver = versions[verIdx];

  const step = useCallback((d: number) => {
    setIdx((i) => (media.length ? (i + d + media.length) % media.length : 0));
  }, [media.length]);

  /**
   * Fullscreens the STAGE, not just the `<img>`/`<video>` — the same
   * `element.requestFullscreen?.()` pattern the main player dock already uses
   * (`Workspace.tsx`), called on the container rather than the media element
   * so the prev/next arrows and the explicit-reveal button keep working
   * without leaving fullscreen. `?.()` matters here specifically: WKWebView
   * (the desktop build) has supported element-level Fullscreen only since
   * relatively recent macOS releases, so an older one silently no-ops instead
   * of throwing.
   */
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void stageRef.current?.requestFullscreen?.();
  }, []);

  // The UA exits fullscreen on Escape natively — this listener does not need
  // to, and MUST NOT also close the modal on that same keypress, or one
  // Escape does two things a user only asked one of.
  useEffect(() => {
    const onFsChange = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Escape closes THIS, not the hub underneath it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.fullscreenElement) return;
        e.stopPropagation(); onClose(); return;
      }
      if (e.key === "ArrowLeft") { e.stopPropagation(); step(-1); }
      if (e.key === "ArrowRight") { e.stopPropagation(); step(1); }
      if (e.key.toLowerCase() === "f") { e.stopPropagation(); toggleFullscreen(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, step, toggleFullscreen]);

  // Keep the selected thumbnail in view when the arrows move it.
  useEffect(() => {
    stripRef.current?.children[idx]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [idx]);

  const reveal = (url: string) => setRevealed((s) => new Set(s).add(url));
  const blurredCount = media.filter((m) => explicit(m.nsfwLevel) && !revealed.has(m.url)).length;
  const revealAll = () => setRevealed(new Set(media.map((m) => m.url)));
  const wf = ver ? workflowFile(ver) : null;
  const weights = ver ? weightFile(ver) : null;
  // Where this KIND of model belongs in ComfyUI. Null means we do not know,
  // and a weight file in the wrong directory is invisible to the loader that
  // wants it — so the download declines rather than guessing.
  const dir = modelDir(full.type);

  // WHICH MODEL A LORA IS FOR is the one thing the engine cannot work out for
  // itself: `models/loras/` gives filenames, and nothing in a filename says
  // whether an adapter is SD 1.5 or Wan. Civitai does say, in `baseModel`, so
  // it is captured HERE — at the only moment it is known — and kept in
  // `localLoras`. Without it the file downloads and no picker ever mentions it.
  const isLora = dir === "loras";
  const guessed = familyForBaseModel(ver?.baseModel);
  // The guess is a DEFAULT, not a verdict. `familyForBaseModel` returns null
  // rather than guessing on an ambiguous tag ("Wan Video" names no generation),
  // and a user who knows better must be able to say so — an adapter filed
  // under the wrong family is one that renders nothing and logs shape errors.
  const [famPick, setFamPick] = useState<string | null>(null);
  useEffect(() => { setFamPick(null); }, [verIdx, full.id]);
  const loraFamily = famPick ?? guessed;
  const famName = (id: string | null) => FAMILIES.find((f) => f.id === id)?.name ?? id;

  /**
   * Stream the weights into the engine's models directory.
   *
   * Deliberately fire-and-forget past the first await: the Rust task outlives
   * this modal (a 12GB LoRA is not a modal's lifetime) and reports itself
   * through `download://progress`, which the queue popover already renders.
   * Awaiting it here would tie a multi-minute download to a screen the user
   * has every reason to close.
   */
  const getWeights = async () => {
    if (!ver || !weights || !dir) return;
    setDlBusy(true); setDlMsg(null);
    try {
      const { invoke } = await import("../../lib/desktop");
      const dest = await invoke<string>("engine_model_path",
        { kind: dir, filename: weights.name });
      if (!dest) throw new Error(`could not resolve where to put ${weights.name}`);
      // The id is the FILE: two models sharing one file must not report each
      // other's progress. `owner` attributes a resumed download to this model
      // rather than to whatever else names the same filename.
      void invoke<string>("download_model_file", {
        id: weights.name,
        url: downloadUrlFor(ver, weights),
        dest,
        sha256: sha256Of(weights),
        token: getToken(),
        owner: `civitai/${full.id}`,
      }).catch((e) => setDlMsg({ bad: true, text: String((e as Error)?.message ?? e) }));
      // Registered BEFORE the bytes land, deliberately: the download outlives
      // this modal (that is the whole point of the fire-and-forget above), so
      // a record written on completion would be a record nobody is around to
      // write. Existence is always re-checked against `engine_status.files`,
      // so an entry whose download failed simply never appears in a picker.
      if (isLora && loraFamily) {
        registerLocalLora({
          filename: weights.name,
          family: loraFamily,
          name: full.name,
          ...(ver?.trainedWords?.[0] ? { trigger: ver.trainedWords[0] } : {}),
          ...(ver?.baseModel ? { baseModel: ver.baseModel } : {}),
          source: `civitai/${full.id}`,
        });
      }
      setDlMsg({
        bad: false,
        text: isLora && loraFamily
          ? `Downloading ${weights.name}. It will appear in the LoRA picker for `
            + `${famName(loraFamily)}.`
          : `Downloading ${weights.name} into models/${dir}/.`,
      });
    } catch (e) {
      setDlMsg({ bad: true, text: String((e as Error)?.message ?? e) });
    } finally {
      setDlBusy(false);
    }
  };
  const file = kind === "workflows" ? wf : weights;
  const license = [
    full.allowCommercialUse?.length ? `commercial: ${full.allowCommercialUse.join(", ")}` : "no commercial use",
    full.allowDerivatives === false ? "no derivatives" : null,
    full.allowNoCredit === false ? "credit required" : null,
  ].filter(Boolean) as string[];

  return createPortal(
    <ModalShell
      icon={<Sparkles size={15} />}
      title={full.name}
      context={`${full.creator?.username ?? "unknown"} · ${full.type}`
        + (versions.length ? ` · ${versions.length} version${versions.length === 1 ? "" : "s"}` : "")}
      width={1180}
      tall
      z={96}
      onClose={onClose}
      headActions={
        <>
          {/* Per-item reveal is the default — one misclick should not unblur a
              screen. But a model that is explicit throughout would then be 29
              clicks, so the whole-gallery version is offered once, deliberately,
              and only when there is something blurred to reveal. */}
          {blurredCount > 0 && (
            <button className="ws-actbtn" onClick={revealAll}>
              <Eye size={12} /> Show {blurredCount} explicit
            </button>
          )}
          <button className="ws-actbtn"
                  onClick={() => void openExternal(`https://civitai.com/models/${full.id}`)}>
            <ExternalLink size={12} /> Open on Civitai
          </button>
        </>
      }
    >
      <div className="ws-modal-body ns-scroll"
           style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>

        {/* ── media + description ── */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {/* The STAGE always spans the section's FULL WIDTH — only its height
              adapts, and never via `aspect-ratio` on this box. That was tried
              and is wrong: this div is a flex child stretched to fill the
              column, and per the CSS aspect-ratio spec, once a `max-height`
              clamps the ratio-derived height, the browser recomputes the
              WIDTH to preserve the ratio too — so a portrait item (taller
              than wide) narrowed the whole card down to a thin column instead
              of letterboxing inside it. Fixed height by orientation avoids
              that coupling entirely; `object-fit: contain` on the media
              itself does the actual letterboxing, background showing
              through the bars rather than the box shrinking. */}
          {/* `ref` is the fullscreen TARGET. The inline height below is
              overridden by `.ns-cvgal:fullscreen` in CSS (an `!important`
              stylesheet rule beats a plain inline declaration in the cascade,
              so no fullscreen-conditional JS is needed here) — the box goes
              edge-to-edge and the nav/fullscreen buttons ride along as
              ordinary absolutely-positioned children. */}
          <div className="ns-cvgal" ref={stageRef} style={{
            height: cur?.width && cur.height && cur.height > cur.width ? 460 : 400,
          }}>
            {cur ? (
              <Media key={cur.url} m={cur} hero revealed={revealed.has(cur.url)}
                     onReveal={() => reveal(cur.url)} />
            ) : (
              <span style={{ fontSize: 12, color: INK_MUTE, display: "flex", gap: 7 }}>
                {loadingMedia
                  ? <><Loader2 size={13} className="ws-spin" /> Loading previews…</>
                  : <><ImageIcon size={13} /> This model has no preview media.</>}
              </span>
            )}
            {media.length > 1 && (
              <>
                <button className="ns-cvnav l" onClick={() => step(-1)} aria-label="Previous">
                  <ChevronLeft size={16} />
                </button>
                <button className="ns-cvnav r" onClick={() => step(1)} aria-label="Next">
                  <ChevronRight size={16} />
                </button>
              </>
            )}
            {cur && (
              <button className="ns-cvfull" onClick={toggleFullscreen}
                      aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                      title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen (F)"}>
                {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
            )}
          </div>

          {media.length > 0 && (
            <>
              <div className="ns-cvstrip" ref={stripRef}>
                {media.map((m, i) => (
                  <button key={m.url} className={"ns-cvthumb" + (i === idx ? " on" : "")}
                          onClick={() => setIdx(i)}
                          title={m.from === "author"
                            ? `${m.versionName ?? "showcase"} · by the author`
                            : `community post${m.username ? ` by ${m.username}` : ""}`}>
                    <Media m={m} hero={false} revealed={revealed.has(m.url)}
                           onReveal={() => reveal(m.url)} />
                    {isVideo(m) && <span className="tag"><Film size={7} /></span>}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11,
                            color: INK_MUTE, marginTop: -4 }}>
                <span className="mono">{idx + 1} / {media.length}</span>
                <span>·</span>
                <span>{cur?.from === "author"
                  ? `author showcase${cur.versionName ? ` · ${cur.versionName}` : ""}`
                  : `community post${cur?.username ? ` · ${cur.username}` : ""}`}</span>
                {cur?.width ? <span className="mono">{cur.width}×{cur.height}</span> : null}
                {cur?.stats?.likeCount ? (
                  <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
                    <Heart size={10} /> {num(cur.stats.likeCount)}
                  </span>
                ) : null}
              </div>
            </>
          )}

          {compat && <CompatPanel r={compat} />}

          <div className="ws-card">
            <span className="ws-mlabel">ABOUT THIS {full.type === "Workflows" ? "WORKFLOW" : "MODEL"}</span>
            {full.description?.trim()
              ? <RichHtml html={full.description} />
              : <p style={{ fontSize: 12, color: INK_MUTE, margin: 0 }}>
                  The author wrote no description.
                </p>}
          </div>

          {ver?.description?.trim() && (
            <div className="ws-card">
              <span className="ws-mlabel">ABOUT {ver.name.toUpperCase()}</span>
              <RichHtml html={ver.description} />
            </div>
          )}
        </div>

        {/* ── the rail: what to do with it ── */}
        <aside style={{ width: 340, flex: "none", display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="ws-card">
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
              <Chip color="#458de8">{full.type}</Chip>
              {full.nsfw && <Chip color={C_RISK}>nsfw</Chip>}
              {(full.baseModels ?? []).slice(0, 3).map((b) => <Chip key={b}>{b}</Chip>)}
            </div>
            <div style={{ display: "flex", gap: 14, fontSize: 11.5, color: "#c7cddb" }}>
              <span title="downloads"><Download size={11} style={{ marginBottom: -1 }} />
                {" "}{num(full.stats?.downloadCount)}</span>
              <span title="thumbs up"><Heart size={11} style={{ marginBottom: -1 }} />
                {" "}{num(full.stats?.thumbsUpCount)}</span>
              {full.stats?.tippedAmountCount ? (
                <span title="buzz tipped">⚡ {num(full.stats.tippedAmountCount)}</span>
              ) : null}
            </div>
            {(full.tags ?? []).length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 9 }}>
                {(full.tags ?? []).slice(0, 10).map((t) => <Chip key={t}>{t}</Chip>)}
              </div>
            )}
            {license.length > 0 && (
              <div style={{ fontSize: 11, color: INK_MUTE, marginTop: 9, display: "flex",
                            gap: 6, alignItems: "flex-start" }}>
                <Info size={11} style={{ flex: "none", marginTop: 2 }} />
                <span>{license.join(" · ")}</span>
              </div>
            )}
          </div>

          <div className="ws-card">
            <span className="ws-mlabel">VERSIONS</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 5 }}>
              {versions.map((v, i) => {
                const on = i === verIdx;
                const f = kind === "workflows" ? workflowFile(v) : weightFile(v);
                return (
                  <button key={v.id} onClick={() => setVerIdx(i)} style={{
                    textAlign: "left", padding: 9, borderRadius: 9,
                    background: on ? "rgba(90,162,255,0.08)" : "rgba(255,255,255,0.02)",
                    border: `1px solid ${on ? "rgba(90,162,255,0.4)" : "rgba(255,255,255,0.07)"}`,
                  }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span className="mono" style={{ fontSize: 11.5, flex: 1, minWidth: 0,
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {v.name}
                      </span>
                      {v.baseModel && <Chip>{v.baseModel}</Chip>}
                    </div>
                    <div className="mono" style={{ fontSize: 10.5, color: INK_MUTE, marginTop: 3,
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f ? `${f.name} · ${(f.sizeKB / 1024).toFixed(1)}MB` : "no importable file"}
                      {date(v.publishedAt ?? v.createdAt) ? ` · ${date(v.publishedAt ?? v.createdAt)}` : ""}
                    </div>
                  </button>
                );
              })}
              {!versions.length && (
                <span style={{ fontSize: 11.5, color: INK_MUTE }}>No published versions.</span>
              )}
            </div>

            {ver && (ver.trainedWords ?? []).length > 0 && (
              <div style={{ marginTop: 9 }}>
                <span className="ws-mlabel">TRIGGER WORDS</span>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                  {(ver.trainedWords ?? []).slice(0, 8).map((w) => (
                    <Chip key={w} color="#a97bff">{w}</Chip>
                  ))}
                </div>
              </div>
            )}

            {kind === "workflows" ? (
              <>
                {/* Asked BEFORE importing, because the answer is what decides
                    whether to import: this fetches the graph and reads it,
                    stores nothing. */}
                <button className="ws-actbtn" style={{ width: "100%", marginTop: 10 }}
                        disabled={!file || checking || !ver || !canDownload()}
                        onClick={() => ver && onCheck(full, ver)}>
                  {checking ? <Loader2 size={13} className="ws-spin" /> : <Stethoscope size={13} />}
                  Will this run here?
                </button>
                <button className="ws-primary" style={{ width: "100%", marginTop: 7 }}
                        disabled={!file || importing || !ver || !canDownload()}
                        onClick={() => ver && onImport(full, ver)}>
                  {importing ? <Loader2 size={13} className="ws-spin" /> : <Download size={13} />}
                  {file ? `Import ${ver?.name ?? "this version"}` : "No workflow file or archive on this version"}
                </button>
                {/* Say why the button is dead HERE. The hub's token banner is
                    behind this modal, and a disabled primary with no
                    explanation reads as a broken screen. */}
                {!canDownload() && (
                  <p style={{ fontSize: 11, color: INK_MUTE, margin: "6px 0 0" }}>
                    {isDesktop()
                      ? "Add a Civitai API token in the hub behind this screen — every download is "
                        + "gated, including ones marked public."
                      : "The browser can search Civitai but not download from it. Use the desktop "
                        + "app, or paste this workflow's JSON into the hub's paste tab."}
                  </p>
                )}
              </>
            ) : (
              // WEIGHTS DOWNLOAD, and for a long time this said they did not.
              // The Rust command was always general — `download_model_file`
              // takes a url, a destination, a sha256 and a TOKEN, and its own
              // doc comment says it refuses Civitai's HTML gate — and the
              // capability allow-list already permits civitai.com. Nothing was
              // missing except the call; meanwhile the copy read "needs a
              // local engine — set one up in Setup first", which promised a
              // capability that setting one up did not actually unlock.
              <>
                <button className="ws-primary" style={{ width: "100%", marginTop: 10 }}
                        disabled={!weights || !dir || !engineOk || !canDownload() || dlBusy
                                  || (isLora && !loraFamily)}
                        onClick={() => void getWeights()}>
                  {dlBusy ? <Loader2 size={13} className="ws-spin" /> : <Download size={13} />}
                  {weights ? `Get ${(weights.sizeKB / 1024).toFixed(1)}MB` : "No weights on this version"}
                </button>
                {/* Say why the button is dead HERE — the hub's own banner is
                    behind this modal, and a disabled primary with no
                    explanation reads as a broken screen. Each reason is a
                    DIFFERENT fix, so they are not collapsed into one line. */}
                <p style={{ fontSize: 11, color: INK_MUTE, margin: "6px 0 0" }}>
                  {!isDesktop()
                    ? "The browser cannot download weights. Use the desktop app."
                    : !weights ? "This version publishes no weight file."
                    : !dir ? `Nothing here knows where a "${full.type}" belongs in ComfyUI, so it `
                      + "would land somewhere no loader looks."
                    : !engineOk ? "No local engine answered, so there is nowhere to put it — set "
                      + "one up in Setup first."
                    : !canDownload() ? "Add a Civitai API token in the hub behind this screen — "
                      + "every download is gated, including ones marked public."
                    : isLora && !loraFamily
                      ? `Pick which model this is for below. "${ver?.baseModel ?? "no base model"}" `
                        + "does not name one of the families this app installs, and an adapter "
                        + "filed under the wrong model loads nothing."
                    : <>Lands in <span className="mono">models/{dir}/</span>. Progress shows in the
                      queue; it keeps going if you close this.</>}
                </p>
                {/* THE FAMILY PICKER. Always shown for a LoRA, not only when
                    the guess fails: the guess is right most of the time and
                    wrong silently, and "which model is this for" is the one
                    fact that decides whether the download is ever usable. It
                    is a row of chips rather than a dropdown because there are
                    seven families and the answer is usually already correct —
                    this is a confirmation, not a search. */}
                {isLora && (
                  <div style={{ marginTop: 9 }}>
                    <div style={{ fontSize: 10.5, color: INK_MUTE, marginBottom: 5 }}>
                      for which model
                      {ver?.baseModel && (
                        <span className="mono" style={{ marginLeft: 6, opacity: 0.75 }}>
                          author tagged: {ver.baseModel}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                      {FAMILIES.map((f) => {
                        const on = loraFamily === f.id;
                        return (
                          <button key={f.id} className="ws-actbtn"
                                  onClick={() => setFamPick(on ? null : f.id)}
                                  style={{
                                    fontSize: 10.5, padding: "3px 8px",
                                    ...(on ? {
                                      color: "#cfe0ff", borderColor: "rgba(90,162,255,0.55)",
                                      background: "rgba(90,162,255,0.12)",
                                    } : {}),
                                  }}>
                            {f.name}
                            {/* The guess is marked so an override is visibly an
                                override, not a coin toss the user has to
                                second-guess. */}
                            {f.id === guessed && !famPick ? " ·" : ""}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {dlMsg && (
                  <p style={{ fontSize: 11, color: dlMsg.bad ? "#f0b9a4" : C_OK, margin: "6px 0 0" }}>
                    {dlMsg.text}
                  </p>
                )}
              </>
            )}

            {error && (
              <div style={{
                marginTop: 9, padding: "8px 10px", borderRadius: 9, fontSize: 11.5,
                color: "#f0b9a4", background: "rgba(232,115,74,0.08)",
                border: "1px solid rgba(232,115,74,0.3)",
              }}>{error}</div>
            )}
          </div>

          <div className="ws-card">
            <span className="ws-mlabel">DISCUSSION</span>
            <div style={{ display: "flex", gap: 7, alignItems: "flex-start", marginTop: 4 }}>
              <MessageSquare size={12} style={{ color: INK_MUTE, flex: "none", marginTop: 2 }} />
              <p style={{ fontSize: 11.5, color: INK_MUTE, margin: 0 }}>
                Civitai's public API does not serve comments — the v1 route is gone and the
                site's own endpoint refuses outside the website. Comments are worth reading
                on these: it is where the "which node pack" answers end up.
              </p>
            </div>
            {/* The plain model URL, not a deep link to the comments: the page
                is client-rendered (its served HTML contains no comment anchor
                at all), so any #comments or ?dialog= would be a guess that
                lands somewhere else and reads as a broken button. */}
            <button className="ws-actbtn" style={{ width: "100%", marginTop: 8 }}
                    onClick={() => void openExternal(`https://civitai.com/models/${full.id}`)}>
              <ExternalLink size={12} /> Open the model page
            </button>
          </div>
        </aside>
      </div>
    </ModalShell>,
    document.body,
  );
}
