import type { PassiveStatusView } from "./passiveStatus";
export interface ServerStatusScope {
  profileId: string | null;
  generation: string;
  server: string;
  user: string;
  client: string;
}
export type ServerStatusHint = Omit<ServerStatusScope, "generation">;
export interface ServerStatusSnapshot extends Omit<PassiveStatusView, "fresh"> {
  scope: ServerStatusScope;
  revision: string;
  observedAt: number | null;
  expiresAt: number | null;
  sampleCount: number;
  /** Latest completed remote request duration in ms (independent of bucketed samples). */
  lastElapsedMs?: number | null;
  reasonCode:
    | "noSamples"
    | "expired"
    | "insufficientSamples"
    | "networkFailure"
    | "loginRequired"
    | "permissionDenied"
    | "repeatedTimeout"
    | "slowResponses"
    | "normalResponses"
    | "responseObserved";
  source: "passive";
  connectionSource: "unknown" | "passive" | "manual";
}
export interface ManualStatusReceipt {
  status:
    | "completed"
    | "inFlight"
    | "contextChanged"
    | "unavailable"
    | "failed"
    | "duplicate"
    | "invalidRequest";
  snapshot: ServerStatusSnapshot | null;
}
export interface ServerStatusPort {
  read(): Promise<ServerStatusSnapshot>;
  listen(fn: (s: ServerStatusSnapshot) => void): Promise<() => void>;
  check(
    scope: ServerStatusScope,
    requestId: string,
  ): Promise<ManualStatusReceipt>;
  report(phase: "refresh" | "execute"): void;
}
const decimal = (s: string) => /^(0|[1-9]\d*)$/.test(s);
export function compareRevision(a: string, b: string) {
  return a.length - b.length || (a === b ? 0 : a > b ? 1 : -1);
}
export const sameServerScope = (a: ServerStatusScope, b: ServerStatusScope) =>
  a.profileId === b.profileId &&
  a.generation === b.generation &&
  a.server === b.server &&
  a.user === b.user &&
  a.client === b.client;
const matchesHint = (s: ServerStatusScope, h: ServerStatusHint) =>
  s.profileId === h.profileId &&
  s.server === h.server &&
  s.user === h.user &&
  s.client === h.client;
export function validServerStatus(s: ServerStatusSnapshot) {
  return (
    !!s &&
    s.source === "passive" &&
    ["unknown", "passive", "manual"].includes(s.connectionSource) &&
    !!s.scope &&
    (s.scope.profileId === null || typeof s.scope.profileId === "string") &&
    [s.scope.server, s.scope.user, s.scope.client].every(
      (v) => typeof v === "string",
    ) &&
    typeof s.scope.generation === "string" &&
    decimal(s.scope.generation) &&
    typeof s.revision === "string" &&
    decimal(s.revision) &&
    [s.observedAt, s.expiresAt].every(
      (v) => v === null || Number.isFinite(v),
    ) &&
    ["unknown", "reachable", "failed"].includes(s.connection) &&
    ["unknown", "ok", "loginRequired", "permissionDenied"].includes(s.access) &&
    ["unknown", "smooth", "slow", "persistentTimeout"].includes(s.quality)
  );
}
export interface ServerStatusState {
  view?: PassiveStatusView;
  busy: boolean;
  canCheck: boolean;
}
/** One binding lifetime. Only check() can call the manual IPC. All automatic reads are memory-only. */
export function createServerStatusController(
  port: ServerStatusPort,
  hint: ServerStatusHint,
  publish: (state: ServerStatusState) => void,
) {
  let stopped = false,
    busy = false,
    snapshot: ServerStatusSnapshot | undefined,
    unlisten: (() => void) | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    reading: Promise<void> | undefined;
  let buffered: ServerStatusSnapshot[] = [];
  const emit = () => {
    if (!stopped)
      publish({
        view: snapshot
          ? {
              connection: snapshot.connection,
              access: snapshot.access,
              quality: snapshot.quality,
              connectionSource: snapshot.connectionSource,
              samples: snapshot.sampleCount,
              observedAt: snapshot.observedAt,
              lastElapsedMs: snapshot.lastElapsedMs ?? null,
              fresh:
                snapshot.expiresAt !== null && snapshot.expiresAt > Date.now(),
            }
          : undefined,
        busy,
        canCheck: !!snapshot,
      });
  };
  const apply = (next: ServerStatusSnapshot, anchor = false) => {
    if (stopped || !validServerStatus(next) || !matchesHint(next.scope, hint))
      return;
    if (snapshot) {
      if (!sameServerScope(snapshot.scope, next.scope)) {
        if (!anchor) return;
      } else if (compareRevision(next.revision, snapshot.revision) <= 0) return;
    }
    snapshot = next;
    clearTimeout(timer);
    emit();
    if (next.expiresAt !== null && next.expiresAt > Date.now())
      timer = setTimeout(
        () => {
          emit();
          void load();
        },
        Math.min(2147483647, next.expiresAt - Date.now()),
      );
  };
  const load = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (reading) return reading;
    reading = port
      .read()
      .then(
        (value) => {
          apply(value, true);
          for (const event of buffered) apply(event);
          buffered = [];
        },
        () => {
          if (!stopped) port.report("refresh");
        },
      )
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };
  return {
    async start() {
      try {
        const stop = await port.listen((event) => {
          if (stopped) return;
          if (!snapshot) {
            if (buffered.length === 16) buffered.shift();
            buffered.push(event);
            return;
          }
          if (
            validServerStatus(event) &&
            !sameServerScope(event.scope, snapshot.scope)
          )
            return;
          apply(event);
        });
        if (stopped) {
          stop();
          return;
        }
        unlisten = stop;
        await load();
      } catch {
        if (!stopped) port.report("refresh");
      }
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      unlisten?.();
    },
    async check() {
      if (stopped || busy || !snapshot) return;
      busy = true;
      emit();
      const expected = { ...snapshot.scope };
      try {
        const result = await port.check(expected, crypto.randomUUID());
        if (stopped) return;
        if (result.snapshot && sameServerScope(result.snapshot.scope, expected))
          apply(result.snapshot);
        if (result.status === "inFlight" || result.status === "contextChanged")
          await load();
      } catch {
        if (!stopped) port.report("execute");
      } finally {
        busy = false;
        emit();
      }
    },
  };
}
