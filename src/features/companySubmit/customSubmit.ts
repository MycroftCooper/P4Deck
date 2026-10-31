import type { ConnectionSnapshot } from "./model";
import type { ConnectionProfiles } from "../../shared/contracts";

/** Wire mirrors app/custom_submit.rs; the caller never supplies a launch path. */
export interface CustomSubmitStartRequest {
  changeId: string;
  connection: ConnectionSnapshot;
  requestId: string;
}
export interface CustomSubmitSession {
  requestId: string;
  changeId: string;
  state: "started" | "notStarted" | "outcomeUnknown";
  executablePath: string;
  exitCode: number | null;
  reason: string | null;
}

export function customSubmitRoute(
  profiles: ConnectionProfiles,
  connection: ConnectionSnapshot,
  changeIds: readonly string[],
): { kind: "native" } | { kind: "custom"; changeId: string; path: string } {
  const profile = profiles.profiles.find(
    (p) => p.id === profiles.activeProfileId,
  );
  if (
    !profile ||
    profile.id !== connection.profileId ||
    profile.context.server !== connection.server ||
    profile.context.user !== connection.user ||
    profile.context.client !== connection.client
  )
    throw new Error("connectionChanged");
  const path = profile.context.customSubmitExecutablePath ?? "";
  if (!path.trim()) return { kind: "native" };
  if (changeIds.length !== 1 || !/^[0-9]+$/.test(changeIds[0]))
    throw new Error("singleNumberedChangeRequired");
  const changeId = changeIds[0].replace(/^0+(?=\d)/, "");
  if (
    changeId === "0" ||
    changeId.length > 20 ||
    (changeId.length === 20 && changeId > "18446744073709551615")
  )
    throw new Error("invalidChangeId");
  return { kind: "custom", changeId, path };
}

/** Minimal fixed-body constructor prevents accidental path/argv/env forwarding. */
export function customSubmitRequest(
  changeId: string,
  connection: ConnectionSnapshot,
  requestId: string,
): CustomSubmitStartRequest {
  const { profileId, generation, server, user, client } = connection;
  return {
    changeId,
    connection: { profileId, generation, server, user, client },
    requestId,
  };
}
