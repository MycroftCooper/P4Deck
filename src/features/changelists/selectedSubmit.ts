import type { ConnectionSnapshot } from "../companySubmit/model";
/** Frozen CL07 v1 host wire. */
export interface SelectedSubmitLookup {
  operationId: string;
  connection: ConnectionSnapshot;
  customSubmitExecutablePath: string;
}
export interface SelectedSubmitRequest extends SelectedSubmitLookup {
  description: string;
  files: { depotPath: string; sourceChangeId: number }[];
}
export interface SelectedSubmitReceipt {
  operationId: string;
  newChangeId: number | null;
  stage: "inProgress" | "stopped" | "readyForSubmit" | "handedOff";
  files: {
    depotPath: string;
    sourceChangeId: number;
    state: "moved" | "notMoved" | "unknown";
  }[];
  canContinue: boolean;
  message: string;
}
export type SelectedSubmitExpectation = Omit<
  SelectedSubmitLookup,
  "operationId"
>;
export function sameSubmitIdentity(
  a: ConnectionSnapshot,
  b: ConnectionSnapshot,
) {
  return (
    a.profileId === b.profileId &&
    a.generation === b.generation &&
    a.server === b.server &&
    a.user === b.user &&
    a.client === b.client
  );
}
export function validSelectedSubmitGrant(
  request: SelectedSubmitRequest,
  receipt: SelectedSubmitReceipt,
): boolean {
  if (
    receipt.operationId !== request.operationId ||
    receipt.stage !== "handedOff" ||
    !receipt.canContinue ||
    !Number.isSafeInteger(receipt.newChangeId) ||
    receipt.newChangeId! <= 0
  )
    return false;
  const expected = new Map(
    request.files.map((f) => [f.depotPath, f.sourceChangeId]),
  );
  return (
    receipt.files.length === expected.size &&
    new Set(receipt.files.map((f) => f.depotPath)).size === expected.size &&
    receipt.files.every(
      (f) =>
        f.state === "moved" && expected.get(f.depotPath) === f.sourceChangeId,
    )
  );
}
