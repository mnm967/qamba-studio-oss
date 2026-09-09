// The director's backend list, pinned by parsing its source.
//
// `director.ts` reaches `lib/supabase`, whose extensionless `.js` specifier
// `node --test` cannot resolve — the same corner `scoreTrack.test.ts` is in.
// What is checked here is worth the parse: every one of these failures is
// silent, and two of them spend money or fail a turn on a machine that had a
// perfectly good answer available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHAT_MODELS } from "./byokChat.ts";

const src = readFileSync(new URL("./director.ts", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

/** The `DIRECTOR_BACKENDS` literal, minus the spread of the BYOK rows. */
function backendBlock(): string {
  const i = src.indexOf("export const DIRECTOR_BACKENDS");
  assert.ok(i > 0, "DIRECTOR_BACKENDS not found — the scanner is broken");
  const j = src.indexOf("\n];", i);
  assert.ok(j > i, "unterminated DIRECTOR_BACKENDS literal");
  return src.slice(i, j);
}

test("every backend declares which plane it runs on, except the router", () => {
  const block = backendBlock();
  const ids = [...block.matchAll(/\n\s*(?:\/\/[^\n]*\n\s*)*id: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.includes("auto"), `ids parsed: ${JSON.stringify(ids)}`);
  for (const id of ids) {
    const entry = block.slice(block.indexOf(`id: "${id}"`));
    const decl = entry.slice(0, entry.indexOf("hint:"));
    const tiered = /tier: "(local|byok|cloud)"/.test(decl);
    if (id === "auto") {
      // A ROUTER IS NOT A PLACE. Giving it a tier would file it under one of
      // the three headings and claim it always answers from there.
      assert.equal(tiered, false, "auto must not claim a plane");
    } else {
      assert.ok(tiered, `${id} has no tier — it would render under no heading`);
    }
  }
});

test("the BYOK rows are built with the byok tier, not the cloud one", () => {
  // They are generated from CHAT_MODELS rather than written out, so the tier
  // is set once — and setting it wrong would file "your Anthropic key" under
  // "Studio cloud", i.e. under the heading that says the studio pays.
  assert.match(src, /CHAT_MODELS\.map\(\(m\) => \(\{\s*\n\s*id: byokBackendId\(m\.provider, m\.api\), tier: "byok"/);
});

test("a routed model is an ordinary picker row — nothing is blocked for it", () => {
  // The whole point of routing rather than refusing: a model whose function
  // tools need `/v1/responses` was listed and unpickable while they had
  // nowhere to go, and a fix that left the row disabled would be half of one.
  const fn = /export function backendBlocked\([\s\S]*?\n\}/.exec(src)?.[0] ?? "";
  assert.ok(fn, "backendBlocked not found");
  assert.ok(!/toolBlock|toolTransport|responses/.test(fn),
    "backendBlocked still refuses on the transport — the routing made that dead");
  assert.ok(CHAT_MODELS.some((d) => d.toolTransport),
    "no model declares a tool transport — is the field gone?");
});

test("auto describes THIS machine, and promises to spend nothing", () => {
  const hint = /id: "auto"[\s\S]*?hint: ([\s\S]*?)\n  \},/.exec(src)?.[1] ?? "";
  assert.ok(hint, "auto's hint not found");
  // The old copy was "Claude, then OpenAI, then the local pod" — a description
  // of a hosted fallback chain this build does not have. On a machine with a
  // local model that was a failed turn from the option named "best configured".
  assert.ok(/This machine first/.test(hint), `auto's hint is: ${hint}`);
  // AND THE ONE IT MUST NOT DO. Reaching for a stored key here would bill the
  // user for picking "best configured" — the same rule `desktopEnhance`
  // follows, where a key is spent only when its backend was chosen.
  assert.ok(/[Nn]ever spends one of your API keys/.test(hint),
    "auto no longer promises to leave your keys alone");
});

test("every backend picker is the SAME picker", () => {
  // The wizard's was its own flat list — every backend in one column, "your
  // Anthropic key" beside the studio's subscription — and because it was its
  // own code it never grew the tiers, never grew the blocked states, and went
  // on offering rows that answer 403 long after the dock stopped. The demo's
  // was four hardcoded names, so the one screen meant for REVIEWING this
  // chrome was the last place the real thing could be seen.
  //
  // Three copies is the shape `TieredModelMenu` already refused for the model
  // pickers. This pins the fix: a surface that renders backends renders
  // `BackendMenu`, and nothing else maps over the list itself.
  const src = (f: string) =>
    readFileSync(new URL(f, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  for (const f of ["../components/shell/DirectorDock.tsx",
                   "../components/modals/WizardModal.tsx",
                   "../components/shell/DirectorChromeDemo.tsx"]) {
    const body = src(f);
    assert.match(body, /<BackendMenu\b/, `${f} does not use BackendMenu`);
    assert.ok(!/availableBackends\([^)]*\)\s*\.map/.test(body),
      `${f} maps over the backend list itself — that is the second copy`);
    assert.ok(!/DIRECTOR_BACKENDS\s*\.map/.test(body),
      `${f} maps over DIRECTOR_BACKENDS itself`);
  }
});

test("the shared menu decides blocked rows, and cannot forget the inputs", () => {
  // `backendBlocked` needs the ROLE and the KEYS. Taking them as props would
  // be a call site free to forget one, which is how a picker ends up offering
  // a member the studio's own subscription — so the component reads both.
  const menu = readFileSync(new URL("../components/ui/BackendMenu.tsx", import.meta.url), "utf8");
  assert.match(menu, /useIsAdmin\(\)/);
  assert.match(menu, /useByok\(\)/);
  assert.match(menu, /backendBlocked\(/);
});
