import { removalLedger, fileActionLedger } from "./actionStore";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { recordFrontendOperationLog } from "../../infrastructure/backend/frontendOperationLog";
import { releaseLocalMoveAdmission } from "../changelists/moveOptimism";
import { releaseLocalDeleteAdmission } from "./localDeleteTask";
import type {
  AdmissionPort,
  FenceSnapshot,
  ReleaseFenceResult,
} from "./admission";
export const admissionNative = isTauri;
export const admissionPort: AdmissionPort = {
  query: () => invoke<FenceSnapshot>("action_write_fences"),
  release: (request) =>
    invoke<ReleaseFenceResult>("action_release_unknown", { request }),
  subscribe: (fn) =>
    listen<{ fenceId: string; revision: string }>(
      "action-admission-changed",
      (event) => fn(event.payload),
    ),
  log: (operationId, phase) => {
    void recordFrontendOperationLog({
      eventId: `${operationId}-admission-${phase}`,
      operationId,
      action: "otherOperation",
      phase,
      outcome: "unknown",
      code: "transportError",
      targetCount: 0,
    });
  },
  released: (fence) => {
    releaseLocalMoveAdmission(fence.operationId, fence.scope);
    // Local-trash claims are per-file truth kept in memory: the host fence
    // release is the only authoritative "verified by the user" event, so the
    // unknown rows are downgraded here and the blocked paths become usable.
    releaseLocalDeleteAdmission(fence.operationId, fence.scope);
    const fileAction = fileActionLedger.get(fence.operationId);
    const connection = fileAction?.data.connection;
    if (
      fileAction &&
      !fileAction.data.busy &&
      connection?.server === fence.scope.server &&
      connection.user === fence.scope.user &&
      connection.client === fence.scope.client
    )
      fileActionLedger.update(
        fileAction.operationId,
        { ...fileAction.data, admissionReleased: true },
        fileAction.phase,
      );
    const record = removalLedger.get(fence.operationId);
    if (
      record?.data.execution &&
      !record.data.execution.busy &&
      record.data.execution.transport.server === fence.scope.server &&
      record.data.execution.transport.user === fence.scope.user &&
      record.data.execution.transport.client === fence.scope.client
    )
      removalLedger.update(
        record.operationId,
        {
          ...record.data,
          execution: { ...record.data.execution, admissionReleased: true },
        },
        record.phase,
      );
  },
};
