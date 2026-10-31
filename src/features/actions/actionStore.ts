import {
  createActionLedger,
  type ActionRecord,
  type ActionPhase,
  type ReceiptAuthority,
} from "./ledger";
import type { MoveAttempt } from "../changelists/moveOptimism";
import type { RemovalAction } from "./removalProjection";
import type { GenericFileIntent } from "./genericFileTask";
type Payloads = {
  move: MoveAttempt;
  removal: RemovalAction;
  fileAction: GenericFileIntent;
};
type Payload = {
  [K in keyof Payloads]: { kind: K; value: Payloads[K] };
}[keyof Payloads];
/** One owner for business intents. Typed views below own no state or listeners. */
const actions = createActionLedger<Payload>();
function view<K extends keyof Payloads>(kind: K) {
  let previous: readonly ActionRecord<Payload>[] | undefined;
  let snapshot: readonly ActionRecord<Payloads[K]>[] = [];
  const getSnapshot = () => {
    const all = actions.getSnapshot();
    if (all !== previous) {
      previous = all;
      snapshot = all
        .filter((r) => r.data.kind === kind)
        .map((r) => ({ ...r, data: r.data.value as Payloads[K] }));
    }
    return snapshot;
  };
  return {
    getSnapshot,
    subscribe: actions.subscribe,
    get: (id: string) => getSnapshot().find((r) => r.operationId === id),
    admit: (scope: string, id: string, data: Payloads[K]) =>
      actions.admit(scope, id, { kind, value: data } as Payload),
    update: (
      id: string,
      data: Payloads[K],
      phase: ActionPhase,
      authority?: ReceiptAuthority,
    ) =>
      actions.get(id)?.data.kind === kind &&
      actions.update(id, { kind, value: data } as Payload, phase, authority),
  };
}
export const moveLedger = view("move");
export const removalLedger = view("removal");

export const fileActionLedger = view("fileAction");
