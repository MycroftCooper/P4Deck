import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { recordFrontendOperationLog } from "../../infrastructure/backend/frontendOperationLog";
import {
  createServerStatusController,
  type ServerStatusState,
  type ServerStatusHint,
  type ServerStatusSnapshot,
  type ManualStatusReceipt,
} from "./serverStatus";
export function useServerStatus(
  native: boolean,
  connectionKey: string,
  hint: ServerStatusHint | undefined,
) {
  const identity = JSON.stringify(hint);
  const binding = `${native}:${connectionKey}:${identity}`;
  const [state, setState] = useState<ServerStatusState & { binding?: string }>({
    busy: false,
    canCheck: false,
  });
  const controller = useRef<
    ReturnType<typeof createServerStatusController> | undefined
  >(undefined);
  useEffect(() => {
    if (!native || !hint) {
      controller.current = undefined;
      return;
    }
    const c = createServerStatusController(
      {
        read: () => invoke<ServerStatusSnapshot>("get_server_status"),
        listen: (fn) =>
          listen<ServerStatusSnapshot>("server-status-changed", (e) =>
            fn(e.payload),
          ),
        check: (expectedScope, requestId) =>
          invoke<ManualStatusReceipt>("check_server_status", {
            expectedScope,
            requestId,
          }),
        report: (phase) => {
          const id = crypto.randomUUID();
          void recordFrontendOperationLog({
            eventId: `${id}-${phase}`,
            operationId: id,
            action: "otherOperation",
            phase,
            outcome: "failed",
            code: phase === "refresh" ? "refreshFailed" : "operationFailed",
            targetCount: 0,
          });
        },
      },
      hint,
      (next) => setState({ ...next, binding }),
    );
    controller.current = c;
    void c.start();
    return () => {
      c.stop();
      if (controller.current === c) controller.current = undefined;
    };
  }, [binding]);
  const current =
    state.binding === binding ? state : { busy: false, canCheck: false };
  return {
    ...current,
    check: () => {
      void controller.current?.check();
    },
  };
}
