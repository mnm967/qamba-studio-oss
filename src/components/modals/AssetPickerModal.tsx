// Reference picker — the "choose an image" surface for every generation.
//
// It replaces a 320px anchored dropdown that listed assets as text rows with a
// 38px thumbnail. Three things were wrong with that, and all three are what a
// reference picker exists to do:
//
//  * You pick a reference by LOOKING at it. A filename ("e26952c6-2539-…") and
//    a thumbnail the size of a favicon is the one presentation that carries no
//    information about the image. This is a grid, sized to actually see.
//  * You could only add one at a time, and only from the first 24 rows — past
//    that the menu told you to "open the library", i.e. to leave. Search,
//    source filters and multi-select mean the whole library is reachable here.
//  * You could not bring in a new image at all. An upload lands in the library
//    (B2 + `assets` row + ingest job, invariant #2) and is selected in place.
//
// The caller decides what a pick MEANS: `roles` shows the role chooser (H3
// treats an opening frame and a look plate as opposite instructions — see
// worker/h3_prompt.py), `defaultRole` fixes it for a named frame slot.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check, Image as ImageIcon, Images, Loader2, Music, Search, Sparkles, Upload, X,
} from "lucide-react";
import ModalShell, { Z_OVER_MODAL } from "./ModalShell";
import VideoPreviewThumb from "../ui/VideoPreviewThumb";
import AudioPreviewThumb from "../ui/AudioPreviewThumb";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import { assetUrl, loadAssets, registerAsset } from "../../lib/db/assets";
import { probedUploadMeta, probeElementFor } from "../../lib/mediaProbe";
import { loadBible, loadBibleAssets } from "../../lib/db/director";
import { enqueueJob } from "../../lib/db/jobs";
import { uploadMedia } from "../../lib/upload";
import type { Asset, AssetKind, BibleAsset, BibleEntry } from "../../lib/db/types";

export interface RoleDef { id: string; label: string; hint: string }

export interface Pick {
  asset: Asset;
  /** what the image is FOR — the caller's role vocabulary */
  role: string;
  /** human name: the bible entry it belongs to, or its filename */
  label: string;
}

type Source = "all" | "project" | "bible" | "library" | "generated" | "uploaded" | "hidden";

const BASE_SOURCES: { id: Source; label: string }[] = [
  { id: "all", label: "All" },
  { id: "project", label: "This project" },
  { id: "bible", label: "Bible" },
  { id: "library", label: "Library" },
  { id: "generated", label: "Generated" },
  { id: "uploaded", label: "Uploaded" },
  // Its own source, never folded into "All": an incognito collection's images
  // are out of every browse, and this is the deliberate act of asking for them.
  { id: "hidden", label: "Hidden" },
];

/** What a bible entry's kind means as a reference role. */
const ROLE_FOR_KIND: Record<string, string> = {
  character: "character",
  environment: "environment",
};

interface Entry {
  asset: Asset;
  label: string;
  sub: string;
  /** the role this image lands with when the caller hasn't fixed one */
  role: string;
  fromBible: boolean;
  /** belongs to the project being worked on (ordering only, never a filter) */
  mine: boolean;
  bibleKind?: string;
}

function formatAssetLabel(a: Asset): string {
  if (a.meta?.original_name && typeof a.meta.original_name === "string") {
    return a.meta.original_name;
  }
  const raw = a.b2_key.split("/").pop() || a.id;
  const match = raw.match(/^([a-z0-9_-]+?)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|\b[a-f0-9]{32}\b)(.*)$/i);
  if (match) {
    const prefix = match[1] ? match[1].replace(/[-_]$/, "") : "";
    const uuid = match[2];
    const ext = match[3] || "";
    const shortId = uuid.slice(0, 8);
    if (prefix) return `${prefix} ${shortId}${ext}`;
    return `${a.origin === "uploaded" ? "Upload" : "Take"} ${shortId}${ext}`;
  }
  if (raw.length > 24) {
    const ext = (raw.match(/\.[a-z0-9]+$/i) || [""])[0];
    const namePart = raw.slice(0, raw.length - ext.length);
    return `${namePart.slice(0, 16)}…${ext}`;
  }
  return raw;
}

