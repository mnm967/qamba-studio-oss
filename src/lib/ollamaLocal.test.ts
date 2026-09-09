import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_LLMS, bestLlm, blockedReason, daemonAction, hasModel,
  installedDirectorModel, versionNote, type OllamaStatus,
} from "./ollamaLocal.ts";

const status = (over: Partial<OllamaStatus> = {}): OllamaStatus => ({
  bundled: true, bin: "/x/ollama", reachable: true, ours: true, foreign: false,
  version: "0.32.15", version_ok: true, min_version: "0.32.12",
  bundled_version: "0.32.15", bundled_version_ok: true,
  models: [], port: 11434, root: "/x",
  ...over,
});

test("an installed model is recognised whatever spelling the daemon reports", () => {
  // Ollama answers `name:tag`, and a bare name means `:latest`. Comparing the
  // raw strings makes an installed model read as missing, and the row then
  // offers a second 17GB download of something already on disk.
  const s = status({ models: [{ name: "qwen3:8b", size_mb: 5000 }] });
  assert.equal(hasModel(s, "qwen3:8b"), true);
  assert.equal(hasModel(s, "qwen3.8:27b"), false);

  const latest = status({ models: [{ name: "qwen3.8", size_mb: 17700 }] });
  assert.equal(hasModel(latest, "qwen3.8:latest"), true);
  assert.equal(hasModel(latest, "qwen3.8"), true);
});

test("a too-old daemon blocks every row, and says why rather than warning", () => {
  // The failure this prevents is SILENT: chat formatting and tool-call
  // parsing come from a renderer built into the DAEMON, so a model pulled onto
  // one too old to have it loses the system prompt and every tool signature
  // with nothing saying so.
  const old = status({ version: "0.23.2", version_ok: false });
  const why = blockedReason(old, LOCAL_LLMS[0], 64);
  assert.ok(why && why.includes("0.23.2"), `expected the version in the reason, got: ${why}`);
  assert.ok(versionNote(old).includes("renderer"));
});

test("the daemon's own problems outrank a memory problem", () => {
  // "needs 20GB" is unhelpful advice on a machine with no Ollama at all.
  const none = status({ bundled: false, reachable: false });
  assert.equal(blockedReason(none, LOCAL_LLMS[0], 4), "Ollama is not installed yet");
  const stopped = status({ reachable: false });
  assert.equal(blockedReason(stopped, LOCAL_LLMS[0], 4), "Ollama is installed but not running");
});

test("a 16GB laptop is told the 27B will not fit, and the 8B is not blocked", () => {
  // Measured on the machine this was written on: an M3/16GB budgets ~9.6GB.
  const s = status();
  const big = LOCAL_LLMS.find((m) => m.name.startsWith("qwen3.8"))!;
  const small = LOCAL_LLMS.find((m) => m.name === "qwen3:8b")!;
  assert.ok(blockedReason(s, big, 9.6)?.includes("needs about 20GB"));
  assert.equal(blockedReason(s, small, 9.6), null);
});

test("an unknown budget blocks nothing — a missing probe is not a refusal", () => {
  assert.equal(blockedReason(status(), LOCAL_LLMS[0], 0), null);
});

test("the recommendation is the biggest row that fits", () => {
  assert.equal(bestLlm(64)?.name, "qwen3.8:27b");
  assert.equal(bestLlm(9.6)?.name, "qwen3:8b");
  assert.equal(bestLlm(12)?.name, "qwen3:14b");
  assert.equal(bestLlm(2), null);
});

test("a director turn picks the biggest INSTALLED model, not the biggest known one", () => {
  const s = status({ models: [{ name: "qwen3:8b", size_mb: 5000 }] });
  assert.equal(installedDirectorModel(s), "qwen3:8b");
});

test("nothing installed, unreachable or too old all mean 'let the pod have it'", () => {
  // Each of these returning a model name would turn a two-second rewrite into
  // a failed one instead of a pod round trip.
  assert.equal(installedDirectorModel(status({ models: [] })), null);
  assert.equal(installedDirectorModel(status({ reachable: false })), null);
  assert.equal(
    installedDirectorModel(status({
      version_ok: false,
      models: [{ name: "qwen3:8b", size_mb: 5000 }],
    })),
    null,
  );
  assert.equal(installedDirectorModel(null), null);
});

test("every row is a role with a consumer on this machine", () => {
  // The rule the section is built around: a row nothing on this machine
  // loads is 17GB of download with no consumer.
  for (const m of LOCAL_LLMS) assert.equal(m.role, "director");
});

test("a too-old daemon of the USER'S OWN is offered a way out, not just a diagnosis", () => {
  // The dead end this fixes: the screen said "0.23.2 is too old" and offered
  // nothing, because their Ollama is not ours to update.
  const theirs = status({
    foreign: true, ours: false, version: "0.23.2", version_ok: false,
    bundled: false, bundled_version: null, bundled_version_ok: false,
  });
  const a = daemonAction(theirs);
  assert.equal(a.kind, "update");
  assert.ok(a.note?.includes("leaves yours alone"));
});

test("once a newer one is installed beside theirs, the action becomes Start and says why", () => {
  // Installing ours cannot evict a daemon they are running, so the button
  // changes meaning and the note has to carry the missing step.
  const both = status({
    foreign: true, ours: false, version: "0.23.2", version_ok: false,
    bundled: true, bundled_version: "0.32.15", bundled_version_ok: true,
  });
  const a = daemonAction(both);
  assert.equal(a.kind, "start");
  assert.ok(a.note?.includes("Quit your Ollama"));
  assert.ok(a.note?.includes("0.32.15") && a.note?.includes("0.23.2"));
});

test("our own stale binary offers a plain Update", () => {
  const stale = status({
    ours: false, foreign: false, reachable: false,
    bundled: true, bundled_version: "0.30.0", bundled_version_ok: false,
  });
  assert.equal(daemonAction(stale).kind, "update");
});

test("nothing anywhere offers Install; a healthy one of ours offers Stop", () => {
  assert.equal(daemonAction(null).kind, "install");
  assert.equal(
    daemonAction(status({ bundled: false, reachable: false, bundled_version: null, bundled_version_ok: false })).kind,
    "install",
  );
  assert.equal(daemonAction(status()).kind, "stop");
  assert.equal(daemonAction(status({ reachable: false, ours: false })).kind, "start");
});

test("a healthy daemon the USER started is left alone — no Stop for someone else's process", () => {
  const ok = daemonAction(status({ foreign: true, ours: false }));
  assert.equal(ok.kind, "none");
});
