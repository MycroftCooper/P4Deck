import type { ConnectionSnapshot } from "../companySubmit/model";
import { sameSubmitIdentity } from "../changelists/selectedSubmit";
import { compareRevision, canonicalRevision } from "./ledger";
export interface FenceScope {
  server: string;
  user: string;
  client: string;
}
export interface WriteFence {
  fenceId: string;
  operationId: string;
  scope: FenceScope;
  revision: string;
  active: boolean;
  outcome: "running" | "unknown";
  released: false;
}
export interface FenceSnapshot {
  connection: ConnectionSnapshot;
  fences: WriteFence[];
}
export interface ReleaseFenceRequest {
  fenceId: string;
  revision: string;
  scope: FenceScope;
  acknowledgeUnknown: true;
}
export type ReleaseFenceResult =
  | "released"
  | "notFound"
  | "stale"
  | "active"
  | "scopeMismatch"
  | "acknowledgementRequired"
  | "storageUnavailable";
export interface AdmissionPort {
  query(): Promise<FenceSnapshot>;
  release(request: ReleaseFenceRequest): Promise<ReleaseFenceResult>;
  subscribe(
    fn: (event: { fenceId: string; revision: string }) => void,
  ): Promise<() => void>;
  log(operationId: string, phase: "refresh" | "execute"): void;
  released(fence: WriteFence): void;
}
export interface AdmissionView {
  fences: readonly WriteFence[];
  loading: boolean;
  releasing: readonly string[];
}
/** One view owner, memory-only reads. Event revisions invalidate, never imply business success. */
export function createAdmissionView(
  expected: ConnectionSnapshot,
  port: AdmissionPort,
) {
  let view: AdmissionView = { fences: [], loading: true, releasing: [] };
  let disposed = false,
    started = false,
    reading = false,
    dirty = false;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>(),
    busy = new Set<string>(),
    revisions = new Map<string, string>();
  const publish = (value: AdmissionView) => {
    if (disposed) return;
    view = value;
    listeners.forEach((fn) => fn());
  };
  async function refresh() {
    if (disposed) return;
    if (reading) {
      dirty = true;
      return;
    }
    reading = true;
    dirty = false;
    publish({ ...view, loading: true });
    try {
      const value = await port.query();
      if (disposed || dirty) return;
      if (!sameSubmitIdentity(value.connection, expected)) return;
      if (
        value.fences.some(
          (f) =>
            typeof f.revision !== "string" ||
            !canonicalRevision(f.revision) ||
            !f.fenceId ||
            !f.operationId ||
            f.released !== false ||
            typeof f.active !== "boolean" ||
            !["running", "unknown"].includes(f.outcome) ||
            !f.scope.server ||
            !f.scope.user ||
            !f.scope.client,
        )
      )
        throw Error("invalid fence");
      if (
        value.fences.some((f) => {
          const revision = revisions.get(f.fenceId);
          return revision && compareRevision(f.revision, revision) < 0;
        })
      )
        return;
      for (const f of value.fences) revisions.set(f.fenceId, f.revision);
      publish({
        ...view,
        fences: value.fences.map((f) =>
          Object.freeze({ ...f, scope: Object.freeze({ ...f.scope }) }),
        ),
      });
    } catch {
      if (!disposed) port.log(crypto.randomUUID(), "refresh");
    } finally {
      reading = false;
      if (!disposed) {
        publish({ ...view, loading: false });
        if (dirty) void refresh();
      }
    }
  }
  async function release(fence: WriteFence, acknowledged: boolean) {
    const current = view.fences.find((f) => f.fenceId === fence.fenceId);
    if (
      disposed ||
      !acknowledged ||
      !current ||
      current.revision !== fence.revision ||
      revisions.get(fence.fenceId) !== current.revision ||
      current.active ||
      current.outcome !== "unknown" ||
      busy.has(fence.fenceId)
    )
      return;
    busy.add(fence.fenceId);
    publish({ ...view, releasing: [...busy] });
    try {
      const result = await port.release({
        fenceId: current.fenceId,
        revision: current.revision,
        scope: { ...current.scope },
        acknowledgeUnknown: true,
      });
      if (result === "released") port.released(current);
      if (disposed) return;
      if (result === "released") {
        publish({
          ...view,
          fences: view.fences.filter(
            (f) =>
              f.fenceId !== current.fenceId || f.revision !== current.revision,
          ),
        });
      }
      // Host logs defined rejection statuses. A read refresh is not a retry of release.
      await refresh();
    } catch {
      if (!disposed) port.log(current.operationId, "execute");
    } finally {
      busy.delete(fence.fenceId);
      if (!disposed) publish({ ...view, releasing: [...busy] });
    }
  }
  async function start() {
    if (started || disposed) return;
    started = true;
    try {
      const off = await port.subscribe((event) => {
        if (disposed || !canonicalRevision(event.revision)) return;
        const old = revisions.get(event.fenceId);
        if (old && compareRevision(event.revision, old) <= 0) return;
        revisions.set(event.fenceId, event.revision);
        void refresh();
      });
      if (disposed) {
        off();
        return;
      }
      stop = off;
    } catch {
      if (!disposed) port.log(crypto.randomUUID(), "refresh");
    }
    if (!disposed) await refresh();
  }
  return {
    getSnapshot: () => view,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    refresh,
    release,
    start,
    dispose() {
      disposed = true;
      stop?.();
      listeners.clear();
    },
  };
}
