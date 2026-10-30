import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import {
  customSubmitIntentOf,
  customSubmitSessionOf,
  isCustomSubmitActionResult,
  lookupCustomSubmitReceipt,
  type CustomSubmitActionResult,
} from "./customSubmitLifecycle";
import { invoke } from "@tauri-apps/api/core";

const action = (
  state: CustomSubmitActionResult["state"],
  toolState: CustomSubmitActionResult["tool"]["toolState"],
  exitCode: number | null = null,
): CustomSubmitActionResult => ({
  kind: "customSubmit",
  operationId: "req-1",
  state,
  outcome: state === "rejected" ? "rejected" : "unknown",
  tool: {
    requestId: "req-1",
    changeId: "42",
    executablePath: "C:\\tool\\submit.exe",
    toolState,
    parentRunning: toolState === "started",
    exitCode,
    reason: toolState === "notStarted" ? "toolMissing" : null,
  },
  optimistic: "intentOnly",
  message: "",
});
it("started is running intent only — never success, even with exitCode 0", () => {
  const started = action("running", "started", 0);
  expect(isCustomSubmitActionResult(started)).toBe(true);
  expect(customSubmitIntentOf(started)).toBe("running");
  expect(customSubmitSessionOf(started)?.state).toBe("started");
  // No success/failure mapping exists: intent can only be running/rejected/unknown.
  expect(["running", "rejected", "unknown"]).toContain(
    customSubmitIntentOf(started),
  );
});
it("notStarted is rejected (positive not-launched evidence); outcomeUnknown is explicit unknown", () => {
  expect(customSubmitIntentOf(action("rejected", "notStarted"))).toBe(
    "rejected",
  );
  // exitCode (0 or non-zero) never upgrades outcomeUnknown to success/failure.
  expect(customSubmitIntentOf(action("unknown", "outcomeUnknown", 0))).toBe(
    "unknown",
  );
  expect(customSubmitIntentOf(action("unknown", "outcomeUnknown", 1))).toBe(
    "unknown",
  );
});
it("legacy raw Session stays supported (mock/pre-migration host)", () => {
  const legacy = {
    requestId: "req-2",
    changeId: "42",
    state: "started" as const,
    executablePath: "x",
    exitCode: 0,
    reason: null,
  };
  expect(isCustomSubmitActionResult(legacy)).toBe(false);
  expect(customSubmitIntentOf(legacy)).toBe("running");
  expect(customSubmitSessionOf(legacy)).toBe(legacy);
});
it("unknown recovery looks up the SAME requestId once with the exact connection", async () => {
  const connection = {
    profileId: "p",
    generation: "18446744073709551615",
    server: "s",
    user: "u",
    client: "c",
  };
  vi.mocked(invoke).mockResolvedValue({
    kind: "found",
    receipt: { state: "interrupted", result: null },
  });
  const found = await lookupCustomSubmitReceipt("req-1", connection);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("workflow_action_lookup", {
    request: { operationId: "req-1", connection },
  });
  expect(found.kind).toBe("found");
});
