import { tFor } from "../../shared/i18n";
import type {
  JournalState,
  LogLevel,
  OperationFailureKind,
} from "../../shared/contracts";

/** Single source of truth for log level labels/filtering/journal projection. */
export const LOG_LEVELS = [
  "info",
  "warning",
  "error",
  "cancelled",
] as const satisfies readonly LogLevel[];

export function logLevelLabel(level: LogLevel, zh: boolean): string {
  switch (level) {
    case "info":
      return "Info";
    case "warning":
      return "Warning";
    case "error":
      return "Error";
    case "cancelled":
      return tFor(zh ? "zh-CN" : "en-US", "tools.cancelled");
    default: {
      // Exhaustiveness guard: a future LogLevel must be handled here.
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

/** Journal projection: a cancelled log must never show up as a successful operation. */
export function journalMappingForLogLevel(level: LogLevel): {
  state: JournalState;
  failure?: OperationFailureKind;
} {
  switch (level) {
    case "error":
      return { state: "failed", failure: "commandFailure" };
    case "cancelled":
      return { state: "failed", failure: "cancelled" };
    case "warning":
    case "info":
      return { state: "succeeded" };
    default: {
      const _exhaustive: never = level;
      return { state: _exhaustive };
    }
  }
}
