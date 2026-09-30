import { expect, it } from "vitest";
import { fileActionFeedback } from "./fileActionFeedback";
import type {
  FileActionResult,
  OperationEvent,
} from "../../shared/contracts/types";
const result = (
  exitCode = 0,
  events: OperationEvent[] = [],
): FileActionResult => ({
  message: "Server feedback",
  affectedPaths: ["//depot/a"],
  operation: { operationId: "op-1", exitCode, events, durationMs: 1 },
});
const event = (
  type: OperationEvent["type"],
  message = "detail",
): OperationEvent => ({ operationId: "op-1", type, message, timestamp: "now" });
it("does not equate a resolved command promise with success", () => {
  const feedback = fileActionFeedback(result(1), true);
  expect(feedback.failed).toBe(true);
  expect(feedback.message).toContain("部分文件可能已改变");
  expect(feedback.message).toContain("op-1");
});
it("does not hide cancellation or error events behind a zero exit code", () => {
  expect(
    fileActionFeedback(result(0, [event("cancelled")]), true).message,
  ).toContain("操作已取消");
  expect(fileActionFeedback(result(0, [event("error")]), false).failed).toBe(
    true,
  );
});
it("preserves warnings and does not invent an exit status when missing", () => {
  const warning = fileActionFeedback(
    result(0, [event("warning", "check this")]),
    true,
  );
  expect(warning.failed).toBe(false);
  expect(warning.message).toContain("check this");
  expect(warning.message).toContain("存在警告");
  expect(
    fileActionFeedback({ affectedPaths: [], message: "Preview" }, true).message,
  ).toContain("未提供退出状态");
});
