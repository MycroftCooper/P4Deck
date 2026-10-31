import { expect, it } from "vitest";
import type { RuntimeInfo } from "../../shared/contracts";
import { pendingSnapshotKey } from "./pendingCache";

it("reuses snapshots across restarts while isolating server, user, workspace and profile", () => {
  const runtime: RuntimeInfo = {
    mode: "tauri",
    p4Version: "P4/TEST",
    activeProfileId: "main",
    contextGeneration: 1,
    context: { server: "p4:1666", user: "alice", client: "ws", cwd: "C:/ws" },
    connection: {
      state: "connected",
      message: "",
      recovery: "none",
      server: "p4:1666",
    },
  };
  const key = pendingSnapshotKey(runtime);
  expect(pendingSnapshotKey({ ...runtime, contextGeneration: 99 })).toEqual(
    key,
  );
  for (const context of [
    { ...runtime.context, server: "other:1666" },
    { ...runtime.context, user: "bob" },
    { ...runtime.context, client: "other-ws" },
    { ...runtime.context, cwd: "C:/other-ws" },
  ])
    expect(pendingSnapshotKey({ ...runtime, context })).not.toEqual(key);
  expect(
    pendingSnapshotKey({ ...runtime, activeProfileId: "other" }),
  ).not.toEqual(key);
  expect(pendingSnapshotKey({ ...runtime, mode: "mock" })).not.toEqual(key);
});
