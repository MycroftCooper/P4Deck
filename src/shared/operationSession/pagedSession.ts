import type { CancelOperation } from "./session";

/**
 * Paged-chain composition layer over an operation session owner.
 *
 * The owner guarantees "one live lease per channel" and supersedes on every
 * `start`. A paged chain is the opposite: one reviewed query keeps several
 * requests alive (first page, more pages) that must *not* cancel each other,
 * while a new query, a reconnect or an unmount must retire all of them.
 *
 * Rather than bending the owner's judgement (which eight pages depend on),
 * this layer keeps one channel per request and tracks the chain itself. It
 * borrows three things from the owner: a monotonic per-chain generation, the
 * single `cancelOperation` binding, and idempotent cancellation by id.
 *
 * Framework-free and backend-free: the React binding lives in
 * `useOperationSession`, which passes the bound `cancelOperation`.
 */

export interface PagedChain {
  readonly channel: string;
  /** Wire `requestGeneration`: stable for the chain, always at least 1. */
  readonly generation: number;
  /** Internally identifies the chain across `open()` calls. */
  readonly id: number;
}

export interface PagedRequest {
  readonly operationId: string;
  readonly generation: number;
  /** Aborted once the chain is retired or this request is cancelled. */
  readonly signal: AbortSignal;
}

export interface PagedSessionOptions {
  cancelOperation: CancelOperation;
  mintOperationId?: () => string;
}

interface RegisteredRequest {
  readonly request: PagedRequest;
  readonly chain: PagedChain;
  readonly controller: AbortController;
}

export class PagedSession {
  private sequence = 0;
  private chains = 0;
  private readonly generations = new Map<string, number>();
  private readonly live = new Map<number, RegisteredRequest>();
  private readonly cancelOperation: CancelOperation;
  private readonly mintOperationId: () => string;

  constructor(options: PagedSessionOptions) {
    this.cancelOperation = options.cancelOperation;
    this.mintOperationId =
      options.mintOperationId ?? (() => crypto.randomUUID());
  }

  /** Retires the channel's previous chain and starts a new one. */
  open(channel: string): PagedChain {
    this.retireAll(channel);
    const generation = (this.generations.get(channel) ?? 0) + 1;
    this.generations.set(channel, generation);
    return { channel, generation, id: ++this.chains };
  }

  /**
   * Adds a request to a chain without superseding its siblings. A request for
   * a retired chain is returned already aborted and never reaches the host.
   */
  request(
    chain: PagedChain,
    options: { operationId?: string } = {},
  ): PagedRequest {
    const controller = new AbortController();
    const request: PagedRequest = {
      operationId: options.operationId ?? this.mintOperationId(),
      generation: chain.generation,
      signal: controller.signal,
    };
    if (!this.isChainLive(chain)) controller.abort();
    else this.live.set(++this.sequence, { request, chain, controller });
    return request;
  }

  /** The request may still publish: its chain is live and it was not retired. */
  isCurrent(chain: PagedChain, request: PagedRequest): boolean {
    return (
      !request.signal.aborted &&
      this.isChainLive(chain) &&
      [...this.live.values()].some((entry) => entry.request === request)
    );
  }

  /** Retires a settled request without cancelling it on the host. */
  settle(request: PagedRequest): void {
    const key = this.keyOf(request);
    if (key === undefined) return;
    this.live.delete(key);
  }

  /** Retires a request whose result is unwanted and cancels it on the host. */
  abandon(request: PagedRequest): void {
    const key = this.keyOf(request);
    if (key === undefined) return;
    const entry = this.live.get(key)!;
    this.live.delete(key);
    // Aborting always happens: it is what makes `isCurrent` answer false.
    entry.controller.abort();
    void this.cancelOperation(request.operationId).catch(() => undefined);
  }

  /** Cancels the chain's in-flight requests without ending the chain. */
  cancel(chain: PagedChain): void {
    for (const entry of [...this.live.values()])
      if (entry.chain.id === chain.id) this.abandon(entry.request);
  }

  /** Cancels every request of every chain: the owning component goes away. */
  cancelAll(): void {
    for (const entry of [...this.live.values()]) this.abandon(entry.request);
  }

  /** Live operation ids, for assertions and diagnostics. */
  liveOperationIds(): readonly string[] {
    return [...this.live.values()].map((entry) => entry.request.operationId);
  }

  /** Ends a chain: its requests abort locally and are cancelled on the host. */
  private retireAll(channel: string): void {
    for (const entry of [...this.live.values()])
      if (entry.chain.channel === channel) this.abandon(entry.request);
  }

  private isChainLive(chain: PagedChain): boolean {
    return this.generations.get(chain.channel) === chain.generation;
  }

  private keyOf(request: PagedRequest): number | undefined {
    for (const [key, entry] of this.live)
      if (entry.request === request) return key;
    return undefined;
  }
}

/**
 * Cursor bookkeeping for one chain: which cursors were claimed by a request
 * and which pages have been consumed, so a retry is allowed and a cursor the
 * backend hands back again is recognised as the end of the paging.
 */
export class CursorLedger {
  private readonly claimed = new Set<string>();
  private readonly consumed = new Set<string>();

  /** False when the cursor is already in flight or already consumed. */
  claim(cursor: string): boolean {
    if (this.claimed.has(cursor) || this.consumed.has(cursor)) return false;
    this.claimed.add(cursor);
    return true;
  }

  /** A request settled without producing a page: the cursor may be retried. */
  release(cursor: string): void {
    this.claimed.delete(cursor);
  }

  consume(cursor: string): void {
    this.claimed.delete(cursor);
    this.consumed.add(cursor);
  }

  /** True when the backend repeated or failed to advance the cursor. */
  isStalled(next: string | undefined, current?: string): boolean {
    return !next || next === current || this.consumed.has(next);
  }

  reset(): void {
    this.claimed.clear();
    this.consumed.clear();
  }
}
