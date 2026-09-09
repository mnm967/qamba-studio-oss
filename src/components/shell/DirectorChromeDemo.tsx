// The Creative Director panel's chrome, at its design width, with fixtures.
//
// Here for the reason `replan` and `panel` are: the real dock is behind a
// sign-in, a project and a conversation, and the claim this handoff makes —
// "colours, type sizes, spacing, radii and icon sizes are final and should be
// matched" — is one only a picture can check. It reads no Supabase at all.
//
// It composes the SAME components and the SAME classes the dock does
// (`DirectorChrome`, `.ws-tool-row`, `.ws-umsg`, `.ws-amsg`, `.ws-receipt`,
// `.ws-composer`), so it cannot drift into being a second, prettier copy of
// the design — which is the whole failure mode of a hand-built harness.
import React from "react";
import {
  Check, ChevronRight, History, Mic, Paperclip, Plus, Send, Sparkles,
} from "lucide-react";
import Dropdown from "../ui/Dropdown";
import TieredModelMenu, { type Quality } from "../ui/TieredModelMenu";
import BackendMenu, { backendShort, backendTierLabel } from "../ui/BackendMenu";
import { tierOf } from "../../lib/localModels";
import type { ModelCatalogRow } from "../../lib/db/types";
import { DirectorMsg } from "./DirectorDock";
import RevertTurnDialog from "../modals/RevertTurnDialog";
import { DockIconBtn, ErrorRow, LlmChip, ModelChip, StaleNotice } from "./DirectorChrome";
import StaleBlocksModal from "../modals/StaleBlocksModal";
import type { BlockIndexRow, BlockPlanDetail } from "../../lib/db/director";

/** Catalog-shaped fixtures spanning all three planes.
 *
 *  The dock's two render-model chips open the SAME grouped menu the library's
 *  generate dock does (`TieredModelMenu`), and the group headers are the whole
 *  point of it — so a harness that only showed pod rows would be reviewing the
 *  half of the picker that never needed reviewing. `local:` ids are what
 *  `tierOf` reads as "on this machine"; nothing here touches the real engine. */
const row = (o: Partial<ModelCatalogRow> & { id: string; display_name: string }) => ({
  provider: "local", enabled: true, sort: 1, kind: "video",
  modes: ["t2v"], capabilities: {}, pricing: {}, ...o,
}) as ModelCatalogRow;

const VIDEO_MODELS: ModelCatalogRow[] = [
  row({ id: "h3-turbo-local", display_name: "MiniMax H3 · Turbo", modes: ["i2v", "t2v", "flf", "r2v"],
        capabilities: { multiRef: 9, vramGb: 48 } }),
  row({ id: "h3-local", display_name: "MiniMax H3", modes: ["i2v", "t2v", "flf", "r2v"],
        capabilities: { multiRef: 9, vramGb: 48 } }),
  row({ id: "ltx-25-local", display_name: "LTX 2.5", modes: ["t2v", "r2v"], sort: 2 }),
  row({ id: "local:wan22-5b/Q6_K", display_name: "Wan 2.2 5B · Q6_K",
        capabilities: { vramGb: 10 }, sort: 3 }),
  row({ id: "h3-api", display_name: "MiniMax H3 (hosted)", provider: "minimax",
        pricing: { usd: 0.43, unit: "clip" } as never, sort: 4 }),
];

const IMAGE_MODELS: ModelCatalogRow[] = [
  row({ id: "krea2", display_name: "Krea 2", kind: "image", modes: ["t2i", "r2i"],
        capabilities: { multiRef: 4 } }),
  row({ id: "h3-image-turbo-local", display_name: "MiniMax H3 image · Turbo", kind: "image",
        modes: ["t2i", "r2i", "edit"], capabilities: { multiRef: 9 }, sort: 2 }),
  row({ id: "local:sdxl/base", display_name: "SDXL 1.0", kind: "image",
        capabilities: { vramGb: 10 }, sort: 3 }),
  row({ id: "gpt-image-2", display_name: "GPT Image 2", kind: "image", provider: "openai",
        modes: ["t2i", "edit"], pricing: { usd: 0.067, unit: "image" } as never, sort: 4 }),
  row({ id: "nano-banana-2", display_name: "Nano Banana 2", kind: "image", provider: "google",
        modes: ["t2i", "edit"], enabled: false,
        capabilities: { blocked: "needs a GEMINI_API_KEY" }, sort: 5 }),
];

