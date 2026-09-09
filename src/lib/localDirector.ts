// The director, run on THIS MACHINE — same toolset, no pod, no API key.
//
// WHAT MAKES THIS POSSIBLE is that `director/tools.js` takes its database by
// injection and speaks POSTGREST PATHS rather than a client API. `sbGet(
// 'scenes?select=*&id=eq.X')` is a URL, so the same forty tools that run on
// Vercel with a service key run here with the user's own anon key and access
// token, and RLS does the scoping that the service key never needed. Nothing
// in the toolset knows which it is.
//
// WHY THE LOOP LIVES HERE AND NOT IN RUST. Only the model call has to be in
// Rust (Ollama sends no CORS headers and the webview's origin is
// `tauri://localhost`). Everything else — history, tool dispatch, writing the
// reply back — is ordinary Supabase work the browser already does, and putting
// it in Rust would mean a second implementation of the whole database layer.
//
// EITHER PLANE, and getting there was one function rather than forty. This
// used to be CLOUD PROJECTS ONLY — the tools fetched PostgREST directly, so
// pointed at a project whose rows are a file on this machine they would have
// read and written the STUDIO's copy of it: every tool reporting success, the
// storyboard it edited not the one on screen. What fixed it is the shape
// choice above. A tool speaks a PATH, and `localRest` already answers paths
// out of a local project's store for the studio's own pipeline Python — so
// `rest()` picks the transport and not one of the forty tools knows.
//
// What a local project still cannot do is reach the POD, and that is not a
// database question: `db.ins` sends a job through `enqueueJob`, which corrects
// the lane for the kinds this build can serve and refuses the rest by name.

import { supabase } from "./supabase";
import { activeLocalStore } from "./localPlane";
import { planesFor } from "./localPlanes";
import { localRest } from "./localRest";
import { isDesktop, invokeStrict } from "./desktop";
import { installedDirectorModel, ollamaStatus } from "./ollamaLocal";
import {
  MAX_ROUNDS, TOOLS, TOOL_NAMES, configureTools, runTool,
} from "../../director/tools.js";
import type { ToolDef } from "./localDirectorRules";
import { asOllamaTools, localDirectorBlocker, parseLooseToolCall } from "./localDirectorRules";

/* ─────────────────────────────────────────────── the injected database ── */

/** What `rest` hands back. Kept as an interface rather than inlined because
 *  `director/tools.js` reads `status` on one path and `json()` on the rest. */
interface RestReply { status: number; json(): Promise<unknown> }

/**
 * One PostgREST call, against the open project's own store.
 *
 * THIS IS WHY THE DIRECTOR WORKS AT ALL HERE. Every tool speaks a PostgREST
 * path (`scenes?select=*&id=eq.X`) rather than a client API — the shape choice
 * that let one toolset serve a server and a browser — and `localRest` is the
 * translator the pipeline's own Python already goes through for exactly that
 * reason. So the toolset needs no change: the SAME path is answered out of the
 * project's file instead of over a wire.
 *
 * IT IS DECIDED PER CALL, not at `configureTools` time. The store follows the
 * open project (`planeRouter` reads the URL), and this module is configured
 * once for the life of the tab.
 */
async function rest(method: string, path: string, body?: unknown,
                    extra: Record<string, string> = {}): Promise<RestReply> {
  const store = activeLocalStore();
  if (!store) {
    // No project open, so there are no rows for a tool to read or write. The
    // dock only ever runs a turn inside one, so this is a programming error
    // rather than a state a user can reach — said plainly rather than left to
    // fail as an undefined read three frames down.
    throw new Error("no project is open — the director edits a project's own rows");
  }
  const res = await localRest(planesFor(store), {
    method, path,
    body: body === undefined ? null : JSON.stringify(body),
    prefer: extra.prefer ?? null,
  });
  if (res.status >= 400) {
    // `localRest` answers a PostgREST-shaped error body, and its MESSAGE is
    // the part worth surfacing. The table name only, like the server twin
    // this descends from: a PostgREST path carries filters that can include a
    // user's own prose.
    let why = res.body;
    try { why = String((JSON.parse(res.body) as { message?: string }).message ?? res.body); }
    catch { /* not JSON */ }
    throw new Error(`${method} ${path.split("?")[0]}: ${res.status} ${why}`);
  }
  return {
    status: res.status,
    // A 204 has no body at all, and `JSON.parse("")` throws — the callers
    // that get one (`upd`, `del`) never read it, but it must not blow up.
    json: async () => (res.body ? JSON.parse(res.body) : null),
  };
}

