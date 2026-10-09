export type RetryOperationKind = "read" | "refresh" | "mutation";
export type RetryFailureKind =
  | "offline"
  | "serverUnreachable"
  | "timeout"
  | "busy"
  | "auth"
  | "permission"
  | "invalid"
  | "unknown";

export interface RetryBinding {
  profileId?: string;
  generation: number;
}

export interface RetryOptions {
  kind: RetryOperationKind;
  idempotent: boolean;
  binding: RetryBinding;
  currentBinding(): RetryBinding;
  signal?: AbortSignal;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export function classifyRetryFailure(error: unknown): RetryFailureKind {
  const text = String(error).toLowerCase();
  if (/auth|ticket|login|credential/.test(text)) return "auth";
  if (/permission|protect|denied|forbidden/.test(text)) return "permission";
  if (/invalid|malformed|unsupported|not found/.test(text)) return "invalid";
  if (
    /offline|network|unreachable|connection reset|connection refused|dns/.test(
      text,
    )
  )
    return /offline/.test(text) ? "offline" : "serverUnreachable";
  if (/timeout|timed out/.test(text)) return "timeout";
  if (/busy|temporar|try again|rate limit|unavailable/.test(text))
    return "busy";
  return "unknown";
}

export function retryDelay(
  attempt: number,
  baseDelayMs = 400,
  maxDelayMs = 5_000,
  jitter = 0.2,
  random = Math.random,
): number {
  const exponential = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.min(
    maxDelayMs,
    Math.round(exponential * (1 - jitter + random() * jitter * 2)),
  );
}

function sameBinding(left: RetryBinding, right: RetryBinding): boolean {
  return (
    left.profileId === right.profileId && left.generation === right.generation
  );
}

function abortError(message = "Retry cancelled") {
  return new DOMException(message, "AbortError");
}

export function abortableDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const cancel = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

export async function runWithRetry<T>(
  task: (attempt: number, signal?: AbortSignal) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  if (!options.idempotent || options.kind === "mutation")
    return task(1, options.signal);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw abortError();
    if (!sameBinding(options.binding, options.currentBinding()))
      throw abortError("Connection generation changed");
    try {
      const result = await task(attempt, options.signal);
      if (!sameBinding(options.binding, options.currentBinding()))
        throw abortError("Connection generation changed");
      return result;
    } catch (error) {
      if (
        options.signal?.aborted ||
        !sameBinding(options.binding, options.currentBinding())
      )
        throw abortError("Connection generation changed or retry cancelled");
      const retryable = [
        "offline",
        "serverUnreachable",
        "timeout",
        "busy",
      ].includes(classifyRetryFailure(error));
      if (!retryable || attempt >= maxAttempts) throw error;
      await (options.sleep ?? abortableDelay)(
        retryDelay(
          attempt,
          options.baseDelayMs,
          options.maxDelayMs,
          options.jitter,
          options.random,
        ),
        options.signal,
      );
    }
  }
}
