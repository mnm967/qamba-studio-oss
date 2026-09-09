// `/ui/blockaudio` — the "Change the audio" modal against fixtures.
//
// Here for the reason `panel` and `render` are, plus one of its own: this
// screen's two riskiest claims are pictures. A take tile has to be sized to the
// RENDER (a 9:16 take under `object-fit: cover` shows the middle third of the
// shot and still looks like a shot), and the negative-prompt field has to be
// ABSENT — not disabled — on a row whose cfg cannot evaluate one. Neither is
// observable from an assertion about state.
//
// It reads no Supabase and CANNOT QUEUE: `enqueue` is stubbed, because a review
// screen that spends GPU time by being opened is the failure StaleBlocksModal's
// own harness seam exists to prevent. Its fixture media are the two real assets
// the timeline demo already ships, so the tiles show actual frames.
import React, { useState } from "react";
import BlockAudioModal, { type BlockAudioData } from "./BlockAudioModal";
import type { ModelCatalogRow } from "../../lib/db/types";

const MODEL = {
  id: "mmaudio-large-44k-v2-local",
  family: "mmaudio",
  display_name: "MMAudio · Large 44k v2",
  kind: "audio",
  provider: "local",
  enabled: true,
  sort: 48,
  modes: ["v2a"],
  max_seconds: 30,
  pricing: {},
  capabilities: {
    steps: 25, cfg: 4.5, negativePrompt: true, syncFps: 25, trainedSeconds: 8,
    video2audio: true,
    note: "Scores a silent clip: it watches the frames and writes a synchronised soundtrack.",
  },
} as unknown as ModelCatalogRow;

/** A distilled twin that samples at cfg 1. Nothing declares this today — it is
 *  here so the "the negative field is ABSENT, not disabled" claim can be seen
 *  rather than argued about. */
const DISTILLED = {
  ...MODEL, id: "mmaudio-distilled-demo", display_name: "MMAudio · Distilled (demo)",
  capabilities: { ...(MODEL.capabilities as object), cfg: 1, steps: 4 },
} as unknown as ModelCatalogRow;

const asset = (id: string, key: string, w: number, h: number, ms: number) => ({
  id, b2_key: key, kind: "video", width: w, height: h, duration_ms: ms,
  created_at: new Date(0).toISOString(), meta: {},
});

/** Landscape and PORTRAIT side by side, on purpose: the tile is sized to the
 *  render, and a fixture set that is all 16:9 cannot show that. */
const FIXTURES: Record<string, BlockAudioData> = {
  default: {
    block: { id: "b1", idx: 0, active_take_id: "t2", storyboard_id: "s1" } as never,
    takes: [
      { take: { id: "t3", kind: "audio", asset_id: "a3" } as never,
        asset: asset("a3", "demo/portrait.mp4", 736, 1280, 8000) as never },
      { take: { id: "t2", kind: "master", asset_id: "a2" } as never,
        asset: asset("a2", "demo/wide.mp4", 1280, 704, 8000) as never },
      { take: { id: "t1", kind: "master", asset_id: "a1" } as never,
        asset: asset("a1", "demo/wide2.mp4", 1280, 736, 14500) as never },
    ],
    projectId: "p1", episodeId: "e1", models: [MODEL, DISTILLED],
  },
  /** A block that has never rendered — the honest refusal rather than an empty
   *  strip that looks like a loading state. */
  empty: {
    block: { id: "b1", idx: 3, active_take_id: null, storyboard_id: "s1" } as never,
    takes: [], projectId: "p1", episodeId: "e1", models: [MODEL],
  },
};

/** ONE MODEL, which is what production looks like — and the only way the
 * desktop states are visible at all.
 *
 * `default` carries a second, deliberately un-markable row (the distilled
 * twin), and `usable[0]` then falls back to it the moment MMAudio is blocked
 * — so the sentence under the picker, the whole point of the state, never
 * appears. The marks themselves come from the MOCK BRIDGE rather than being
 * written here, because what is under review is the live path:
 *
 *   ?engine=running&mmaudio=1       renders here
 *   ?engine=absent                  offer — download it
 *   ?engine=installed&mmaudio=1     blocked — start the engine
 *   ?engine=running&mmaudio=broken  blocked — a pack would not install
 */
FIXTURES.solo = { ...FIXTURES.default, models: [MODEL] };

export default function BlockAudioDemo() {
  const which = new URLSearchParams(location.search).get("fixture") ?? "default";
  const [queued, setQueued] = useState<unknown[]>([]);
  const data = FIXTURES[which] ?? FIXTURES.default;
  return (
    <div style={{ minHeight: "100vh", background: "#0b0e14" }}>
      <BlockAudioModal
        blockId="b1"
        load={async () => data}
        enqueue={(async (job: unknown) => {
          // Records rather than queues. The payload is printed so the shape
          // this modal sends can be read off the screen.
          setQueued((q) => [...q, job]);
          return { id: "demo" } as never;
        }) as never}
      />
      {!!queued.length && (
        <pre data-testid="queued" style={{
          position: "fixed", left: 12, bottom: 12, right: 12, maxHeight: "26vh",
          overflow: "auto", zIndex: 9999, margin: 0, padding: 10,
          background: "#05070c", border: "1px solid #2a3242", borderRadius: 8,
          color: "#8fc2ff", font: "400 11px/1.5 ui-monospace, monospace",
        }}>{JSON.stringify(queued, null, 1)}</pre>
      )}
    </div>
  );
}
