import type { ConnectionSnapshot } from "./model";
import { sameSubmitIdentity } from "../changelists/selectedSubmit";
import { releaseCustomSubmitRequest } from "./customSubmitSessions";
export interface CustomParentExit {
  requestId: string;
  changeId: string;
  connection: ConnectionSnapshot;
  exitCode: number | null;
}
export function validParentExit(value: unknown): value is CustomParentExit {
  const e = value as CustomParentExit | undefined;
  const c = e?.connection;
  return (
    !!e &&
    typeof e.requestId === "string" &&
    !!e.requestId &&
    typeof e.changeId === "string" &&
    /^[1-9]\d*$/.test(e.changeId) &&
    !!c &&
    [c.profileId, c.server, c.user, c.client].every(
      (v) => typeof v === "string" && !!v.trim(),
    ) &&
    typeof c.generation === "string" &&
    /^(0|[1-9]\d*)$/.test(c.generation) &&
    (e.exitCode === null || Number.isSafeInteger(e.exitCode))
  );
}
export interface CustomExitPort {
  owner: boolean;
  scope(): string;
  snapshot(): Promise<ConnectionSnapshot>;
  invalidate(connection: ConnectionSnapshot): Promise<void>;
  refresh(
    connection: ConnectionSnapshot,
    current: () => boolean,
  ): Promise<void>;
  report(event: CustomParentExit, error: unknown): void;
}
/** No submission inference, polling or retry. Caller can retain dedupe across listener remounts. */
export function createCustomExitConsumer(
  port: CustomExitPort,
  seen = new Set<string>(),
) {
  let stopped = false;
  return {
    stop() {
      stopped = true;
    },
    async receive(value: unknown) {
      if (stopped || !validParentExit(value)) return;
      const e = { ...value, connection: { ...value.connection } };
      const c = e.connection;
      const key = JSON.stringify([
        e.requestId,
        c.profileId,
        c.generation,
        c.server,
        c.user,
        c.client,
      ]);
      if (seen.has(key)) return;
      seen.add(key);
      // The parent exit is the terminal runtime fact: the tool window is gone,
      // so release the per-(connection, changelist) occupancy even if the later
      // cache refresh fails. Submission outcome stays unknown in session state
      // and durable receipts; only the "already running" claim ends here.
      releaseCustomSubmitRequest(e.requestId, e.changeId);
      const scope = port.scope();
      const current = () => !stopped && port.scope() === scope;
      try {
        await port.invalidate(c);
        if (!port.owner || !current()) return;
        const active = await port.snapshot();
        if (!current() || !sameSubmitIdentity(active, c)) return;
        await port.refresh(c, current);
      } catch (error) {
        if (!stopped) port.report(e, error);
      }
    },
  };
}
