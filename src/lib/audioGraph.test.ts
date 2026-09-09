// audioGraph runs on Web Audio and the DOM, so almost all of it is verified
// in-page (the __fx dev handle) rather than here. What CAN be pinned from
// outside is structure whose absence is silence — the scoreTrack.test.ts
// situation: unexported wiring, no unit seam, and a failure nobody hears
// until the feature "doesn't work".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  fileURLToPath(new URL("./audioGraph.ts", import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const fnBody = (name: string) => {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} exists`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${name}: unbalanced braces`);
};

test("a fresh chain wires its interior as well as its exit", () => {
  // The bug this pins: `createMediaElementSource` permanently reroutes the
  // element, so a chain whose src is not connected to anything is not "no
  // effects yet", it is SILENCE — and the no-own-effects fast path (a plain
  // clip on a lane with a rack) never builds nodes, so nothing later rewires
  // it. ensureChain must therefore do both halves itself: relink (src -> out,
  // through zero nodes) and routeOut (out -> bus or destination). Shipped
  // without the first, every clip on a lane went quiet the moment the lane
  // gained an effect.
  const body = fnBody("ensureChain");
  const fresh = body.slice(0, body.indexOf("} else"));
  assert.ok(fresh.includes("relink(chain)"), "fresh chain wires src -> out");
  assert.ok(fresh.includes("routeOut(chain)"), "fresh chain routes out -> bus/destination");
});

test("the no-own-effects path still attaches, for the lane's sake", () => {
  // A clip with no chain of its own but a lane rack over it has to reach the
  // bus, and it must not wait for Tuna to do it — the rack's own nodes load
  // async, the routing must not.
  const body = fnBody("applyFx");
  assert.ok(/if \(!active\.length && !busId\)/.test(body),
    "untouched elements (no fx, no bus) stay untouched");
  const fast = body.slice(body.indexOf("if (!active.length) {"));
  assert.ok(fast.includes("ensureChain(el, busId)"),
    "a bare bussed clip is routed through ensureChain, synchronously");
});

test("the bus fader sits after the inserts, like the render's", () => {
  // worker/mix.py::lane_bus puts the lane's level after its rack; the preview
  // holds it on bus.out (the tail `link` connects the rack INTO), written by
  // setBusGain. If the gain ever moves to bus.input, a lane compressor hears
  // the fader instead of the lane and the two engines part ways silently.
  const body = fnBody("setBusGain");
  assert.ok(body.includes("bus.out.gain"), "setBusGain writes the tail gain");
});
