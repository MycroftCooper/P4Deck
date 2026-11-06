import { useEffect, useRef } from "react";
import { backend } from "../../infrastructure/backend";
import { OperationSessionOwner } from "./session";

/**
 * One session owner for the lifetime of a component.
 *
 * Leases handed out by the owner are cancelled on unmount, so a page cannot
 * leave a backend operation running after it is gone. Callers that change their
 * reviewed context (connection, target, refresh) call `invalidate(channel)`
 * instead of bumping a ref and forgetting to cancel.
 */
export function useOperationSession(): OperationSessionOwner {
  const owner = useRef<OperationSessionOwner | undefined>(undefined);
  if (!owner.current) {
    owner.current = new OperationSessionOwner({
      cancelOperation: (operationId) =>
        backend.cancelOperation(operationId).then(() => undefined),
    });
  }
  useEffect(() => {
    const current = owner.current!;
    return () => current.cancelAll();
  }, []);
  return owner.current;
}
