import { expect, it } from "vitest";
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
  });
});
