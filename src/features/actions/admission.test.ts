import { describe, it, expect, vi } from "vitest";
import {
  createAdmissionView,
  type AdmissionPort,
  type WriteFence,
  type FenceSnapshot,
} from "./admission";
const connection = {
  profileId: "profile",
  generation: "1",
  server: "server",
  user: "user",
  client: "client",
};
const fence: WriteFence = {
  fenceId: "fence",
  operationId: "operation",
  scope: { server: "server", user: "user", client: "client" },
  revision: "1",
  active: false,
  outcome: "unknown",
  released: false,
};
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
function setup() {
  let event!: (e: { fenceId: string; revision: string }) => void;
  const off = vi.fn();
  const port: AdmissionPort = {
    query: vi.fn(async () => ({ connection, fences: [fence] })),
    release: vi.fn(async () => "released" as const),
    subscribe: vi.fn(async (fn) => {
      event = fn;
      return off;
    }),
    log: vi.fn(),
    released: vi.fn(),
  };
  return {
    port,
    off,
    event: (revision: string) => event({ fenceId: "fence", revision }),
    controller: createAdmissionView(connection, port),
  };
}
describe("admission view", () => {
  it("queries memory only after subscribing; acknowledgement required", async () => {
    const s = setup();
    await s.controller.start();
    await s.controller.release(fence, false);
    expect(s.port.release).not.toHaveBeenCalled();
    expect(s.port.subscribe).toHaveBeenCalledOnce();
    expect(s.port.query).toHaveBeenCalledOnce();
  });
  it("releases exact immutable identity once; preserves unknown evidence", async () => {
    const s = setup();
    await s.controller.start();
    const d = deferred<"released">();
    vi.mocked(s.port.release).mockReturnValue(d.promise);
    const a = s.controller.release(fence, true);
    await s.controller.release(fence, true);
    expect(s.port.release).toHaveBeenCalledExactlyOnceWith({
      fenceId: "fence",
      revision: "1",
      scope: fence.scope,
      acknowledgeUnknown: true,
    });
    d.resolve("released");
    await a;
    expect(s.port.released).toHaveBeenCalledWith(fence);
    expect(fence.outcome).toBe("unknown");
  });
  it("active and stale clicks cannot release", async () => {
    const s = setup();
    vi.mocked(s.port.query).mockResolvedValue({
      connection,
      fences: [{ ...fence, active: true }],
    });
    await s.controller.start();
    await s.controller.release(fence, true);
    expect(s.port.release).not.toHaveBeenCalled();
  });
  it("connection changes reject snapshots", async () => {
    const s = setup();
    vi.mocked(s.port.query).mockResolvedValue({
      connection: { ...connection, generation: "2" },
      fences: [fence],
    });
    await s.controller.start();
    expect(s.controller.getSnapshot().fences).toEqual([]);
  });
  it("event during query ignores old snapshot and coalesces one read", async () => {
    const s = setup();
    const d = deferred<FenceSnapshot>();
    vi.mocked(s.port.query)
      .mockReturnValueOnce(d.promise)
      .mockResolvedValue({ connection, fences: [{ ...fence, revision: "2" }] });
    const started = s.controller.start();
    await Promise.resolve();
    s.event("2");
    d.resolve({ connection, fences: [fence] });
    await started;
    await Promise.resolve();
    expect(s.port.query).toHaveBeenCalledTimes(2);
    expect(s.controller.getSnapshot().fences[0].revision).toBe("2");
  });
  it("persistent stale host snapshot does not loop", async () => {
    const s = setup();
    await s.controller.start();
    s.event("2");
    await Promise.resolve();
    await Promise.resolve();
    expect(s.port.query).toHaveBeenCalledTimes(2);
  });
  it("defined refusal never retries or releases local admission", async () => {
    const s = setup();
    await s.controller.start();
    vi.mocked(s.port.release).mockResolvedValue("stale");
    await s.controller.release(fence, true);
    expect(s.port.release).toHaveBeenCalledOnce();
    expect(s.port.released).not.toHaveBeenCalled();
    expect(s.port.log).not.toHaveBeenCalled();
  });
  it("transport failure logs once without replay", async () => {
    const s = setup();
    await s.controller.start();
    vi.mocked(s.port.release).mockRejectedValue(Error("private"));
    await s.controller.release(fence, true);
    expect(s.port.log).toHaveBeenCalledExactlyOnceWith("operation", "execute");
    expect(s.port.release).toHaveBeenCalledOnce();
  });
  it("new invalidation immediately rejects old acknowledgement while refresh waits", async () => {
    const s = setup();
    await s.controller.start();
    const d = deferred<FenceSnapshot>();
    vi.mocked(s.port.query).mockReturnValue(d.promise);
    s.event("2");
    await s.controller.release(fence, true);
    expect(s.port.release).not.toHaveBeenCalled();
    s.controller.dispose();
    d.resolve({ connection, fences: [] });
  });
  it("accepted release after view unmount still clears only its local admission", async () => {
    const s = setup();
    await s.controller.start();
    const d = deferred<"released">();
    vi.mocked(s.port.release).mockReturnValue(d.promise);
    const task = s.controller.release(fence, true);
    s.controller.dispose();
    d.resolve("released");
    await task;
    expect(s.port.released).toHaveBeenCalledExactlyOnceWith(fence);
  });
  it("starting twice installs one subscription", async () => {
    const s = setup();
    await s.controller.start();
    await s.controller.start();
    expect(s.port.subscribe).toHaveBeenCalledOnce();
  });
  it("dispose prevents late changes and unsubscribes", async () => {
    const s = setup();
    await s.controller.start();
    const before = s.controller.getSnapshot();
    s.controller.dispose();
    s.event("3");
    expect(s.controller.getSnapshot()).toBe(before);
    expect(s.off).toHaveBeenCalledOnce();
  });
});
