import type {
  ActionRecord,
  ReceiptAuthority,
  createActionLedger,
} from "./ledger";
/** Semantic inputs for pure adapters, NOT a backend wire contract or server CAS claim. */
export interface RemovalEntity {
  readonly path: string;
  readonly changeId: number;
  readonly version: string | null;
}
export type RemovalKind = "shelfDelete" | "revert";
export type RemovalOutcome = "pending" | "confirmed" | "notApplied" | "unknown";
export interface RemovalItem extends RemovalEntity {
  readonly outcome: RemovalOutcome;
  readonly ioComplete: boolean;
  readonly retired: boolean;
}
export interface RemovalAction {
  execution?: {
    observation: string;
    busy: boolean;
    admissionReleased?: boolean;
    transport: { server: string; user: string; client: string };
    confirmation?:
      | import("../../shared/contracts").WorkflowConfirmation
      | import("../../shared/contracts").FileActionRequest;
    connection?: import("../companySubmit/model").ConnectionSnapshot;
  };
  readonly kind: RemovalKind;
  readonly items: readonly RemovalItem[];
}
export type RemovalLedger = ReturnType<
  typeof createActionLedger<RemovalAction>
>;
export interface RemovalIntent {
  scope: string;
  operationId: string;
  items: readonly RemovalEntity[];
  confirmed: boolean;
}
export interface RemovalFact extends RemovalEntity {
  outcome: Exclude<RemovalOutcome, "pending">;
  ioComplete: boolean;
}
export interface RemovalReceipt {
  scope: string;
  operationId: string;
  authority: ReceiptAuthority;
  items: readonly RemovalFact[];
}
const identity = (kind: RemovalKind, item: RemovalEntity) =>
  JSON.stringify([
    kind,
    kind === "shelfDelete" ? item.changeId : null,
    item.path,
  ]);
const same = (a: RemovalEntity, b: RemovalEntity) =>
  a.path === b.path && a.changeId === b.changeId && a.version === b.version;
const occupied = (kind: RemovalKind, item: RemovalItem) =>
  item.outcome === "pending" ||
  item.outcome === "unknown" ||
  (kind === "revert" && !item.ioComplete);
