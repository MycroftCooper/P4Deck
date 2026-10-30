import type { QueryKey } from "@tanstack/react-query";
import type {
  RevisionGraph,
  RevisionGraphRequest,
  FileReviewScope,
  SubmittedChangeDetail,
  BranchMappingDetailResult,
} from "../../shared/contracts";
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
type Entry<T> = {
  controller: AbortController;
  users: number;
  promise: Promise<T>;
};

/** Shared, bounded reads. Cancelling one view never aborts another view's read. */
export function createSharedGraphReader<
  R extends { refresh?: boolean; operationId?: string },
  T,
>(
  fetch: (r: R) => Promise<T>,
  cancel: (id: string) => Promise<void>,
  keyFor: (request: R, mode: string) => QueryKey,
) {
  const pending = new Map<string, Entry<T>>();
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
  return (request: R, mode: string, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) return Promise.reject(new Error("Cancelled"));
    const key = keyFor(request, mode);
    if (!request.refresh && isFresh(key, CACHE_POLICY.target.staleTime))
      return Promise.resolve(appCache.getQueryData<T>(key)!);
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
        promise: Promise.resolve(undefined as unknown as T),
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
export function createGraphReader(
  fetch: (r: RevisionGraphRequest) => Promise<RevisionGraph>,
  cancel: (id: string) => Promise<void>,
) {
  return createSharedGraphReader(fetch, cancel, graphReadKey);
}
type InvestigationRead =
  | (RevisionGraphRequest & { kind: "graph" })
  | {
      kind: "change";
      scope: FileReviewScope;
      changeId: number;
      refresh?: boolean;
      operationId?: string;
    }
  | {
      kind: "mapping";
      scope: FileReviewScope;
      name: string;
      refresh?: boolean;
      operationId?: string;
    };
type InvestigationValue =
  RevisionGraph | SubmittedChangeDetail | BranchMappingDetailResult;
export function investigationReadKey(
  request: InvestigationRead,
  mode: string,
): QueryKey {
  if (request.kind === "graph") return graphReadKey(request, mode);
  return [
    "target",
    "graph-investigation",
    mode,
    { ...request.scope, fileIdentity: "" },
    request.kind,
    request.kind === "change" ? request.changeId : request.name,
  ];
}
const sharedRead = createSharedGraphReader<
  InvestigationRead,
  InvestigationValue
>(
  async (request) => {
    if (request.kind === "graph") {
      // Internal dispatch tags are not part of the strict native request contract.
      const { scope, revisionLimit, cursor, refresh, operationId } = request;
      return backend.getRevisionGraph({
        scope,
        revisionLimit,
        cursor,
        refresh,
        operationId,
      });
    }
    if (request.kind === "change") {
      const value = await backend.getSubmittedChangeDetail({
        changeId: request.changeId,
        operationId: request.operationId!,
        expectedGeneration: request.scope.contextGeneration,
        refresh: request.refresh,
      });
      if (
        value.changeId !== request.changeId ||
        value.inspectionStatus === "unavailable"
      )
        throw new Error(value.message || "CL unavailable");
      return value;
    }
    const value = await backend.getBranchMappingDetail({
      expectedGeneration: request.scope.contextGeneration,
      name: request.name,
      requestGeneration: request.scope.contextGeneration,
      operationId: request.operationId!,
    });
    if (
      value.detail.name !== request.name ||
      value.scope.contextGeneration !== request.scope.contextGeneration ||
      value.scope.server !== request.scope.server ||
      value.scope.user !== request.scope.user ||
      value.scope.client !== request.scope.client ||
      value.scope.activeProfileId !== request.scope.activeProfileId
    )
      throw new Error("Connection or mapping changed");
    return value;
  },
  (id) => backend.cancelOperation(id).then(() => undefined),
  investigationReadKey,
);
export const readGraph = (
  request: RevisionGraphRequest,
  mode: string,
  signal: AbortSignal,
) =>
  sharedRead(
    { ...request, kind: "graph" },
    mode,
    signal,
  ) as Promise<RevisionGraph>;
export const readGraphChange = (
  scope: FileReviewScope,
  changeId: number,
  mode: string,
  signal: AbortSignal,
  refresh = false,
) =>
  sharedRead(
    { kind: "change", scope, changeId, refresh },
    mode,
    signal,
  ) as Promise<SubmittedChangeDetail>;
export const readGraphMapping = (
  scope: FileReviewScope,
  name: string,
  mode: string,
  signal: AbortSignal,
  refresh = false,
) =>
  sharedRead(
    { kind: "mapping", scope, name, refresh },
    mode,
    signal,
  ) as Promise<BranchMappingDetailResult>;
