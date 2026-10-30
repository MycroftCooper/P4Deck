// @vitest-environment jsdom
import { act } from "react";
import { it, expect, vi, beforeEach } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import { useServerStatus } from "./useServerStatus";
const api = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: api.listen }));
vi.mock("../../infrastructure/backend/frontendOperationLog", () => ({
  recordFrontendOperationLog: vi.fn(async () => ({ status: "recorded" })),
}));
const hint = {
  profileId: "p",
  server: "fixture.invalid",
  user: "u",
  client: "c",
};
const snapshot = {
  scope: { ...hint, generation: "9007199254740993" },
  revision: "9007199254740993",
  connection: "reachable",
  access: "loginRequired",
  quality: "unknown",
  sampleCount: 0,
  reasonCode: "loginRequired",
  source: "passive",
  connectionSource: "passive",
  observedAt: Date.now(),
  expiresAt: Date.now() + 60000,
};
const h = dialogHarness();
function View({
  binding = "one",
  native = true,
}: {
  binding?: string;
  native?: boolean;
}) {
  const status = useServerStatus(native, binding, hint);
  return (
    <button disabled={!status.canCheck || status.busy} onClick={status.check}>
      {status.view?.access ?? "unknown"}
    </button>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  api.listen.mockResolvedValue(api.stop);
  api.invoke.mockResolvedValue(snapshot);
});
it("actual adapter mounts via memory IPC, and only explicit click invokes manual command once", async () => {
  let complete!: (value: unknown) => void;
  api.invoke.mockImplementation((command: string) =>
    command === "get_server_status"
      ? Promise.resolve(snapshot)
      : new Promise((r) => (complete = r)),
  );
  await h.render(<View />);
  expect(api.listen).toHaveBeenCalledWith(
    "server-status-changed",
    expect.any(Function),
  );
  expect(api.invoke).toHaveBeenCalledExactlyOnceWith("get_server_status");
  await act(async () => {
    const b = document.querySelector("button")!;
    b.click();
    b.click();
  });
  expect(api.invoke).toHaveBeenCalledTimes(2);
  expect(api.invoke).toHaveBeenLastCalledWith("check_server_status", {
    expectedScope: snapshot.scope,
    requestId: expect.stringMatching(/^[a-zA-Z0-9_-]+$/),
  });
  await act(async () =>
    complete({
      status: "completed",
      snapshot: { ...snapshot, revision: "9007199254740994" },
    }),
  );
  expect(document.querySelector("button")?.textContent).toBe("loginRequired");
});
it("connection binding reset disables stale display while awaiting new memory read", async () => {
  await h.render(<View />);
  let finish!: (value: unknown) => void;
  api.invoke.mockImplementation(() => new Promise((r) => (finish = r)));
  await h.render(<View binding="two" />);
  expect(document.querySelector("button")?.textContent).toBe("unknown");
  expect(document.querySelector("button")?.disabled).toBe(true);
  expect(api.stop).toHaveBeenCalledOnce();
  await act(async () =>
    finish({
      ...snapshot,
      scope: { ...snapshot.scope, generation: "9007199254740994" },
    }),
  );
  expect(document.querySelector("button")?.disabled).toBe(false);
});
it("browser/mock mode performs zero host calls", async () => {
  await h.render(<View native={false} />);
  expect(api.invoke).not.toHaveBeenCalled();
  expect(api.listen).not.toHaveBeenCalled();
});
