/**
 * `ownedOnly`'s owner scope, pinned by parsing its source.
 *
 * `db/assets.ts` imports the Supabase client at module scope, so `node --test`
 * cannot load it — the situation `scoreTrack.test.ts` and `audioGraph.test.ts`
 * are already in, and the same answer: read the decision's own text.
 *
 * The property below has now been broken TWICE, both times silently, and both
 * times in the same shape — a local project's rows compared against an id that
 * is not on them:
 *
 *   * against the SESSION uid, which emptied the library the moment nobody was
 *     signed in (the mode whose whole point is working without the cloud);
 *   * against THIS INSTALL's id, which emptied it for a project PULLED from
 *     the cloud, because `fromSnapshot` copies each row's `owner_id` down
 *     verbatim and those rows carry the cloud account's uuid. Measured on one
 *     such project: 1,298 of 1,304 assets hidden from every kind facet and
 *     every sidebar tally, over a grid that was showing all 1,268 of them
 *     under "This project" — the one row scoped by project rather than owner.
 *
 * Neither failure raises. The library simply reports zero, which reads as the
 * app not classifying the files rather than as a filter excluding them.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// Normalised to LF before anything indexes into it: git's default on Windows
// is core.autocrlf=true, and a regex `.` does not match `\r` — which is how a
// source-parsing test comes back reporting "found 0" instead of failing.
const SRC = readFileSync(new URL("./assets.ts", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

function body(signature: string): string {
  const at = SRC.indexOf(signature);
  assert.ok(at > 0, `${signature} is gone — did it move or get renamed?`);
  const end = SRC.indexOf("\n}\n", at);
  assert.ok(end > at, `could not find the end of ${signature}`);
  return SRC.slice(at, end);
}

test("a local project filters by NO owner id at all", () => {
  const fn = body("async function ownerScope");
  assert.match(
    fn, /planeIsLocal\(\)[\s\S]{0,40}by: "all"/,
    "the local plane must resolve to the unfiltered scope — a local store is "
    + "one project, all of it on this machine, so there is nothing to exclude");
});

test("the INSTALL's own id never reaches the filter", () => {
  // `planeOwnerId()` is a real and correct function — it is what a local row is
  // WRITTEN with. It is simply not what a pulled row carries, so using it here
  // is the second failure above.
  assert.equal(
    SRC.includes("planeOwnerId"), false,
    "planeOwnerId is back in db/assets.ts — a pulled project's rows carry the "
    + "cloud account's owner_id, so filtering on the install id hides them");
});

test("signed out on the CLOUD plane still means nothing is mine", () => {
  const fn = body("async function ownerScope");
  assert.match(fn, /by: "none"/,
    "the signed-out cloud case must stay distinct from 'do not filter', or a "
    + "collaborator's shared files land in a personal library that has none");
  for (const sig of ["export async function loadAssets", "export async function loadAssetCounts"]) {
    assert.match(body(sig), /owner\.by === "none"/,
      `${sig} must refuse the 'none' scope rather than querying unfiltered`);
  }
});

test("both consumers apply an owner filter only for a real uid", () => {
  const load = body("export async function loadAssets");
  assert.match(load, /owner\.by === "uid"[\s\S]{0,80}\.eq\("owner_id", owner\.uid\)/,
    "loadAssets must guard its owner_id filter on the uid scope");

  const counts = body("export async function loadAssetCounts");
  assert.match(counts, /p_owner: owner\.by === "uid" \? owner\.uid : null/,
    "asset_counts must be passed a null p_owner for every non-uid scope — the "
    + "SQL reads `(p_owner is null or owner_id = p_owner)`, so null is what "
    + "'count every owner' is spelled as");
});
