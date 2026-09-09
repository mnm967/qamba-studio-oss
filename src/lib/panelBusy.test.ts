import { test } from "node:test";
import assert from "node:assert/strict";
import type { PanelBusyInfo } from "../components/shell/ScenePanelGrid";

export function resolvePanelBusyState(busyVal: PanelBusyInfo): {
  isBusy: boolean;
  isDrawing: boolean;
  isQueued: boolean;
  label: string | null;
} {
  const isBusy = !!busyVal;
  const status =
    typeof busyVal === "object" && busyVal
      ? busyVal.status
      : typeof busyVal === "string"
        ? busyVal
        : null;
  const isDrawing = status === "running";
  const isQueued = status === "queued" || (isBusy && !isDrawing);
  const label = isDrawing ? "drawing…" : isQueued ? "in queue" : null;
  return { isBusy, isDrawing, isQueued, label };
}

export function aggregatePanelJobs(
  jobs: { status: string; payload: { target?: { beat_id?: string; scene_id?: string } } }[]
): Map<string, { status: string }> {
  const map = new Map<string, { status: string }>();
  for (const j of jobs) {
    const t = j.payload?.target ?? {};
    if (t.beat_id) {
      const prev = map.get(t.beat_id);
      if (!prev || (prev.status === "queued" && j.status === "running")) {
        map.set(t.beat_id, { status: j.status });
      }
    }
    if (t.scene_id) {
      const key = `s:${t.scene_id}`;
      const prev = map.get(key);
      if (!prev || (prev.status === "queued" && j.status === "running")) {
        map.set(key, { status: j.status });
      }
    }
  }
  return map;
}

test("resolvePanelBusyState handles null and false", () => {
  assert.deepEqual(resolvePanelBusyState(null), {
    isBusy: false,
    isDrawing: false,
    isQueued: false,
    label: null,
  });
  assert.deepEqual(resolvePanelBusyState(false), {
    isBusy: false,
    isDrawing: false,
    isQueued: false,
    label: null,
  });
});

test("resolvePanelBusyState handles boolean true as in queue fallback", () => {
  const res = resolvePanelBusyState(true);
  assert.equal(res.isBusy, true);
  assert.equal(res.isDrawing, false);
  assert.equal(res.isQueued, true);
  assert.equal(res.label, "in queue");
});

test("resolvePanelBusyState handles running / drawing status", () => {
  const res1 = resolvePanelBusyState("running");
  assert.equal(res1.isBusy, true);
  assert.equal(res1.isDrawing, true);
  assert.equal(res1.isQueued, false);
  assert.equal(res1.label, "drawing…");

  const res2 = resolvePanelBusyState({ status: "running", progress: 0.5 });
  assert.equal(res2.isBusy, true);
  assert.equal(res2.isDrawing, true);
  assert.equal(res2.isQueued, false);
  assert.equal(res2.label, "drawing…");
});

test("resolvePanelBusyState handles queued status", () => {
  const res1 = resolvePanelBusyState("queued");
  assert.equal(res1.isBusy, true);
  assert.equal(res1.isDrawing, false);
  assert.equal(res1.isQueued, true);
  assert.equal(res1.label, "in queue");

  const res2 = resolvePanelBusyState({ status: "queued", progress: null });
  assert.equal(res2.isBusy, true);
  assert.equal(res2.isDrawing, false);
  assert.equal(res2.isQueued, true);
  assert.equal(res2.label, "in queue");
});

test("aggregatePanelJobs gives running jobs precedence over queued jobs for the same beat", () => {
  const jobs = [
    { status: "queued", payload: { target: { beat_id: "b1" } } },
    { status: "running", payload: { target: { beat_id: "b1" } } },
    { status: "queued", payload: { target: { beat_id: "b2" } } },
  ];
  const aggregated = aggregatePanelJobs(jobs);
  assert.equal(aggregated.get("b1")?.status, "running");
  assert.equal(aggregated.get("b2")?.status, "queued");
});
