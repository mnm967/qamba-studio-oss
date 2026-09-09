// Draft storage helper: preserves unsent message drafts for normal director chat,
// one-shot wizard chat, and wizard form pages in localStorage across page reloads.

function safeGet(key: string): string {
  try {
    if (typeof window === "undefined" || !window.localStorage) return "";
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage quota or disabled storage errors
  }
}

function safeRemove(key: string): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.removeItem(key);
  } catch {
    // Ignore errors
  }
}

// ── Normal Director Chat ──────────────────────────────────────────────────

export function getChatDraft(projectId?: string | null, threadId?: string | null): string {
  if (!projectId) return "";
  const key = `qamba.draft.chat.${projectId}.${threadId || "new"}`;
  return safeGet(key);
}

export function setChatDraft(projectId?: string | null, threadId?: string | null, draft?: string): void {
  if (!projectId) return;
  const key = `qamba.draft.chat.${projectId}.${threadId || "new"}`;
  safeSet(key, (draft ?? "").trim() ? draft! : "");
}

export function clearChatDraft(projectId?: string | null, threadId?: string | null): void {
  if (!projectId) return;
  const key = `qamba.draft.chat.${projectId}.${threadId || "new"}`;
  safeRemove(key);
}

// ── One-Shot Wizard Chat (Interview) ──────────────────────────────────────

export function getWizardDraft(projectId?: string | null, threadId?: string | null): string {
  if (!projectId) return "";
  const key = `qamba.draft.wizard.${projectId}.${threadId || "new"}`;
  return safeGet(key);
}

export function setWizardDraft(projectId?: string | null, threadId?: string | null, draft?: string): void {
  if (!projectId) return;
  const key = `qamba.draft.wizard.${projectId}.${threadId || "new"}`;
  safeSet(key, (draft ?? "").trim() ? draft! : "");
}

export function clearWizardDraft(projectId?: string | null, threadId?: string | null): void {
  if (!projectId) return;
  const key = `qamba.draft.wizard.${projectId}.${threadId || "new"}`;
  safeRemove(key);
}

// ── One-Shot Wizard Chat (Sidebar: Cast & World / Storyboard) ─────────────

export function getWizardSideDraft(projectId?: string | null, threadId?: string | null): string {
  if (!projectId) return "";
  const key = `qamba.draft.wizard_side.${projectId}.${threadId || "new"}`;
  return safeGet(key);
}

export function setWizardSideDraft(projectId?: string | null, threadId?: string | null, draft?: string): void {
  if (!projectId) return;
  const key = `qamba.draft.wizard_side.${projectId}.${threadId || "new"}`;
  safeSet(key, (draft ?? "").trim() ? draft! : "");
}

export function clearWizardSideDraft(projectId?: string | null, threadId?: string | null): void {
  if (!projectId) return;
  const key = `qamba.draft.wizard_side.${projectId}.${threadId || "new"}`;
  safeRemove(key);
}

// ── One-Shot Wizard Page (Form) ───────────────────────────────────────────

export interface WizardPageDraft {
  logline?: string;
  notes?: string;
  lyricsText?: string;
}

export function getWizardPageDraft(projectId?: string | null): WizardPageDraft {
  if (!projectId) return {};
  const key = `qamba.draft.wizard_page.${projectId}`;
  const raw = safeGet(key);
  if (!raw) return {};
  try {
    return (JSON.parse(raw) as WizardPageDraft) || {};
  } catch {
    return {};
  }
}

export function setWizardPageDraft(projectId?: string | null, draft?: WizardPageDraft): void {
  if (!projectId) return;
  const key = `qamba.draft.wizard_page.${projectId}`;
  if (!draft || (!draft.logline?.trim() && !draft.notes?.trim() && !draft.lyricsText?.trim())) {
    safeRemove(key);
  } else {
    safeSet(key, JSON.stringify(draft));
  }
}

export function clearWizardPageDraft(projectId?: string | null): void {
  if (!projectId) return;
  const key = `qamba.draft.wizard_page.${projectId}`;
  safeRemove(key);
}
