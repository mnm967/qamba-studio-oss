// A scene's STORYBOARD — one panel per shot, in reading order.
//
// It exists as its own component because two surfaces draw it and they must
// not drift: the storyboard page (StoryboardView, where it replaced the single
// "key still" — one arbitrary frame standing in for a whole scene, which says
// nothing about coverage) and the one-shot wizard's review step, which was
// still showing that key still long after the page had moved on. Same tiles,
// same numbering, same generated-vs-designated tell, at whatever width the
// column happens to be.
//
// The classes are the page's own (`.sb-panelgrid` / `.sb-panel` in
// workspace.css): the tiles carry an absolutely-positioned image inside an
// aspect-ratio box, which is what keeps a grid of frames from depending on
// when each one loads.
import React from "react";
import { Image as ImageIcon, Loader2, Plus } from "lucide-react";
import { beatImageId } from "../../lib/panels";
import { assetUrl } from "../../lib/db/assets";
import type { Asset, Beat } from "../../lib/db/types";

export type PanelBusyInfo =
  | boolean
  | { status?: string; progress?: number | null }
  | "queued"
  | "running"
  | null
  | undefined;

interface Props {
  /** The shots to draw, in order. The CALLER decides what belongs — the
   *  wizard drops breath beats (the panel queue skips them, so their tile
   *  could never fill) where the page shows every beat it has. */
  beats: Beat[];
  /** The scene's number as the LIST reads it, not `scenes.idx`: for the round
   *  trip after a drag they disagree, and the number the user just moved has
   *  to be the one that moved. */
  sceneNo: number;
  assetOf: (id: string | null | undefined) => Asset | null | undefined;
  /** Is a panel for this shot on the GPU or in queue right now — each surface
   *  keys its own pending set differently, so the question is asked rather
   *  than the set passed in. Supports returning boolean or status object/string
   *  to differentiate "queued" vs "running" (drawing). */
  busy?: (beat: Beat) => PanelBusyInfo;
  /** Clicking a drawn panel. Absent, the tile is inert and the click reaches
   *  whatever the grid sits inside — which is how the wizard's row opens the
   *  scene editor from anywhere on it. */
  onOpen?: (beat: Beat) => void;
  /** Clicking an empty panel tile to pick an asset (e.g. in the scene editor). */
  onFill?: (beat: Beat) => void;
}

export default function ScenePanelGrid({ beats, sceneNo, assetOf, busy, onOpen, onFill }: Props) {
  return (
    <div className="sb-panelgrid"
         style={{ "--cols": beats.length <= 1 ? 1 : 2 } as React.CSSProperties}>
      {(beats.length ? beats : [null]).map((b, i) => {
        // A user-designated still outranks the generated panel here exactly as
        // it does in the render's ref plan.
        const pick = b ? beatImageId(b) : { id: null, kind: null };
        const img = assetOf(pick.id);
        const busyVal = b ? busy?.(b) : null;
        const isBusy = !!busyVal;
        const status = typeof busyVal === "object" && busyVal ? busyVal.status
          : typeof busyVal === "string" ? busyVal : null;
        const isDrawing = status === "running";
        const isQueued = status === "queued" || (isBusy && !isDrawing);
        const fill = !!b && !img && !isBusy && !!onFill;

        const busyCls = isBusy ? (isDrawing ? " busy drawing" : " busy queued") : "";
        const emptyCls = img ? "" : " empty";
        const fillCls = fill ? " fill" : "";

        const titleText = b
          ? `shot ${b.idx + 1}${b.camera ? ` · ${b.camera}` : ""}${
              isDrawing
                ? " — drawing panel…"
                : isQueued
                  ? (img ? " — in queue for redraw" : " — in queue to draw")
                  : fill
                    ? " — click to choose a picture from the library"
                    : ""
            }`
          : undefined;

        return (
          <div key={b?.id ?? i}
               className={"sb-panel" + emptyCls + busyCls + fillCls}
               onClick={fill && b ? () => onFill(b) : undefined}
               title={titleText}>
            {img && (
              <img src={assetUrl(img) ?? undefined} alt=""
                   onClick={!isBusy && onOpen && b ? () => onOpen(b) : undefined}
                   style={{
                     cursor: !isBusy && onOpen ? "zoom-in" : undefined,
                     filter: isBusy ? "brightness(0.35) blur(0.5px)" : undefined,
                   }} />
            )}
            {isBusy ? (
              <div className={"sb-panel-busy" + (isDrawing ? " drawing" : " queued")}>
                <Loader2 size={13} className="ns-spin" style={{ color: isDrawing ? "#8fc2ff" : "#ffb454" }} />
                <span className="sb-panel-status">
                  {isDrawing ? "drawing…" : "in queue"}
                </span>
              </div>
            ) : !img ? (
              <span className="ph">
                {fill ? <Plus size={13} /> : <ImageIcon size={14} />}
              </span>
            ) : null}
            {b && <span className="num">{b.idx + 1}</span>}
            {pick.kind === "panel" && <span className="dot" title="generated panel" />}
          </div>
        );
      })}
      <span className="tag">S{sceneNo}</span>
    </div>
  );
}
