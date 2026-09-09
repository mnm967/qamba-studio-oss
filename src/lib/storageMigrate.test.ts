// The rename sweep is the one module whose failure is invisible and expensive:
// get it wrong and every signed-in browser is signed out, every wizard draft
// is gone, and nothing anywhere reports it. So the precedence rules are pinned
// here rather than argued about in the comment.
//
// The module has no exports — it runs on import — so each case installs its own
// fake `localStorage` and then imports the module under a distinct URL query,
// which is what gets past the ES module cache.
import { test } from "node:test";
import assert from "node:assert/strict";

function fakeStorage(seed: Record<string, string>) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    _dump: () => Object.fromEntries(map),
  };
}

let caseNo = 0;
async function sweep(seed: Record<string, string>) {
  const ls = fakeStorage(seed);
  (globalThis as Record<string, unknown>).window = { localStorage: ls };
  await import(`./storageMigrate.ts?case=${++caseNo}`);
  delete (globalThis as Record<string, unknown>).window;
  return ls._dump();
}

test("a browser last used before the FIRST rename still carries across", async () => {
  // The failure this guards: a chain that only handled yeuka.* -> qamba.*
  // would sign out everyone who has not opened the app since 2026-08-18.
  const out = await sweep({ "neon.auth": "session-A", "neon.civitai.token": "tok" });
  assert.equal(out["qamba.auth"], "session-A");
  assert.equal(out["qamba.civitai.token"], "tok");
  assert.equal(out["neon.auth"], undefined);
});

test("a browser on the previous name carries across", async () => {
  const out = await sweep({ "yeuka.auth": "session-B", "yeuka.ws": "{}" });
  assert.equal(out["qamba.auth"], "session-B");
  assert.equal(out["qamba.ws"], "{}");
  assert.equal(out["yeuka.auth"], undefined);
});

test("the NEWER prefix wins when both are present", async () => {
  // Order is the whole point: sweeping neon.* first would hand a stale session
  // precedence over the one the user actually last used.
  const out = await sweep({ "neon.auth": "stale", "yeuka.auth": "current" });
  assert.equal(out["qamba.auth"], "current");
});

test("a value this build already wrote is never overwritten", async () => {
  const out = await sweep({ "qamba.auth": "live", "yeuka.auth": "old", "neon.auth": "older" });
  assert.equal(out["qamba.auth"], "live");
  assert.equal(out["yeuka.auth"], undefined);
  assert.equal(out["neon.auth"], undefined);
});

test("dynamic per-project/per-thread keys are swept, not just the fixed ones", async () => {
  // A list of known names would silently miss every draft anyone had open.
  const out = await sweep({
    "yeuka.draft.chat.proj-1.thread-9": "half a message",
    "yeuka.draft.wizard_page.proj-1": "{}",
    "yeuka.timeline.last": "cut-3",
  });
  assert.equal(out["qamba.draft.chat.proj-1.thread-9"], "half a message");
  assert.equal(out["qamba.draft.wizard_page.proj-1"], "{}");
  assert.equal(out["qamba.timeline.last"], "cut-3");
});

test("it marks itself done and clears the older markers", async () => {
  const out = await sweep({ "yeuka.migrated.v1": "2", "yeuka.auth": "s" });
  assert.equal(out["qamba.migrated.v2"], "1");        // one key actually moved
  assert.equal(out["yeuka.migrated.v1"], undefined);  // not carried forward
  assert.equal(out["qamba.migrated.v1"], undefined);  // and not re-keyed either
});

test("it does not run twice", async () => {
  // Re-running would resurrect keys the user has since deleted.
  const out = await sweep({ "qamba.migrated.v2": "0", "yeuka.auth": "untouched" });
  assert.equal(out["yeuka.auth"], "untouched");
  assert.equal(out["qamba.auth"], undefined);
});

test("no storage at all is survivable", async () => {
  // A privacy-blocked browser throws on access; a rename must not be the
  // reason the app fails to boot.
  (globalThis as Record<string, unknown>).window = {
    get localStorage(): Storage { throw new Error("blocked"); },
  };
  await import(`./storageMigrate.ts?case=${++caseNo}`);
  delete (globalThis as Record<string, unknown>).window;
});
