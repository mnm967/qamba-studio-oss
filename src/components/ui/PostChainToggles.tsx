// The post chain's toggle rows, shared by the two surfaces that set it: the
// clip inspector (per clip, when it overrides the project) and the project
// settings panel (the default every clip inherits). One list, so a pass added
// to lib/postChain.ts appears in both and its availability note reads the same
// in both.
//
// `readOnly` is what the inspector shows while a clip is inheriting: the rows
// still render, dimmed, because "inherit project settings" is not an answer to
// "what will actually happen to this shot".
//
// THE PLAN IS READ HERE, not passed in. Three surfaces mount this component,
// and a prop is three call sites free to forget it — the same reasoning
// `TieredModelMenu` states for reading `useIsAdmin` itself. It also means the
// rows are never HIDDEN: a Free account sees exactly what the chain is and why
// it is unavailable, which is the standing rule here (nothing is hidden; a fix
// the user can perform is a button).
import React from "react";
import { Film, Layers, Palette, RefreshCw, ScanFace, Sparkles, Wand2 } from "lucide-react";
import { offeredOps, toggleOp, type PostChain, type PostOpId } from "../../lib/postChain";

export const POST_ICON: Record<PostOpId, React.ReactNode> = {
  upscale: <Layers size={13} />,
  ltx_refine: <Wand2 size={13} />,
  interpolate: <RefreshCw size={13} />,
  facefix: <Film size={13} />,
  h3_facefix: <ScanFace size={13} />,
  color_match: <Palette size={13} />,
  grain: <Sparkles size={13} />,
};

export default function PostChainToggles({ chain, onChange, readOnly = false, disabled = false }: {
  chain: PostChain;
  onChange?: (next: PostChain) => void;
  readOnly?: boolean;
  disabled?: boolean;
}) {
  const off = readOnly || disabled;
  // NOT `POST_OPS`. A retired pass is listed only while it is ON, so it can be
  // switched off and then stays gone — see PostOpDef.retired.
  const rows = offeredOps(chain);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8,
                  opacity: readOnly ? 0.62 : 1 }}>
      {rows.map((op) => {
        const on = chain[op.id] === true;
        return (
          <div key={op.id} className="ws-toggrow">
            <span style={{ color: on ? "#8fc2ff" : "#5e6678", display: "grid", placeItems: "center" }}>
              {POST_ICON[op.id]}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 12.5, color: on ? "#eaeef6" : "#9aa4b6" }}>
                {op.label}
              </span>
              {(op.retired || (op.unavailable && on)) && (
                <span className="mono" style={{
                  display: "block", fontSize: 9.5, color: "#e0a23c", marginTop: 2,
                }}>
                  {op.retired ?? op.unavailable}
                </span>
              )}
            </span>
            <button className={"ws-switch-t" + (on ? " on" : "")}
                    disabled={off}
                    style={off ? { cursor: "default" } : undefined}
                    title={readOnly
                      ? `${op.label} — set on the project`
                      : [op.hint,
                         op.retired && `${op.retired}. Switching it off removes it from this list.`,
                         op.unavailable && `Unavailable: ${op.unavailable}`]
                          .filter(Boolean).join("\n")}
                    onClick={() => {
                      if (off || !onChange) return;
                      // `toggleOp` and not three lines of spread: it also
                      // resolves the exclusive pairs, so turning one face
                      // pass on turns the other off here AND in the project
                      // panel, which is the combination the worker refuses.
                      onChange(toggleOp(chain, op.id));
                    }}>
              <i />
            </button>
          </div>
        );
      })}
    </div>
  );
}