/** Three stale blocks, one of them chained off another — which is the case the
 *  review popup exists to SAY out loud: b8 opens on b7's final frame, so
 *  checking b8 and not b7 continues from the take b7 is about to replace, and
 *  the popup has to offer to close that gap rather than silently doing it.
 *
 *  Fixtures rather than a query for the same reason the model rows above are:
 *  the popup's claims are all layout claims — that the plan text is readable at
 *  this width, that a chain gap reads as a warning and not as an error, that
 *  "nothing selected" disables the button rather than queueing nothing — and
 *  every one of them is behind a sign-in, an episode and a plan that has
 *  actually drifted. */
const STALE_BLOCKS: BlockIndexRow[] = [
  { id: "blk-3", idx: 2, t_start_ms: 12_000, t_end_ms: 23_750, status: "stale",
    scene_id: "sc-1", scene_label: "S1 ROOFTOP-DUSK", chain_from_block_id: null },
  { id: "blk-7", idx: 6, t_start_ms: 61_500, t_end_ms: 74_000, status: "stale",
    scene_id: "sc-2", scene_label: "S2 THE-PRESS", chain_from_block_id: null },
  { id: "blk-8", idx: 7, t_start_ms: 74_000, t_end_ms: 87_250, status: "stale",
    scene_id: "sc-2", scene_label: "S2 THE-PRESS", chain_from_block_id: "blk-7" },
];

const STALE_DETAIL = new Map<string, BlockPlanDetail>([
  ["blk-3", {
    scenes: [{ id: "sc-1", idx: 0, slug: "ROOFTOP-DUSK" }],
    beats: [
      { id: "bt-1", scene_id: "sc-1", idx: 0, lines: 0, camera: "a slow push in on the stairwell door",
        action: "Aki shoulders the door open and stops dead — the tarp is gone and the whole roof is bare." },
      { id: "bt-2", scene_id: "sc-1", idx: 1, lines: 2, camera: "a medium two-shot at eye level",
        action: "Haru does not turn around. He keeps folding the sheet, corner over corner, until it is small enough to hold in one hand." },
    ],
  }],
  ["blk-7", {
    scenes: [{ id: "sc-2", idx: 1, slug: "THE-PRESS" }],
    beats: [
      { id: "bt-9", scene_id: "sc-2", idx: 0, lines: 1, camera: "a close-up on the platen",
        action: "She drives the lever down and the press takes her weight; the sheet comes away with the type biting clean through it." },
    ],
  }],
  ["blk-8", {
    scenes: [{ id: "sc-2", idx: 1, slug: "THE-PRESS" }],
    beats: [
      { id: "bt-11", scene_id: "sc-2", idx: 1, lines: 0, camera: "holding the wide",
        action: "The stack tips. Paper goes everywhere and she does not move to catch any of it." },
      { id: "bt-12", scene_id: "sc-2", idx: 2, lines: 3, camera: "an over-the-shoulder onto the doorway",
        action: "Only after the last sheet has settled does she look up at whoever is standing in the doorway." },
    ],
  }],
]);

/** What the chip shows once the menu is shut. The dock trims the vendor
 *  prefix off the catalog's own name for the same reason: 176px of chip has
 *  to carry a label, a value and a caret. */
const shortName = (m?: ModelCatalogRow) =>
  (m?.display_name ?? "—").replace(/^MiniMax\s+/i, "").replace(/\s+image\b/i, "");

const tierFor = (rows: ModelCatalogRow[], id: string) => {
  const m = rows.find((r) => r.id === id);
  return m ? tierOf(m) : null;
};


/** Two turns as `chat_messages` rows: what the user asked, and a reply that
 *  ran two tools, queued a render and carries the journal of what it wrote —
 *  which is what makes the Revert button appear. */
