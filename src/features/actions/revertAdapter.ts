import {
  acceptRemoval,
  projectRemoval,
  type RemovalIntent,
  type RemovalLedger,
  type RemovalEntity,
} from "./removalProjection";
export const acceptRevert = (ledger: RemovalLedger, intent: RemovalIntent) =>
  acceptRemoval(ledger, "revert", intent);
export const projectRevert = <T extends RemovalEntity>(
  scope: string,
  items: readonly T[],
  ledger: RemovalLedger,
) => projectRemoval("revert", scope, items, ledger.getSnapshot());
