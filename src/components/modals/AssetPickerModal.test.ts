// node --test src/components/modals/AssetPickerModal.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { probeElementFor } from "../../lib/mediaProbe.ts";

const SOURCE = readFileSync(
  new URL("./AssetPickerModal.tsx", import.meta.url),
  "utf8"
);

test("AssetPickerModal imports and renders AudioPreviewThumb for audio items", () => {
  assert.match(SOURCE, /import AudioPreviewThumb from "\.\.\/ui\/AudioPreviewThumb";/);
  assert.match(SOURCE, /<AudioPreviewThumb/);
  assert.match(SOURCE, /<span className="badge" style=\{\{[^}]*color:\s*"#c97aff"[^}]*\}\}>\s*audio\s*<\/span>/s);
});

test("AssetPickerModal implements infinite scroll pagination with visibleCount and IntersectionObserver", () => {
  assert.match(SOURCE, /const PICKER_PAGE = \d+;/);
  assert.match(SOURCE, /const \[visibleCount,\s*setVisibleCount\] = useState\(PICKER_PAGE\);/);
  assert.match(SOURCE, /limit:\s*visibleCount/);
  assert.match(SOURCE, /new IntersectionObserver/);
  assert.match(SOURCE, /setVisibleCount\(\(n\)\s*=>\s*n\s*\+\s*PICKER_PAGE\);/);
  assert.match(SOURCE, /ref=\{sentinelRef\}/);
});

test("AssetPickerModal provides a 'This project' filter and scopes query when selected", () => {
  assert.match(SOURCE, /\{ id: "project", label: "This project" \}/);
  assert.match(SOURCE, /const isProjectSource = source === "project";/);
  assert.match(SOURCE, /projectId:\s*isProjectSource \? projectId : undefined/);
  assert.match(SOURCE, /if \(source === "project" && !e\.mine\) return false;/);
});

test("probeElementFor identifies various audio formats correctly", () => {
  assert.equal(probeElementFor({ b2_key: "library/828d9eb538fce6fc.mp3" }), "audio");
  assert.equal(probeElementFor({ b2_key: "audio/track.wav" }), "audio");
  assert.equal(probeElementFor({ kind: "audio" }), "audio");
  assert.equal(probeElementFor({ content_type: "audio/mpeg" }), "audio");
  assert.equal(probeElementFor({ content_type: "audio/wav" }), "audio");
  assert.equal(probeElementFor({ b2_key: "image.png", kind: "image" }), null);
  assert.equal(probeElementFor({ b2_key: "clip.mp4", kind: "video" }), "video");
});

test("project filtering predicate keeps project assets and excludes foreign assets", () => {
  const currentProjectId = "proj-123";
  const assets = [
    { id: "a1", project_id: "proj-123", b2_key: "a1.mp3" },
    { id: "a2", project_id: "proj-456", b2_key: "a2.png" },
    { id: "a3", project_id: "proj-123", b2_key: "a3.mp4" },
    { id: "a4", project_id: null, b2_key: "a4.png" },
  ];

  const filtered = assets.filter((a) => a.project_id === currentProjectId);
  assert.deepEqual(filtered.map((a) => a.id), ["a1", "a3"]);
});
