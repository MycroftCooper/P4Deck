// @vitest-environment jsdom
import { act, Activity, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ConnectionStatus,
  RuntimeInfo,
} from "../../shared/contracts/types";
import { useRuntime } from "./useRuntime";

const backend = vi.hoisted(() => ({
  runtimeInfo: vi.fn(),
  testConnection: vi.fn(),
  queryLoginStatus: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
const initial: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  activeProfileId: "active",
  contextGeneration: 1,
  context: {
    server: "p4:1666",
    user: "tester",
    client: "workspace",
    cwd: "C:/workspace",
  },
  connection: {
    state: "notTested",
    message: "not tested",
    recovery: "retry",
    server: "p4:1666",
  },
};
const connected: ConnectionStatus = {
  ...initial.connection,
  state: "connected",
  recovery: "none",
};
const failure: ConnectionStatus = {
  ...initial.connection,
  state: "networkError",
  errorCode: "networkError",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let dispose: (() => Promise<void>) | undefined;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.runtimeInfo.mockResolvedValue(initial);
  backend.testConnection.mockResolvedValue(connected);
  backend.queryLoginStatus.mockResolvedValue(connected);
});
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  vi.useRealTimers();
  vi.resetAllMocks();
});
async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  dispose = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  let value!: ReturnType<typeof useRuntime>;
  function View() {
    value = useRuntime();
    return null;
  }
  const render = async (mode: "visible" | "hidden") =>
    act(async () =>
      root.render(
        <StrictMode>
          <Activity mode={mode}>
            <View />
          </Activity>
        </StrictMode>,
      ),
    );
  await render("visible");
  return Object.assign(() => value, {
    // Like Fast Refresh, Activity reconnects effects while retaining hook state.
    replayEffects: async () => {
      await render("hidden");
      await render("visible");
    },
    render,
  });
}
it("automatically verifies connectivity and login once under StrictMode", async () => {
  const login = deferred<ConnectionStatus>();
  backend.queryLoginStatus.mockReturnValue(login.promise);
  const value = await mount();
  expect(value().checkingConnection).toBe(true);
  expect(value().runtime.connection.state).toBe("notTested");
  const identity = value().connectionKey;
  await act(async () => value().applyRuntime(initial));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(value().checkingConnection).toBe(true);
  await act(async () => login.resolve(connected));
  expect(value().runtime.connection.state).toBe("connected");
  expect(value().checkingConnection).toBe(false);
  expect(value().connectionKey).toBe(identity);
  expect(backend.runtimeInfo).toHaveBeenCalledTimes(1);
  expect(backend.testConnection).toHaveBeenCalledTimes(1);
  expect(backend.queryLoginStatus).toHaveBeenCalledTimes(1);
  await act(async () => value().applyRuntime(initial));
  expect(value().runtime.connection.state).toBe("connected");
});
it("ignores the old login result after switching profiles and verifies the new connection", async () => {
  const login = deferred<ConnectionStatus>();
  backend.queryLoginStatus.mockReturnValueOnce(login.promise);
  const value = await mount();
  const identity = value().connectionKey;
  const next = {
    ...initial,
    activeProfileId: "next",
    contextGeneration: 2,
    context: { ...initial.context, server: "other:1666" },
  };
  await act(async () => value().applyRuntime(next));
  expect(value().runtime.context.server).toBe("other:1666");
  expect(value().runtime.connection.state).toBe("connected");
  expect(value().connectionKey).not.toBe(identity);
  await act(async () => login.resolve(failure));
  expect(value().runtime.context.server).toBe("other:1666");
  expect(value().runtime.connection.state).toBe("connected");
  expect(backend.testConnection).toHaveBeenCalledTimes(2);
});
it("does not overwrite a newer manual verification or launch stale login queries", async () => {
  const probe = deferred<ConnectionStatus>();
  backend.testConnection.mockReturnValue(probe.promise);
  const value = await mount();
  await act(async () => value().applyConnection(initial.context, connected));
  await act(async () => probe.resolve(failure));
  expect(value().runtime.connection.state).toBe("connected");
  expect(backend.queryLoginStatus).not.toHaveBeenCalled();
});
it("publishes failure without looping, then checks again when the network returns", async () => {
  backend.testConnection.mockResolvedValueOnce(failure);
  const value = await mount();
  expect(value().runtime.connection.state).toBe("networkError");
  expect(backend.testConnection).toHaveBeenCalledTimes(1);
  expect(backend.queryLoginStatus).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(value().runtime.connection.state).toBe("connected");
  expect(backend.testConnection).toHaveBeenCalledTimes(2);
  expect(backend.queryLoginStatus).toHaveBeenCalledTimes(1);
});
it("keeps expired authentication distinct from successful connectivity", async () => {
  backend.queryLoginStatus.mockResolvedValue({
    ...failure,
    state: "ticketExpired",
    errorCode: "ticketExpired",
  });
  const value = await mount();
  expect(value().runtime.connection.state).toBe("ticketExpired");
  expect(value().checkingConnection).toBe(false);
  expect(backend.queryLoginStatus).toHaveBeenCalledTimes(1);
});
it.each(["focus", "p4deck:auto-refresh"])(
  "rechecks an established connection on %s and detects an expired ticket without looping",
  async (event) => {
    const value = await mount();
    expect(value().runtime.connection.state).toBe("connected");
    backend.queryLoginStatus.mockResolvedValue({
      ...failure,
      state: "ticketExpired",
      errorCode: "ticketExpired",
      recovery: "login",
    });
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(value().runtime.connection.state).toBe("ticketExpired");
    expect(backend.testConnection).toHaveBeenCalledTimes(2);
    expect(backend.queryLoginStatus).toHaveBeenCalledTimes(2);
    backend.queryLoginStatus.mockResolvedValue(connected);
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(value().runtime.connection.state).toBe("connected");
    expect(backend.queryLoginStatus).toHaveBeenCalledTimes(3);
  },
);
it.each(["cliMissing", "invalidConfig", "connected"] as const)(
  "does not probe a runtime already marked %s",
  async (state) => {
    backend.runtimeInfo.mockResolvedValue({
      ...initial,
      connection: { ...initial.connection, state },
    });
    await mount();
    expect(backend.testConnection).not.toHaveBeenCalled();
  },
);
it("does not verify or reactivate an empty connection", async () => {
  backend.runtimeInfo.mockResolvedValue({
    ...initial,
    activeProfileId: undefined,
    context: { server: "", user: "", client: "" },
    connection: { ...failure, state: "disconnected" },
  });
  const value = await mount();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(backend.testConnection).not.toHaveBeenCalled();
  expect(value().runtime.activeProfileId).toBeUndefined();
});
it("turns unexpected check errors into a recoverable status", async () => {
  backend.testConnection.mockRejectedValue(new Error("transport unavailable"));
  const value = await mount();
  expect(value().runtime.connection.state).toBe("networkError");
  expect(value().checkingConnection).toBe(false);
  expect(backend.testConnection).toHaveBeenCalledTimes(1);
});
it.each(["connected", "ticketExpired", "networkError"] as const)(
  "does not replay startup discovery over a verified %s state when effects reconnect",
  async (state) => {
    backend.queryLoginStatus.mockResolvedValue({ ...connected, state });
    const value = await mount();
    expect(value().runtime.connection.state).toBe(state);
    const identity = value().connectionKey;
    await value.replayEffects();
    expect(value().runtime.connection.state).toBe(state);
    expect(value().checkingConnection).toBe(false);
    expect(value().connectionKey).toBe(identity);
    expect(backend.runtimeInfo).toHaveBeenCalledTimes(1);
    expect(backend.testConnection).toHaveBeenCalledTimes(1);
  },
);
it("can finish a verification that settles while effects are detached", async () => {
  const probe = deferred<ConnectionStatus>();
  backend.testConnection.mockReturnValue(probe.promise);
  const value = await mount();
  await value.render("hidden");
  await act(async () => probe.resolve(connected));
  await value.render("visible");
  expect(value().runtime.connection.state).toBe("connected");
  expect(value().checkingConnection).toBe(false);
});
it("restarts an obsolete check when metadata changes without changing the connection binding", async () => {
  const probe = deferred<ConnectionStatus>();
  backend.testConnection.mockReturnValueOnce(probe.promise);
  const value = await mount();
  const next = {
    ...initial,
    context: { ...initial.context, swarmBaseUrl: "https://swarm.example.com" },
  };
  await act(async () => value().applyRuntime(next));
  await act(async () => probe.resolve(failure));
  expect(value().runtime.connection.state).toBe("connected");
  expect(value().runtime.context.swarmBaseUrl).toBe(next.context.swarmBaseUrl);
  expect(value().checkingConnection).toBe(false);
});
it.each(["info", "login"] as const)(
  "ends a hung %s check with a recoverable timeout and retries after focus",
  async (phase) => {
    vi.useFakeTimers();
    const stalled = deferred<ConnectionStatus>();
    if (phase === "info")
      backend.testConnection.mockReturnValueOnce(stalled.promise);
    else backend.queryLoginStatus.mockReturnValueOnce(stalled.promise);
    const value = await mount();
    expect(value().checkingConnection).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(45_001));
    expect(value().checkingConnection).toBe(false);
    expect(value().runtime.connection).toMatchObject({
      state: "networkError",
      recovery: "retry",
    });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(value().runtime.connection.state).toBe("connected");
    await act(async () => stalled.resolve(failure));
    expect(value().runtime.connection.state).toBe("connected");
    expect(backend.testConnection).toHaveBeenCalledTimes(2);
    expect(backend.queryLoginStatus).toHaveBeenCalledTimes(
      phase === "info" ? 1 : 2,
    );
  },
);
