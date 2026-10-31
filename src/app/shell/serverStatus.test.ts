import { it, expect, vi, afterEach } from "vitest";
import {
  createServerStatusController,
  compareRevision,
  type ServerStatusSnapshot,
  type ServerStatusPort,
} from "./serverStatus";
const hint = {
  profileId: "fixture",
  server: "fixture.invalid",
  user: "u",
  client: "c",
};
const snapshot = (
  over: Partial<ServerStatusSnapshot> = {},
): ServerStatusSnapshot => ({
  scope: { ...hint, generation: "9007199254740993" },
  revision: "9007199254740993",
  observedAt: Date.now(),
  expiresAt: Date.now() + 60000,
  connection: "reachable",
  access: "loginRequired",
  quality: "unknown",
  sampleCount: 0,
  reasonCode: "loginRequired",
  source: "passive",
  connectionSource: "passive",
  ...over,
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function fixture() {
  let event!: (s: ServerStatusSnapshot) => void;
  const dispose = vi.fn(),
    publish = vi.fn();
  const port: ServerStatusPort = {
    read: vi.fn(async () => snapshot()),
    listen: vi.fn(async (fn) => {
      event = fn;
      return dispose;
    }),
    check: vi.fn(async () => ({
      status: "completed" as const,
      snapshot: snapshot({ revision: "9007199254740994" }),
    })),
    report: vi.fn(),
  };
  const c = createServerStatusController(port, hint, publish);
  return {
    c,
    port,
    publish,
    event: (s: ServerStatusSnapshot) => event(s),
    dispose,
  };
}
afterEach(() => vi.useRealTimers());
it("subscribe precedes memory read; mount never probes", async () => {
  const f = fixture();
  await f.c.start();
  expect(vi.mocked(f.port.listen).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(f.port.read).mock.invocationCallOrder[0],
  );
  expect(f.port.check).not.toHaveBeenCalled();
  f.c.stop();
  expect(f.dispose).toHaveBeenCalledOnce();
});
it("exact large revisions reject old initial read and subsequent old event", async () => {
  const f = fixture(),
    read = deferred<ServerStatusSnapshot>();
  f.port.read = vi.fn(() => read.promise);
  const start = f.c.start();
  await Promise.resolve();
  f.event(
    snapshot({ revision: "9007199254740995", access: "permissionDenied" }),
  );
  read.resolve(snapshot());
  await start;
  expect(f.publish.mock.lastCall?.[0].view.access).toBe("permissionDenied");
  f.event(snapshot({ revision: "9007199254740994", access: "ok" }));
  expect(f.publish.mock.lastCall?.[0].view.access).toBe("permissionDenied");
  expect(
    compareRevision("9007199254740993", "9007199254740992"),
  ).toBeGreaterThan(0);
  f.c.stop();
});
it("expiry turns grey and reads memory only", async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.mocked(f.port.read)
    .mockResolvedValueOnce(snapshot({ expiresAt: Date.now() + 100 }))
    .mockResolvedValueOnce(
      snapshot({
        revision: "9007199254740994",
        connection: "unknown",
        access: "unknown",
        expiresAt: null,
      }),
    );
  await f.c.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.publish.mock.lastCall?.[0].view.fresh).toBe(false);
  expect(f.port.read).toHaveBeenCalledTimes(2);
  expect(f.port.check).not.toHaveBeenCalled();
  f.c.stop();
});
it("click coalesces immediately across repeated clicks and progress events", async () => {
  const f = fixture(),
    d = deferred<Awaited<ReturnType<ServerStatusPort["check"]>>>();
  f.port.check = vi.fn(() => d.promise);
  await f.c.start();
  const run = f.c.check();
  void f.c.check();
  f.event(snapshot({ revision: "9007199254740994" }));
  void f.c.check();
  expect(f.port.check).toHaveBeenCalledOnce();
  expect(f.port.check).toHaveBeenCalledWith(
    snapshot().scope,
    expect.stringMatching(/^[a-zA-Z0-9_-]+$/),
  );
  d.resolve({
    status: "completed" as const,
    snapshot: snapshot({
      revision: "9007199254740995",
      connection: "reachable",
    }),
  });
  await run;
  expect(f.publish.mock.lastCall?.[0].busy).toBe(false);
  expect(f.publish.mock.lastCall?.[0].view.access).toBe("loginRequired");
  expect(f.publish.mock.lastCall?.[0].view.quality).toBe("unknown");
  f.c.stop();
});
it("host inFlight only rereads memory, never retries manual check", async () => {
  const f = fixture();
  f.port.check = vi.fn(async () => ({
    status: "inFlight" as const,
    snapshot: null,
  }));
  await f.c.start();
  await f.c.check();
  expect(f.port.check).toHaveBeenCalledOnce();
  expect(f.port.read).toHaveBeenCalledTimes(2);
  expect(f.publish.mock.lastCall?.[0].busy).toBe(false);
  f.c.stop();
});
it("dispose on connection switch drops manual response and old events", async () => {
  const f = fixture(),
    d = deferred<Awaited<ReturnType<ServerStatusPort["check"]>>>();
  f.port.check = () => d.promise;
  await f.c.start();
  const run = f.c.check();
  f.c.stop();
  const count = f.publish.mock.calls.length;
  d.resolve({
    status: "completed" as const,
    snapshot: snapshot({ revision: "9999999999999999" }),
  });
  await run;
  f.event(snapshot());
  expect(f.publish).toHaveBeenCalledTimes(count);
});
it("foreign workspace data is never accepted", async () => {
  const f = fixture();
  f.port.read = vi.fn(async () =>
    snapshot({ scope: { ...snapshot().scope, client: "other" } }),
  );
  await f.c.start();
  await f.c.check();
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.port.check).not.toHaveBeenCalled();
  f.c.stop();
});
it("manual transport failure logs once, never retries or opens anything", async () => {
  const f = fixture();
  f.port.check = vi.fn(async () => {
    throw Error("synthetic");
  });
  await f.c.start();
  await f.c.check();
  expect(f.port.report).toHaveBeenCalledExactlyOnceWith("execute");
  expect(f.port.check).toHaveBeenCalledOnce();
  f.c.stop();
});
it("host failed receipt is not duplicate-logged as an IPC failure", async () => {
  const f = fixture();
  f.port.check = vi.fn(async () => ({
    status: "failed" as const,
    snapshot: null,
  }));
  await f.c.start();
  await f.c.check();
  expect(f.port.report).not.toHaveBeenCalled();
  f.c.stop();
});