const DEMO_MESSAGES = [
  {
    id: "u1", thread_id: "t", role: "user", streaming: false,
    tokens_in: null, tokens_out: null, cost_usd: null, job_id: null, created_at: "",
    content: [{ type: "text", text: "Change nothing else in block three." }],
  },
  {
    id: "a1", thread_id: "t", role: "assistant", streaming: false,
    tokens_in: null, tokens_out: null, cost_usd: null, job_id: null, created_at: "",
    content: [
      { type: "tool_use", name: "update_beat" },
      { type: "tool_result", name: "update_beat", result: { beat_id: "bt-3" } },
      { type: "tool_use", name: "rerender_block" },
      { type: "tool_result", name: "rerender_block", result: { job_id: "43ac0d07-0000-4000-8000-000000000000" } },
      { type: "changes", ops: [
        { op: "update", table: "beats", keys: ["action"], before: [{ id: "bt-3", action: "She turns." }] },
        { op: "insert", table: "jobs", id: "43ac0d07-0000-4000-8000-000000000000" },
        { op: "update", table: "generation_blocks", keys: ["status"], before: [{ id: "blk-3", status: "generated" }] },
      ] },
      { type: "text", text: "Updated **b6** with the new sequence — replacement render queued from b5's final frame." },
    ],
  },
  // A turn nothing answered — the state a reload leaves behind, and the one
  // the per-message Retry exists for. Its pictures render from the row, which
  // is the same fact that makes the turn re-runnable.
  {
    id: "u2", thread_id: "t", role: "user", streaming: false,
    tokens_in: null, tokens_out: null, cost_usd: null, job_id: null, created_at: "",
    content: [
      { type: "text", text: "regenerate this block, it should be a continuation of the previous one." },
      { type: "asset_ref", asset_id: "as-1", b2_key: "demo/portal.png", media: "image", label: "portal" },
      { type: "asset_ref", asset_id: "as-2", b2_key: "demo/impact.png", media: "image", label: "impact" },
    ],
  },
] as const;

