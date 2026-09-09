// The cap this escapes is invisible from the client: PostgREST returns 1000
// rows for a `.limit(5000)` with no error and nothing in the body to say the
// list was cut, so every regression here looks like "there just isn't any
// more" — which is exactly how the library came to show 1,000 of 3,031 assets
// and report itself complete. The request PATTERN is therefore the thing worth
// pinning, not just the returned rows.
import assert from "node:assert/strict";
import test from "node:test";

import { ROW_CAP, pageThrough } from "./db/paging.ts";

/** A fake PostgREST table: records every range asked for, serves that slice,
 *  and — like the real one — never returns more than ROW_CAP rows at a time. */
function table(total: number) {
  const calls: [number, number][] = [];
  const build = () => ({
    range(from: number, to: number) {
      calls.push([from, to]);
      const want = Math.min(to - from + 1, ROW_CAP);
      const rows = [];
      for (let i = from; i < Math.min(from + want, total); i++) rows.push({ i });
      return Promise.resolve({ data: rows, error: null });
    },
  });
  return { build, calls };
}

test("a normal page is one request and costs nothing extra", async () => {
  const t = table(5000);
  const rows = await pageThrough<{ i: number }>(t.build, 160);
  assert.equal(rows.length, 160);
  assert.deepEqual(t.calls, [[0, 159]]);
});

test("asking past the cap keeps going instead of stopping at 1000", async () => {
  const t = table(3031);
  const rows = await pageThrough<{ i: number }>(t.build, 1120);
  assert.equal(rows.length, 1120);
  assert.deepEqual(t.calls, [[0, 999], [1000, 1119]]);
  // A contiguous prefix of the order, not two overlapping windows.
  assert.deepEqual(rows.map((r) => r.i).slice(0, 3), [0, 1, 2]);
  assert.equal(rows[1119].i, 1119);
});

test("exactly the cap does not cost a second, empty request", async () => {
  const t = table(3031);
  const rows = await pageThrough<{ i: number }>(t.build, ROW_CAP);
  assert.equal(rows.length, ROW_CAP);
  assert.deepEqual(t.calls, [[0, 999]]);
});

test("a short page ends it — that is how exhaustion is detected", async () => {
  const t = table(1200);
  const rows = await pageThrough<{ i: number }>(t.build, 4000);
  assert.equal(rows.length, 1200);
  // Second page came back short (200 of 1000 asked), so there is no third.
  assert.deepEqual(t.calls, [[0, 999], [1000, 1999]]);
});

test("an empty table is one request and no rows", async () => {
  const t = table(0);
  assert.deepEqual(await pageThrough(t.build, 160), []);
  assert.equal(t.calls.length, 1);
});

test("each page gets a FRESH builder — a PostgrestBuilder is single-use", async () => {
  let built = 0;
  const build = () => {
    built++;
    return {
      range: (from: number, to: number) =>
        Promise.resolve({ data: Array.from({ length: to - from + 1 }, (_, i) => ({ i })), error: null }),
    };
  };
  await pageThrough(build, 2500);
  assert.equal(built, 3);
});

test("an error is thrown, never silently returned as a short list", async () => {
  const build = () => ({
    range: () => Promise.resolve({ data: null, error: { message: "boom" } }),
  });
  // The raw PostgrestError propagates rather than an Error wrapping it — the
  // `if (error) throw error` convention every other function in db/ follows.
  // What matters is that it throws at all: swallowing it would return a short
  // list, which is indistinguishable from a list that simply ended.
  await assert.rejects(
    () => pageThrough(build, 160),
    (e: unknown) => (e as { message?: string })?.message === "boom",
  );
});
