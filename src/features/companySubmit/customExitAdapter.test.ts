// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
const api = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => api);
import { recordFrontendOperationLog } from "../../infrastructure/backend/frontendOperationLog";
import { matchesExitCache } from "./useCustomExitRefresh";
const c = {
  profileId: "fixture",
  generation: "9007199254740993",
  server: "fixture.invalid",
  user: "u",
  client: "w",
};
it("matches all cached roots of exactly the exited workspace", () => {
  const key = (client: string, cwd: string) => [
    "snapshot",
    "pending",
    JSON.stringify(["tauri", "fixture", "fixture.invalid", "u", client, cwd]),
  ];
  expect(matchesExitCache(key("w", "C:/a"), c)).toBe(true);
  expect(matchesExitCache(key("w", "C:/b"), c)).toBe(true);
  expect(matchesExitCache(key("other", "C:/a"), c)).toBe(false);
  expect(matchesExitCache(["snapshot", "submitted", key("w", "")[2]], c)).toBe(
    false,
  );
  expect(matchesExitCache(["snapshot", "pending", "invalid"], c)).toBe(false);
});
it("writes only frozen fields and returns the actual host receipt", async () => {
  api.invoke.mockResolvedValue({ status: "duplicate" });
  const r = {
    eventId: "exit-1-refresh",
    operationId: "exit-1",
    action: "customSubmit" as const,
    phase: "refresh" as const,
    outcome: "failed" as const,
    code: "refreshFailed" as const,
    targetCount: 0,
    changeId: "42",
    secret: "must-not-cross",
  };
  expect(await recordFrontendOperationLog(r)).toEqual({
    status: "duplicate",
    businessActionRetryAllowed: false,
  });
  expect(api.invoke).toHaveBeenLastCalledWith("record_frontend_operation_log", {
    request: {
      eventId: r.eventId,
      operationId: r.operationId,
      action: r.action,
      phase: r.phase,
      outcome: r.outcome,
      code: r.code,
      targetCount: 0,
      changeId: "42",
    },
  });
});
it("logging IPC failure returns unavailable without retry or throwing", async () => {
  api.invoke.mockClear().mockRejectedValue(Error("synthetic"));
  const r = await recordFrontendOperationLog({
    eventId: "exit-2-refresh",
    operationId: "exit-2",
    action: "customSubmit",
    phase: "refresh",
    outcome: "failed",
    code: "refreshFailed",
    targetCount: 0,
  });
  expect(r.status).toBe("unavailable");
  expect(api.invoke).toHaveBeenCalledOnce();
});
