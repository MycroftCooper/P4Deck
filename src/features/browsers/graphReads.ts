import type {
  RevisionGraph,
  RevisionGraphRequest,
} from "../../shared/contracts/types";
import { appCache } from "../../shared/cache/appCache";
import { isFresh, writeSnapshot } from "../../shared/cache/snapshots";
import { CACHE_POLICY } from "../../shared/cache/policy";
import { backend } from "../../infrastructure/backend";

export const graphReadKey = (request: RevisionGraphRequest, mode: string) =>
  [
    "target",
    "focused-graph",
    mode,
    request.scope,
    request.revisionLimit,
    request.cursor ?? "",
  ] as const;
type Entry = {
  controller: AbortController;
  users: number;
  promise: Promise<RevisionGraph>;
};

/** Shared, bounded reads. Cancelling one view never aborts another view's read. */
export function createGraphReader(
  fetch: (r: RevisionGraphRequest) => Promise<RevisionGraph>,
  cancel: (id: string) => Promise<void>,
) {
  const pending = new Map<string, Entry>();
  const latest = new Map<string, symbol>();
  const waiting: (() => void)[] = [];
  let running = 0;
  async function acquire() {
    if (running >= 2)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
  }
  function release() {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
  return (
    request: RevisionGraphRequest,
    mode: string,
    signal: AbortSignal,
  ): Promise<RevisionGraph> => {
    if (signal.aborted) return Promise.reject(new Error("Cancelled"));
    const key = graphReadKey(request, mode);
    if (!request.refresh && isFresh(key, CACHE_POLICY.target.staleTime))
      return Promise.resolve(appCache.getQueryData<RevisionGraph>(key)!);
    const force =
      !!request.refresh || !!appCache.getQueryState(key)?.isInvalidated;
    const identity = JSON.stringify([key, force]);
    let entry = pending.get(identity);
    if (!entry) {
      const cacheId = JSON.stringify(key);
      const token = Symbol();
      latest.set(cacheId, token);
      const controller = new AbortController();
      const id = crypto.randomUUID();
      entry = {
        controller,
        users: 0,
        promise: Promise.resolve(undefined as unknown as RevisionGraph),
      };
      const owned = entry;
      owned.promise = (async () => {
        await acquire();
        let started = false;
        const abort = () => {
          if (started) void cancel(id).catch(() => undefined);
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        try {
          if (controller.signal.aborted) throw new Error("Cancelled");
          started = true;
          const result = await fetch({
            ...request,
            refresh: force,
            operationId: id,
          });
          if (controller.signal.aborted) throw new Error("Cancelled");
          if (latest.get(cacheId) === token) writeSnapshot(key, result);
          return result;
        } finally {
          controller.signal.removeEventListener("abort", abort);
          if (pending.get(identity) === owned) pending.delete(identity);
          if (latest.get(cacheId) === token) latest.delete(cacheId);
          release();
        }
      })();
      pending.set(identity, owned);
    }
    const owned = entry;
    owned.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true;
        signal.removeEventListener("abort", abort);
        owned.users--;
        return true;
      };
      const abort = () => {
        if (!finish()) return;
        if (!owned.users) {
          if (pending.get(identity) === owned) pending.delete(identity);
          owned.controller.abort();
        }
        reject(new Error("Cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      owned.promise.then(
        (value) => {
          if (finish()) resolve(value);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
    });
  };
}
export const readGraph = createGraphReader(
  (r) => backend.getRevisionGraph(r),
  (id) => backend.cancelOperation(id),
);
