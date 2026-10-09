import { useEffect, useRef } from "react";
import { backend } from "../../infrastructure/backend";
import type {
  FileReviewScope,
  RevisionReference,
  RuntimeInfo,
} from "../../shared/contracts/types";

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
  left?: RevisionReference;
  right?: RevisionReference;
  nodeId?: string;
  cursor?: string;
  expandTarget?: string;
}

export interface ReviewRequestLease {
  readonly channel: string;
  readonly identity: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly signal: AbortSignal;
}

type CancelOperation = (operationId: string) => Promise<void>;

/**
 * Owns every in-flight review request. A lease may publish state only while it
 * remains the exact current lease for its channel.
 */
export class ReviewRequestOwner {
  private sequence = 0;
  private readonly requests = new Map<
    string,
    { lease: ReviewRequestLease; controller: AbortController }
  >();

  constructor(
    private readonly cancelOperation: CancelOperation = (operationId) =>
      backend.cancelOperation(operationId),
  ) {}

  start(channel: string, identity: ReviewRequestIdentity): ReviewRequestLease {
    this.cancel(channel);
    const controller = new AbortController();
    const lease: ReviewRequestLease = {
      channel,
      identity: reviewRequestIdentityKey(identity),
      operationId: crypto.randomUUID(),
      sequence: ++this.sequence,
      signal: controller.signal,
    };
    controller.signal.addEventListener(
      "abort",
      () => void this.cancelOperation(lease.operationId).catch(() => undefined),
      { once: true },
    );
    this.requests.set(channel, { lease, controller });
    return lease;
  }

  isCurrent(lease: ReviewRequestLease): boolean {
    const current = this.requests.get(lease.channel)?.lease;
    return (
      !lease.signal.aborted &&
      current?.sequence === lease.sequence &&
      current.identity === lease.identity
    );
  }

  finish(lease: ReviewRequestLease): boolean {
    if (!this.isCurrent(lease)) return false;
    this.requests.delete(lease.channel);
    return true;
  }

  cancel(channel: string): void {
    const request = this.requests.get(channel);
    if (!request) return;
    this.requests.delete(channel);
    request.controller.abort();
  }

  cancelAll(): void {
    for (const channel of [...this.requests.keys()]) this.cancel(channel);
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
    "left" | "right" | "nodeId" | "cursor" | "expandTarget"
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
