import { expect, it } from "vitest";
import {
  normalizeLegacyFileResult,
  normalizeDispatchFailure,
} from "./legacyResult";
it("affectedPaths and zero exit code cannot fabricate per-file success", () => {
  const r = normalizeLegacyFileResult(
    { operationId: "op", paths: ["a", "b"] },
    {
      affectedPaths: ["a", "b"],
      message: "ok",
      operation: { operationId: "op", exitCode: 0, events: [], durationMs: 1 },
    },
  );
  expect(r.outcome).toBe("unknown");
  expect(r.items).toEqual([
    { path: "a", outcome: "unknown" },
    { path: "b", outcome: "unknown" },
  ]);
  expect(r.invalidationPaths).toEqual(["a", "b"]);
});
it("missing result after String Err stays unknown, not failed-before-dispatch", () => {
  expect(normalizeLegacyFileResult({ paths: ["a"] })).toMatchObject({
    outcome: "unknown",
    requiresReconciliation: true,
  });
  expect(normalizeDispatchFailure()).toEqual({
    outcome: "unknown",
    mayHaveWritten: true,
  });
});
it("only explicit admission evidence can prove zero dispatch", () => {
  expect(
    normalizeDispatchFailure({
      kind: "notDispatched",
      source: "localValidation",
    }),
  ).toEqual({ outcome: "notDispatched", mayHaveWritten: false });
});
it("retains caller operation identity and flags mismatched receipts", () => {
  expect(
    normalizeLegacyFileResult(
      { operationId: "expected", paths: [] },
      {
        message: "",
        affectedPaths: [],
        operation: {
          operationId: "other",
          exitCode: 0,
          events: [],
          durationMs: 0,
        },
      },
    ),
  ).toMatchObject({
    operationId: "expected",
    correlation: "mismatch",
    outcome: "unknown",
  });
});
