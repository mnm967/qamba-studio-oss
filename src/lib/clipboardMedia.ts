// Getting media out of the clipboard, for the library's paste path.
//
// There are two ways in and neither substitutes for the other. A real ⌘V paste
// event carries its files with it and needs no permission — that is the
// reliable path, but it is invisible, so nobody discovers it. A click on a
// Paste button has to ASK for the clipboard (`navigator.clipboard.read()`),
// which Chrome gates behind a permission prompt and Firefox does not implement
// for anything but text — that is the affordance, and it can fail. So both
// exist, and `readClipboardMedia` throws a sentence worth showing the user
// (pointing at ⌘V) rather than a bare DOMException.

/** What to CALL the paste chord. Only the label is platform-dependent — the
 *  handling takes ctrl and ⌘ alike, because this dev server is routinely
 *  reached from another machine over the port-forward. Computed on call, not
 *  at import: this module is also loaded by `node --test`, which has a
 *  `navigator` but not a browser's. */
export function pasteChord(): string {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const plat = (nav as { userAgentData?: { platform?: string } })?.userAgentData?.platform
    || nav?.platform || nav?.userAgent || "";
  return /mac|iphone|ipad/i.test(plat) ? "⌘V" : "Ctrl+V";
}

/** mime -> extension, for the names the library cards read. Anything not listed
 *  falls back to the mime subtype, which is right far more often than not. */
const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/avif": "avif", "image/heic": "heic", "image/svg+xml": "svg",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a",
  "audio/aac": "aac", "audio/ogg": "ogg", "audio/flac": "flac",
};

export const isMediaType = (t: string) => /^(image|video|audio)\//.test(t || "");

/** A clipboard blob is either unnamed or generically named ("image.png" is what
 *  Chrome calls every copied picture), and that name is what the card in the
 *  grid shows — so a generic one is replaced with a dated one. A file copied
 *  from the Finder arrives with its real name and keeps it. */
function named(blob: Blob, i = 0): File {
  const type = blob.type || "application/octet-stream";
  const existing = blob instanceof File ? blob.name : "";
  if (existing && !/^(image|clipboard|untitled)\.\w+$/i.test(existing)) return blob as File;
  const ext = EXT[type] ?? type.split("/")[1]?.replace(/[^a-z0-9]+/gi, "") ?? "bin";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return new File([blob], `pasted-${stamp}${i ? `-${i + 1}` : ""}.${ext}`, { type });
}

/** The media files on a paste (or drop) event. `files` and `items` describe the
 *  same payload in different browsers, so `items` is only consulted when
 *  `files` came back empty — reading both would double every paste. */
export function clipboardMediaFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const found: File[] = Array.from(data.files ?? []).filter((f) => isMediaType(f.type));
  if (!found.length) {
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== "file" || !isMediaType(item.type)) continue;
      const f = item.getAsFile();
      if (f) found.push(f);
    }
  }
  return found.map((f, i) => named(f, i));
}

/** Read the clipboard on demand, for a button rather than a key press. Throws
 *  with something readable — every failure here is one the user can act on. */
export async function readClipboardMedia(): Promise<File[]> {
  const chord = pasteChord();
  if (!navigator.clipboard?.read) {
    throw new Error(`this browser only pastes from the keyboard — press ${chord} over the library`);
  }
  let items: ClipboardItem[];
  try {
    items = await navigator.clipboard.read();
  } catch (e) {
    const name = (e as DOMException)?.name;
    throw new Error(name === "NotAllowedError"
      ? `the browser blocked clipboard access — allow it from the address bar, or press ${chord}`
      : `couldn't read the clipboard (${name || String(e)}) — press ${chord} instead`);
  }
  const out: File[] = [];
  for (const item of items) {
    for (const type of item.types) {
      if (!isMediaType(type)) continue;
      // Chrome only serves a few types through this API; an unreadable one is
      // skipped rather than failing a paste that has other usable parts.
      try { out.push(named(await item.getType(type), out.length)); } catch { /* not readable */ }
    }
  }
  return out;
}

/** Whether a paste belongs to whatever is focused. A text field owns its own
 *  ⌘V — hijacking it would mean an image dropped into the library while the
 *  user was typing a prompt, and no text where they were typing. */
export function isEditableTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}