it("different exact generation events cannot alter current facts or trigger a check", async () => {
  const f = fixture();
  await f.c.start();
  const count = f.publish.mock.calls.length;
  f.event(
    snapshot({
      scope: { ...snapshot().scope, generation: "9007199254740992" },
      revision: "9999999999999999999",
      access: "ok",
    }),
  );
  expect(f.publish).toHaveBeenCalledTimes(count);
  expect(f.port.read).toHaveBeenCalledOnce();
  expect(f.port.check).not.toHaveBeenCalled();
  f.c.stop();
});

it.each(["duplicate", "invalidRequest"] as const)(
  "%s receipt never causes another manual request",
  async (status) => {
    const f = fixture();
    f.port.check = vi.fn(async () => ({ status, snapshot: null }));
    await f.c.start();
    await f.c.check();
    expect(f.port.check).toHaveBeenCalledOnce();
    expect(f.port.report).not.toHaveBeenCalled();
    f.c.stop();
  },
);
it("each separately accepted user click gets a distinct stable request ID", async () => {
  const f = fixture();
  await f.c.start();
  await f.c.check();
  await f.c.check();
  const calls = vi.mocked(f.port.check).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0][1]).not.toBe(calls[1][1]);
  expect(calls[0][1].length).toBeLessThanOrEqual(128);
  f.c.stop();
});
it("manual connection provenance does not invent quality or clear access", async () => {
  const f = fixture();
  f.port.check = vi.fn(async () => ({
    status: "completed" as const,
    snapshot: snapshot({
      revision: "9007199254740994",
      connectionSource: "manual",
    }),
  }));
  await f.c.start();
  await f.c.check();
  expect(f.publish.mock.lastCall?.[0].view).toMatchObject({
    connectionSource: "manual",
    access: "loginRequired",
    quality: "unknown",
  });
  f.c.stop();
});
