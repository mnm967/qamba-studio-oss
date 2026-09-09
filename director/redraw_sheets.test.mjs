/**
 * `redraw_sheets` — the director's route to a coverage sheet.
 *
 * The toolset takes its database by INJECTION (`configureTools`), which is the
 * whole reason this is testable without a project: the tool speaks PostgREST
 * paths, so a stub that answers those paths exercises the real code.
 *
 * What is pinned here is everything whose failure is silent or expensive:
 * picking the wrong entry out of several, queueing a job whose own
 * preconditions will fail it, and archiving before a render that is built from
 * the very plates being archived.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { configureTools, runTool } from "./tools.js";

const PID = "proj-1";

/** A stub PostgREST. Only the paths this tool asks for, and it RECORDS them —
 *  a filter silently dropped from a query returns more rows than were asked
 *  for, which is the failure `localQuery` documents at length. */
function stubDb({ entries = [], plates = [] } = {}) {
  const seen = { get: [], ins: [] };
  return {
    seen,
    db: {
      get: async (path) => {
        seen.get.push(path);
        if (path.startsWith("bible_entries?")) {
          const m = /name=ilike\.\*([^&]*)\*/.exec(path);
          const q = decodeURIComponent(m ? m[1] : "").toLowerCase();
          return entries.filter((e) => e.name.toLowerCase().includes(q));
        }
        if (path.startsWith("bible_assets?")) {
          const id = /entry_id=eq\.([^&]+)/.exec(path)[1];
          const roles = /role=in\.\(([^)]*)\)/.exec(path)[1].split(",");
          // The tool MUST ask for live rows only; if it stops, this stub keeps
          // returning archived plates and the test below catches it.
          const live = path.includes("slot=lt.90");
          return plates.filter((p) => p.entry_id === id && roles.includes(p.role)
                                      && (!live || p.slot < 90));
        }
        throw new Error(`unexpected path ${path}`);
      },
      ins: async (table, body) => { seen.ins.push({ table, body }); return { id: "job-1" }; },
      upd: async () => ({}),
      del: async () => ({}),
    },
  };
}

const CHAR = { id: "e1", name: "Eli Rusk", kind: "character" };
const LOC = { id: "e2", name: "Katagiri Print", kind: "environment" };
const PERSON = { id: "e3", name: "Mrs. Katagiri", kind: "character" };

const run = (input, fixture) => {
  const { db, seen } = stubDb(fixture);
  configureTools({ db, lore: {} });
  return runTool("redraw_sheets", input, { projectId: PID })
    .then((r) => ({ r, seen }));
};

test("it queues one coverage take built from the plates on file", async () => {
  const { r, seen } = await run({ entry: "Eli" }, {
    entries: [CHAR],
    plates: [{ entry_id: "e1", role: "face", slot: 0 },
             { entry_id: "e1", role: "turnaround", slot: 0 }],
  });
  assert.equal(r.entry, "Eli Rusk");
  assert.deepEqual(r.building_from, ["face", "turnaround"]);
  assert.equal(seen.ins.length, 1);
  const { table, body } = seen.ins[0];
  assert.equal(table, "jobs");
  assert.equal(body.kind, "orbit_sheet");
  assert.equal(body.lane, "gpu");          // it drives ComfyUI
  assert.equal(body.payload.sheet_mode, "coverage");
  assert.equal(body.payload.entry_id, "e1");
  assert.ok(body.payload.label, "every enqueuer carries a label");
});

test("NOTHING is archived before the render", async () => {
  // The handler retires what it REPLACES once the take lands, and it reads
  // live rows only. Archiving here would withdraw the very pictures the take
  // is built from, and the job would then raise "has no reference plates" on
  // an entry that visibly has four.
  const { seen } = await run({ entry: "Eli" }, {
    entries: [CHAR], plates: [{ entry_id: "e1", role: "face", slot: 0 }],
  });
  assert.equal(seen.ins.filter((i) => i.table !== "jobs").length, 0);
});

test("it reads LIVE plates only", async () => {
  const path = (await run({ entry: "Eli" }, {
    entries: [CHAR], plates: [{ entry_id: "e1", role: "face", slot: 0 }],
  })).seen.get.find((p) => p.startsWith("bible_assets?"));
  assert.ok(path.includes("slot=lt.90"),
            "a withdrawn plate is not something to build on");
});

test("an entry with only ARCHIVED plates is refused, not queued", async () => {
  const { r, seen } = await run({ entry: "Eli" }, {
    entries: [CHAR], plates: [{ entry_id: "e1", role: "face", slot: 90 }],
  });
  assert.match(r.error, /no reference plate/);
  assert.equal(seen.ins.length, 0, "a job that cannot succeed is not worth a claim");
});

test("an entry with no plates at all names the one to draw first", async () => {
  const c = await run({ entry: "Eli" }, { entries: [CHAR], plates: [] });
  assert.match(c.r.error, /face plate first/);
  const l = await run({ entry: "Katagiri Print" }, { entries: [LOC], plates: [] });
  assert.match(l.r.error, /master plate first/);
});

test("AMBIGUITY IS A MISS, NOT A GUESS", async () => {
  // Measured on real data: "Katagiri" matches the CHARACTER Mrs. Katagiri and
  // the LOCATION Katagiri Print. Taking the first row redrew a person's plates
  // when a shop was asked for — expensive, wrong, and it reads as the tool
  // ignoring you.
  const { r, seen } = await run({ entry: "Katagiri" }, {
    entries: [PERSON, LOC],
    plates: [{ entry_id: "e2", role: "master", slot: 0 }],
  });
  assert.match(r.error, /matches 2 entries/);
  assert.deepEqual(r.candidates.map((c) => c.name), ["Mrs. Katagiri", "Katagiri Print"]);
  assert.equal(seen.ins.length, 0);
});

test("an exact name still resolves out of an ambiguous set", async () => {
  const { r } = await run({ entry: "Katagiri Print" }, {
    entries: [PERSON, LOC],
    plates: [{ entry_id: "e2", role: "master", slot: 0 }],
  });
  assert.equal(r.entry, "Katagiri Print");
  assert.equal(r.kind, "environment");
});

test("a name matching nothing says so", async () => {
  const { r } = await run({ entry: "Zebedee" }, { entries: [CHAR] });
  assert.match(r.error, /no character or location/);
});

test("the model is the caller's when given, and PDD by default", async () => {
  const f = { entries: [CHAR], plates: [{ entry_id: "e1", role: "face", slot: 0 }] };
  const a = await run({ entry: "Eli" }, f);
  assert.equal(a.r.renders_on, "minimax-h3-pdd");
  assert.equal(a.seen.ins[0].body.payload.model_key, undefined,
               "absent, so the handler's own default applies rather than a copy of it");
  const b = await run({ entry: "Eli", model_key: "minimax-h3-turbo" }, f);
  assert.equal(b.r.renders_on, "minimax-h3-turbo");
  assert.equal(b.seen.ins[0].body.payload.model_key, "minimax-h3-turbo");
});

test("only kinds with a coverage shape are looked up", async () => {
  // A prop is one flat product shot; `_sheet_refs` has no ranking for it.
  const { seen } = await run({ entry: "forklift" }, { entries: [] });
  const q = seen.get.find((p) => p.startsWith("bible_entries?"));
  assert.ok(q.includes("kind=in.(character,environment)"));
});
