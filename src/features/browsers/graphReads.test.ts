import { afterEach, expect, it, vi } from "vitest";
vi.mock("../../infrastructure/backend", () => ({
  backend: { getRevisionGraph: vi.fn(), cancelOperation: vi.fn() },
}));
import { createGraphReader } from "./graphReads";
import { appCache } from "../../shared/cache/appCache";
import type {
  RevisionGraph,
  RevisionGraphRequest,
} from "../../shared/contracts";
const request: RevisionGraphRequest = {
  scope: {
    server: "mock",
    user: "u",
    client: "c",
    workspace: "",
    contextGeneration: 1,
    fileIdentity: "//d/main/f",
  },
  revisionLimit: 100,
};
const graph: RevisionGraph = {
  nodes: [],
  edges: [],
  partial: false,
  truncated: false,
  hasMore: false,
  operationIds: [],
};
const signal = () => new AbortController().signal;
afterEach(() => appCache.clear());
it("deduplicates subscribers, caches hits and isolates identity/generation", async () => {
  let resolve!: (g: RevisionGraph) => void;
  const fetch = vi.fn(
    () =>
      new Promise<RevisionGraph>((r) => {
        resolve = r;
      }),
  );
  const cancel = vi.fn(async () => {});
  const read = createGraphReader(fetch, cancel);
  const first = new AbortController();
  const p = read(request, "mock", first.signal).catch((e) => e.message);
  const q = read(request, "mock", signal());
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(1);
  first.abort();
  expect(cancel).not.toHaveBeenCalled();
  resolve(graph);
  await q;
  expect(await p).toBe("Cancelled");
  await read(request, "mock", signal());
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValue(graph);
  await read(
    { ...request, scope: { ...request.scope, user: "other" } },
    "mock",
    signal(),
  );
  await read(
    { ...request, scope: { ...request.scope, contextGeneration: 2 } },
    "mock",
    signal(),
  );
  await read({ ...request, refresh: true }, "mock", signal());
  expect(fetch).toHaveBeenCalledTimes(4);
});
it("limits concurrent reads to two and cancels unobserved work", async () => {
  const resolvers: ((g: RevisionGraph) => void)[] = [];
  const fetch = vi.fn(
    () => new Promise<RevisionGraph>((resolve) => resolvers.push(resolve)),
  );
  const cancel = vi.fn(async () => {}),
    read = createGraphReader(fetch, cancel);
  const controller = new AbortController();
  const a = read(request, "mock", controller.signal).catch((e) => e.message);
  const b = read({ ...request, cursor: "2" }, "mock", signal());
  const c = read({ ...request, cursor: "3" }, "mock", signal());
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(2);
  controller.abort();
  expect(cancel).toHaveBeenCalledTimes(1);
  resolvers[0](graph);
  await a;
  await Promise.resolve();
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(3);
  resolvers[1](graph);
  resolvers[2](graph);
  await Promise.all([b, c]);
});

it("shared graph dispatch sends only native request fields, preserving scope/cursor/limit", async () => {
  const { backend } = await import("../../infrastructure/backend");
  const { readGraph } = await import("./graphReads");
  vi.mocked(backend.getRevisionGraph).mockReset().mockResolvedValue(graph);
  await readGraph(
    { ...request, cursor: "bounded-next", refresh: true },
    "mock",
    signal(),
  );
  expect(backend.getRevisionGraph).toHaveBeenCalledExactlyOnceWith({
    scope: request.scope,
    revisionLimit: 100,
    cursor: "bounded-next",
    refresh: true,
    operationId: expect.any(String),
  });
  const payload = vi.mocked(backend.getRevisionGraph).mock.calls[0][0];
  expect(Object.keys(JSON.parse(JSON.stringify(payload))).sort()).toEqual([
    "cursor",
    "operationId",
    "refresh",
    "revisionLimit",
    "scope",
  ]);
  expect(payload.scope).toEqual(request.scope);
});
