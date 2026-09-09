import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  AudioLines, Camera, ClipboardPaste, Copy, CopyPlus, Files, FolderOpen, Layers, Link2,
  Music4, Plus, RefreshCw, Scissors, Undo2, Unlink, Wand2,
} from "lucide-react";
import { isMacUA } from "../../lib/titlebar";
import type { Clip } from "../../lib/db/types";

interface BlockContextMenuProps {
  clip: Clip;
  x: number;
  y: number;
  hasNextClip: boolean;
  onClose: () => void;
  onAssemble?: () => void;
  onRetake?: () => void;
  onCompareTakes?: () => void;
  onPickTakeFromLibrary?: () => void;
  /** Re-score the block: a model watches one of its takes and writes a new
   *  soundtrack for it, published as another take. */
  onChangeAudio?: () => void;
  onSaveLastFrame: () => void;
  /** Promote this clip's trimmed window to a block of its own. */
  onSaveAsNewBlock?: () => void;
  /** Why that cannot be done here, in the words the tooltip should use.
   *  Computed by the parent (it holds the asset), for the same reason
   *  `hasNextClip` is: this component decides layout, never eligibility. */
  saveAsNewBlockBlocker?: string | null;
  onAddBlockAfter: () => void;
  onExtendBlock: () => void;
  onChainWithNext: () => void;
  /** Copy / paste / duplicate. Supplied by the parent, which owns the note
   *  these report through — a paste that silently does nothing is
   *  indistinguishable from a menu item that is broken. */
  onDuplicate?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  /** Why paste cannot run here (nothing copied, wrong lane kind, locked). */
  pasteBlocker?: string | null;

  /** Audio actions — omitted on surfaces that have no audio lanes. */
  onDetachAudio?: () => void;
  onReattachAudio?: () => void;
  onUnlinkAudio?: () => void;
}

