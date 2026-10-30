/** CL-06 v1 data contract. No execution or IPC implementation is supplied here. */
export interface ConnectionSnapshot {
  profileId: string;
  generation: string;
  server: string;
  user: string;
  client: string;
}
export interface PlanRequest {
  changeIds: readonly string[];
  executablePath: string;
  connection: ConnectionSnapshot;
}
export interface Plan {
  changeId: string;
  executablePath: string;
  argv: readonly string[];
  connection: ConnectionSnapshot;
  realStartAllowed: false;
  blockers: readonly string[];
}
export type PlanError =
  | "singleNumberedChangeRequired"
  | "invalidChangeId"
  | "invalidExecutablePath"
  | "invalidConnection"
  | "connectionChanged"
  | "toolMissing"
  | "toolNotFile"
  | "toolUnverified"
  | "toolChanged"
  | "busy"
  | "staleSession"
  | "invalidTransition"
  | "realStartDisabled";
export type PlanResult =
  { ok: true; plan: Plan } | { ok: false; error: PlanError };
/** Hints only. Range, canonicalization, current identity and file evidence belong to BE. */
export function inputHint(request: PlanRequest): PlanError | undefined {
  if (request.changeIds.length !== 1) return "singleNumberedChangeRequired";
  if (
    !/^[0-9]+$/.test(request.changeIds[0]) ||
    !/[1-9]/.test(request.changeIds[0])
  )
    return "invalidChangeId";
  if (!request.executablePath) return "invalidExecutablePath";
  if (
    !request.connection.profileId ||
    !request.connection.generation ||
    ![
      request.connection.server,
      request.connection.user,
      request.connection.client,
    ].every((v) => v.trim())
  )
    return "invalidConnection";
}
/** Local response correlation only; never substitute this key for host identity. */
export function requestBinding(request: PlanRequest): string {
  const c = request.connection;
  return JSON.stringify([
    request.changeIds,
    request.executablePath,
    c.profileId,
    c.generation,
    c.server,
    c.user,
    c.client,
  ]);
}
export function snapshotRequest(request: PlanRequest): PlanRequest {
  const { profileId, generation, server, user, client } = request.connection;
  return Object.freeze({
    changeIds: Object.freeze([...request.changeIds]),
    executablePath: request.executablePath,
    connection: Object.freeze({ profileId, generation, server, user, client }),
  });
}
export type SimulationPhase =
  "reserved" | "running" | "notStarted" | "outcomeUnknown";
export type SessionState =
  | { state: "reserved" }
  | { state: "running" }
  | { state: "notStarted" }
  | { state: "outcomeUnknown"; exitCode: number | null };
export interface Simulation {
  readonly requestId: string;
  readonly binding: string;
  readonly state: SessionState;
}
/** Test-only state machine; host reservation is still the only cross-window authority. */
export function beginSimulation(
  current: Simulation | undefined,
  request: PlanRequest,
  requestId: string,
): Simulation | undefined {
  if (
    !requestId ||
    (current &&
      (current.state.state !== "notStarted" || current.requestId === requestId))
  )
    return current;
  return Object.freeze({
    requestId,
    binding: requestBinding(request),
    state: { state: "reserved" as const },
  });
}
export function applySimulation(
  current: Simulation,
  event: {
    requestId: string;
    binding: string;
    state: Exclude<SessionState, { state: "reserved" }>;
  },
): Simulation {
  if (
    event.requestId !== current.requestId ||
    event.binding !== current.binding ||
    current.state.state === "notStarted" ||
    current.state.state === "outcomeUnknown"
  )
    return current;
  if (event.state.state === "notStarted" && current.state.state !== "reserved")
    return current;
  return Object.freeze({
    ...current,
    state: Object.freeze({ ...event.state }),
  });
}
/** Local envelope: request ID and binding are not extra BE wire fields. */
export interface PreviewReply {
  requestId: string;
  binding: string;
  result: PlanResult;
}
export function currentReply(
  reply: PreviewReply | undefined,
  request: PlanRequest,
  requestId: string,
): PlanResult | undefined {
  return reply?.requestId === requestId &&
    reply.binding === requestBinding(request)
    ? reply.result
    : undefined;
}
