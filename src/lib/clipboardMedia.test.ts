// What comes off a paste, and what it ends up called. Both halves fail
// quietly: a mis-filtered clipboard uploads an HTML fragment as an "image",
// and a name that isn't replaced puts a grid full of cards all called
// "image.png" in the library, which is only visible once there are several.
import assert from "node:assert/strict";
import test from "node:test";

import { clipboardMediaFiles, isEditableTarget, isMediaType, pasteChord } from "./clipboardMedia.ts";

test("the chord is named, never thrown over — this module loads outside a browser", () => {
  // Only the LABEL is platform-dependent; both chords are handled either way.
  assert.ok(["⌘V", "Ctrl+V"].includes(pasteChord()));
});

/** `clipboardMediaFiles` reads two properties of a DataTransfer and Node has no
 *  such class, so the tests hand it the shape rather than the object. */
const dt = (files: File[], items: unknown[] = []) =>
  ({ files, items } as unknown as DataTransfer);
const file = (name: string, type: string) => new File(["x"], name, { type });

test("only image / video / audio come off the clipboard", () => {
  assert.equal(isMediaType("image/png"), true);
  assert.equal(isMediaType("video/quicktime"), true);
  assert.equal(isMediaType("audio/mpeg"), true);
  assert.equal(isMediaType("text/html"), false);
  assert.equal(isMediaType("application/pdf"), false);
  assert.equal(isMediaType(""), false);

  const got = clipboardMediaFiles(dt([
    file("shot.png", "image/png"),
    file("notes.txt", "text/plain"),
    file("take.mp4", "video/mp4"),
  ]));
  assert.deepEqual(got.map((f) => f.name), ["shot.png", "take.mp4"]);
});

test("a generic clipboard name is replaced, a real one is kept", () => {
  // Chrome calls every copied picture "image.png" — a library of those is
  // unreadable, so those get a dated name instead.
  const [pasted] = clipboardMediaFiles(dt([file("image.png", "image/png")]));
  assert.match(pasted.name, /^pasted-\d{8}-\d{6}\.png$/);
  assert.equal(pasted.type, "image/png");

  // A file copied out of the Finder arrives named, and that name is the
  // useful one.
  const [copied] = clipboardMediaFiles(dt([file("aki-face-sheet.jpg", "image/jpeg")]));
  assert.equal(copied.name, "aki-face-sheet.jpg");
});

test("the extension follows the type, not the name it arrived with", () => {
  const [webm] = clipboardMediaFiles(dt([file("image.png", "video/webm")]));
  assert.match(webm.name, /\.webm$/);
  // An unlisted type still gets a plausible extension from its subtype rather
  // than landing on B2 with no extension at all.
  const [odd] = clipboardMediaFiles(dt([file("image.png", "image/bmp")]));
  assert.match(odd.name, /\.bmp$/);
});

test("items are only read when files came back empty, so a paste is never doubled", () => {
  const f = file("shot.png", "image/png");
  const asItem = { kind: "file", type: "image/png", getAsFile: () => f };
  assert.equal(clipboardMediaFiles(dt([f], [asItem])).length, 1);
  // …and a browser that populates only `items` still yields the file.
  assert.equal(clipboardMediaFiles(dt([], [asItem])).length, 1);
  // A non-file item (the text/html flavour of a copied image) is not one.
  assert.equal(clipboardMediaFiles(dt([], [{ kind: "string", type: "text/html" }])).length, 0);
  assert.equal(clipboardMediaFiles(null).length, 0);
});

test("a text field owns its own paste", () => {
  const el = (tag: string, extra: object = {}) =>
    ({ nodeType: 1, tagName: tag, isContentEditable: false, ...extra } as unknown as EventTarget);
  assert.equal(isEditableTarget(el("INPUT")), true);
  assert.equal(isEditableTarget(el("TEXTAREA")), true);
  assert.equal(isEditableTarget(el("DIV", { isContentEditable: true })), true);
  assert.equal(isEditableTarget(el("DIV")), false);
  assert.equal(isEditableTarget(el("BUTTON")), false);
  assert.equal(isEditableTarget(null), false);
});

test("composer paste extracts media files while ignoring pure text", () => {
  const textPaste = dt([file("prompt.txt", "text/plain")]);
  assert.equal(clipboardMediaFiles(textPaste).length, 0);

  const imagePaste = dt([file("reference.png", "image/png")]);
  const extracted = clipboardMediaFiles(imagePaste);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].name, "reference.png");
  assert.equal(extracted[0].type, "image/png");

  const multiPaste = dt([
    file("ref1.png", "image/png"),
    file("ref2.jpg", "image/jpeg"),
    file("prompt.txt", "text/plain"),
  ]);
  const multiExtracted = clipboardMediaFiles(multiPaste);
  assert.equal(multiExtracted.length, 2);
  assert.deepEqual(multiExtracted.map((f) => f.name), ["ref1.png", "ref2.jpg"]);
});

