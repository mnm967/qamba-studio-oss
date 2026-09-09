// Who is responsible for making media READABLE by Web Audio.
//
// This is the failure the whole module exists for, and it is silent in the
// worst way: a MediaElementAudioSourceNode built from an opaque element
// outputs ZEROES rather than failing, so the video plays, the audio goes
// quiet, and no error appears anywhere. Measured in a real browser against
// the media server's own headers — peak amplitude 0.00000 without
// `crossOrigin` and 0.548 with it, on the same file — with the browser
// logging "MediaElementAudioSource outputs zeroes due to CORS access
// restrictions".
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/** A desktop bridge, so `needsCorsProxy()` is true — the module reads it at
 *  CALL time, so this only has to be in place before the calls. */
const asked: string[] = [];
(globalThis as any).window = {
  __TAURI__: {
    core: { invoke: async () => null },
    http: { fetch: async (url: string) => { asked.push(url); throw new Error("no network in a test"); } },
  },
};

const { ensureCorsUrl, _resetCorsMedia } = await import("./corsMedia.ts");
const { setLocalMediaOrigin } = await import("./desktop.ts");

const ORIGIN = "http://127.0.0.1:53411/9f2c-token";

test("a local project's media is NOT proxied — it is already readable", async () => {
  _resetCorsMedia();
  asked.length = 0;
  setLocalMediaOrigin(ORIGIN);
  try {
    const got = await ensureCorsUrl(`${ORIGIN}/proj-1/audio/x.mp3`, null);
    assert.equal(got, null, "null means: use the URL you have");
    assert.deepEqual(asked, [], "and it must not spend a fetch finding that out");
  } finally {
    setLocalMediaOrigin(null);
  }
});

test("a bucket URL still goes through the proxy", async () => {
  // The control. Without it the test above passes for a build where the
  // proxy was switched off entirely.
  _resetCorsMedia();
  asked.length = 0;
  setLocalMediaOrigin(ORIGIN);
  try {
    await ensureCorsUrl("https://media.example.com/library/x.mp3", null);
    assert.deepEqual(asked, ["https://media.example.com/library/x.mp3"]);
  } finally {
    setLocalMediaOrigin(null);
  }
});

test("the player takes on what the proxy declined", () => {
  // `ensureCorsUrl` returning null puts the obligation on the CALLER, and the
  // caller is the only place that can meet it — the attribute is on the
  // element. A parse rather than a render because PreviewPlayer reaches
  // supabase and React at import; the risk being pinned is that somebody
  // simplifies the branch away and the audio goes silent with nothing said.
  const src = readFileSync("src/components/timeline/PreviewPlayer.tsx", "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /import \{ isLocalMediaUrl \} from "\.\.\/\.\.\/lib\/desktop"/,
    "PreviewPlayer has to be able to recognise local media");
  const block = src.slice(src.indexOf("const inGraph ="), src.indexOf("const wantsFx ="));
  assert.match(block, /isLocalMediaUrl\(plain\)/,
    "local media must be recognised where the fx source is chosen");
  assert.match(block, /localCors \? plain/,
    "and it must be loaded AS ITSELF, not proxied into a blob");
  // The attribute is what the browser acts on; without it the URL is loaded
  // opaquely and the graph is silent however good the headers were.
  assert.match(src, /crossOrigin=\{wantsFx && !fxUrl\.startsWith\("blob:"\) \? "anonymous" : undefined\}/,
    "a non-blob fx source must load in CORS mode");
});
