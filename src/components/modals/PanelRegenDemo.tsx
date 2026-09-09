// PanelRegenModal on its own, for /ui/panel.
//
// Reaching the real one means signing in, opening a project, planning an
// episode and drawing a storyboard — a credential a test should not hold and a
// path an agent should not click through on someone's behalf. What is worth
// looking at is a picture either way: this modal grew from a single-column form
// into the two-column `pr-` shell PromptRefsModal uses, PORTALLED, and a
// portalled `position: fixed` scrim opening inside a `backdrop-filter`ed modal
// is the bug this harness already exists to catch once.
//
// What is live here and what is not, stated rather than implied:
//   * The layout, both intent tabs, the blockers, the copy, the seed and rolls
//     controls and the footer summary are all real — they come from props and
//     from `panelRetake.ts`, neither of which touches the network.
//   * The BEAT query comes back empty (no session), so the alternates rail
//     shows its own empty state. Same deal as the queue popover's jobs half.
//   * The PICTURES are absent: `assetUrl` points at the B2 bucket and these
//     ids are invented, so the tiles render as their empty boxes. That is the
//     layout, minus the photographs.
import React, { useState } from "react";
import PanelRegenModal from "./PanelRegenModal";
import { primeCatalog } from "../../lib/catalog";
import type { Asset, ModelCatalogRow } from "../../lib/db/types";

// One row that can rework a picture and one that cannot, because the whole
// point of the screen is the difference between the two intents — and Edit is
// gated on `modes` carrying "edit".
const MODELS = [
  {
    id: "krea2-local", family: "krea2", display_name: "Krea 2", kind: "image",
    provider: "local", modes: ["t2i", "r2i"], enabled: true,
    capabilities: { multiRef: 4 }, sizes: [], pricing: {}, sort: 1,
  },
  {
    id: "qwen-edit-local", family: "qwen", display_name: "Qwen-Image-Edit 2511",
    kind: "image", provider: "local", modes: ["t2i", "r2i", "edit"], enabled: true,
    capabilities: { multiRef: 3 }, sizes: [], pricing: {}, sort: 2,
  },
  // The third state: a model that edits, but only ONE picture at a time
  // (`edit_one = editing and len(ref_names) == 1`). Adding a reference there
  // drops the render back to a compose and says so nowhere but the pod's
  // journal — so the modal warns, and this row is what makes that reviewable.
  {
    id: "h3-image-local", family: "minimax-h3", display_name: "MiniMax H3 · image",
    kind: "image", provider: "local", modes: ["t2i", "r2i", "edit"], enabled: true,
    capabilities: { multiRef: 9 }, sizes: [], pricing: {}, sort: 3,
  },
] as unknown as ModelCatalogRow[];

// A HOSTED row too: the tier grouping and the per-row quality picker only
// exist on one, and neither is reviewable against a list of pod models.
MODELS.push({
  id: "gpt-image-2", family: "gpt-image", display_name: "GPT Image 2",
  kind: "image", provider: "openai", modes: ["t2i", "edit"], enabled: true,
  capabilities: { multiRef: 8, edit: true },
  sizes: [], pricing: { unit: "image", usd: 0.06 }, sort: 9,
} as never);

primeCatalog(MODELS);

const fake = (id: string, meta: Record<string, unknown> = {}): Asset => ({
  id, project_id: "demo", kind: "image", b2_key: `demo/${id}.png`,
  content_type: "image/png", bytes: 0, width: 1280, height: 704, duration_ms: null,
  fps: null, origin: "generated", source_job_id: null, tags: [],
  created_at: new Date().toISOString(), meta,
});

const PROMPT = `[STYLE] anime, 2D-animated, cel shading, flat colour.
[FRAMING] extreme close-up — the subject fills the frame edge to edge.
[SHOT] Astronaut Rei presses her gloved hand against the crystallization
lattice, pushing in slowly as the facets bloom outward.
[LOCKED CHARACTER] Astronaut Rei — dark shoulder-length wavy hair with a cyan
streak, gray-blue eyes, orange one-piece jumpsuit with a black neck.
[LOCKED LOCATION] Alternate City — glass towers, suspended traffic.
[REFERENCES] identity and design only; framing is not taken from them.`;

export default function PanelRegenDemo() {
  const [open, setOpen] = useState(true);
  const q = new URLSearchParams(window.location.search);
  // `?seed=none` is the picture that recorded no seed — the one case where
  // "hold this panel's" has nothing to hold and must say so rather than
  // inventing a number and calling it the panel's.
  const withSeed = q.get("seed") !== "none";
  const asset = fake("panel-1", {
    prompt: PROMPT, model: "krea2", ...(withSeed ? { seed: 8412 } : {}),
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "#070910" }}>
      {!open && (
        <button className="ws-pillbtn" style={{ height: 28, margin: 20 }}
                onClick={() => setOpen(true)}>Redraw…</button>
      )}
      {open && (
        <PanelRegenModal
          asset={asset} prompt={PROMPT}
          refs={[fake("ref-face"), fake("ref-face-2"), fake("ref-loc")]}
          beatId="beat-1" projectId="demo" label="CITY_CAPTURE_1 b3 · panel"
          onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