/** The five calls `director/tools.js` makes, with this user's credentials. */
const db = {
  get: async (path: string) => (await rest("GET", path)).json(),
  ins: async (table: string, body: unknown) => {
    // A JOB IS NOT AN ORDINARY ROW: it names a QUEUE, and the queues the
    // cloud build's render pod served name nothing here. Fifteen tools write
    // `lane: "gpu"` outright, so correcting it here is the funnel `enqueueJob`
    // already states its own reason for — a rule repeated at fifteen call
    // sites is one that is wrong at the sixteenth. It corrects the kinds this
    // build can serve and REFUSES the rest by name, which beats a row that
    // queues, is never claimed, and says nothing.
    //
    // Imported LAZILY: `db/jobs` pulls the catalog in with it, and that does
    // not belong in the chunk a chat turn loads to answer a question about a
    // scene.
    if (table === "jobs") {
      const { enqueueJob } = await import("./db/jobs.ts");
      return enqueueJob(body as Parameters<typeof enqueueJob>[0]);
    }
    const rows = await (await rest("POST", table, body, { prefer: "return=representation" })).json();
    return Array.isArray(rows) ? rows[0] : rows;
  },
  upd: async (path: string, body: unknown) => { await rest("PATCH", path, body); },
  updRows: async (path: string, body: unknown) =>
    (await rest("PATCH", path, body, { prefer: "return=representation" })).json(),
  del: async (path: string) => { await rest("DELETE", path); },
};

/**
 * Lore, as far as a browser can take it.
 *
 * `loreDocList` and `setLoreTiming` are ordinary rows. `searchLore` is NOT:
 * a semantic search embeds the QUERY, and embedding is a provider call the
 * bundled Python makes with the key in the keychain — which a webview cannot
 * reach by design. So the semantic path is unavailable here and this says so
 * IN THE TOOL RESULT rather than returning an empty list: "no lore matched"
 * and "I could not look" are different answers, and only one of them is true.
 */
const lore = {
  loreDocList: async (projectId: string) =>
    db.get(`bible_entries?select=id,name,summary&project_id=eq.${projectId}&kind=eq.lore&order=name`),
  setLoreTiming: async (projectId: string, args: Record<string, unknown>) => {
    const id = String(args.entry_id ?? "");
    if (!id) return { error: "entry_id is required" };
    await db.upd(`bible_entries?id=eq.${id}&project_id=eq.${projectId}`,
      { doc: { when: args.when ?? null } });
    return { ok: true, entry_id: id };
  },
  searchLore: async (projectId: string, query: string, limit?: number) => {
    // Text search only — the fallback the server twin keeps for when it has
    // no embedding quota, which is permanently the case in a browser.
    const q = String(query ?? "").trim().replace(/[%,()]/g, " ");
    if (!q) return { results: [], note: "empty query" };
    const rows = await db.get(
      `bible_entries?select=id,name,summary,doc&project_id=eq.${projectId}` +
      `&kind=eq.lore&or=(name.ilike.*${encodeURIComponent(q)}*,summary.ilike.*${encodeURIComponent(q)}*)` +
      `&limit=${Math.max(1, Math.min(20, Number(limit) || 8))}`);
    return {
      results: rows,
      note: "Text match only. Semantic lore search needs the studio's embedding "
          + "key, which a local turn does not have — switch to a hosted backend "
          + "if a search comes back thinner than you expect.",
    };
  },
};

let configured = false;
function configureOnce() {
  if (configured) return;
  configureTools({ db, lore });
  configured = true;
}

/* ────────────────────────────────────────────────────── availability ── */

/** The model a local director turn would use, or null.
 *
 *  IT NO LONGER ASKS WHICH PLANE THE PROJECT IS ON. It used to return null for
 *  a local one, because the toolset fetched PostgREST directly and would have
 *  read and written the studio's copy of a project that is on this disk. The
 *  db above routes through the plane now, so the only questions left are the
 *  ones Ollama cares about: is this the desktop, and is a model installed. */
export async function localDirectorModel(): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    return installedDirectorModel(await ollamaStatus());
  } catch {
    return null;
  }
}

/* ───────────────────────────────────────────────────────── the loop ── */

export interface LocalTurnEvent {
  t: "tool" | "text" | "done" | "error";
  name?: string;
  status?: "run" | "ok" | "err";
  text?: string;
  /** the tool's own return value, on an ok/err event — the runner persists a
   *  compact form of it beside the call, which is what lets the dock draw the
   *  "queued · job …" receipt and place a block's placeholder on this path
   *  exactly as it does on the hosted one */
  result?: unknown;
}

interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}
interface OllamaMessage {
  content?: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
}

export interface ChatTurnReq {
  system: string; messages: unknown[]; model: string; tools?: unknown[];
}

/** One model call. The loop below is provider-agnostic and this is the only
 *  part that is not — so it is INJECTED, which is what lets the same forty
 *  tools and the same round discipline run against the local Ollama or against
 *  a BYOK provider without a second copy of the loop. `byokChat.ts` supplies
 *  the other implementations and translates each vendor's wire format back to
 *  this shape. */
export type ChatFn = (req: ChatTurnReq) => Promise<OllamaMessage>;

