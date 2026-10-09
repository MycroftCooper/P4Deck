import type { LogLevel, OperationSource } from "../../shared/contracts/types";

export interface LogViewPreferences {
  level: LogLevel | "";
  source: OperationSource | "";
  followTail: boolean;
}

export const defaultLogViewPreferences: LogViewPreferences = {
  level: "",
  source: "",
  followTail: true,
};

export function readLogViewPreferences(raw: string | null): LogViewPreferences {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return defaultLogViewPreferences;
    const candidate = value as Partial<LogViewPreferences>;
    return {
      level: ["", "info", "warning", "error"].includes(candidate.level ?? "")
        ? (candidate.level ?? "")
        : "",
      source: ["", "gui", "terminal"].includes(candidate.source ?? "")
        ? (candidate.source ?? "")
        : "",
      followTail: candidate.followTail !== false,
    };
  } catch {
    return defaultLogViewPreferences;
  }
}
