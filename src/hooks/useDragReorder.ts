// Drag-to-reorder for a vertical list of rows. Plain HTML5 drag-and-drop, in
// keeping with the rest of the app's drag surfaces (the library's
// `application/x-qamba-asset` cards, the timeline) — no dependency.
//
// Two things it does that a naive version doesn't:
//   * the drag starts from a HANDLE, not the row. A whole draggable row can't
//     have its prose selected and swallows the clicks of the buttons inside it,
//     and both of those are things these rows are for.
//   * the commit is optimistic and self-healing: `ids` reports the new order
//     immediately, then defers back to the server's once the reload agrees.
//     Without that the list snaps back to the old order for the length of a
//     round trip, which reads exactly like the drag failed.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";

export const DND_ROW = "application/x-qamba-row";

export interface DragReorder {
  /** The order to render in — the pending one while a commit is in flight. */
  ids: string[];
  /** The row being dragged, or null. */
  dragId: string | null;
  /** Where the drop line sits: 0 above the first row … n below the last. */
  gap: number | null;
  /** Spread onto the grab handle. */
  handleProps: (id: string) => {
    draggable: true;
    onDragStart: (e: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  };
  /** Spread onto the row. */
  rowProps: (id: string) => {
    ref: (el: HTMLElement | null) => void;
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
  /** Spread onto the list container, so a release in the gutter still lands. */
  listProps: {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
  error: string | null;
  clearError: () => void;
}

/**
 * Move `id` into `gap` — where a gap is a position *between* rows: 0 is above
 * the first, `ids.length` below the last. Returns the same array (by value)
 * when the move is a no-op, which is what "dropped where it started" is.
 *
 * The -1 is the whole trick and the easy thing to get wrong: once the row is
 * pulled out of the list, every gap after its old position has shifted down
 * one, so a gap index measured against the list *with* the row in it is one
 * too high. Without it, dragging a row down lands it one short every time.
 */
export function moveTo(ids: string[], id: string, gap: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const at = Math.max(0, Math.min(ids.length, gap));
  const next = ids.filter((x) => x !== id);
  next.splice(at > from ? at - 1 : at, 0, id);
  return next.every((x, i) => ids[i] === x) ? ids : next;
}

/** `serverIds` in their current order; `commit` persists a new order. */
export function useDragReorder(
  serverIds: string[],
  commit: (ids: string[]) => Promise<unknown>,
): DragReorder {
  const [dragId, setDragId] = useState<string | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  const [pending, setPending] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());

  // The optimistic order stands until the server's agrees with it — or until
  // the set of ids changes underneath us (a scene added or deleted elsewhere),
  // where holding on to it would render a list that no longer exists.
  const same = pending !== null && pending.length === serverIds.length
    && pending.every((id, i) => serverIds[i] === id);
  const known = pending !== null && pending.length === serverIds.length
    && pending.every((id) => serverIds.includes(id));
  useEffect(() => {
    if (pending !== null && (same || !known)) setPending(null);
  }, [pending, same, known]);
  const ids = pending && known ? pending : serverIds;

  const reorder = useCallback((id: string, at: number) => {
    const next = moveTo(ids, id, at);
    if (next === ids) return;                            // dropped where it was
    setPending(next);
    setError(null);
    commit(next).catch((e: unknown) => {
      setPending(null);                                   // back to the truth
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [ids, commit]);

  const handleProps = useCallback((id: string) => ({
    draggable: true as const,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(DND_ROW, id);
      // Drag the whole row, not the grip: the default drag image is the element
      // the gesture started on, and a floating 12px handle says nothing about
      // what is moving.
      const row = rows.current.get(id);
      if (row) {
        const r = row.getBoundingClientRect();
        e.dataTransfer.setDragImage(row, e.clientX - r.left, e.clientY - r.top);
      }
      setDragId(id);
    },
    onDragEnd: () => { setDragId(null); setGap(null); },
    // The handle is a button, so the same move is available without a mouse.
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const d = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      if (!d) return;
      e.preventDefault();
      const from = ids.indexOf(id);
      if (from + d < 0 || from + d >= ids.length) return;
      reorder(id, d < 0 ? from - 1 : from + 2);
    },
  }), [ids, reorder]);

  const rowProps = useCallback((id: string) => ({
    ref: (el: HTMLElement | null) => {
      if (el) rows.current.set(id, el);
      else rows.current.delete(id);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      const i = ids.indexOf(id);
      setGap(e.clientY < r.top + r.height / 2 ? i : i + 1);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (dragId && gap !== null) reorder(dragId, gap);
      setDragId(null);
      setGap(null);
    },
  }), [dragId, gap, ids, reorder]);

  const listProps = {
    // Rows are spaced apart, so a release in the gutter lands on the container.
    // Without this it hits the browser's default (no drop) and the drag is lost
    // an inch from where it was aimed.
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      if (dragId && gap !== null) reorder(dragId, gap);
      setDragId(null);
      setGap(null);
    },
  };

  return { ids, dragId, gap, handleProps, rowProps, listProps, error,
           clearError: () => setError(null) };
}

/** Reorder a list of rows by the id order the hook reports. */
export function byIds<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const by = new Map(items.map((x) => [x.id, x]));
  const out = ids.map((id) => by.get(id)).filter(Boolean) as T[];
  // Anything the order doesn't mention still has to render.
  for (const it of items) if (!ids.includes(it.id)) out.push(it);
  return out;
}
