// The BYOK key set and the models it turns on, as React sees them.
//
// `useSyncExternalStore` over the module-level store in `lib/byok.ts`, for the
// reason `useLocalEngine` is shared: the keys tab, the composer, the timeline's
// extend modal and the director's backend list all ask at once, and a probe per
// consumer is a keychain probe per consumer — which on macOS is the call that
// can prompt.
//
// THE SNAPSHOT MUST BE A STABLE REFERENCE. `byokSnapshot()` returns the stored
// object and every write REPLACES it; building one on read makes the store look
// changed on every render, which is the render/read/render loop that blanked
// the storage sheet.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  byokSnapshot, keyedProviders, refreshByok, subscribeByok, type ByokState,
} from "../lib/byok";
import {
  byokOfferRows, byokRows, type ByokConfig,
} from "../lib/byokCatalog";
import { providersFor, type ByokUnlock } from "../lib/byokProviders";
import { isDesktop } from "../lib/desktop";
import type { ModelCatalogRow } from "../lib/db/types";

export interface Byok {
  keys: ByokState["keys"];
  config: ByokConfig;
  /** false until the first probe lands — "no keys" and "not asked" differ */
  loaded: boolean;
  /** providers with a key on this machine */
  keyed: Set<string>;
  has: (provider: string) => boolean;
  /** does any stored key unlock this capability */
  can: (u: ByokUnlock) => boolean;
  reload: () => void;
}

export function useByok(): Byok {
  const s = useSyncExternalStore(subscribeByok, byokSnapshot, byokSnapshot);
  useEffect(() => { void refreshByok(); }, []);
  const keyed = useMemo(() => keyedProviders(s), [s]);
  return {
    keys: s.keys,
    config: s.config,
    loaded: s.loaded,
    keyed,
    has: (p) => keyed.has(p),
    can: (u) => providersFor(u).some((p) => keyed.has(p.id)),
    reload: () => void refreshByok(),
  };
}

/**
 * The hosted rows a picker should show, given the catalog it already loaded.
 *
 * Safe to concatenate unconditionally — the same shape `useLocalEngine().rows`
 * has, and for the same reason: a picker should not have to ask which build it
 * is running in before it can build a list.
 *
 * IT IS NEVER EMPTY, and the older note here saying it returns [] in the
 * browser stopped being true the day offers landed. A machine with no keys
 * still gets one OFFER row per model (`byokOfferRows`), because a picker with
 * no hosted section reads as a build that cannot do hosted work at all when it
 * is one paste away — and the row is the only place that names which key to
 * add. The picker renders those disabled, with a button onto the keys screen.
 *
 * A TAB GETS THEM TOO AND CANNOT TAKE THEM, which is why the build is named
 * here: a key lives in this machine's keychain behind Rust, so on the web the
 * row says where the key goes and carries no button at all. Listing nothing
 * there would be the worse answer — the models are the account's, and the
 * desktop app is where they are reachable.
 *
 * ONE PLACE, for every picker in the app: GenComposer, the timeline's
 * extend/chain modal and `useMarkedCatalog` (which is what the wizard's sheets
 * step, project settings and the new-project form read) are the three
 * consumers, so a rule any one of them applied for itself would be a rule the
 * other two forgot.
 */
export function useByokRows(catalog: ModelCatalogRow[] | null | undefined): ModelCatalogRow[] {
  const { keyed, config } = useByok();
  return useMemo(
    () => (catalog?.length
      ? [...byokRows(catalog, keyed, config),
         // THE ONE CALLER, so the one place the build has to be named. An
         // offer in a tab is an offer nobody can take — see `byokOfferRows`.
         ...byokOfferRows(catalog, keyed, { desktop: isDesktop() })]
      : []),
    [catalog, keyed, config],
  );
}
