// The hub's LoRAs, offered on a POD-CATALOGUE video row.
//
// `localModels` already does this for `local:` rows, which is what the
// composer picks from. An EPISODE is chosen from the CATALOGUE rows instead
// (the wizard, project settings, the context panel), and those carry only the
// studio's own adapters — pruned to nothing in the desktop model map. See
// `withDesktopVideoLoras` for why this needs no worker change.
//
// A hook rather than three call sites doing it themselves: each of them has to
// know the engine's file list, the registry and the model_map key, and a rule
// spelled out three times is one that is wrong in the third place.
import { useMemo } from "react";
import { useLocalEngine } from "./useLocalEngine";
import { allLocalLoras, withDesktopVideoLoras } from "../lib/localLoras";
import { modelKeyOf } from "../lib/projectSettings";
import type { ModelCatalogRow } from "../lib/db/types";

export function useVideoLoras(
  row: ModelCatalogRow | null | undefined,
): ModelCatalogRow | null | undefined {
  const engine = useLocalEngine();
  const files = engine.status?.files;
  return useMemo(() => {
    if (!engine.desktop || !row) return row;
    const have = new Set(files ?? []);
    if (!have.size) return row;
    return withDesktopVideoLoras(row, modelKeyOf(row.id), have, allLocalLoras());
    // `files` is a fresh array each poll; its LENGTH plus the row id is what
    // actually changes when a download lands, and re-wrapping on every poll
    // would hand the picker a new object 3 times a second.
  }, [engine.desktop, row, files?.length]);   // eslint-disable-line react-hooks/exhaustive-deps
}
