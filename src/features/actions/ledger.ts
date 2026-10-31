export type ActionPhase =
  "localAccepted" | "dispatching" | "running" | "settled" | "unknown";
export interface ReceiptAuthority {
  revision: string;
  payloadDigest: string;
}
export interface ActionRecord<T> {
  readonly operationId: string;
  readonly scope: string;
  readonly sequence: number;
  readonly phase: ActionPhase;
  readonly authority?: ReceiptAuthority;
  readonly data: T;
}
export const canonicalRevision = (v: string) => /^(0|[1-9][0-9]*)$/.test(v);
export function compareRevision(a: string, b: string) {
  return a.length - b.length || a.localeCompare(b);
}
/** Single local intent store, independent of server-data cache. Per-action adapters own data semantics. */
export function createActionLedger<T>() {
  let records: readonly ActionRecord<T>[] = [];
  let sequence = 0;
  const listeners = new Set<() => void>();
  const publish = (next: readonly ActionRecord<T>[]) => {
    records = next;
    listeners.forEach((fn) => fn());
  };
  const get = (id: string) => records.find((r) => r.operationId === id);
  function admit(scope: string, operationId: string, data: T) {
    if (get(operationId)) return false;
    publish([
      ...records,
      {
        scope,
        operationId,
        sequence: ++sequence,
        phase: "localAccepted",
        data,
      },
    ]);
    return true;
  }
  function update(
    operationId: string,
    data: T,
    phase: ActionPhase,
    authority?: ReceiptAuthority,
  ) {
    const old = get(operationId);
    if (!old) return false;
    if (authority) {
      if (
        !canonicalRevision(authority.revision) ||
        !/^[a-f0-9]{64}$/.test(authority.payloadDigest)
      )
        return false;
      if (
        old.authority &&
        (old.authority.payloadDigest !== authority.payloadDigest ||
          compareRevision(authority.revision, old.authority.revision) <= 0)
      )
        return false;
    }
    publish(
      records.map((r) =>
        r === old
          ? {
              ...r,
              data,
              phase,
              authority: authority
                ? Object.freeze({ ...authority })
                : old.authority,
            }
          : r,
      ),
    );
    return true;
  }
  return {
    get,
    admit,
    update,
    getSnapshot: () => records,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
