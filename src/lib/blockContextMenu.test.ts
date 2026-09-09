// Tests verifying that BlockContextMenu includes Assemble and Retake options at the top.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

test("BlockContextMenu renders Assemble and Retake at the top of the menu options", () => {
  const src = readSrc("../components/timeline/BlockContextMenu.tsx");

  // Props include onAssemble and onRetake
  assert.match(src, /onAssemble\?: \(\) => void;/);
  assert.match(src, /onRetake\?: \(\) => void;/);

  // Positioned right after header divider and before Compare takes
  const dividerIdx = src.indexOf('<div className="menu-divider" />');
  const assembleIdx = src.indexOf("<span>Assemble...</span>");
  const retakeIdx = src.indexOf("<span>Retake...</span>");
  const compareIdx = src.indexOf("<span>Compare takes...</span>");

  assert.ok(dividerIdx > 0, "menu divider found");
  assert.ok(assembleIdx > dividerIdx, "Assemble... is after the header divider");
  assert.ok(retakeIdx > assembleIdx, "Retake... follows Assemble...");
  assert.ok(compareIdx > retakeIdx, "Compare takes... is after Assemble and Retake");
});

test("WsTimeline wires onAssemble and onRetake to open takes and prompt modals", () => {
  const src = readSrc("../components/shell/WsTimeline.tsx");

  assert.match(src, /onAssemble=\{/);
  assert.match(src, /ws\.openModal\(\{\s*kind:\s*"takes",\s*blockId:\s*contextMenu\.clip\.block_id\s*\}\)/);
  assert.match(src, /onRetake=\{/);
  assert.match(src, /ws\.openModal\(\{\s*kind:\s*"prompt",\s*blockId:\s*contextMenu\.clip\.block_id\s*\}\)/);
});

test("Timeline.tsx wires onAssemble and onRetake to open takes and prompt modals", () => {
  const src = readSrc("../components/timeline/Timeline.tsx");

  assert.match(src, /onAssemble=\{/);
  assert.match(src, /kind:\s*"takes",\s*blockId:\s*contextMenu\.clip\.block_id/);
  assert.match(src, /onRetake=\{/);
  assert.match(src, /kind:\s*"prompt",\s*blockId:\s*contextMenu\.clip\.block_id/);
});
