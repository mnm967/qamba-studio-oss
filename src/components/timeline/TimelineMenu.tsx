// THE CUT PICKER — what used to be the word "Timeline" in the slab header.
//
// `timelines` has always held a list per episode: `timelinesForEpisode`
// returns all of them and `ensureTimeline` merely picks "Main" out of it. What
// was missing was a way to make a second one and a way to say which one you
// are looking at, so a static title was telling the truth about a table with
// exactly one row in it. This is both halves.
//
// It reads the episode off the loaded timeline (`timeline.episode_id`) rather
// than taking it as a prop: WsTimeline does not know the episode, and passing
// one down would mean the header could disagree with the cut the store has
// actually loaded.
import React, { useState } from "react";
import { Check, ChevronDown, Copy, FilePlus2, Pencil, Trash2 } from "lucide-react";
import Dropdown from "../ui/Dropdown";
import { useTimelineStore } from "../../stores/useTimelineStore";
import { usePlaybackStore } from "../../stores/usePlaybackStore";
import { useLiveQuery } from "../../hooks/useLiveQuery";
import { supabase } from "../../lib/supabase";
import {
  createBlankTimeline, deleteTimeline, duplicateTimeline, ensureLanes,
  renameTimeline, timelinesForEpisode,
} from "../../lib/db/timeline";
import { forgetCut, rememberCut } from "../../lib/timelineCuts";

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

interface CutRow { id: string; name: string; clips: number; ms: number }

