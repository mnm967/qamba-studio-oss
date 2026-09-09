// One anchored dropdown for the whole app: a trigger you render, a panel that
// closes on outside click or Escape. Exists so pickers stop reaching for
// native <select> (which ignores the theme and clips its own label) and so the
// top bar and the scene editor share one behaviour instead of two.
//
// The panel is portalled to <body> and positioned `fixed` off the trigger's
// rect. Absolute positioning worked while every menu lived in the top bar, but
// inside a modal's scrolling column the panel got clipped by the column and
// stacked under sibling cards — the picker rendered fine and was simply not
// visible. Fixed + portal takes it out of every ancestor's overflow and
// stacking context; the cost is repositioning on scroll/resize, below.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const MARGIN = 8;   // keep the panel this far from any viewport edge
const GAP = 7;      // matches the old `top: calc(100% + 7px)`

/** Every open dropdown, oldest first — i.e. outermost first when they nest.
 *
 * Dropdowns nest: a picker inside a picker's panel (the LoRA stack's "add a
 * LoRA" lives inside the style-LoRAs menu). Because every panel portals to
 * <body>, an inner panel is NOT a DOM descendant of the outer one, so the outer
 * one's own contains() check called the inner click "outside" and closed on
 * mousedown — taking the inner panel down with it before its click could land.
 * The option looked like it did nothing at all.
 *
 * So containment is answered against the whole stack rather than one panel: a
 * click closes only the dropdowns opened *after* the deepest one it landed in.
 */
interface OpenEntry {
  anchor: React.RefObject<HTMLDivElement | null>;
  panel: React.RefObject<HTMLDivElement | null>;
  close: () => void;
}
const openStack: OpenEntry[] = [];

const hitIndex = (t: Node) => {
  let idx = -1;
  openStack.forEach((e, i) => {
    if (e.anchor.current?.contains(t) || e.panel.current?.contains(t)) idx = i;
  });
  return idx;
};

export default function Dropdown({
  trigger, children, width = 260, align = "left", maxHeight = "60vh", className,
}: {
  trigger: (o: { open: boolean; toggle: () => void }) => React.ReactNode;
  /** receives `close` so a row can dismiss the menu after acting */
  children: (close: () => void) => React.ReactNode;
  width?: number;
  align?: "left" | "right";
  maxHeight?: number | string;
  /** On the ANCHOR, not the panel. A dropdown sitting in a flex toolbar has to
   *  be able to shrink, and the anchor is the flex item — styling the trigger
   *  alone leaves a `min-width: auto` wrapper that refuses to give up a pixel,
   *  so a long label pushes the rest of the row off the end instead of
   *  ellipsising. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (!a) return;
    const vh = window.innerHeight, vw = window.innerWidth;
    const below = vh - a.bottom - GAP - MARGIN;
    const above = a.top - GAP - MARGIN;
    // flip up only when down is genuinely cramped and up is roomier
    const up = below < 200 && above > below;
    const h = panelRef.current?.offsetHeight ?? 0;
    const top = up ? Math.max(MARGIN, a.top - GAP - h) : a.bottom + GAP;
    const rawLeft = align === "right" ? a.right - width : a.left;
    const left = Math.max(MARGIN, Math.min(rawLeft, vw - width - MARGIN));
    setPos({ top, left, maxH: Math.max(140, up ? above : below) });
  };

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
    // second pass once the panel has a height (flip-up needs it)
    const r = requestAnimationFrame(place);
    return () => cancelAnimationFrame(r);
  }, [open, width, align]);

  useEffect(() => {
    if (!open) return;
    const entry: OpenEntry = {
      anchor: anchorRef, panel: panelRef, close: () => setOpen(false),
    };
    openStack.push(entry);

    const onDown = (e: MouseEvent) => {
      const mine = openStack.indexOf(entry);
      if (mine === -1) return;
      // Close only what was opened deeper than wherever the click landed, so a
      // nested menu can be used without its parent yanking it out from under it.
      if (mine > hitIndex(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Innermost first: one Escape should peel one layer, not the whole stack
      // (and not the modal behind it either).
      if (openStack[openStack.length - 1] !== entry) return;
      e.stopPropagation();
      setOpen(false);
    };
    const onMove = () => place();
    // defer: the click that opened this is still propagating
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onMove);
    // capture: catch scrolls on any ancestor, not just the window
    window.addEventListener("scroll", onMove, true);
    return () => {
      clearTimeout(t);
      const i = openStack.indexOf(entry);
      if (i !== -1) openStack.splice(i, 1);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  return (
    <div className={className} style={{ position: "relative" }} ref={anchorRef}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && createPortal(
        <div ref={panelRef} className="ws-menu ns-l2 ns-pop"
             style={{
               position: "fixed", zIndex: 320,
               top: pos?.top ?? -9999, left: pos?.left ?? -9999,
               width,
               maxHeight: pos
                 ? `min(${typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight}, ${pos.maxH}px)`
                 : maxHeight,
               visibility: pos ? "visible" : "hidden",
             }}>
          {children(() => setOpen(false))}
        </div>,
        document.body,
      )}
    </div>
  );
}
