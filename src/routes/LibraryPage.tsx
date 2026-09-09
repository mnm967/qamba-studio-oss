import React, { useMemo, useRef, useState } from "react";
import { Upload, Film, Music, Image as ImageIcon, Trash2 } from "lucide-react";
import V2Shell from "../design/V2Shell";
import { useLiveQuery } from "../hooks/useLiveQuery";
import { loadAssets, registerAsset, deleteAssets } from "../lib/db/assets";
import { probedUploadMeta } from "../lib/mediaProbe";
import { enqueueJob } from "../lib/db/jobs";
import { mediaUrl } from "../lib/supabase";
import { uploadMedia, deleteMedia } from "../lib/upload";
import type { Asset, AssetKind } from "../lib/db/types";
import VideoPreviewThumb from "../components/ui/VideoPreviewThumb";

const KIND_TABS: { id: AssetKind | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Video" },
  { id: "image", label: "Images" },
  { id: "audio", label: "Audio" },
  { id: "render", label: "Renders" },
];

function AssetCard({ a, onDelete }: { a: Asset; onDelete: (a: Asset) => void }) {
  const url = mediaUrl(a.b2_key);
  const name = a.b2_key.split("/").pop() ?? a.b2_key;
  return (
    <div
      className="libcard"
      draggable
      onDragStart={(e) => e.dataTransfer.setData("application/x-qamba-asset", JSON.stringify({ id: a.id }))}
    >
      <div className="libthumb">
        {a.kind === "image" || a.kind === "frame" ? (
          <img src={url ?? undefined} loading="lazy" alt="" />
        ) : a.kind === "video" || a.kind === "render" ? (
          <VideoPreviewThumb src={url ?? undefined} />
        ) : (
          <div className="libaudio"><Music size={22} /></div>
        )}
      </div>
      <div className="libmeta">
        <span className="libname">{name}</span>
        <span className="libsub mono">
          {a.duration_ms ? `${(a.duration_ms / 1000).toFixed(1)}s` : a.width ? `${a.width}×${a.height}` : a.kind}
          {a.tags.length ? ` · ${a.tags.slice(0, 2).join(",")}` : ""}
        </span>
      </div>
      <button className="libdel" title="Delete asset (DB first, then B2)" onClick={() => onDelete(a)}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}

export default function LibraryPage() {
  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [search, setSearch] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { data, reload } = useLiveQuery(
    () => loadAssets({ kind: kind === "all" ? undefined : kind, search: search || undefined, limit: 120 }),
    ["assets"],
    [kind, search]
  );
  const assets = useMemo(() => data ?? [], [data]);

  const ingest = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const k: AssetKind = file.type.startsWith("video/") ? "video"
        : file.type.startsWith("audio/") ? "audio" : "image";
      const ext = (file.name.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
      const key = `library/${crypto.randomUUID()}${ext}`;
      setUploading(0);
      try {
        await uploadMedia(file, key, (p: number) => setUploading(p));
        const asset = await registerAsset({
          b2_key: key, kind: k, content_type: file.type, bytes: file.size,
          origin: "uploaded", tags: ["library"],
          meta: { original_name: file.name },
          ...(await probedUploadMeta(file)),   // don't wait on the pod for a length
        });
        await enqueueJob({ kind: "asset_ingest", lane: "cpu", priority: 60, payload: { asset_id: asset.id } });
      } finally {
        setUploading(null);
      }
    }
    reload();
  };

  const onDelete = async (a: Asset) => {
    const keys = await deleteAssets([a.id]);
    await deleteMedia(keys).catch(() => {});
    reload();
  };

  return (
    <V2Shell title="Asset library" eyebrow="B2">
      <div
        className={"libdrop" + (dragOver ? " over" : "")}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void ingest(e.dataTransfer.files); }}
        onClick={() => fileRef.current?.click()}
      >
        <Upload size={16} />
        {uploading != null ? ` Uploading ${Math.round(uploading * 100)}%…` : " Drop media here or click to upload"}
        <input ref={fileRef} type="file" multiple accept="image/*,video/*,audio/*" style={{ display: "none" }}
          onChange={(e) => e.target.files && void ingest(e.target.files)} />
      </div>
      <div className="v2-section" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {KIND_TABS.map((t) => (
          <button key={t.id} className={"insp-chip" + (kind === t.id ? " on" : "")} onClick={() => setKind(t.id)}>
            {t.id === "video" ? <Film size={11} /> : t.id === "image" ? <ImageIcon size={11} /> : null} {t.label}
          </button>
        ))}
        <input className="insp-input" style={{ marginTop: 0, maxWidth: 220, marginLeft: "auto" }}
          placeholder="Search keys…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="libgrid">
        {assets.map((a) => <AssetCard key={a.id} a={a} onDelete={onDelete} />)}
        {assets.length === 0 && <div className="v2-empty" style={{ gridColumn: "1/-1" }}>Nothing here yet.</div>}
      </div>
    </V2Shell>
  );
}
