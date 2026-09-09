// Editor keyboard map. Bound once by the timeline view; ignores keystrokes
// aimed at text fields or a modal, so typing a scene title never scrubs the
// timeline.
import { useEffect } from "react";
import { useTimelineStore } from "../stores/useTimelineStore";
import { usePlaybackStore } from "../stores/usePlaybackStore";
import { useWorkspaceStore } from "../stores/useWorkspaceStore";
import { claimPaste, emitTimelineNote, timelineVisible } from "../lib/timelineSignals";
import { groupMove } from "../lib/marquee";

const FRAME_MS = 1000 / 24;

function typingInto(el: EventTarget | null) {
  const n = el as HTMLElement | null;
  if (!n) return false;
  const tag = n.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || n.isContentEditable;
}

/** Is this keystroke aimed at a panel that owns its own editing keys?
 *
 *  Only the DESTRUCTIVE keys consult this. Delete has to mean "the thing I am
 *  working on", and while you are inside the effects rack that is a band or an
 *  effect, never the clip on the timeline — pressing it on an EQ point deleted
 *  the whole block, which is as bad as this gets. Transport keys deliberately
 *  still work from in there: tweaking a filter and hitting space to hear it is
 *  the whole loop.
 *
 *  A control that handles a key itself should ALSO stop it propagating (Knob
 *  and EqPlot do). This is the net under that, because forgetting to is
 *  silent and the cost is someone's shot. */
const ownsEditKeys = (el: EventTarget | null) =>
  !!(el as HTMLElement | null)?.closest?.('[data-keys="own"]');

/** Is the user copying TEXT rather than a clip?
 *
 *  ⌘C on a page with a live selection means "copy what I highlighted", and
 *  this workspace is full of prose someone legitimately wants — the director
 *  transcript, a compiled prompt, an error message. Taking that keystroke to
 *  copy a clip instead would replace the clipboard they were reaching for,
 *  which is a small theft that is very annoying to diagnose. */
const hasTextSelection = () => {
  const s = typeof window !== "undefined" ? window.getSelection() : null;
  return !!s && !s.isCollapsed && (s.toString() ?? "").trim().length > 0;
};

