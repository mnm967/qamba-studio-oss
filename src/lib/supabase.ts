// THE DATA CLIENT — and there is no Supabase behind it any more.
//
// This module keeps its name because twenty-odd modules import `{ supabase }`
// from it and call `.from(table)` / `.rpc(name, args)` — the PostgREST builder
// shape the app has always spoken. What answers those calls now is one of two
// planes, both on this machine:
//
//   * the LOCAL PLANE (lib/localPlane.ts): the open project's own rows, a JSON
//     file under the app's data directory, spoken through `localQuery.ts`'s
//     builder;
//   * the STUDIO PLANE (lib/studioPlane.ts): the bundled model catalogue,
//     this machine's render timings, and — with no project open — a read-only
//     union of every local project.
//
// `planeFrom` returns null unless a local project is open AND the table is
// part of a project, which is exactly the routing the cloud build used; the
// studio plane simply took the cloud's place as the fallback.
import "./storageMigrate";

import { planeFrom, planeMediaUrl, planeRpc } from "./planeRouter.ts";
import { studioFrom, studioRpc } from "./studioPlane.ts";
import type { LocalQueryBuilder, LocalResult } from "./localQuery.ts";

/**
 * THE RETURN TYPE IS DECLARED, and that is load-bearing rather than tidy.
 *
 * `planeFrom` is typed `any` — it hands back a builder from whichever plane
 * installed itself, and the router deliberately knows nothing about either —
 * so an inferred union with `studioFrom`'s collapses to `any`, and a `.map()`
 * on an `any` array is a callback with NO contextual type. That is
 * `noImplicitAny` at some thirty-five call sites, none of which is wrong.
 * Naming the builder here types every one of them at once.
 *
 * Written as an `if` rather than `??` for a second reason from the same
 * family: `any ?? x` narrows to `{}` in TypeScript 7, which turns every
 * `.select()` in the app into an error about a type nobody wrote.
 */
function routedFrom(table: string): LocalQueryBuilder {
  const open = planeFrom(table);
  if (open) return open as LocalQueryBuilder;
  return studioFrom(table);
}

function routedRpc(
  name: string, args?: Record<string, unknown>,
): PromiseLike<LocalResult<unknown>> {
  const open = planeRpc(name, args);
  if (open) return open as PromiseLike<LocalResult<unknown>>;
  return studioRpc(name, args);
}

export const supabase = { from: routedFrom, rpc: routedRpc };

/**
 * Where a media key is served from.
 *
 * A key held by a local project resolves to a file on this machine (over the
 * app's own loopback media server, or `asset://` on an older bridge). Every
 * media surface — the grid, the player, the filmstrip, the reference picker,
 * the timeline — goes through this function and none of them has to know.
 *
 * A key nothing on this machine holds answers null: there is no bucket to fall
 * through to. A `<video>` handed null renders nothing and the player's own
 * retry says so, which is the honest answer for a file that is not here.
 */
export function mediaUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  if (/^https?:\/\//.test(key)) return key;
  return planeMediaUrl(key);
}
