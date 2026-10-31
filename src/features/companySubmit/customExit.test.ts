import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  createCustomExitConsumer,
  validParentExit,
  type CustomExitPort,
} from "./customExit";
const connection = {
  profileId: "fixture",
  generation: "9007199254740993",
  server: "fixture.invalid",
  user: "u",
  client: "c",
};
const event = {
  requestId: "request-1",
  changeId: "42",
  connection,
  exitCode: 0,
};
function fixture() {
  let scope = "a";
  const port: CustomExitPort = {
    owner: true,
    scope: () => scope,
    snapshot: vi.fn(async () => connection),
    invalidate: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    report: vi.fn(),
  };
  return {
    port,
    setScope: (s: string) => {
      scope = s;
    },
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("parent exit", () => {
  it("refreshes once while duplicate arrives during snapshot", async () => {
    const { port } = fixture();
    const d = deferred<typeof connection>();
    port.snapshot = vi.fn(() => d.promise);
    const c = createCustomExitConsumer(port);
    const a = c.receive(event);
    await c.receive(event);
    d.resolve(connection);
    await a;
    expect(port.refresh).toHaveBeenCalledTimes(1);
    expect(port.invalidate).toHaveBeenCalledTimes(1);
  });
  it("compares exact generation beyond JS integer range", async () => {
    const { port } = fixture();
    port.snapshot = vi.fn(async () => ({
      ...connection,
      generation: "9007199254740992",
    }));
    await createCustomExitConsumer(port).receive(event);
    expect(port.invalidate).toHaveBeenCalledOnce();
    expect(port.refresh).not.toHaveBeenCalled();
  });
  it("old workspace invalidates without querying pending", async () => {
    const { port } = fixture();
    port.snapshot = vi.fn(async () => ({ ...connection, client: "other" }));
    await createCustomExitConsumer(port).receive(event);
    expect(port.refresh).not.toHaveBeenCalled();
  });
  it("popout only invalidates", async () => {
    const { port } = fixture();
    port.owner = false;
    await createCustomExitConsumer(port).receive(event);
    expect(port.invalidate).toHaveBeenCalledOnce();
    expect(port.snapshot).not.toHaveBeenCalled();
    expect(port.refresh).not.toHaveBeenCalled();
  });
  it("connection change during passive snapshot prevents refresh", async () => {
    const { port, setScope } = fixture();
    const d = deferred<typeof connection>();
    port.snapshot = () => d.promise;
    const a = createCustomExitConsumer(port).receive(event);
    await Promise.resolve();
    setScope("b");
    d.resolve(connection);
    await a;
    expect(port.refresh).not.toHaveBeenCalled();
  });
  it("unmount prevents late refresh", async () => {
    const { port } = fixture();
    const d = deferred<typeof connection>();
    port.snapshot = () => d.promise;
    const c = createCustomExitConsumer(port);
    const a = c.receive(event);
    await Promise.resolve();
    c.stop();
    d.resolve(connection);
    await a;
    expect(port.refresh).not.toHaveBeenCalled();
  });
  it("refresh failure logs once and never retries business", async () => {
    const { port } = fixture();
    port.refresh = vi.fn(async () => {
      throw Error("synthetic");
    });
    const c = createCustomExitConsumer(port);
    await c.receive(event);
    await c.receive(event);
    expect(port.report).toHaveBeenCalledOnce();
    expect(port.refresh).toHaveBeenCalledOnce();
  });
  it("remounted listener shares dedupe", async () => {
    const { port } = fixture();
    const seen = new Set<string>();
    const a = createCustomExitConsumer(port, seen);
    await a.receive(event);
    a.stop();
    await createCustomExitConsumer(port, seen).receive(event);
    expect(port.refresh).toHaveBeenCalledOnce();
  });
  it("new request refreshes independently", async () => {
    const { port } = fixture();
    const c = createCustomExitConsumer(port);
    await c.receive(event);
    await c.receive({ ...event, requestId: "request-2" });
    expect(port.refresh).toHaveBeenCalledTimes(2);
  });
  it.each([
    null,
    {},
    { ...event, changeId: "default" },
    { ...event, connection: { ...connection, generation: 9007199254740992 } },
    { ...event, connection: { ...connection, client: "" } },
  ])("rejects malformed event %j", async (value) => {
    const { port } = fixture();
    expect(validParentExit(value)).toBe(false);
    await createCustomExitConsumer(port).receive(value);
    expect(port.invalidate).not.toHaveBeenCalled();
  });
});

import {
  claimCustomSubmitChange,
  isCustomSubmitChangeActive,
  resetCustomSubmitSessions,
} from "./customSubmitSessions";

describe("parent exit occupancy", () => {
  beforeEach(() => resetCustomSubmitSessions());

  it("releases the exited request before refreshing, even when refresh fails", async () => {
    const { port } = fixture();
    claimCustomSubmitChange("a", "42", "request-1");
    let releasedBeforeRefresh = false;
    port.refresh = vi.fn(async () => {
      releasedBeforeRefresh = !isCustomSubmitChangeActive("a", "42");
      throw Error("synthetic");
    });
    await createCustomExitConsumer(port).receive(event);
    expect(releasedBeforeRefresh).toBe(true);
    expect(isCustomSubmitChangeActive("a", "42")).toBe(false);
    expect(port.report).toHaveBeenCalledOnce();
  });

  it("releases a terminal exit whose exit code is unavailable", async () => {
    const { port } = fixture();
    claimCustomSubmitChange("a", "42", "request-1");
    await createCustomExitConsumer(port).receive({ ...event, exitCode: null });
    expect(isCustomSubmitChangeActive("a", "42")).toBe(false);
  });

  it("never releases a different request or changelist", async () => {
    const { port } = fixture();
    claimCustomSubmitChange("a", "42", "request-1");
    claimCustomSubmitChange("a", "43", "request-2");
    claimCustomSubmitChange("b", "42", "request-3");
    await createCustomExitConsumer(port).receive(event);
    expect(isCustomSubmitChangeActive("a", "42")).toBe(false);
    expect(isCustomSubmitChangeActive("a", "43")).toBe(true);
    expect(isCustomSubmitChangeActive("b", "42")).toBe(true);
  });

  it("does not release occupancy for a malformed exit event", async () => {
    const { port } = fixture();
    claimCustomSubmitChange("a", "42", "request-1");
    await createCustomExitConsumer(port).receive({
      ...event,
      changeId: "default",
    });
    expect(isCustomSubmitChangeActive("a", "42")).toBe(true);
  });
});