export function useTimelineKeys(opts: { onRender?: () => void } = {}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingInto(e.target)) return;
      const ws = useWorkspaceStore.getState();
      if (ws.modal) return;                    // modals own the keyboard
      const tl = useTimelineStore.getState();
      const pb = usePlaybackStore.getState();
      const sel = tl.clips.find((c) => c.id === tl.selectedClipId) ?? null;
      // The whole selection, which a marquee makes bigger than one clip.
      // Delete and the nudge take all of it; copy, duplicate and split are
      // one-clip operations and SAY so (`onlyOne`) rather than silently
      // picking whichever clip the primary happens to be.
      const ids = tl.selectedClipIds;
      const many = ids.length > 1;
      const onlyOne = (Verb: string) =>
        many ? ` ${Verb} takes one clip, and ${ids.length} are selected.` : "";
      const mod = e.metaKey || e.ctrlKey;

      switch (e.key) {
        case " ":
          e.preventDefault();
          pb.toggle();
          return;
        case "k":
          if (mod) return;
          e.preventDefault(); pb.pause(); return;
        case "Home":
          e.preventDefault(); pb.seek(0); return;
        case "End":
          e.preventDefault(); pb.seek(pb.durationMs); return;
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          const step = e.shiftKey ? 1000 : FRAME_MS;
          if (sel && e.altKey) {
            // alt+arrow nudges the SELECTION instead of the playhead — rigid,
            // so a group keeps its own spacing (lib/marquee `groupMove`).
            // Coalesced: a HELD arrow key repeats ~30 times a second, and one
            // undo step per repeat is a stack that cannot reach past the nudge.
            const movers = tl.clips.filter((c) => ids.includes(c.id));
            tl.moveClips(groupMove(movers, dir * step),
                         { coalesceKey: `nudge:${ids.join(",")}` });
          } else {
            pb.seek(pb.nowMs() + dir * step);
          }
          return;
        }
        case "s":
        case "S":
          if (mod || !sel || ownsEditKeys(e.target)) return;
          e.preventDefault();
          void tl.splitAt(sel.id, pb.nowMs());
          if (many) emitTimelineNote(`Split “${sel.label ?? "clip"}”.${onlyOne("Split")}`);
          return;
        case "Delete":
        case "Backspace":
          if (!sel || ownsEditKeys(e.target)) return;
          e.preventDefault();
          // The WHOLE selection, as one undo step — `removeClips` falls
          // through to `removeClip` for a single clip, so nothing changed for
          // the ordinary case. shift = ripple.
          void tl.removeClips(ids, e.shiftKey);
          return;
        // ── the clipboard ──────────────────────────────────────────────
        // Every one of these REPORTS, through the same note the context menus
        // use. A shortcut that silently declines — nothing copied, the wrong
        // lane kind, a locked lane — is indistinguishable from one that was
        // never wired up, and this is the only surface with no menu to grey.
        case "c":
        case "C":
          if (!mod || e.altKey || ownsEditKeys(e.target) || !timelineVisible()) return;
          if (hasTextSelection()) return;      // they meant the text
          if (!sel) return;                    // let the browser have it
          e.preventDefault();
          emitTimelineNote(tl.copyClip(sel.id)
            ? `Copied “${sel.label ?? "clip"}”${sel.linked_clip_id ? " and its linked half" : ""}.`
              + onlyOne("Copy")
            : "Couldn't copy that clip.");
          return;
        case "v":
        case "V": {
          if (!mod || e.altKey || ownsEditKeys(e.target) || !timelineVisible()) return;
          // NOT claimed unless there is something to paste: ⌘V also pastes
          // media files from the OS clipboard into the library, and claiming
          // a keystroke this handler is about to decline would swallow that.
          if (!tl.clipboard) return;
          e.preventDefault();
          claimPaste();
          // The lane the selection is on, so a paste goes where the user is
          // working. With nothing selected `pasteTarget` falls back to the
          // first unlocked lane of the right kind.
          void tl.pasteClip(sel?.track_id ?? null, pb.nowMs())
            .then((note) => note && emitTimelineNote(note),
                  (err) => emitTimelineNote(`Couldn't paste: ${(err as Error)?.message ?? err}`));
          return;
        }
        case "d":
        case "D":
          // ⌘D is Add Bookmark in every browser, so this one preventDefaults
          // even when there is no selection to act on — but only while the
          // timeline is up. Blocking a browser shortcut on a screen that has
          // nothing to offer instead is a worse trade than a bookmark.
          if (!mod || e.altKey || ownsEditKeys(e.target) || !timelineVisible()) return;
          e.preventDefault();
          if (!sel) { emitTimelineNote("Select a clip to duplicate."); return; }
          void tl.duplicateClip(sel.id)
            .then((note) => {
              // The store only speaks up when there is something to say (the
              // copy slid down the lane to find room, or it refused). The
              // suffix is the other case: a duplicate that took one of five.
              const extra = onlyOne("Duplicate");
              if (note) emitTimelineNote(note + extra);
              else if (extra) emitTimelineNote(`Duplicated “${sel.label ?? "clip"}”.${extra}`);
            }, (err) => emitTimelineNote(`Couldn't duplicate: ${(err as Error)?.message ?? err}`));
          return;
        // ── the selection ─────────────────────────────────────────────
        case "a":
        case "A":
          // Every clip on every lane. ⌘A otherwise selects the whole page's
          // TEXT, which on this screen highlights the transcript and the lane
          // labels and does nothing anyone wanted — so it is claimed only
          // while the timeline is up, the same trade ⌘D makes one case down.
          if (!mod || e.altKey || ownsEditKeys(e.target) || !timelineVisible()) return;
          e.preventDefault();
          tl.selectMany(tl.clips.map((c) => c.id));
          if (tl.clips.length) useWorkspaceStore.getState().set("inspOpen", true);
          return;
        case "Escape":
          // Clearing the selection needs a key as well as a click on empty
          // lane: with the lanes full there may be no empty lane to click.
          if (!ids.length && !tl.selectedTrackId) return;
          e.preventDefault();
          tl.select(null);
          tl.selectTrack(null);
          return;
        case "z":
        case "Z":
          if (!mod) return;
          e.preventDefault();
          if (e.shiftKey) tl.redo(); else tl.undo();
          return;
        // ⌘⇧Z is the mac spelling and ctrl+Y the Windows one — the desktop app
        // ships on both, and a redo that only answers one of them reads as a
        // redo that does not work.
        case "y":
        case "Y":
          if (!mod) return;
          e.preventDefault();
          tl.redo();
          return;
        case "+":
        case "=":
          e.preventDefault(); tl.zoomBy(1.4); return;
        case "-":
        case "_":
          e.preventDefault(); tl.zoomBy(1 / 1.4); return;
        case "r":
        case "R":
          if (mod || !opts.onRender) return;
          e.preventDefault(); opts.onRender(); return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts]);
}
