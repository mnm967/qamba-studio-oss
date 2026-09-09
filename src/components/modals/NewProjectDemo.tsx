// NewProjectModal on its own, for /ui/newproject.
//
// The real one is behind a sign-in, and its newest section is a claim only a
// picture can check: two model pickers have to sit in one row without pushing
// each other off it, the tier icon has to lead the SHUT control (a pod row and
// a hosted row are otherwise the same words and a different bill), and the
// local-storage warning has to appear against the DEFAULTS — which is the
// pairing this screen exists to show, because on the desktop both halves of it
// are chosen by nobody.
//
// What is live and what is not:
//   * Every control, the storage row, the warning and the create button are
//     real. `?desktop=` decides whether the storage picker renders at all.
//   * The catalog is PRIMED (`primeCatalog`), because `model_catalog_visible`
//     answers with nothing without a session — which is a real state, and not
//     the one you want to review a model-dependent layout in.
//   * Creating still runs `createProject`, which fails without a session (and
//     writes to the mocked local store on `?desktop=`). Nothing here spends
//     GPU time or money, which is the bar a review screen has to clear.
import React, { useEffect } from "react";
import NewProjectModal from "./NewProjectModal";
import { primeCatalog } from "../../lib/catalog";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import type { ModelCatalogRow } from "../../lib/db/types";

// One pod row and one hosted row per kind, because the tier GROUPING is the
// thing being looked at and a list of pod models cannot show it. The pod rows
// are the studio's real defaults — `krea2-local` and `h3-turbo-local` — so the
// warning this screen exists for fires without touching a control.
const MODELS = [
  { id: "krea2-local", family: "krea2", display_name: "Krea 2", kind: "image",
    provider: "local", modes: ["t2i", "r2i"], enabled: true,
    capabilities: { multiRef: 4, vramGb: 24 }, sizes: [], pricing: {}, sort: 1 },
  { id: "qwen-edit-local", family: "qwen", display_name: "Qwen-Image-Edit 2511",
    kind: "image", provider: "local", modes: ["t2i", "r2i", "edit"], enabled: true,
    capabilities: { multiRef: 3 }, sizes: [], pricing: {}, sort: 2 },
  // Enabled, hosted, and an IMAGE — so it is the one cloud-tier row a project
  // on this computer can still render (the `hosted` edge function), and the warning must
  // not name it.
  { id: "gpt-image-2", family: "gpt-image", display_name: "GPT Image 2",
    kind: "image", provider: "openai", modes: ["t2i", "edit"], enabled: true,
    capabilities: { multiRef: 8 }, sizes: [], pricing: {}, sort: 9 },
  { id: "h3-turbo-local", family: "minimax-h3", display_name: "MiniMax H3 · Turbo",
    kind: "video", provider: "local", modes: ["t2v", "i2v", "flf", "r2v"], enabled: true,
    capabilities: { multiRef: 9, vramGb: 40 }, sizes: [], pricing: {}, sort: 1 },
  { id: "ltx-25-local", family: "ltx", display_name: "LTX 2.5", kind: "video",
    provider: "local", modes: ["t2v", "r2v"], enabled: true,
    capabilities: { multiRef: 5 }, sizes: [], pricing: {}, sort: 2 },
  // A hosted VIDEO row: cloud-tier and NOT servable from here, so it is the
  // control that proves the warning is about the route rather than the tier.
  { id: "wan3-video", family: "wan3", display_name: "Wan 3.0", kind: "video",
    provider: "alibaba", modes: ["t2v", "i2v", "flf", "r2v"], enabled: false,
    capabilities: { blocked: "the studio has no alibaba key" },
    sizes: [], pricing: {}, sort: 8 },
] as unknown as ModelCatalogRow[];

primeCatalog(MODELS);

export default function NewProjectDemo() {
  const open = useWorkspaceStore((s) => s.openModal);
  useEffect(() => { open({ kind: "newProject" }); }, [open]);
  return <NewProjectModal />;
}
