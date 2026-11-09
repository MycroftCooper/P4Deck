import { afterEach, expect, it, vi } from "vitest";
import {
  diskMetrics,
  progressSummary,
  updateProgress,
  type ActiveOperations,
} from "./statusProgress";
it("uses remaining capacity for the strict 5% threshold", () => {
  expect(diskMetrics({ path: "/", total: 100, available: 5 })?.low).toBe(false);
  expect(diskMetrics({ path: "/", total: 100, available: 4 })?.low).toBe(true);
  expect(diskMetrics({ path: "/", total: 0, available: 0 })).toBeUndefined();
});
it("tracks concurrency and clears completed/cancelled operations", () => {
  const active: ActiveOperations = new Map();
  const send = (
    operationId: string,
    type: Parameters<typeof updateProgress>[1]["type"],
    progress?: number,
  ) => updateProgress(active, { operationId, type, progress, timestamp: "" });
  send("a", "started", 2);
  send("b", "queued");
  send("a", "progress", 50);
  expect(progressSummary(active.values())).toEqual({
    count: 2,
    percent: undefined,
  });
  send("b", "progress", 30);
  expect(progressSummary(active.values()).percent).toBe(40);
  send("a", "completed");
  send("b", "cancelled");
  send("a", "progress", 90);
  expect(progressSummary(active.values()).count).toBe(0);
});

it("keeps the command and queued/running phase without retaining output", () => {
  const active: ActiveOperations = new Map();
  updateProgress(active, {
    operationId: "query",
    type: "queued",
    message: "p4 fstat //depot/...",
    timestamp: "",
  });
  expect(active.get("query")).toMatchObject({
    label: "p4 fstat //depot/...",
    phase: "queued",
  });
  updateProgress(active, {
    operationId: "query",
    type: "started",
    timestamp: "",
  });
  updateProgress(active, {
    operationId: "query",
    type: "stdout",
    message: "large output",
    timestamp: "",
  });
  expect(active.get("query")).toEqual({
    id: "query",
    label: "p4 fstat //depot/...",
    phase: "running",
    progress: undefined,
    current: undefined,
    total: undefined,
    // One stdout line is counted, its text is never retained.
    lines: 1,
    startedAt: expect.any(Number),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

it("counts stdout lines per operation and ignores stderr or unknown operations", () => {
  const active: ActiveOperations = new Map();
  updateProgress(active, {
    operationId: "sync",
    type: "started",
    message: "p4 sync //depot/...",
    timestamp: "",
  });
  for (const type of ["stdout", "stdout", "stdout"] as const)
    updateProgress(active, { operationId: "sync", type, timestamp: "" });
  updateProgress(active, {
    operationId: "sync",
    type: "stderr",
    message: "boom",
    timestamp: "",
  });
  updateProgress(active, {
    operationId: "other",
    type: "stdout",
    message: "ignored",
    timestamp: "",
  });
  expect(active.get("sync")?.lines).toBe(3);
  expect(active.has("other")).toBe(false);
});

it("stores countable progress units and keeps the percent monotonic", () => {
  const active: ActiveOperations = new Map();
  const send = (
    type: Parameters<typeof updateProgress>[1]["type"],
    extra: {
      progress?: number;
      progressCurrent?: number;
      progressTotal?: number;
    } = {},
  ) =>
    updateProgress(active, {
      operationId: "sync",
      type,
      message: "p4 sync //depot/...",
      timestamp: "",
      ...extra,
    });
  send("started");
  send("progress", { progress: 40, progressCurrent: 25, progressTotal: 1000 });
  expect(active.get("sync")).toMatchObject({
    phase: "running",
    progress: 40,
    current: 25,
    total: 1000,
  });
  // A reordered/late event must not move the bar backwards.
  send("progress", { progress: 10 });
  expect(active.get("sync")?.progress).toBe(40);
  // Counts can arrive without a percent, and vice versa.
  send("progress", { progressCurrent: 30 });
  expect(active.get("sync")).toMatchObject({ progress: 40, current: 30 });
  send("progress", { progressCurrent: Number.NaN, progressTotal: -5 });
  expect(active.get("sync")).toMatchObject({ current: 30, total: 0 });
});

it("preserves counts and line counters when the phase changes", () => {
  const active: ActiveOperations = new Map();
  const base = { operationId: "sync", message: "p4 sync //depot/..." };
  updateProgress(active, { ...base, type: "queued", timestamp: "" });
  updateProgress(active, {
    ...base,
    type: "progress",
    progress: 25,
    progressCurrent: 2,
    progressTotal: 8,
    timestamp: "",
  });
  updateProgress(active, { ...base, type: "stdout", timestamp: "" });
  updateProgress(active, { ...base, type: "started", timestamp: "" });
  expect(active.get("sync")).toMatchObject({
    phase: "running",
    progress: 25,
    current: 2,
    total: 8,
    lines: 1,
  });
});

it("derives startedAt from the event timestamp and falls back to now", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  const active: ActiveOperations = new Map();
  updateProgress(active, {
    operationId: "timed",
    type: "queued",
    message: "p4 sync",
    timestamp: "2025-12-31T23:59:50.000Z",
  });
  updateProgress(active, {
    operationId: "untimed",
    type: "queued",
    message: "p4 sync",
    timestamp: "",
  });
  expect(active.get("timed")?.startedAt).toBe(
    Date.parse("2025-12-31T23:59:50.000Z"),
  );
  expect(active.get("untimed")?.startedAt).toBe(Date.now());
});
