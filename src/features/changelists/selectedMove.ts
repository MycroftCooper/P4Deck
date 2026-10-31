export interface MoveExecution {
  schemaVersion: 1;
  payloadDigest: string;
  revision: string;
  executionState: "running" | "settled" | "interrupted";
  outcome: "notDispatched" | "verified" | "partial" | "unknown";
  dispatchState: "none" | "possible";
  recoveryRequired: boolean;
}
export type SelectedMoveLookupResult =
  | { kind: "found"; receipt: SelectedMoveReceipt }
  | { kind: "notFound" | "storageUnavailable" | "scopeMismatch" };
export function validMoveExecution(value: MoveExecution | null | undefined) {
  return (
    value == null ||
    (value.schemaVersion === 1 &&
      /^[a-f0-9]{64}$/.test(value.payloadDigest) &&
      /^(0|[1-9][0-9]*)$/.test(value.revision) &&
      ["running", "settled", "interrupted"].includes(value.executionState) &&
      ["notDispatched", "verified", "partial", "unknown"].includes(
        value.outcome,
      ) &&
      ["none", "possible"].includes(value.dispatchState) &&
      typeof value.recoveryRequired === "boolean")
  );
}
import type { ConnectionSnapshot } from "../companySubmit/model";
export interface SelectedMoveRequest {
  operationId: string;
  connection: ConnectionSnapshot;
  files: { depotPath: string; sourceChangeId: number }[];
  target:
    | { kind: "existing"; changeId: number }
    | { kind: "new"; description: string };
}
export interface SelectedMoveLookup {
  operationId: string;
  connection: ConnectionSnapshot;
}
export interface SelectedMoveReceipt {
  execution?: MoveExecution | null;
  operationId: string;
  targetCreationUnknown: boolean;
  targetChangeId: number | null;
  stage: "inProgress" | "stopped" | "completed";
  files: {
    depotPath: string;
    sourceChangeId: number;
    state: "moved" | "notMoved" | "unknown" | "alreadyInTarget";
  }[];
  message: string;
}
export function validMoveReceipt(
  request: SelectedMoveRequest,
  receipt: SelectedMoveReceipt,
): boolean {
  return (
    validMoveExecution(receipt.execution) &&
    receipt.operationId === request.operationId &&
    typeof receipt.targetCreationUnknown === "boolean" &&
    (!receipt.targetCreationUnknown ||
      (request.target.kind === "new" &&
        receipt.targetChangeId === null &&
        receipt.stage !== "completed")) &&
    ["inProgress", "stopped", "completed"].includes(receipt.stage) &&
    (receipt.targetChangeId === null ||
      (Number.isSafeInteger(receipt.targetChangeId) &&
        receipt.targetChangeId >= 0)) &&
    (request.target.kind !== "new" ||
      receipt.targetChangeId === null ||
      receipt.targetChangeId > 0) &&
    (request.target.kind !== "existing" ||
      receipt.targetChangeId === null ||
      receipt.targetChangeId === request.target.changeId) &&
    new Set(receipt.files.map((f) => f.depotPath)).size ===
      request.files.length &&
    receipt.files.length === request.files.length &&
    request.files.every((f) =>
      receipt.files.some(
        (r) =>
          r.depotPath === f.depotPath &&
          r.sourceChangeId === f.sourceChangeId &&
          ["moved", "notMoved", "unknown", "alreadyInTarget"].includes(r.state),
      ),
    ) &&
    (receipt.stage !== "completed" ||
      (receipt.targetChangeId !== null &&
        receipt.files.every(
          (f) => f.state === "moved" || f.state === "alreadyInTarget",
        )))
  );
}
