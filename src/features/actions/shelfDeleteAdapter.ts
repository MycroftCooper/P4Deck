import {
  acceptRemoval,
  projectRemoval,
  type RemovalIntent,
  type RemovalLedger,
  type RemovalEntity,
} from "./removalProjection";
export const acceptShelfDelete = (
  ledger: RemovalLedger,
  intent: RemovalIntent,
) => acceptRemoval(ledger, "shelfDelete", intent);
export const projectShelfDelete = <T extends RemovalEntity>(
  scope: string,
  items: readonly T[],
  ledger: RemovalLedger,
) => projectRemoval("shelfDelete", scope, items, ledger.getSnapshot());
