// Right-click menu for an audio clip. Audio lanes had no menu at all, so
// everything you can do to a sound — cut it, unpin it from the picture it was
// detached from, put it back, remove it — was reachable only by keyboard, or
// not at all.
//
// It reads the store directly for everything the store can finish on its own.
// The actions that REPORT — copy, paste, duplicate, save as new block — take
// callbacks, because the sentence they produce belongs on the timeline's own
// note and this component has no way to show one.
import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  ClipboardPaste, Copy, CopyPlus, Files, Link2, Scissors, Trash2, Undo2, Unlink,
} from "lucide-react";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { isMacUA } from "../../lib/titlebar";
import type { Clip } from "../../lib/db/types";

export default function AudioClipMenu({
  clip, x, y, onClose, onSaveAsNewBlock, saveAsNewBlockBlocker,
  onDuplicate, onCopy, onPaste, pasteBlocker,
}: {
  clip: Clip; x: number; y: number; onClose: () => void;
  /** Save the PICTURE this sound was detached from, over this window, as a
   *  block of its own. A detached pair mirrors its geometry, so the trim on
   *  screen here is the same trim as on the video half — which is why the
   *  action belongs on both menus and does the same thing from either. */
  onSaveAsNewBlock?: () => void;
  saveAsNewBlockBlocker?: string | null;
  onDuplicate?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  pasteBlocker?: string | null;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const store = useTimelineStore();
  const mod = isMacUA() ? "⌘" : "Ctrl+";
  const at = usePlaybackStore.getState().nowMs();

  useEffect(() => {
    const onDown = (e: MouseEvent | PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = setTimeout(() => window.addEventListener("pointerdown", onDown), 50);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const splittable = at > clip.t_start_ms + 80 && at < clip.t_start_ms + clip.duration_ms - 80;
  const partner = clip.linked_clip_id
    ? store.clips.find((c) => c.id === clip.linked_clip_id) ?? null : null;
  // "Put it back" only means anything while the picture it came from is still
  // silent — an unlinked or hand-made audio clip has nothing to go back to.
  const reattachable = !!partner?.audio_detached;

  const run = (fn: () => void | Promise<void>) => () => { onClose(); void fn(); };

  const left = Math.min(x, window.innerWidth - 232);
  const top = Math.min(y, window.innerHeight - 380);

  return createPortal(
    <div ref={menuRef} className="tl-contextmenu" style={{ position: "fixed", left, top, zIndex: 1000 }}
         onContextMenu={(e) => e.preventDefault()}>
      <div className="menu-header">
        <span className="clip-name">{clip.label ?? "Audio"}</span>
        <span className="clip-dur">{(clip.duration_ms / 1000).toFixed(1)}s</span>
      </div>
      <div className="menu-divider" />

      <button className={"menu-item" + (splittable ? "" : " disabled")} disabled={!splittable}
              title={splittable ? "Split at the playhead"
                : "Put the playhead inside this clip to split it"}
              onClick={run(() => store.splitAt(clip.id, usePlaybackStore.getState().nowMs()))}>
        <Scissors size={14} className="menu-icon" />
        <span>Split at playhead</span>
        <span className="menu-key">S</span>
      </button>

      {!!clip.linked_clip_id && (
        <button className="menu-item" title="Move and trim this sound independently of the picture"
                onClick={run(() => store.unlinkAudio(clip.id))}>
          <Unlink size={14} className="menu-icon" />
          <span>Unlink from picture</span>
        </button>
      )}
      {!clip.linked_clip_id && (
        <div className="menu-note">
          <Link2 size={12} /> not linked to a video clip
        </div>
      )}

      {reattachable && (
        <button className="menu-item" title="Delete this clip and give the video its own audio back"
                onClick={run(() => store.reattachAudio(clip.id))}>
          <Undo2 size={14} className="menu-icon" />
          <span>Re-attach to video</span>
        </button>
      )}

      {onSaveAsNewBlock && (
        <>
          <div className="menu-divider" />
          <button className={"menu-item" + (saveAsNewBlockBlocker ? " disabled" : "")}
                  disabled={!!saveAsNewBlockBlocker}
                  title={saveAsNewBlockBlocker
                    ?? "Cut this window out of the picture this sound came from and save it "
                       + "as a new block in the storyboard"}
                  onClick={() => { if (saveAsNewBlockBlocker) return; onClose(); onSaveAsNewBlock(); }}>
            <CopyPlus size={14} className="menu-icon" />
            <span>Save as new block...</span>
          </button>
        </>
      )}

      {/* Copy / paste / duplicate. A copy lands as close to where it was asked
          for as it FITS, and never re-packs the lane — packing an audio lane
          that holds a linked clip would slide dialogue off its own shot, which
          is why `autoAlignImpl` refuses to do it at all. */}
      {(onDuplicate || onCopy || onPaste) && <div className="menu-divider" />}
      {onDuplicate && (
        <button className="menu-item" title="A copy of this clip immediately after it"
                onClick={() => { onClose(); onDuplicate(); }}>
          <Files size={14} className="menu-icon" />
          <span>Duplicate</span>
          <span className="menu-key">{mod}D</span>
        </button>
      )}
      {onCopy && (
        <button className="menu-item"
                title={clip.linked_clip_id
                  ? "Copy this clip and the picture it is linked to"
                  : "Copy this clip"}
                onClick={() => { onClose(); onCopy(); }}>
          <Copy size={14} className="menu-icon" />
          <span>Copy</span>
          <span className="menu-key">{mod}C</span>
        </button>
      )}
      {onPaste && (
        <button className={"menu-item" + (pasteBlocker ? " disabled" : "")}
                disabled={!!pasteBlocker}
                title={pasteBlocker ?? "Paste the copied clip onto this lane at the playhead"}
                onClick={() => { if (pasteBlocker) return; onClose(); onPaste(); }}>
          <ClipboardPaste size={14} className="menu-icon" />
          <span>Paste at playhead</span>
          <span className="menu-key">{mod}V</span>
        </button>
      )}

      <div className="menu-divider" />
      <button className="menu-item danger" onClick={run(() => store.removeClip(clip.id, false))}>
        <Trash2 size={14} className="menu-icon" />
        <span>{clip.linked_clip_id ? "Delete (both halves)" : "Delete clip"}</span>
        <span className="menu-key">⌫</span>
      </button>
    </div>,
    document.body
  );
}