export default function DirectorChromeDemo() {
  /** the journal of the reply whose Revert was pressed, while its dialog is up */
  const [revertOps, setRevertOps] = React.useState<Record<string, unknown>[] | null>(null);
  const [retried, setRetried] = React.useState(0);
  const [stale, setStale] = React.useState(3);
  const [review, setReview] = React.useState(false);
  const [video, setVideo] = React.useState("h3-turbo-local");
  const [image, setImage] = React.useState("h3-image-turbo-local");
  const [quality, setQuality] = React.useState<Quality>("low");
  // A backend ID now, not a display name — the real menu picks by id and
  // `backendLabel` is what turns it back into words for the chip.
  const [llm, setLlm] = React.useState("claude-api");
  const [draft, setDraft] = React.useState("");
  // The same grow-with-content the dock does. Worth reproducing rather than
  // leaving to the dock: the two-row composer exists FOR the paragraph-length
  // brief, and a harness that only ever shows one line cannot show why.
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(184, Math.max(20, el.scrollHeight))}px`;
  }, [draft]);
  return (
    <div style={{ padding: 28, display: "flex", gap: 24, alignItems: "flex-start" }}>
      {/* The rail's own frame. Width is pinned to the handoff's 380px design
          width rather than inherited, so the harness shows the same panel on
          any window — the dock itself narrows to 320px under 1440px, which is
          the app's layout speaking and not the design. */}
      <aside className="ws-dock" style={{ width: 380, height: 560, borderRadius: 8, overflow: "hidden" }}>
        <div className="ws-dock-head">
          <div className="ws-dock-id">
            <span className="ws-avatar"><Sparkles size={17} /></span>
            <div className="ws-dock-who">
              <div className="ws-dock-t">Creative Director</div>
              <div className="ws-dock-s">Rooftop pass · RAG on</div>
            </div>
            <DockIconBtn title="New chat"><Plus size={15} /></DockIconBtn>
            <DockIconBtn title="History"><History size={15} /></DockIconBtn>
            <DockIconBtn title="Collapse the director"><ChevronRight size={15} /></DockIconBtn>
          </div>
          <div className="ws-dock-models">
            <Dropdown width={310} align="left"
              trigger={({ toggle }) => <ModelChip kind="video" onClick={toggle}
                            value={shortName(VIDEO_MODELS.find((m) => m.id === video))}
                            tier={tierFor(VIDEO_MODELS, video)} />}>
              {(close) => (
                <TieredModelMenu models={VIDEO_MODELS} value={video} close={close}
                                 onPick={setVideo} />
              )}
            </Dropdown>
            <Dropdown width={310} align="right"
              trigger={({ toggle }) => <ModelChip kind="image" onClick={toggle}
                            value={shortName(IMAGE_MODELS.find((m) => m.id === image))}
                            tier={tierFor(IMAGE_MODELS, image)} />}>
              {(close) => (
                <TieredModelMenu models={IMAGE_MODELS} value={image} close={close}
                                 onPick={setImage} quality={quality} onQuality={setQuality} />
              )}
            </Dropdown>
          </div>
        </div>

        <div className="ws-thread ns-scroll">
          {/* THE REAL TRANSCRIPT ENTRY over fixture rows, not markup that
              looks like one: the per-reply actions (copy, and revert on a
              turn that wrote something) are part of the component, and a
              hand-built .ws-amsg would go on showing a transcript with no
              actions on the one screen meant for reviewing this chrome. */}
          {DEMO_MESSAGES.map((m, i) => (
            <DirectorMsg key={m.id} m={m}
                         onOpenAsset={() => {}} onOpenBlock={() => {}} onPickChoice={() => {}}
                         onRevert={setRevertOps}
                         onRetry={i === DEMO_MESSAGES.length - 1
                           ? () => setRetried((n) => n + 1) : undefined} />
          ))}
        </div>
        {revertOps && (
          <RevertTurnDialog ops={revertOps} threadId={null} messageId="a1" isLast
                            onCancel={() => setRevertOps(null)}
                            onRestore={() => setRetried((n) => n + 1)}
                            onDone={() => setRevertOps(null)} />
        )}

        {/* The failure state, with the one thing that gets the turn back. The
            words and the pictures are held, so this is a click rather than
            retyping the brief and finding the reference again. */}
        <ErrorRow message="rate limited — try again in a moment"
                  onRetry={() => setRetried((n) => n + 1)} />
        {retried > 0 && (
          <div className="ws-tool-row" style={{ color: "#8fc2ff" }}>
            retried {retried}x — the dock re-runs the held turn here
          </div>
        )}

        <StaleNotice count={stale} seconds={23} onReview={() => setReview(true)} />

        {review && (
          <StaleBlocksModal
            blocks={STALE_BLOCKS.slice(0, Math.max(1, stale))}
            onClose={() => setReview(false)}
            onQueued={() => { setStale(0); setReview(false); }}
            loadDetail={async () => STALE_DETAIL}
            // The harness must not be able to spend GPU time: these block ids
            // are fixtures, so the real queue would write `master_pass` rows
            // against blocks that do not exist.
            queue={async (chosen) => ({ queued: chosen.map((b) => `demo-${b.id}`), failed: 0 })}
          />
        )}

        <div className="ws-composer">
          <textarea ref={inputRef} rows={1} className="ws-compose-in ns-scroll" value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Direct me…  (⇧↵ for a new line · drop or paste media)" />
          <div className="row">
            <button className="ws-cbtn" title="Attach"><Paperclip size={14} /></button>
            <Dropdown width={312} align="left"
              trigger={({ toggle }) => (
                <LlmChip model={backendShort(llm)} level={backendTierLabel(llm)} onClick={toggle} />
              )}>
              {/* THE REAL MENU, not a stub of it. The two model pickers above
                  have always been the real `TieredModelMenu`, and this one was
                  four hardcoded names — so the harness went on showing a flat
                  list of model names for a picker that had grown tiers, blocked
                  states and a keys button, and the one screen meant for
                  reviewing this chrome was the last place to see it. */}
              {(close) => <BackendMenu value={llm} onPick={setLlm} close={close} />}
            </Dropdown>
            <span className="sp" />
            <button className="ws-cbtn mic" title="Push-to-talk"><Mic size={14} /></button>
            <button className="ws-cbtn send" disabled={!draft.trim()} title="Send"><Send size={14} /></button>
          </div>
        </div>
      </aside>

      <div style={{ font: "12px/1.7 ui-monospace, Menlo, monospace", color: "#8892a6", maxWidth: 320 }}>
        <p style={{ marginTop: 0 }}>
          Creative Director panel — design handoff option 2b, at the 380px design width.
        </p>
        <p>
          Render models (video, image) at the top; the LLM that answers the message at the
          bottom, next to the message.
        </p>
        <p>
          <button className="ws-microbtn" onClick={() => setStale((n) => (n ? 0 : 3))}>
            toggle the stale notice
          </button>
          {" "}
          {/* The real dock does NOT show this today: `STALE_UI` is off (see
              lib/staleBlocks), so `staleBlocks` is empty there and the bar
              hides itself at zero. It stays reviewable here because the
              component is still wired and one flag brings it back. */}
          <span style={{ opacity: 0.7 }}>
            — off in the app while <code>STALE_UI</code> is false; kept here so the
            component stays reviewable
          </span>
        </p>
      </div>
    </div>
  );
}