export function removalConflicts(
  records: readonly ActionRecord<RemovalAction>[],
  scope: string,
): ReadonlySet<string> {
  return new Set(
    records
      .filter((r) => r.scope === scope)
      .flatMap((r) =>
        r.data.items
          .filter(
            (i) =>
              (r.data.execution?.busy ||
                !r.data.execution?.admissionReleased) &&
              occupied(r.data.kind, i),
          )
          .map((i) => i.path),
      ),
  );
}
/** Returns an admission result only; never executes, retries or schedules business work. */
export function acceptRemoval(
  ledger: RemovalLedger,
  kind: RemovalKind,
  intent: RemovalIntent,
): "accepted" | "cancelled" | "invalid" | "unsupported" | "conflict" {
  if (!intent.confirmed) return "cancelled";
  if (
    !intent.scope ||
    !intent.operationId ||
    !intent.items.length ||
    intent.items.some(
      (i) =>
        !i.path ||
        !Number.isSafeInteger(i.changeId) ||
        i.changeId < (kind === "shelfDelete" ? 1 : 0),
    )
  )
    return "invalid";
  if (
    intent.items.some((i) => typeof i.version !== "string" || !i.version.trim())
  )
    return "unsupported";
  if (new Set(intent.items.map((i) => i.path)).size !== intent.items.length)
    return "invalid";
  const blocked = removalConflicts(ledger.getSnapshot(), intent.scope);
  if (intent.items.some((i) => blocked.has(i.path))) return "conflict";
  const data: RemovalAction = Object.freeze({
    kind,
    items: Object.freeze(
      intent.items.map((i) =>
        Object.freeze({
          ...i,
          outcome: "pending" as const,
          ioComplete: false,
          retired: false,
        }),
      ),
    ),
  });
  return ledger.admit(intent.scope, intent.operationId, data)
    ? "accepted"
    : "conflict";
}
/** Missing/duplicate/foreign-version facts are unknown, never inferred from requested paths. */
export function applyRemovalFacts(
  ledger: RemovalLedger,
  receipt: RemovalReceipt,
): boolean {
  const record = ledger.get(receipt.operationId);
  if (!record || record.scope !== receipt.scope) return false;
  const items = record.data.items.map((item) => {
    const facts = receipt.items.filter((f) => same(f, item));
    const fact = facts.length === 1 ? facts[0] : undefined;
    const valid =
      fact &&
      ["confirmed", "notApplied", "unknown"].includes(fact.outcome) &&
      typeof fact.ioComplete === "boolean";
    // A missing later result cannot erase a previously verified fact for this exact entity.
    if (!valid && item.outcome === "confirmed") return item;
    return Object.freeze({
      ...item,
      outcome: valid ? fact.outcome : ("unknown" as const),
      ioComplete: valid ? fact.ioComplete : item.ioComplete,
    });
  });
  const unknown = items.some(
    (i) =>
      i.outcome === "unknown" ||
      (record.data.kind === "revert" && !i.ioComplete),
  );
  return ledger.update(
    record.operationId,
    Object.freeze({ ...record.data, items: Object.freeze(items) }),
    unknown ? "unknown" : "settled",
    receipt.authority,
  );
}
export interface RemovalProjection<T> {
  items: readonly T[];
  needsReconciliation: readonly RemovalEntity[];
  blocked: ReadonlySet<string>;
  unsupported: readonly RemovalEntity[];
}
/** Version equality is mandatory. Retired latest intents still suppress older overlays. */
export function projectRemoval<T extends RemovalEntity>(
  kind: RemovalKind,
  scope: string,
  base: readonly T[],
  records: readonly ActionRecord<RemovalAction>[],
): RemovalProjection<T> {
  const latest = new Map<string, RemovalItem>();
  for (const r of records)
    if (r.scope === scope && r.data.kind === kind)
      for (const item of r.data.items) latest.set(identity(kind, item), item);
  const needsReconciliation: RemovalEntity[] = [],
    unsupported: RemovalEntity[] = [];
  for (const item of latest.values())
    if (
      item.outcome === "unknown" ||
      (kind === "revert" && !item.ioComplete && item.outcome !== "pending")
    )
      needsReconciliation.push(item);
  const items = base.filter((item) => {
    const action = latest.get(identity(kind, item));
    if (!action || action.retired) return true;
    if (!item.version) {
      unsupported.push(item);
      return true;
    }
    if (item.version !== action.version) return true;
    return action.outcome !== "pending" && action.outcome !== "confirmed";
  });
  return {
    items: items.length === base.length ? base : items,
    needsReconciliation,
    unsupported,
    blocked: removalConflicts(records, scope),
  };
}
/** Capture at read START. This local watermark is not a P4 version or an execution permit. */
export function captureRemovalRead(
  records: readonly ActionRecord<RemovalAction>[],
  scope: string,
) {
  return Object.freeze({
    scope,
    marks: Object.freeze(
      records
        .filter((r) => r.scope === scope)
        .map((r) =>
          Object.freeze({
            operationId: r.operationId,
            sequence: r.sequence,
            revision: r.authority?.revision ?? null,
          }),
        ),
    ),
  });
}
export type RemovalRead = ReturnType<typeof captureRemovalRead>;
export function removalReadIsCurrent(
  records: readonly ActionRecord<RemovalAction>[],
  read: RemovalRead,
) {
  const current = records.filter((r) => r.scope === read.scope);
  return (
    current.length === read.marks.length &&
    current.every((r) =>
      read.marks.some(
        (m) =>
          m.operationId === r.operationId &&
          m.sequence === r.sequence &&
          m.revision === (r.authority?.revision ?? null),
      ),
    )
  );
}
/** Caller may replace its cache only when this returns true. No cache is owned by the adapter. */
export function reconcileRemovalRead(
  ledger: RemovalLedger,
  read: RemovalRead,
  observed: readonly RemovalEntity[],
  complete: boolean,
): boolean {
  if (!complete || !removalReadIsCurrent(ledger.getSnapshot(), read))
    return false;
  for (const record of ledger.getSnapshot()) {
    if (record.scope !== read.scope || !record.authority) continue;
    const items = record.data.items.map((item) => {
      if (
        item.retired ||
        occupied(record.data.kind, item) ||
        item.outcome !== "confirmed"
      )
        return item;
      // Absence of the exact old version retires only that known successful projection.
      return observed.some(
        (v) =>
          same(v, item) ||
          (v.path === item.path && v.changeId === item.changeId && !v.version),
      )
        ? item
        : Object.freeze({ ...item, retired: true });
    });
    if (items.some((item, index) => item !== record.data.items[index]))
      ledger.update(
        record.operationId,
        Object.freeze({ ...record.data, items: Object.freeze(items) }),
        record.phase,
      );
  }
  return true;
}
/** Existing generic FileActionResult cannot establish any per-file outcome or completed local I/O. */
export function unknownRemovalFacts(
  items: readonly RemovalEntity[],
): readonly RemovalFact[] {
  return items.map((item) => ({
    ...item,
    outcome: "unknown",
    ioComplete: false,
  }));
}