const ollamaTurn: ChatFn = (req) => invokeStrict<OllamaMessage>("ollama_chat", { req });

/**
 * Run one director turn against the local model, tools and all.
 *
 * Mirrors `llm.complete_with_tools` on the pod, including the two things that
 * loop gets right: the assistant's own tool-call message is kept in the
 * history (dropping it leaves the results answering a question that is no
 * longer there), and running out of rounds asks for a closing summary with the
 * tools TAKEN AWAY rather than merely discouraged — a model mid-chain that is
 * told to stop but still handed tools calls the next one.
 */
export async function runLocalDirectorTurn(args: {
  system: string;
  history: { role: string; content: string }[];
  model: string;
  ctx: Record<string, unknown>;
  onEvent?: (e: LocalTurnEvent) => void;
  maxRounds?: number;
  /** which model call to make. Defaults to the local Ollama; `byokChat.ts`
   *  passes one bound to the user's own provider key. */
  chat?: ChatFn;
  /** WHOSE TOOLS THIS TURN GETS. Defaults to the director's forty. The
   *  wizard's interview passes its own three (`localBrief.ts`) — it is a
   *  different agent with a different contract, and handing it the editing
   *  toolset gave it every tool except the one it exists to call.
   *
   *  `names` is not derivable from `tools` here because `parseLooseToolCall`
   *  wants a Set and building one per round is work in a loop; it is passed
   *  so the two cannot disagree about what exists. */
  toolset?: {
    tools: ToolDef[];
    names: Set<string>;
    run(name: string, input: Record<string, unknown>, ctx: Record<string, unknown>): Promise<unknown>;
  };
}): Promise<{ text: string; calls: { name: string; input: unknown; result: unknown }[] }> {
  configureOnce();
  const { system, model, ctx, onEvent } = args;
  const chatTurn = args.chat ?? ollamaTurn;
  const kit = args.toolset;
  const known = (kit?.names ?? TOOL_NAMES) as Set<string>;
  const call = kit ? kit.run : runTool;
  const tools = asOllamaTools((kit?.tools ?? TOOLS) as never);
  const convo: unknown[] = [...args.history];
  const calls: { name: string; input: unknown; result: unknown }[] = [];
  const rounds = args.maxRounds ?? MAX_ROUNDS;

  for (let i = 0; i < rounds; i++) {
    const msg = await chatTurn({ system, messages: convo, model, tools });
    let wanted = msg?.tool_calls ?? [];
    // A small model handed the whole toolset picks the right tool and loses
    // the wrapper — see `parseLooseToolCall`. Recover it rather than reporting
    // a turn that did nothing.
    if (!wanted.length) {
      const loose = parseLooseToolCall(msg?.content ?? "", known);
      if (loose) wanted = [{ function: { name: loose.name, arguments: loose.arguments } }];
    }
    if (!wanted.length) {
      const text = (msg?.content ?? "").trim();
      onEvent?.({ t: "text", text });
      return { text, calls };
    }
    convo.push({ role: "assistant", content: msg?.content ?? "", tool_calls: wanted });
    for (const c of wanted) {
      const name = c.function?.name ?? "";
      const raw = c.function?.arguments;
      // Ollama sends a dict; some builds send a JSON string. Same split the
      // worker's loop handles.
      let input: Record<string, unknown> = {};
      try {
        input = (typeof raw === "string" ? JSON.parse(raw || "{}") : (raw ?? {})) as Record<string, unknown>;
      } catch { input = {}; }
      onEvent?.({ t: "tool", name, status: "run" });
      let result: unknown;
      try {
        result = await call(name, input, ctx);
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      const failed = !!(result && typeof result === "object" && "error" in (result as object));
      onEvent?.({ t: "tool", name, status: failed ? "err" : "ok", result });
      calls.push({ name, input, result });
      convo.push({ role: "tool", content: JSON.stringify(result).slice(0, 4000) });
    }
  }

  // Out of rounds. Ask for the report with tools withheld, so a tool call is
  // not even expressible.
  convo.push({
    role: "user",
    content: "Stop calling tools. In at most three sentences, tell the user what you "
           + "just changed and what is left to do. An edit nobody was told about is "
           + "worse than one that did not happen.",
  });
  const last = await chatTurn({ system, messages: convo, model });
  let text = (last?.content ?? "").trim();
  if (!text) {
    const did = calls.map((c) => c.name);
    text = "I ran out of tool rounds before writing a reply. Completed: "
         + (did.length ? did.join(", ") : "nothing")
         + ". Ask me to continue and I'll pick up from there.";
  }
  onEvent?.({ t: "text", text });
  return { text, calls };
}

/** Re-exported so callers need not reach into the shared module themselves. */
export { TOOLS as DIRECTOR_TOOLS };
export { asOllamaTools, localDirectorBlocker } from "./localDirectorRules";
