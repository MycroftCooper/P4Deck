import { invoke } from "@tauri-apps/api/core";
import { sameSubmitIdentity } from "../changelists/selectedSubmit";
import { canonicalRevision } from "./ledger";
import type { ConnectionSnapshot } from "../companySubmit/model";
import type {
  BranchMutationResult,
  ConnectionSpecCreateResult,
  ControlPlaneActionKind,
  ControlPlaneActionResult,
  StreamSwitchResult,
  SubmitResult,
  WorkflowResult,
  WorkspaceMutationResult,
} from "../../shared/contracts";

export interface WorkflowActionReceipt {
  operationId: string;
  kind: "shelf" | "revert" | "unshelve";
  connection: ConnectionSnapshot;
  payloadDigest: string;
  revision: string;
  state: "running" | "settled" | "interrupted";
  result: WorkflowResult | null;
}

export type WorkflowActionLookup =
  | { kind: "found"; receipt: WorkflowActionReceipt }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };

export const lookupWorkflowAction = (request: {
  operationId: string;
  connection: ConnectionSnapshot;
}) => invoke<WorkflowActionLookup>("workflow_action_lookup", { request });

export function validWorkflowReceipt(
  request: { operationId: string; connection: ConnectionSnapshot },
  receipt: WorkflowActionReceipt,
  kind: "shelf" | "revert" | "unshelve" = "shelf",
) {
  return (
    receipt.operationId === request.operationId &&
    receipt.kind === kind &&
    sameSubmitIdentity(receipt.connection, request.connection) &&
    typeof receipt.revision === "string" &&
    canonicalRevision(receipt.revision) &&
    /^[a-f0-9]{64}$/.test(receipt.payloadDigest) &&
    ["running", "settled", "interrupted"].includes(receipt.state)
  );
}

/** S4j2 control-plane receipts; authority stays the post-write readback. */

export interface SubmitActionReceipt {
  operationId: string;
  kind: "submit";
  connection: ConnectionSnapshot;
  payloadDigest: string;
  revision: string;
  state: "running" | "settled" | "interrupted";
  result: SubmitResult | null;
}

export type SubmitActionLookup =
  | { kind: "found"; receipt: SubmitActionReceipt }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };

export const lookupSubmitAction = (request: {
  operationId: string;
  connection: ConnectionSnapshot;
}) => invoke<SubmitActionLookup>("workflow_action_lookup", { request });

export function isSubmitResult(value: unknown): value is SubmitResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SubmitResult>;
  return (
    typeof candidate.outcome === "string" &&
    typeof candidate.changeId === "number" &&
    typeof candidate.message === "string" &&
    typeof candidate.refresh === "object" &&
    candidate.refresh !== null
  );
}
/** Identity/shape check only; `settled` means persisted, never "submitted". */

export function validSubmitReceipt(
  request: { operationId: string; connection: ConnectionSnapshot },
  receipt: SubmitActionReceipt,
) {
  return (
    receipt.operationId === request.operationId &&
    receipt.kind === "submit" &&
    sameSubmitIdentity(receipt.connection, request.connection) &&
    typeof receipt.revision === "string" &&
    canonicalRevision(receipt.revision) &&
    /^[a-f0-9]{64}$/.test(receipt.payloadDigest) &&
    ["running", "settled", "interrupted"].includes(receipt.state) &&
    (receipt.result === null || isSubmitResult(receipt.result))
  );
}

export interface BranchMappingActionReceipt {
  operationId: string;
  kind: "branchMapping";
  connection: ConnectionSnapshot;
  payloadDigest: string;
  revision: string;
  state: "running" | "settled" | "interrupted";
  result: BranchMutationResult | null;
}

export type BranchMappingActionLookup =
  | { kind: "found"; receipt: BranchMappingActionReceipt }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };

export const lookupBranchMappingAction = (request: {
  operationId: string;
  connection: ConnectionSnapshot;
}) => invoke<BranchMappingActionLookup>("workflow_action_lookup", { request });

export interface StreamSwitchActionReceipt {
  operationId: string;
  kind: "streamSwitch";
  connection: ConnectionSnapshot;
  payloadDigest: string;
  revision: string;
  state: "running" | "settled" | "interrupted";
  result: StreamSwitchResult | null;
}

export type StreamSwitchActionLookup =
  | { kind: "found"; receipt: StreamSwitchActionReceipt }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };

export const lookupStreamSwitchAction = (request: {
  operationId: string;
  connection: ConnectionSnapshot;
}) => invoke<StreamSwitchActionLookup>("workflow_action_lookup", { request });