const PICKER_PAGE = 120;

export default function AssetPickerModal({
  projectId, title = "Choose a reference", context,
  multi = false, used, capacity, roles, defaultRole = "look",
  kindFilter = "image",
  onPick, onClose,
}: {
  projectId: string | null;
  title?: string;
  context?: string;
  /** allow several picks in one visit (the r2v reference set) */
  multi?: boolean;
  /** asset ids already attached — shown as taken, not offered again */
  used?: Set<string>;
  /** how many MORE the caller can accept; undefined = no ceiling */
  capacity?: number;
  /** show the role chooser with this vocabulary; omit for a fixed-role slot */
  roles?: readonly RoleDef[];
  defaultRole?: string;
  kindFilter?: "image" | "video" | "audio" | "all";
  onPick: (picks: Pick[]) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<Source>("all");
  const [visibleCount, setVisibleCount] = useState(PICKER_PAGE);
  const [sel, setSel] = useState<Map<string, string>>(new Map());  // asset id -> role
  const [uploading, setUploading] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingMoreRef = useRef(false);

  const sources = useMemo(
    () => BASE_SOURCES.filter((s) => s.id !== "project" || !!projectId),
    [projectId]
  );

  // Reset page limit when filter source, project, or kindFilter changes
  useEffect(() => {
    setVisibleCount(PICKER_PAGE);
    loadingMoreRef.current = false;
  }, [source, kindFilter, projectId]);

  // Escape closes the picker, not the modal underneath it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const isProjectSource = source === "project";

  const { data, reload } = useLiveQuery(
    async () => {
      const [library, bible] = await Promise.all([
        // The library is global everywhere else it is shown (the composer
        // strip, the Library view), and this picker exists so the WHOLE of it
        // is reachable. Scoping the query to the project hid every image that
        // predates the project or was generated without one — an empty grid
        // reading "no images yet" on top of a full library. The project's own
        // images sort first instead. When "This project" is explicitly picked,
        // scope directly to that project.
        loadAssets({
          projectId: isProjectSource ? projectId : undefined,
          kind: kindFilter === "all" ? undefined : kindFilter,
          limit: visibleCount,
        }),
        projectId ? loadBible(projectId, { committedOnly: true }) : Promise.resolve([] as BibleEntry[]),
      ]);
      const links: BibleAsset[] = bible.length ? await loadBibleAssets(bible.map((e) => e.id)) : [];
      const missing = [...new Set(links.map((l) => l.asset_id))]
        .filter((id) => !library.some((a) => a.id === id));
      // Bible images the library query didn't return. `hidden` must be filtered
      // here too: this is a browse (it builds the grid), and a hidden asset that
      // happens to be linked to a bible entry would otherwise walk straight back
      // into the All tab through the one query that fetches by id.
      const extra = missing.length
        ? (((await supabase.from("assets").select("*").in("id", missing)
              .is("hidden", false)).data ?? []) as Asset[])
        : [];
      return { library, bible, links, extra };
    },
    ["assets", "bible_assets"], [projectId, kindFilter, visibleCount, isProjectSource]
  );

  // Lazy on purpose: nothing hidden is fetched until the tab is opened, so the
  // picker's normal traffic carries no trace of what is in a hidden collection.
  const { data: hidden } = useLiveQuery(
    () => source === "hidden"
      ? loadAssets({
          projectId: isProjectSource ? projectId : undefined,
          kind: kindFilter === "all" ? undefined : kindFilter,
          hidden: true,
          limit: visibleCount,
        })
      : Promise.resolve([] as Asset[]),
    ["assets", "collection_assets"], [source, kindFilter, visibleCount, isProjectSource, projectId]
  );

  const hasMore = source === "hidden"
    ? (hidden?.length ?? 0) >= visibleCount
    : (data?.library.length ?? 0) >= visibleCount;

  useEffect(() => {
    loadingMoreRef.current = false;
  }, [data, hidden]);

  useEffect(() => {
    const root = gridRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !hasMore) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !loadingMoreRef.current) {
        loadingMoreRef.current = true;
        setVisibleCount((n) => n + PICKER_PAGE);
      }
    }, { root, rootMargin: "400px 0px" });
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasMore, data, hidden]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (!hasMore || loadingMoreRef.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 450) {
      loadingMoreRef.current = true;
      setVisibleCount((n) => n + PICKER_PAGE);
    }
  };

  const entries = useMemo<Entry[]>(() => {
    if (source === "hidden") {
      return (hidden ?? []).map((a) => ({
        asset: a, fromBible: false, mine: !projectId || a.project_id === projectId,
        label: formatAssetLabel(a),
        sub: a.width && a.height ? `${a.width}×${a.height} · hidden` : "hidden",
        role: "look",
      }));
    }
    if (!data) return [];
    const byEntry = new Map<string, BibleAsset>();
    for (const l of data.links) if (!byEntry.has(l.asset_id)) byEntry.set(l.asset_id, l);
    const entryById = new Map(data.bible.map((e) => [e.id, e]));
    const all = [...data.extra, ...data.library];
    const seen = new Set<string>();
    const out: Entry[] = [];
    for (const a of all) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const link = byEntry.get(a.id);
      const entry = link ? entryById.get(link.entry_id) : undefined;
      const mine = !projectId || a.project_id === projectId || entry != null;
      if (entry) {
        out.push({
          asset: a, fromBible: true, mine, bibleKind: entry.kind,
          label: entry.name,
          sub: `${entry.kind}${link?.role ? ` · ${link.role}` : ""}`,
          role: ROLE_FOR_KIND[entry.kind] ?? "look",
        });
      } else {
        const durStr = a.duration_ms ? `${(a.duration_ms / 1000).toFixed(1)}s` : null;
        out.push({
          asset: a, fromBible: false, mine,
          label: formatAssetLabel(a),
          sub: a.width && a.height
            ? `${a.width}×${a.height} · ${a.origin}`
            : durStr
              ? `${durStr} · ${a.origin}`
              : a.origin,
          role: "look",
        });
      }
    }
    // Bible refs first — they are the identity anchors, and the thing you are
    // most often reaching for — then this project's images, then the rest of
    // the library. Sort is stable, so newest-first survives inside each group.
    return out.sort((x, y) => Number(y.fromBible) - Number(x.fromBible)
                            || Number(y.mine) - Number(x.mine));
  }, [data, hidden, source, projectId]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (source === "project" && !e.mine) return false;
      if (source === "bible" && !e.fromBible) return false;
      if (source === "library" && e.fromBible) return false;
      if (source === "generated" && e.asset.origin !== "generated") return false;
      if (source === "uploaded" && e.asset.origin !== "uploaded") return false;
      if (!q) return true;
      return e.label.toLowerCase().includes(q)
        || e.sub.toLowerCase().includes(q)
        || e.asset.b2_key.toLowerCase().includes(q)
        || e.asset.kind.toLowerCase().includes(q)
        || String(e.asset.meta?.prompt ?? "").toLowerCase().includes(q)
        || e.asset.tags.some((t) => t.toLowerCase().includes(q));
    });
  }, [entries, search, source]);

  const full = capacity != null && sel.size >= capacity;

  const toggle = (e: Entry) => {
    if (used?.has(e.asset.id)) return;
    if (!multi) { onPick([{ asset: e.asset, role: defaultRole, label: e.label }]); onClose(); return; }
    setSel((m) => {
      const next = new Map(m);
      if (next.has(e.asset.id)) next.delete(e.asset.id);
      else if (capacity != null && next.size >= capacity) {
        setErr(`That's all ${capacity} free slot${capacity === 1 ? "" : "s"} — deselect one to swap.`);
        return m;
      } else next.set(e.asset.id, roles ? e.role : defaultRole);
      setErr(null);
      return next;
    });
  };

  /** Upload straight into the library and select the result. */
  const ingest = async (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []).filter((f) =>
      kindFilter === "video" ? f.type.startsWith("video/")
      : kindFilter === "audio" ? f.type.startsWith("audio/")
      : kindFilter === "all" ? (f.type.startsWith("image/") || f.type.startsWith("video/") || f.type.startsWith("audio/"))
      : f.type.startsWith("image/")
    );
    if (!list.length) return;
    setErr(null);
    const picked: Entry[] = [];
    for (const file of list) {
      const ext = (file.name.match(/\.[a-z0-9]+$/i) || [".png"])[0].toLowerCase();
      const key = `library/${crypto.randomUUID()}${ext}`;
      setUploading(0);
      try {
        await uploadMedia(file, key, (p: number) => setUploading(p));
        const k: AssetKind = file.type.startsWith("video/") ? "video"
          : file.type.startsWith("audio/") ? "audio" : "image";
        const asset = await registerAsset({
          b2_key: key, kind: k, project_id: projectId, content_type: file.type,
          bytes: file.size, origin: "uploaded", tags: ["library", "reference"],
          meta: { original_name: file.name },
          ...(await probedUploadMeta(file)),   // don't wait on the pod for a length
        });
        // width/height come back from the ingest job; the picker doesn't wait.
        await enqueueJob({ kind: "asset_ingest", lane: "cpu", priority: 60,
                           payload: { asset_id: asset.id } });
        picked.push({ asset, fromBible: false, mine: true, label: file.name,
                      sub: `uploaded · ${(file.size / 1024 / 1024).toFixed(1)}MB`, role: "look" });
      } catch (e) {
        setErr(`Upload failed: ${String((e as Error).message).slice(0, 120)}`);
      } finally {
        setUploading(null);
        if (fileRef.current) fileRef.current.value = "";
      }
    }
    reload();
    if (!picked.length) return;
    if (!multi) {
      onPick([{ asset: picked[0].asset, role: defaultRole, label: picked[0].label }]);
      onClose();
      return;
    }
    setSel((m) => {
      const next = new Map(m);
      for (const p of picked) {
        if (capacity != null && next.size >= capacity) break;
        next.set(p.asset.id, defaultRole);
      }
      return next;
    });
  };

  const confirm = () => {
    const byId = new Map(entries.map((e) => [e.asset.id, e]));
    const picks: Pick[] = [];
    for (const [id, role] of sel) {
      const e = byId.get(id);
      if (e) picks.push({ asset: e.asset, role, label: e.label });
    }
    if (picks.length) onPick(picks);
    onClose();
  };

  const selected = [...sel.keys()];

  // Portalled to <body>, and not optional. Callers mount this from inside a
  // modal, and .ns-l3 carries a backdrop-filter — which makes the modal a
  // containing block for `position: fixed` descendants. Rendered in place, the
  // picker's full-screen scrim resolved against the modal's box instead of the
  // viewport and was then clipped by its overflow:hidden, so the picker opened
  // *inside* the panel that opened it. Same reasoning as ui/Dropdown.
  return createPortal(
    <ModalShell
      z={Z_OVER_MODAL} width={1000} maxH={760} tall
      icon={<Images size={16} />}
      title={title}
      context={context ?? `${shown.length} ${kindFilter === "image" ? "image" : kindFilter === "video" ? "video" : kindFilter === "audio" ? "audio" : "item"}${shown.length === 1 ? "" : "s"}${source === "project" ? " (this project)" : ""}`
        + (capacity != null ? ` · ${capacity} slot${capacity === 1 ? "" : "s"} free` : "")}
      onClose={onClose}
      footer={<>
        <span className="sum">
          {/* Callers open this even with every slot taken; a grid where each
              card is disabled and nothing says why reads as broken. */}
          {capacity === 0
            ? "Every slot on this block is taken — remove one first"
            : multi
              ? `${sel.size} selected${capacity != null ? ` / ${capacity}` : ""}`
              : "Click an image to use it"}
          {err && <span style={{ color: "#e8c268" }}> · {err}</span>}
        </span>
        <button className="ws-ghost" onClick={onClose}>Cancel</button>
        {multi && (
          <button className="ws-primary glow" disabled={!sel.size} onClick={confirm}>
            <Check size={15} />Add {sel.size || ""} reference{sel.size === 1 ? "" : "s"}
          </button>
        )}
      </>}
    >
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
                    gap: 12, padding: "0 22px 6px" }}>
        {/* search + sources + upload */}
        <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ position: "relative", flex: 1, minWidth: 210 }}>
            <Search size={13} style={{ position: "absolute", left: 12, top: 11, color: "#5e6678" }} />
            <input className="ws-input" autoFocus value={search}
                   placeholder="Search names, prompts, tags, filenames…"
                   onChange={(e) => setSearch(e.target.value)}
                   style={{ height: 34, paddingLeft: 33, fontSize: 13 }} />
          </div>
          {sources.map((s) => (
            <button key={s.id} className={"ws-pill" + (source === s.id ? " on" : "")}
                    onClick={() => setSource(s.id)}
                    style={{ height: 34, padding: "0 12px", fontSize: 12,
                             ...(source === s.id
                               ? { borderColor: "rgba(90,162,255,.45)", background: "rgba(90,162,255,.1)", color: "#8fc2ff" }
                               : {}) }}>
              {s.label}
            </button>
          ))}
          <button className="ws-pill" title="Upload files from this machine"
                  onClick={() => fileRef.current?.click()}
                  style={{ height: 34, padding: "0 12px", fontSize: 12,
                           borderColor: "rgba(201,122,255,.4)",
                           background: "rgba(201,122,255,.09)", color: "#c97aff" }}>
            {uploading != null
              ? <><Loader2 size={12} className="ns-spin" />{Math.round(uploading * 100)}%</>
              : <><Upload size={12} />Upload</>}
          </button>
          <input ref={fileRef} type="file" hidden multiple
                 accept={kindFilter === "video" ? "video/*" : kindFilter === "audio" ? "audio/*" : kindFilter === "all" ? "video/*,image/*,audio/*" : "image/*"}
                 onChange={(e) => void ingest(e.target.files)} />
        </div>

        {/* grid — drop anywhere on it to upload */}
        <div ref={gridRef}
             className={"ns-scroll ws-pickgrid-wrap" + (dragOver ? " over" : "")
                        + (shown.length ? "" : " blank")}
             onScroll={handleScroll}
             onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
             onDragLeave={() => setDragOver(false)}
             onDrop={(e) => { e.preventDefault(); setDragOver(false); void ingest(e.dataTransfer.files); }}>
          {!data && (
            <div className="ws-empty" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Loader2 size={15} className="ns-spin" /> Loading assets…
            </div>
          )}
          {data && !shown.length && (
            <div className="ws-empty" style={{ lineHeight: 1.6 }}>
              {source === "hidden" && !search
                ? "Nothing hidden — mark a collection incognito in the library to keep its assets out of here."
                : source === "project" && !search
                  ? "No media assets in this project yet — drop files here or upload files from your device."
                  : search || source !== "all"
                    ? "Nothing matches that filter."
                    : "No media assets yet — drop files here or upload files from your device."}
            </div>
          )}
          {shown.map((e) => {
            const taken = used?.has(e.asset.id) ?? false;
            const on = sel.has(e.asset.id);
            const isAud = probeElementFor(e.asset) === "audio"
              || e.asset.kind === "audio"
              || e.asset.content_type?.startsWith("audio/")
              || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(e.asset.b2_key);
            const isVid = !isAud && (
              probeElementFor(e.asset) === "video"
              || e.asset.kind === "video"
              || e.asset.kind === "render"
              || e.asset.content_type?.startsWith("video/")
              || /\.(mp4|mov|webm|mkv)$/i.test(e.asset.b2_key)
            );
            return (
              <button key={e.asset.id}
                      className={"ws-pickcard" + (on ? " on" : "") + (taken ? " taken" : "")}
                      title={taken ? `${e.label} — already on this block` : e.label}
                      disabled={taken || (full && !on)}
                      onClick={() => toggle(e)}>
                <span className="th">
                  {assetUrl(e.asset) ? (
                    isAud ? (
                      <AudioPreviewThumb
                        src={assetUrl(e.asset) ?? undefined}
                        durationMs={e.asset.duration_ms}
                      />
                    ) : isVid ? (
                      <VideoPreviewThumb
                        src={assetUrl(e.asset) ?? undefined}
                        onLoadedMetadata={(evt) => {
                          const v = evt.currentTarget;
                          if (v.duration) v.currentTime = v.duration * 0.35;
                        }}
                      />
                    ) : (
                      <img src={assetUrl(e.asset) ?? undefined} alt="" loading="lazy" />
                    )
                  ) : (
                    <ImageIcon size={18} />
                  )}
                  {isVid && (
                    <span className="badge" style={{ background: "rgba(7,9,14,0.75)", color: "#8fc2ff", top: 6, left: 6, right: "auto" }}>
                      video
                    </span>
                  )}
                  {isAud && (
                    <span className="badge" style={{ background: "rgba(7,9,14,0.75)", color: "#c97aff", top: 6, left: 6, right: "auto" }}>
                      audio
                    </span>
                  )}
                  {e.fromBible && (
                    <span className="badge bible"><Sparkles size={9} />{e.bibleKind}</span>
                  )}
                  {taken && <span className="badge used">in use</span>}
                  {on && <span className="tick"><Check size={12} /></span>}
                </span>
                <span className="meta">
                  <span className="t">{e.label}</span>
                  <span className="mono s">{e.sub}</span>
                </span>
              </button>
            );
          })}
          {hasMore && (
            <div
              ref={sentinelRef}
              style={{
                gridColumn: "1 / -1",
                height: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                color: "#5e6678",
                fontSize: 12,
                padding: "10px 0",
              }}
            >
              <Loader2 size={15} className="ns-spin" /> Loading more assets…
            </div>
          )}
        </div>

        {/* what the chosen images will be used AS */}
        {multi && roles && sel.size > 0 && (
          <div className="ws-card" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <span className="ws-mlabel">Role for each pick</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {selected.map((id) => {
                const e = entries.find((x) => x.asset.id === id);
                if (!e) return null;
                const role = sel.get(id) ?? defaultRole;
                const pickIsAudio = probeElementFor(e.asset) === "audio"
                  || e.asset.kind === "audio"
                  || e.asset.content_type?.startsWith("audio/")
                  || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(e.asset.b2_key);
                return (
                  <div key={id} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <span style={{ width: 30, height: 30, borderRadius: 9, overflow: "hidden",
                                   flex: "none", background: "#0b0e14", display: "grid", placeItems: "center" }}>
                      {pickIsAudio ? (
                        <Music size={14} style={{ color: "#c97aff" }} />
                      ) : (
                        <img src={assetUrl(e.asset) ?? undefined} alt=""
                             style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      )}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: "hidden",
                                   textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.label}</span>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      {roles.map((r) => (
                        <button key={r.id} className="ws-pill" title={r.hint}
                                onClick={() => setSel((m) => new Map(m).set(id, r.id))}
                                style={{ height: 24, fontSize: 10.5, padding: "0 8px",
                                         ...(role === r.id
                                           ? { borderColor: "rgba(90,162,255,.5)", background: "rgba(90,162,255,.12)", color: "#8fc2ff" }
                                           : {}) }}>
                          {r.label}
                        </button>
                      ))}
                    </div>
                    <button className="ws-microbtn sq" title="Remove from the selection"
                            onClick={() => setSel((m) => { const n = new Map(m); n.delete(id); return n; })}>
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </ModalShell>,
    document.body,
  );
}
