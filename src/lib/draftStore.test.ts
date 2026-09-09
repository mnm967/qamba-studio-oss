import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  getChatDraft, setChatDraft, clearChatDraft,
  getWizardDraft, setWizardDraft, clearWizardDraft,
  getWizardSideDraft, setWizardSideDraft, clearWizardSideDraft,
  getWizardPageDraft, setWizardPageDraft, clearWizardPageDraft,
} from "./draftStore.ts";

class LocalStorageMock {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

beforeEach(() => {
  const mock = new LocalStorageMock();
  // @ts-expect-error mock window for testing
  globalThis.window = {
    localStorage: mock,
  };
});

test("normal chat draft stores, retrieves and clears correctly", () => {
  assert.equal(getChatDraft("proj-1", "thread-a"), "");

  setChatDraft("proj-1", "thread-a", "Direct me into opening scene");
  assert.equal(getChatDraft("proj-1", "thread-a"), "Direct me into opening scene");

  // New chat (no thread id)
  setChatDraft("proj-1", null, "New conversation draft");
  assert.equal(getChatDraft("proj-1", null), "New conversation draft");
  assert.equal(getChatDraft("proj-1", undefined), "New conversation draft");

  // Isolates different projects and threads
  assert.equal(getChatDraft("proj-2", "thread-a"), "");
  assert.equal(getChatDraft("proj-1", "thread-b"), "");

  clearChatDraft("proj-1", "thread-a");
  assert.equal(getChatDraft("proj-1", "thread-a"), "");
  assert.equal(getChatDraft("proj-1", null), "New conversation draft");
});

test("one-shot wizard interview draft persists across reloads", () => {
  assert.equal(getWizardDraft("proj-1", "wiz-1"), "");

  setWizardDraft("proj-1", "wiz-1", "Neon-drenched street race with retro synthwave");
  assert.equal(getWizardDraft("proj-1", "wiz-1"), "Neon-drenched street race with retro synthwave");

  // Setting empty or whitespace removes the draft
  setWizardDraft("proj-1", "wiz-1", "   ");
  assert.equal(getWizardDraft("proj-1", "wiz-1"), "");

  setWizardDraft("proj-1", null, "New wizard interview draft");
  assert.equal(getWizardDraft("proj-1", null), "New wizard interview draft");

  clearWizardDraft("proj-1", null);
  assert.equal(getWizardDraft("proj-1", null), "");
});

test("one-shot wizard sidebar chat draft persists correctly", () => {
  assert.equal(getWizardSideDraft("proj-1", "wiz-1"), "");

  setWizardSideDraft("proj-1", "wiz-1", "Add a cyberpunk hacker ally to the cast");
  assert.equal(getWizardSideDraft("proj-1", "wiz-1"), "Add a cyberpunk hacker ally to the cast");

  clearWizardSideDraft("proj-1", "wiz-1");
  assert.equal(getWizardSideDraft("proj-1", "wiz-1"), "");
});

test("wizard page form draft persists json structure and clears", () => {
  assert.deepEqual(getWizardPageDraft("proj-1"), {});

  setWizardPageDraft("proj-1", {
    logline: "A rogue courier in neo Tokyo",
    notes: "High contrast lighting",
    lyricsText: "[00:05.0] Running in the night",
  });

  const saved = getWizardPageDraft("proj-1");
  assert.equal(saved.logline, "A rogue courier in neo Tokyo");
  assert.equal(saved.notes, "High contrast lighting");
  assert.equal(saved.lyricsText, "[00:05.0] Running in the night");

  clearWizardPageDraft("proj-1");
  assert.deepEqual(getWizardPageDraft("proj-1"), {});
});

test("handles missing project id or broken window gracefully", () => {
  assert.equal(getChatDraft(null), "");
  setChatDraft(null, null, "test");
  clearChatDraft(null);

  // @ts-expect-error test undefined window
  globalThis.window = undefined;
  assert.equal(getChatDraft("p1"), "");
  assert.doesNotThrow(() => setChatDraft("p1", "t1", "test"));
  assert.doesNotThrow(() => clearChatDraft("p1", "t1"));
});
