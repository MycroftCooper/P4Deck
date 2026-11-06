/**
 * One cancellable operation session per channel.
 *
 * A page asks the owner for a lease before every backend call it may have to
 * supersede (refresh, target change, close, unmount) and checks `isCurrent`
 * before writing state. The owner mints the operation id, remembers which lease
 * is the live work for its channel, and answers the only question a late
 * response may ask; it also owns the actual `cancelOperation` call so a lease is
 * never cancelled twice and a superseded one is always withdrawn.
 *
 * Guarantees:
 *  - starting a lease supersedes the channel's previous lease (abort + cancel);
 *  - `invalidate` bumps the channel epoch and cancels the in-flight lease
 *    without starting a replacement (connection/target change, refresh, close);
 *  - `finish` retires a completed lease and never cancels it; `abandon` retires
 *    and cancels a lease whose result nobody wants any more;
 *  - `isCurrent` is false once the lease finished, was superseded, invalidated,
 *    abandoned, or its signal aborted.
 *
 * The module is deliberately framework-free and backend-free: the React binding
 * lives in `useOperationSession` and wires the real backend cancellation.
 */
export type CancelOperation = (operationId: string) => Promise<unknown>;

export interface OperationLease {
  readonly channel: string;
  /** Stable identity of the work (scope/target/tab); "" when not given. */
  readonly identity: string;
  readonly operationId: string;
  /** Monotonic per owner: only the newest sequence for a channel may publish. */
  readonly sequence: number;
  /** Channel epoch at mint time; `invalidate` makes earlier epochs stale. */
  readonly epoch: number;
  readonly signal: AbortSignal;
}

export interface StartOperationOptions {
  identity?: string;
  /** Abort locally without asking the backend to cancel (cache-only reads). */
  cancelBackend?: boolean;
  /** Reuse an operation id the caller already minted. */
  operationId?: string;
}

export interface OperationSessionOptions {
  /** How the owner cancels a superseded operation on the host. */
  cancelOperation: CancelOperation;
  mintOperationId?: () => string;
}

interface RegisteredLease {
  lease: OperationLease;
  controller: AbortController;
}

export class OperationSessionOwner {
  private sequence = 0;
  private readonly epochs = new Map<string, number>();
  private readonly leases = new Map<string, RegisteredLease>();
  private readonly cancelOperation: CancelOperation;
  private readonly mintOperationId: () => string;

  constructor(options: OperationSessionOptions) {
    this.cancelOperation = options.cancelOperation;
    this.mintOperationId =
      options.mintOperationId ?? (() => crypto.randomUUID());
  }

  /** The channel's current epoch; `invalidate` raises it by one. */
  epoch(channel: string): number {
    return this.epochs.get(channel) ?? 0;
  }

  start(channel: string, options: StartOperationOptions = {}): OperationLease {
    this.abort(channel);
    const controller = new AbortController();
    const lease: OperationLease = {
      channel,
      identity: options.identity ?? "",
      operationId: options.operationId ?? this.mintOperationId(),
      sequence: ++this.sequence,
      epoch: this.epoch(channel),
      signal: controller.signal,
    };
    if (options.cancelBackend !== false) {
      controller.signal.addEventListener(
        "abort",
        () => {
          // Cancellation is best-effort: the lease is already stale either way.
          void this.cancelOperation(lease.operationId).catch(() => undefined);
        },
        { once: true },
      );
    }
    this.leases.set(channel, { lease, controller });
    return lease;
  }

  isCurrent(lease: OperationLease): boolean {
    // The owner-wide `sequence` is the load-bearing check; identity and epoch
    // only make the channel's reviewed context explicit to future callers.
    const current = this.leases.get(lease.channel)?.lease;
    return (
      !lease.signal.aborted &&
      current !== undefined &&
      current.sequence === lease.sequence &&
      current.identity === lease.identity &&
      current.epoch === lease.epoch
    );
  }

  /** Retires a lease that settled normally; returns false when superseded. */
  finish(lease: OperationLease): boolean {
    if (!this.isCurrent(lease)) return false;
    this.leases.delete(lease.channel);
    return true;
  }

  /** Retires a lease whose result is unwanted and cancels it on the host. */
  abandon(lease: OperationLease): boolean {
    if (!this.isCurrent(lease)) return false;
    this.abort(lease.channel);
    return true;
  }

  /** Cancels the channel's in-flight lease without starting a replacement. */
  cancel(channel: string): void {
    this.abort(channel);
  }

  /** Cancels the channel and bumps its epoch: the reviewed context changed. */
  invalidate(channel: string): void {
    this.epochs.set(channel, this.epoch(channel) + 1);
    this.abort(channel);
  }

  /** Cancels every channel; the owning component is going away. */
  cancelAll(): void {
    for (const channel of [...this.leases.keys()]) this.abort(channel);
  }

  private abort(channel: string): void {
    const registered = this.leases.get(channel);
    if (!registered) return;
    this.leases.delete(channel);
    registered.controller.abort();
  }
}
