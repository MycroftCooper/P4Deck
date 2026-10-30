import { it, expect, vi } from "vitest";
const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  release: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: api.invoke,
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));
vi.mock("../changelists/moveOptimism", () => ({
  releaseLocalMoveAdmission: api.release,
}));
vi.mock("../../infrastructure/backend/frontendOperationLog", () => ({
  recordFrontendOperationLog: api.log,
}));
import { admissionPort } from "./admissionPort";
it("uses frozen memory/release wire with decimal revisions intact", async () => {
  await admissionPort.query();
  expect(api.invoke).toHaveBeenLastCalledWith("action_write_fences");
  const request = {
    fenceId: "f",
    revision: "18446744073709551615",
    scope: { server: "s", user: "u", client: "c" },
    acknowledgeUnknown: true as const,
  };
  await admissionPort.release(request);
  expect(api.invoke).toHaveBeenLastCalledWith("action_release_unknown", {
    request,
  });
  const fn = vi.fn();
  await admissionPort.subscribe(fn);
  expect(api.listen.mock.calls[0][0]).toBe("action-admission-changed");
  api.listen.mock.calls[0][1]({ payload: { fenceId: "f", revision: "2" } });
  expect(fn).toHaveBeenCalledWith({ fenceId: "f", revision: "2" });
});