export default function BlockContextMenu({
  clip,
  x,
  y,
  hasNextClip,
  onClose,
  onAssemble,
  onRetake,
  onCompareTakes,
  onPickTakeFromLibrary,
  onChangeAudio,
  onSaveLastFrame,
  onSaveAsNewBlock,
  saveAsNewBlockBlocker,
  onAddBlockAfter,
  onExtendBlock,
  onChainWithNext,
  onDuplicate,
  onCopy,
  onPaste,
  pasteBlocker,
  onDetachAudio,
  onReattachAudio,
  onUnlinkAudio,
}: BlockContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // ⌘ on a Mac, Ctrl everywhere else — the desktop app ships on both, and a
  // hint naming the wrong one is worse than none.
  const mod = isMacUA() ? "⌘" : "Ctrl+";

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent | PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", handlePointerDown);
    }, 50);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Adjust positioning to stay within viewport bounds
  const menuWidth = 220;
  const menuHeight = 560;
  const left = Math.max(12, Math.min(x, window.innerWidth - menuWidth - 12));
  const top = Math.max(12, Math.min(y, window.innerHeight - menuHeight - 12));

  return createPortal(
    <div
      ref={menuRef}
      className="tl-contextmenu"
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 1000,
        maxHeight: "calc(100vh - 24px)",
        overflowY: "auto",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="menu-header">
        <span className="clip-name">{clip.label ?? "Block"}</span>
        <span className="clip-dur">{(clip.duration_ms / 1000).toFixed(1)}s</span>
      </div>
      <div className="menu-divider" />

      {onAssemble && (
        <button
          className={"menu-item" + (!clip.block_id ? " disabled" : "")}
          disabled={!clip.block_id}
          title={!clip.block_id ? "No generation block associated with clip" : "Assemble takes for this block"}
          onClick={() => {
            if (!clip.block_id) return;
            onClose();
            onAssemble();
          }}
        >
          <Scissors size={14} className="menu-icon" />
          <span>Assemble...</span>
        </button>
      )}

      {onRetake && (
        <button
          className={"menu-item" + (!clip.block_id ? " disabled" : "")}
          disabled={!clip.block_id}
          title={!clip.block_id ? "No generation block associated with clip" : "Retake this block with AI"}
          onClick={() => {
            if (!clip.block_id) return;
            onClose();
            onRetake();
          }}
        >
          <RefreshCw size={14} className="menu-icon" />
          <span>Retake...</span>
        </button>
      )}

      {onCompareTakes && (
        <button
          className={"menu-item" + (!clip.block_id ? " disabled" : "")}
          disabled={!clip.block_id}
          title={!clip.block_id ? "No generation block associated with clip" : "Compare takes for this block"}
          onClick={() => {
            if (!clip.block_id) return;
            onClose();
            onCompareTakes();
          }}
        >
          <Layers size={14} className="menu-icon" />
          <span>Compare takes...</span>
        </button>
      )}

      {onPickTakeFromLibrary && (
        <button
          className={"menu-item" + (!clip.block_id ? " disabled" : "")}
          disabled={!clip.block_id}
          title={!clip.block_id ? "No generation block associated with clip" : "Choose take from library for this block"}
          onClick={() => {
            if (!clip.block_id) return;
            onClose();
            onPickTakeFromLibrary();
          }}
        >
          <FolderOpen size={14} className="menu-icon" />
          <span>Choose take from library...</span>
        </button>
      )}

      {/* CHANGE THE AUDIO. Needs a BLOCK, not just a clip: what it produces is
          another take, and a clip with no block has nothing to publish one to.
          Disabled with the reason rather than hidden, the way the two take
          actions above are. */}
      {onChangeAudio && (
        <button
          className={"menu-item" + (!clip.block_id ? " disabled" : "")}
          disabled={!clip.block_id}
          title={!clip.block_id
            ? "This clip is not a generation block, so there is no take to publish "
              + "a re-score to. Use the Audio panel's Video tab to score it into "
              + "the library instead."
            : "A model watches this shot and writes a new soundtrack for it. The "
              + "picture is copied untouched — same frames, same length."}
          onClick={() => {
            if (!clip.block_id) return;
            onClose();
            onChangeAudio();
          }}
        >
          <Music4 size={14} className="menu-icon" />
          <span>Change the audio...</span>
        </button>
      )}

      <button
        className="menu-item"
        onClick={() => {
          onClose();
          onSaveLastFrame();
        }}
      >
        <Camera size={14} className="menu-icon" />
        <span>Save last frame</span>
      </button>

      {/* SAVE AS NEW BLOCK. A trim on the lane lives in the cut and nowhere
          else: the block still describes the whole render, `assemble_cut`
          concatenates take assets whole, and the next take repoints the media
          under the clip. This makes the trim its own block, with its own take
          cut to exactly what is on screen. */}
      {onSaveAsNewBlock && (
        <button
          className={"menu-item" + (saveAsNewBlockBlocker ? " disabled" : "")}
          disabled={!!saveAsNewBlockBlocker}
          title={saveAsNewBlockBlocker
            ?? "Cut this clip's trimmed window to its own take and save it as a new "
               + "block in the storyboard"}
          onClick={() => {
            if (saveAsNewBlockBlocker) return;
            onClose();
            onSaveAsNewBlock();
          }}
        >
          <CopyPlus size={14} className="menu-icon" />
          <span>Save as new block...</span>
        </button>
      )}

      <div className="menu-divider" />

      <button
        className="menu-item"
        onClick={() => {
          onClose();
          onAddBlockAfter();
        }}
      >
        <Plus size={14} className="menu-icon" />
        <span>Add block after...</span>
      </button>

      <button
        className="menu-item"
        onClick={() => {
          onClose();
          onExtendBlock();
        }}
      >
        <Wand2 size={14} className="menu-icon" />
        <span>Extend block...</span>
      </button>

      <button
        className={"menu-item" + (!hasNextClip ? " disabled" : "")}
        disabled={!hasNextClip}
        title={!hasNextClip ? "No next clip available on track to chain with" : "Chain with next block"}
        onClick={() => {
          if (!hasNextClip) return;
          onClose();
          onChainWithNext();
        }}
      >
        <Link2 size={14} className="menu-icon" />
        <span>Chain with next block...</span>
      </button>

      {/* Copy / paste / duplicate. A copy is placed as close to where it was
          asked for as it FITS — it never re-packs the lane and never moves a
          clip nobody touched, because on a lane holding a linked clip that
          would slide dialogue off the shot it was detached from. */}
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
        <button className="menu-item" title="Copy this clip (and its linked audio, if any)"
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

      {/* Audio. A block arrives as one file with its sound baked in, so the
          only volume control over it is the whole lane's mute until it has a
          lane of its own. */}
      {(onDetachAudio || onReattachAudio || onUnlinkAudio) && <div className="menu-divider" />}
      {onDetachAudio && !clip.audio_detached && (
        <button className="menu-item"
                title="Put this clip's audio on an audio lane, where it has a fader and automation"
                onClick={() => { onClose(); onDetachAudio(); }}>
          <AudioLines size={14} className="menu-icon" />
          <span>Detach audio to lane</span>
        </button>
      )}
      {onUnlinkAudio && clip.linked_clip_id && (
        <button className="menu-item" title="Move and trim picture and sound independently"
                onClick={() => { onClose(); onUnlinkAudio(); }}>
          <Unlink size={14} className="menu-icon" />
          <span>Unlink audio</span>
        </button>
      )}
      {/* Two different actions wearing one icon. Linked, this deletes the
          audio clip and gives the picture its sound back. UNLINKED, there is
          no partner to delete — the copy on the audio lane is now a clip in
          its own right, wherever the user dragged it — so un-muting the
          picture means both play. Say so rather than doubling the dialogue
          and letting them work out why. */}
      {onReattachAudio && clip.audio_detached && (
        <button className="menu-item"
                title={clip.linked_clip_id
                  ? "Drop the linked audio clip and play this clip's own sound again"
                  : "Un-mute this clip's own audio. Its detached copy is unlinked, so if that "
                    + "clip is still on an audio lane you will hear the take twice — delete it too."}
                onClick={() => { onClose(); onReattachAudio(); }}>
          <Undo2 size={14} className="menu-icon" />
          <span>{clip.linked_clip_id ? "Re-attach audio" : "Un-mute clip audio"}</span>
        </button>
      )}
    </div>,
    document.body
  );
}


