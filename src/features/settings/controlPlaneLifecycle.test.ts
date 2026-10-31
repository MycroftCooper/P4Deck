import { expect, it } from "vitest";
import type { ConnectionSnapshot } from "../companySubmit/model";
import type { ControlPlaneActionResult } from "../../shared/contracts";
import {
  controlPlaneCommitted,
  controlPlaneLegacy,
  controlPlaneRestorePending,
  runControlPlaneAction,
  syntheticUnknownControlPlane,
} from "./controlPlaneLifecycle";

const connection: ConnectionSnapshot = {
  profileId: "fixture",
  generation: "1",
  server: "server:1666",
  user: "tester",
  client: "workspace",
};
const artifact = {
  exists: true,
  sizeBytes: 1024,
  sha256: "A".repeat(64),
  path: "C:/tmp/file.json",
  fileName: "file.json",
};
const result = (
  overrides: Partial<ControlPlaneActionResult> = {},
): ControlPlaneActionResult => ({
  kind: "backupCreate",
  operationId: "op-1",
  state: "committed",
  outcome: "succeeded",
  artifact,
  details: null,
  optimistic: "intentOnly",
  message: "verified",
  legacy: null,
  ...overrides,
});

it("committed needs readback facts, not just a returned result", () => {
  expect(controlPlaneCommitted(result())).toBe(true);
  expect(
    controlPlaneCommitted(
      result({ artifact: { exists: false, sizeBytes: 0 } }),
    ),
  ).toBe(false);
  expect(controlPlaneCommitted(result({ state: "unknown" }))).toBe(false);
  expect(controlPlaneCommitted(result({ outcome: "unknown" }))).toBe(false);
  // logClear is proven by an empty readback, not by a file artifact.
  expect(
    controlPlaneCommitted(
      result({
        kind: "logClear",
        artifact: { exists: false, sizeBytes: 0 },
        details: { remainingEntries: 0 },
      }),
    ),
  ).toBe(true);
  expect(
    controlPlaneCommitted(
      result({
        kind: "logClear",
        details: { remainingEntries: 2 },
      }),
    ),
  ).toBe(false);
});

it("restore can only be pending (staged), never committed here", () => {
  const staged = result({
    kind: "backupRestore",
    state: "pending",
    outcome: "unknown",
    details: { pendingStaged: true, restartRequired: true },
  });
  expect(controlPlaneRestorePending(staged)).toBe(true);
  expect(controlPlaneCommitted(staged)).toBe(false);
  expect(
    controlPlaneRestorePending(
      result({
        kind: "backupRestore",
        state: "pending",
        details: { pendingStaged: false },
      }),
    ),
  ).toBe(false);
});

it("legacy payloads are only reachable through the wrapped legacy field", () => {
  const legacy = result({
    state: "legacy",
    legacy: { backup: { fileName: "safe.json" } },
  });
  expect(controlPlaneLegacy<{ backup: { fileName: string } }>(legacy)).toEqual({
    backup: { fileName: "safe.json" },
  });
  expect(controlPlaneCommitted(legacy)).toBe(false);
  expect(controlPlaneLegacy(result())).toBeUndefined();
});

it("a lost response returns an explicit unknown and looks up the SAME id once", async () => {
  const lookup = async (request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }) => ({
    kind: "found" as const,
    receipt: {
      operationId: request.operationId,
      kind: "backupCreate" as const,
      connection: request.connection,
      payloadDigest: "a".repeat(64),
      revision: "2",
      state: "settled" as const,
      result: result(),
    },
  });
  const execute = () => Promise.reject(new Error("lost"));
  const run = await runControlPlaneAction({
    kind: "backupCreate",
    operationId: "op-9",
    connection,
    execute,
    lookup,
  });
  expect(run.recovered).toBe(true);
  expect(run.result.operationId).toBe("op-1");
  expect(controlPlaneCommitted(run.result)).toBe(true);
});

it("an unresolvable lost response stays explicitly unknown with no new id", () => {
  const unknown = syntheticUnknownControlPlane(
    "diagnosticsExport",
    "op-7",
    "unconfirmed",
  );
  expect(unknown.state).toBe("unknown");
  expect(unknown.operationId).toBe("op-7");
  expect(unknown.artifact.exists).toBe(false);
  expect(controlPlaneCommitted(unknown)).toBe(false);
});