function validActionEnvelope(
  request: { operationId: string; connection: ConnectionSnapshot },
  receipt: {
    operationId: string;
    connection: ConnectionSnapshot;
    payloadDigest: string;
    revision: string;
    state: string;
  },
) {
  return (
    receipt.operationId === request.operationId &&
    sameSubmitIdentity(receipt.connection, request.connection) &&
    typeof receipt.revision === "string" &&
    canonicalRevision(receipt.revision) &&
    /^[a-f0-9]{64}$/.test(receipt.payloadDigest) &&
    ["running", "settled", "interrupted"].includes(receipt.state)
  );
}

export function validBranchMappingReceipt(
  request: { operationId: string; connection: ConnectionSnapshot },
  receipt: BranchMappingActionReceipt,
) {
  return (
    receipt.kind === "branchMapping" && validActionEnvelope(request, receipt)
  );
}

export function validStreamSwitchReceipt(
  request: { operationId: string; connection: ConnectionSnapshot },
  receipt: StreamSwitchActionReceipt,
) {
  return (
    receipt.kind === "streamSwitch" && validActionEnvelope(request, receipt)
  );
}

export interface WorkspaceMutationActionReceipt {
  operationId: string;
  kind: "workspaceMutation";
  connection: ConnectionSnapshot;
  payloadDigest: string;
  revision: string;
  state: "running" | "settled" | "interrupted";
  result: WorkspaceMutationResult | null;
}

export type WorkspaceMutationActionLookup =
  | { kind: "found"; receipt: WorkspaceMutationActionReceipt }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };

export const lookupWorkspaceMutationAction = (request: {
  operationId: string;
  connection: ConnectionSnapshot;
}) =>
  invoke<WorkspaceMutationActionLookup>("workflow_action_lookup", { request });

export type ConnectionCreateKind =
  "connectionCreateUser" | "connectionCreateWorkspace";

export interface ConnectionCreateActionReceipt {
  operationId: string;
  kind: ConnectionCreateKind;
  connection: ConnectionSnapshot;
  payloadDigest: string;
  revision: string;
  state: "running" | "settled" | "interrupted";
  result: ConnectionSpecCreateResult | null;
}

export type ConnectionCreateActionLookup =
  | { kind: "found"; receipt: ConnectionCreateActionReceipt }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };

export const lookupConnectionCreateAction = (request: {
  operationId: string;
  connection: ConnectionSnapshot;
}) =>
  invoke<ConnectionCreateActionLookup>("workflow_action_lookup", { request });

export function validWorkspaceMutationReceipt(
  request: { operationId: string; connection: ConnectionSnapshot },
  receipt: WorkspaceMutationActionReceipt,
) {
  return (
    receipt.kind === "workspaceMutation" &&
    validActionEnvelope(request, receipt)
  );
}

export function validConnectionCreateReceipt(
  request: { operationId: string; connection: ConnectionSnapshot },
  receipt: ConnectionCreateActionReceipt,
  expectedKind?: ConnectionCreateKind,
) {
  return (
    validActionEnvelope(request, receipt) &&
    (expectedKind === undefined || receipt.kind === expectedKind)
  );
}

export interface ControlPlaneActionReceipt {
  operationId: string;
  kind: ControlPlaneActionKind;
  connection: ConnectionSnapshot;
  payloadDigest: string;
  revision: string;
  state: "running" | "settled" | "interrupted";
  result: ControlPlaneActionResult | null;
}

export type ControlPlaneActionLookup =
  | { kind: "found"; receipt: ControlPlaneActionReceipt }
  | { kind: "notFound" | "scopeMismatch" | "storageUnavailable" };

export const lookupControlPlaneAction = (request: {
  operationId: string;
  connection: ConnectionSnapshot;
}) => invoke<ControlPlaneActionLookup>("workflow_action_lookup", { request });

export function validControlPlaneReceipt(
  request: { operationId: string; connection: ConnectionSnapshot },
  receipt: ControlPlaneActionReceipt,
  kind: ControlPlaneActionKind,
) {
  return (
    receipt.operationId === request.operationId &&
    receipt.kind === kind &&
    sameSubmitIdentity(receipt.connection, request.connection) &&
    typeof receipt.revision === "string" &&
    canonicalRevision(receipt.revision) &&
    /^[a-f0-9]{64}$/.test(receipt.payloadDigest) &&
    ["running", "settled", "interrupted"].includes(receipt.state)
  );
}
