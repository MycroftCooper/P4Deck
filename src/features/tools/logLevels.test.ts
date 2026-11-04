import { expect, it } from "vitest";
import type { LogLevel } from "../../shared/contracts";
import {
  LOG_LEVELS,
  journalMappingForLogLevel,
  logLevelLabel,
} from "./logLevels";

it("labels every log level, including the cancelled level in both languages", () => {
  expect(LOG_LEVELS).toEqual(["info", "warning", "error", "cancelled"]);
  for (const level of LOG_LEVELS) {
    expect(logLevelLabel(level, false).length).toBeGreaterThan(0);
    expect(logLevelLabel(level, true).length).toBeGreaterThan(0);
  }
  expect(logLevelLabel("cancelled", true)).toBe("已取消");
  expect(logLevelLabel("cancelled", false)).toBe("Cancelled");
  expect(logLevelLabel("error", false)).toBe("Error");
});

it("journal projection never maps a cancelled log to succeeded", () => {
  expect(journalMappingForLogLevel("cancelled")).toEqual({
    state: "failed",
    failure: "cancelled",
  });
  expect(journalMappingForLogLevel("error")).toEqual({
    state: "failed",
    failure: "commandFailure",
  });
  for (const level of ["info", "warning"] as const)
    expect(journalMappingForLogLevel(level)).toEqual({ state: "succeeded" });
  expect(journalMappingForLogLevel("cancelled" as LogLevel).state).not.toBe(
    "succeeded",
  );
});
