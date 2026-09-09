// The two decisions in localScope.ts, pinned.
//
// The first is consulted by EVERY query in the app — it is what sends a read
// to the machine or to the studio — and the second decides what is on the only
// screen that can open a project at all.
import assert from "node:assert/strict";
import test from "node:test";
import { mergeProjects, projectIdFromPath } from "./localScope.ts";

const PID = "11111111-1111-4111-8111-111111111111";

test("the project id comes off every project route", () => {
  for (const path of [
    `/project/${PID}`,
    `/project/${PID}/`,
    `/project/${PID}/bible`,
    `/project/${PID}/ep/22222222-2222-4222-8222-222222222222/timeline`,
    `/project/${PID}/wizard`,
    `/project/${PID}/chat/33333333-3333-4333-8333-333333333333`,
    `/project/${PID}?tab=refs`,
    `/project/${PID}#top`,
  ]) {
    assert.equal(projectIdFromPath(path), PID, path);
  }
});

test("and off nothing else", () => {
  // `/projects` is the LIST — matching it would put the plane inside a project
  // that is not open, which is how a query lands on the wrong machine.
  for (const path of ["/", "/projects", "/library", "/queue", "/legacy/board", "/ui/local",
                      "/project/not-a-uuid", "/project/", "/projected/x"]) {
    assert.equal(projectIdFromPath(path), null, path);
  }
});

test("the projects list shows one card per project, local first", () => {
  const local = [{ id: "a", title: "On this machine", updated_at: "2026-01-01T00:00:00Z" }];
  const cloud = [
    { id: "a", title: "The backup copy", updated_at: "2026-05-05T00:00:00Z" },
    { id: "b", title: "In the studio", updated_at: "2026-02-02T00:00:00Z" },
  ];
  const merged = mergeProjects(local, cloud);
  assert.deepEqual(merged.map((p) => p.id), ["b", "a"], "newest first");
  assert.equal(merged.find((p) => p.id === "a")!.title, "On this machine",
    "a backed-up project is ONE card, and the local copy is the one the app reads");
});

test("a project with no timestamp still appears", () => {
  const merged = mergeProjects([{ id: "x", title: "No stamp" }], [{ id: "y", updated_at: "2026-01-01T00:00:00Z" }]);
  assert.deepEqual(merged.map((p) => p.id), ["y", "x"]);
});