export default function TimelineMenu() {
  const timeline = useTimelineStore((s) => s.timeline);
  const episodeId = timeline?.episode_id ?? null;
  // Subscribed rather than read off getState(): these feed the fallback row
  // below, and a count that does not follow the cut it describes is a wrong
  // number on screen for as long as nothing else re-renders this.
  const openClips = useTimelineStore((s) => s.clips.length);
  const openMs = useTimelineStore((s) => s.durationMs());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // One read per menu, not one per row. A list of names cannot answer "which
  // of these is the cut I was working on" — the length and the clip count can,
  // and comparing cuts is the entire reason for having more than one.
  const { data: cuts } = useLiveQuery<CutRow[]>(
    async () => {
      if (!episodeId) return [];
      const rows = await timelinesForEpisode(episodeId);
      if (!rows.length) return [];
      const { data: tracks } = await supabase
        .from("tracks").select("id,timeline_id").in("timeline_id", rows.map((t) => t.id));
      const owner = new Map(((tracks ?? []) as { id: string; timeline_id: string }[])
        .map((t) => [t.id, t.timeline_id]));
      const { data: clips } = owner.size
        ? await supabase.from("clips").select("track_id,t_start_ms,duration_ms")
            .in("track_id", [...owner.keys()])
        : { data: [] };
      const tally = new Map<string, { clips: number; ms: number }>();
      for (const c of (clips ?? []) as
           { track_id: string; t_start_ms: number; duration_ms: number }[]) {
        const tl = owner.get(c.track_id);
        if (!tl) continue;
        const cur = tally.get(tl) ?? { clips: 0, ms: 0 };
        cur.clips++;
        cur.ms = Math.max(cur.ms, c.t_start_ms + c.duration_ms);
        tally.set(tl, cur);
      }
      return rows.map((t) => ({
        id: t.id, name: t.name, ...(tally.get(t.id) ?? { clips: 0, ms: 0 }),
      }));
    },
    ["timelines", "tracks", "clips"], [episodeId]);

  if (!timeline) {
    return <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em" }}>Timeline</span>;
  }

  // THE OPEN CUT IS ALWAYS IN ITS OWN PICKER. The list is a separate read
  // from the loaded timeline, so a query that has not landed yet, that failed,
  // or that ran with no session (the /ws-demo harness) would otherwise render
  // a switcher with nothing in it while a cut is plainly on screen. The
  // store's own copy is the fallback, with the counts it already holds.
  const rows: CutRow[] = (cuts ?? []).some((c) => c.id === timeline.id)
    ? (cuts as CutRow[])
    : [{ id: timeline.id, name: timeline.name, clips: openClips, ms: openMs },
       ...(cuts ?? [])];
  const cutCount = rows.length;

  /** One guard for every write here: two clicks on "New blank cut" is two
   *  cuts, and the second one is nobody's intention. */
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error)?.message ?? "Failed.");
    } finally {
      setBusy(false);
    }
  };

  /** The menu stays open until the cut exists, so "Working…" has somewhere to
   *  appear on a duplicate of a long timeline — and so a failure is READ
   *  rather than dismissed with the panel that would have shown it. Only
   *  success closes. */
  const create = (make: () => Promise<{ id: string }>, close: () => void) => run(async () => {
    const tl = await make();
    await useTimelineStore.getState().load(tl.id);
    usePlaybackStore.getState().seek(0);
    if (episodeId) rememberCut(episodeId, tl.id);
    close();
  });

  /** Open a cut. `ensureLanes` first because a timeline made before V2/A2/A3
   *  existed is reached through this menu too — the mount path already does
   *  it, and a switch that skipped it would show a two-lane editor.
   *
   *  A FAILED SWITCH LEAVES THE PREVIOUS CUT LOADED — `load` throws before it
   *  sets anything — so closing the menu first would leave a click that
   *  changed nothing and said nothing. `close` is optional because the
   *  post-delete fallback below has no menu to dismiss. */
  const open = (id: string, close?: () => void) => run(async () => {
    if (id === timeline.id) return;
    await ensureLanes(id);
    await useTimelineStore.getState().load(id);
    // The old playhead is a position in a cut that is no longer on screen.
    usePlaybackStore.getState().seek(0);
    if (episodeId) rememberCut(episodeId, id);
    close?.();
  });

  const commitRename = async (id: string) => {
    const name = draft.trim();
    setRenaming(null);
    if (!name || name === rows.find((c) => c.id === id)?.name) return;
    await run(async () => {
      await renameTimeline(id, name);
      // The header reads the STORE's copy, so the open cut has to be told
      // too — the live query repaints the list and nothing else.
      if (id === timeline.id) {
        useTimelineStore.setState((s) => ({
          timeline: s.timeline ? { ...s.timeline, name } : s.timeline,
        }));
      }
    });
  };

  const remove = (id: string) => run(async () => {
    await deleteTimeline(id);
    if (id !== timeline.id) return;
    // Deleting the cut you are looking at leaves the editor pointed at a row
    // that no longer exists; fall back to whatever is left rather than to a
    // blank screen. Loaded inline rather than through `open`, which refuses
    // to start while `run` holds `busy` — i.e. always, from in here.
    if (episodeId) forgetCut(episodeId);
    const next = rows.find((c) => c.id !== id);
    if (!next) return;
    await ensureLanes(next.id);
    await useTimelineStore.getState().load(next.id);
    usePlaybackStore.getState().seek(0);
    if (episodeId) rememberCut(episodeId, next.id);
  });


  return (
    <Dropdown width={296} align="left" maxHeight={420} className="ws-cutanchor"
      trigger={({ open: isOpen, toggle }) => (
        <button className={"ws-cutpick" + (isOpen ? " on" : "")} onClick={toggle}
                title={`${timeline.name} — ${cutCount} cut${cutCount === 1 ? "" : "s"} of this episode`}>
          <span className="nm">{timeline.name}</span>
          {cutCount > 1 && <span className="n mono">{cutCount}</span>}
          <ChevronDown size={13} style={{ flex: "none", opacity: 0.6 }} />
        </button>
      )}>
      {(close) => (
        <>
          <div className="ws-menu-label">Cuts · {cutCount}</div>
          {rows.map((c) => (
            <div key={c.id} className={"ws-threadrow" + (c.id === timeline.id ? " on" : "")}>
              {renaming === c.id ? (
                <input className="ws-input" autoFocus value={draft}
                       style={{ flex: 1, height: 28, fontSize: 12, padding: "0 9px" }}
                       onChange={(e) => setDraft(e.target.value)}
                       onBlur={() => void commitRename(c.id)}
                       onKeyDown={(e) => {
                         e.stopPropagation();
                         if (e.key === "Enter") void commitRename(c.id);
                         if (e.key === "Escape") setRenaming(null);
                       }} />
              ) : (
                <>
                  <button className="body" onClick={() => void open(c.id, close)}>
                    <span className="t">{c.name}</span>
                    <span className="mono s">
                      {c.clips} clip{c.clips === 1 ? "" : "s"}
                      {c.clips ? ` · ${fmt(c.ms)}` : ""}
                    </span>
                  </button>
                  {c.id === timeline.id
                    && <Check size={12} style={{ flex: "none", color: "#5aa2ff" }} />}
                  <button className="act" title="Rename this cut"
                          onClick={() => { setRenaming(c.id); setDraft(c.name); }}>
                    <Pencil size={11} />
                  </button>
                  {/* The last cut has no replacement to fall back to, and an
                      episode with no timeline is an editor with nothing
                      loaded. Disabled with the reason rather than hidden. */}
                  <button className="act danger" disabled={cutCount < 2}
                          style={{ opacity: cutCount < 2 ? 0.25 : undefined }}
                          title={cutCount < 2
                            ? "The only cut — make another before deleting this one"
                            : "Delete this cut. The clips go with it; the media stays in the library"}
                          onClick={() => void remove(c.id)}>
                    <Trash2 size={11} />
                  </button>
                </>
              )}
            </div>
          ))}
          <div className="ws-menu-sep" />
          <button className="ws-menu-row" disabled={busy || !episodeId}
                  style={{ opacity: busy ? 0.5 : undefined }}
                  title="An empty cut. The blocks already rendered are left off it — drag the ones you want from the Shots rail."
                  onClick={() => void create(() => createBlankTimeline(episodeId as string), close)}>
            <FilePlus2 size={13} style={{ color: "#58a6ff", flex: "none" }} />
            <span style={{ flex: 1, fontSize: 12.5 }}>New blank cut</span>
          </button>
          <button className="ws-menu-row" disabled={busy}
                  style={{ opacity: busy ? 0.5 : undefined }}
                  title={`Branch “${timeline.name}” — same lanes, clips, trims and effects, as its own cut`}
                  onClick={() => void create(() => duplicateTimeline(timeline.id), close)}>
            <Copy size={13} style={{ color: "#58a6ff", flex: "none" }} />
            <span style={{ flex: 1, fontSize: 12.5 }}>Duplicate this cut</span>
          </button>
          {busy && <div className="ws-menu-empty">Working…</div>}
          {err && <div className="ws-menu-empty" style={{ color: "#ff8080" }}>{err}</div>}
        </>
      )}
    </Dropdown>
  );
}
