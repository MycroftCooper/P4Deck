import { t } from "../../shared/i18n";
import type { FileActionResult } from "../../shared/contracts";

/** A resolved bridge promise does not imply that the P4 process succeeded. */
export function fileActionFeedback(
  result: FileActionResult,
  _zh: boolean,
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
    ? t("shell.operation.cancelled")
    : failed
      ? t("shell.operation.did.not.fully.succeed")
      : !operation
        ? t("shell.operation.feedback.received.no.exit")
        : warnings
          ? t("shell.operation.finished.with.warnings")
          : t("shell.completed");
  const scope = failed ? t("shell.some.files.may.have.changed") : "";
  return {
    failed,
    message: [
      status,
      result.message,
      warnings,
      scope,
      operation ? `${t("shell.operation")}: ${operation.operationId}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
