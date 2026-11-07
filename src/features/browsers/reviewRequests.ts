import { useEffect, useRef } from "react";
import { backend } from "../../infrastructure/backend";
import type {
  FileReviewScope,
  RevisionReference,
  RuntimeInfo,
} from "../../shared/contracts";
import { OperationSessionOwner } from "../../shared/operationSession";
import type {
  CancelOperation,
  OperationLease,
} from "../../shared/operationSession";

export type ReviewRequestKind =
  | "diff"
  | "history"
  | "history-page"
  | "history-diff"
  | "graph"
  | "graph-page"
  | "graph-expand"
  | "graph-node-diff";

export interface ReviewRequestIdentity {
  connection: string;
  profile: string;
  generation: number;
  scope: FileReviewScope;
  tab: "diff" | "history" | "revgraph";
  request: ReviewRequestKind;
  rightFileIdentity?: string;
  left?: RevisionReference;
  right?: RevisionReference;
  nodeId?: string;
  cursor?: string;
  expandTarget?: string;
}

export type ReviewRequestLease = OperationLease;

/**
 * Owns every in-flight review request. A lease may publish state only while it
 * remains the exact current lease for its channel.
 *
 * The cancellation/epoch bookkeeping is the shared operation-session primitive;
 * this class only binds a review identity to a channel.
 */
export class ReviewRequestOwner {
  private readonly session: OperationSessionOwner;

  constructor(
    cancelOperation: CancelOperation = (operationId) =>
      backend.cancelOperation(operationId).then(() => undefined),
  ) {
    this.session = new OperationSessionOwner({ cancelOperation });
  }

  start(
    channel: string,
    identity: ReviewRequestIdentity,
    cancelBackend = true,
  ): ReviewRequestLease {
    return this.session.start(channel, {
      identity: reviewRequestIdentityKey(identity),
      cancelBackend,
    });
  }

  isCurrent(lease: ReviewRequestLease): boolean {
    return this.session.isCurrent(lease);
  }

  finish(lease: ReviewRequestLease): boolean {
    return this.session.finish(lease);
  }

  cancel(channel: string): void {
    this.session.cancel(channel);
  }

  cancelAll(): void {
    this.session.cancelAll();
  }
}

export function useReviewRequestOwner(sessionIdentity: string) {
  const owner = useRef<ReviewRequestOwner | undefined>(undefined);
  if (!owner.current) owner.current = new ReviewRequestOwner();
  useEffect(() => {
    const current = owner.current!;
    return () => current.cancelAll();
  }, [sessionIdentity]);
  return owner.current;
}

export function reviewSessionIdentity(
  runtime: RuntimeInfo,
  tab: ReviewRequestIdentity["tab"],
  scope: FileReviewScope,
): string {
  return reviewRequestIdentityKey({
    connection: `${runtime.context.server}\0${runtime.context.user}\0${runtime.context.client}\0${runtime.context.cwd ?? ""}`,
    profile: runtime.activeProfileId ?? "environment",
    generation: runtime.contextGeneration,
    scope,
    tab,
    request: tab === "diff" ? "diff" : tab === "history" ? "history" : "graph",
  });
}

export function reviewRequestIdentityKey(
  identity: ReviewRequestIdentity,
): string {
  return JSON.stringify(identity);
}

export function reviewRequestIdentity(
  runtime: RuntimeInfo,
  scope: FileReviewScope,
  tab: ReviewRequestIdentity["tab"],
  request: ReviewRequestKind,
  details: Pick<
    ReviewRequestIdentity,
    | "left"
    | "right"
    | "rightFileIdentity"
    | "nodeId"
    | "cursor"
    | "expandTarget"
  > = {},
): ReviewRequestIdentity {
  return {
    connection: `${runtime.context.server}\0${runtime.context.user}\0${runtime.context.client}\0${runtime.context.cwd ?? ""}`,
    profile: runtime.activeProfileId ?? "environment",
    generation: runtime.contextGeneration,
    scope,
    tab,
    request,
    ...details,
  };
}

export function isCancellation(cause: unknown): boolean {
  const message =
    cause && typeof cause === "object" && "message" in cause
      ? String((cause as { message: unknown }).message)
      : String(cause);
  return /cancel(?:led|ed)|aborted/i.test(message);
}
