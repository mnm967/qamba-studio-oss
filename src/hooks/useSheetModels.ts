// The catalogue as THIS MACHINE sees it, and the narrower list a REFERENCE
// SHEET can be drawn with.
//
// `useMarkedCatalog` is the base every surface that writes `image_model` /
// `video_model` builds on: the catalogue, with a row a key of yours re-enables
// swapped in, and with the image rows this machine's own pipeline can render
// marked onto the local tier. Shared because those surfaces already state the
// rule for themselves — they write the same fields, so one of them offering a
// plane the others cannot name is a picker showing a raw `local:…` id back.
//
// `useSheetModels` is that list minus the `local:` ids, and the difference is
// the point. Those render through `localGraphs` in TypeScript, which renders a
// PROMPT — right for the composer's one-off still. A plan's sheets are
// composed for the family finally chosen and hang on late-bound `anchors` that
// resolve only once the sheet they anchor to exists, and `handlers/images.py`
// is the only implementation of either. This machine runs it (`plan_cli.KINDS`
// carries `image_gen`) against `model_map.desktop.json`, so the local option
// for a SHEET is the catalogue row that map carries. One row per model either
// way, and the one that appears is the one that can actually draw the sheet.
import { useMemo } from "react";
import { useByokRows } from "./useByok";
import { useLocalEngine } from "./useLocalEngine";
import { markDesktopImageRows } from "../lib/desktopRows";
import { isLocalId } from "../lib/localModels";
import { modelKeyOf } from "../lib/projectSettings";
import type { ModelCatalogRow } from "../lib/db/types";

export function useMarkedCatalog(
  catalog: ModelCatalogRow[] | null | undefined,
): ModelCatalogRow[] {
  const byok = useByokRows(catalog);
  const engine = useLocalEngine();
  return useMemo(
    () => markDesktopImageRows(
      // A row a key of yours re-enables REPLACES the catalogue's copy rather
      // than sitting beside it — `byokRows` hands back the same row with its
      // `enabled` and its tier changed, so keeping both would list one model
      // twice with nothing to tell the copies apart.
      [...(catalog ?? []).filter((m) => !byok.some((b) => b.id === m.id)), ...byok],
      engine.imageModels,
      // WEIGHTS ON DISK IS NOT AVAILABILITY. The video picker has passed these
      // since it grew `WizardChoice.packs`; without them here an image row
      // whose graph needs a custom node reads READY off the model map and
      // every sheet of the episode dies inside ComfyUI on a missing node.
      { planner: engine.planner, engineUp: engine.running,
        nodes: engine.status?.nodes ?? null,
        nodesBroken: engine.status?.nodes_broken ?? null },
      modelKeyOf),
    [catalog, byok, engine.imageModels, engine.planner, engine.running,
     engine.status?.nodes, engine.status?.nodes_broken]);
}

/**
 * @param current the id in the field right now. A `local:` one is kept even
 *   though this list otherwise drops them — it is the value in use, set on a
 *   surface whose list is wider, and a picker that cannot name its own value
 *   renders the raw id back at you.
 */
export function useSheetModels(
  catalog: ModelCatalogRow[] | null | undefined,
  current?: string | null,
  localRows: ModelCatalogRow[] = [],
): ModelCatalogRow[] {
  const all = useMarkedCatalog(catalog);
  return useMemo(() => {
    const rows = all.filter((m) => m.kind === "image");
    const mine = isLocalId(current) && localRows.find((m) => m.id === current);
    return mine ? [...rows, mine] : rows;
  }, [all, current, localRows]);
}
