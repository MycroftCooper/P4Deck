import type { FileActionResult } from "../../shared/contracts";

/** A resolved bridge promise does not imply that the P4 process succeeded. */
export function fileActionFeedback(
  result: FileActionResult,
  zh: boolean,
): { failed: boolean; message: string } {
  const operation = result.operation;
  const events = operation?.events ?? [];
  const cancelled = events.some((event) => event.type === "cancelled");
  const failed =
    cancelled ||
    (!!operation && operation.exitCode !== 0) ||
    events.some((event) => event.type === "error");
  const warnings = events
    .filter((event) =>
      ["warning", "error", "stderr", "cancelled"].includes(event.type),
    )
    .map((event) => event.message)
    .filter(Boolean)
    .slice(-5)
    .join("\n")
    .slice(0, 8000);
  const status = cancelled
    ? zh
      ? "操作已取消"
      : "Operation cancelled"
    : failed
      ? zh
        ? "操作未完全成功"
        : "Operation did not fully succeed"
      : !operation
        ? zh
          ? "已收到操作反馈（未提供退出状态）"
          : "Operation feedback received (no exit status provided)"
        : warnings
          ? zh
            ? "操作结束，存在警告"
            : "Operation finished with warnings"
          : zh
            ? "操作完成"
            : "Completed";
  const scope = failed
    ? zh
      ? "部分文件可能已改变。取消或失败不会回滚已完成部分，请刷新并检查日志。"
      : "Some files may have changed. Failure or cancellation does not roll back completed changes; refresh and inspect the logs."
    : "";
  return {
    failed,
    message: [
      status,
      result.message,
      warnings,
      scope,
      operation ? `${zh ? "任务" : "Operation"}: ${operation.operationId}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
