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
  WorkflowExecution,
  WorkflowResult,
  WorkspaceMutationResult,
} from "../../shared/contracts";

/**
 * Literal receipt `kind` values the host stores via Rust `reserve_action`
 * (`src-tauri/src/ipc/commands.rs`): shelf (2455), shelfDelete (2503),
 * shelve (2640), unshelve (2787/2903), revert (3798). `workflow_action_lookup`
 * returns the stored string unchanged, so callers must pass the exact kind for
 * their command family instead of relying on a default.
 */
export type WorkflowActionReceiptKind =
  "shelf" | "shelve" | "shelfDelete" | "unshelve" | "revert";

export interface WorkflowActionReceipt {
  operationId: string;
  kind: WorkflowActionReceiptKind;
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
  kind: WorkflowActionReceiptKind,
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

/**
 * A command envelope is only evidence for the dispatch that produced it: same
 * operationId, the expected `execution.kind`, and a self-consistent outcome.
 * An absent envelope is a legacy payload (never a success by itself).
 */
export function workflowEnvelopeTrusted(
  result: WorkflowResult | undefined,
  operationId: string,
  kind: WorkflowExecution["kind"],
) {
  const execution = result?.execution;
  return (
    !execution ||
    (!!result &&
      execution.operationId === operationId &&
      execution.kind === kind &&
      execution.outcome === result.outcome)
  );
}

/** `commandCompleted` alone is command lifecycle; trust it only with an exact envelope. */
export function workflowCommandCompleted(
  result: WorkflowResult | undefined,
  operationId: string,
  kind: WorkflowExecution["kind"],
) {
  const execution = result?.execution;
  return (
    !!execution &&
    execution.state === "commandCompleted" &&
    workflowEnvelopeTrusted(result, operationId, kind)
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
