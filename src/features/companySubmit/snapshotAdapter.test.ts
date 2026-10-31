import { expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { tauriBackend } from "../../infrastructure/backend/tauriBackend";
it("reads the exact host snapshot with no caller identity or RuntimeInfo conversion", async () => {
  const snapshot = {
    profileId: "synthetic",
    generation: "18446744073709551615",
    server: "synthetic.invalid:1666",
    user: "fixture",
    client: "fixture",
  };
  invoke.mockResolvedValue(snapshot);
  expect(await tauriBackend.companySubmitConnectionSnapshot()).toBe(snapshot);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "company_submit_connection_snapshot",
  );
});

it("passes only the fixed custom start body and uses a no-argument status query", async () => {
  invoke.mockClear();
  const request = {
    changeId: "42",
    connection: {
      profileId: "fixture",
      generation: "18446744073709551615",
      server: "fixture.invalid",
      user: "u",
      client: "c",
    },
    requestId: "click-1",
  };
  const session = {
    requestId: "click-1",
    changeId: "42",
    state: "started",
    executablePath: "C:\\fixture\\submit.exe",
    exitCode: null,
    reason: null,
  };
  invoke.mockResolvedValue(session);
  expect(await tauriBackend.customSubmitStart(request)).toBe(session);
  expect(invoke).toHaveBeenLastCalledWith("custom_submit_start", { request });
  expect(await tauriBackend.customSubmitStatus()).toBe(session);
  expect(invoke).toHaveBeenLastCalledWith("custom_submit_status");
});
