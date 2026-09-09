// The reference strip, shared by every surface that stages pictures for a
// free-standing render.
//
// One component rather than two, for the reason `_publish_derived_take` is one
// function on the worker side: the rules that are silent when forgotten — the
// tile carrying the NUMBER the prompt will use, `:is(img, video)` rather than
// `> *` so the badge is not stretched over the picture, the cap being the
// MODEL's — would otherwise be remembered in one modal and dropped in the
// next. It is presentation only: what the list means, what may be added to it
// and why it is refused all belong to the caller.
import React from "react";
import { Plus, Trash2 } from "lucide-react";
import { mediaUrl } from "../../lib/supabase";
import type { Asset } from "../../lib/db/types";

export default function RefTiles({
  refs, cap, blocked, onAdd, onRemove, addLabel = "add",
}: {
  refs: Asset[];
  /** How many this model holds. The add tile disappears at the ceiling. */
  cap: number;
  /** Why nothing may be added, or null. Non-null hides the add tile — the
   *  caller shows the reason, since only it knows where the sentence belongs. */
  blocked?: string | null;
  onAdd: () => void;
  onRemove: (asset: Asset) => void;
  addLabel?: string;
}) {
  return (
    <div className="rt-grid">
      {refs.map((a, i) => (
        <div key={a.id} className="rt-tile">
          <img src={mediaUrl(a.b2_key) ?? undefined} alt={`Picture ${i + 1}`} />
          {/* The payload is a flat ORDERED list and the prompt refers to them
              by number, so the tile carries the number the render will use. */}
          <span className="rt-n">{i + 1}</span>
          <button type="button" className="rt-x" title={`Remove picture ${i + 1}`}
                  onClick={() => onRemove(a)}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {!blocked && refs.length < cap && (
        <button type="button" className="rt-add" onClick={onAdd}>
          <Plus size={14} />
          <span>{addLabel}</span>
        </button>
      )}
    </div>
  );
}
