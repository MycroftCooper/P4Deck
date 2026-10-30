import { expect, it } from "vitest";
import type { ConnectionSnapshot } from "../companySubmit/model";
import type {
  BranchMappingDetail,
  StreamSwitchResult,
} from "../../shared/contracts";
import {
  branchConnectionMatchesTarget,
  branchObservedSummary,
  streamConnectionMatchesTarget,
  unknownBranchMutationResult,
  unknownStreamSwitchResult,
  verifiedStreamSwitch,
} from "./mutationLifecycle";

const connection: ConnectionSnapshot = {
  profileId: "profile-a",
  generation: "7",
  server: "localhost:1666",
  user: "alice",
  client: "workspace",
};
const detail: BranchMappingDetail = {
  name: "atlas-release",
  owner: "alice",
  description: "release",
  locked: false,
  view: [
    { modifier: "map", source: "//atlas/main/...", target: "//atlas/rel/..." },
    {
      modifier: "exclude",
      source: "//atlas/secret/...",
      target: "//atlas/rel/...",
    },
  ],
  unknownFields: [],
  editable: true,
  operationIds: [],
  simulated: false,
};
const streamResult: StreamSwitchResult = {
  outcome: "succeeded",
  message: "verified",
  streamChanged: true,
  syncPerformed: false,
  syncCompleted: false,
  verifiedStream: "//depot/dev",
  operationId: "op",
  runtime: {
    mode: "tauri",
    p4Version: "P4/TEST",
    activeProfileId: "profile-a",
    contextGeneration: 8,
    context: {
      server: "localhost:1666",
      user: "alice",
      client: "workspace",
      cwd: "C:/work",
    },
    connection: {
      state: "connected",
      message: "ok",
      recovery: "none",
      server: "localhost:1666",
    },
  },
  refresh: {
    workspace: true,
    streams: true,
    pendingChanges: true,
    submittedChanges: true,
    search: true,
    depot: true,
    reason: "refresh",
  },
};

it("matches exact branch/stream target identity", () => {
  const target = {
    activeProfileId: "profile-a",
    contextGeneration: 7,
    server: "localhost:1666",
    user: "alice",
    client: "workspace",
    mode: "create" as const,
    name: "atlas-release",
    currentExists: false,
  };
  expect(branchConnectionMatchesTarget(target, connection)).toBe(true);
  expect(
    branchConnectionMatchesTarget({ ...target, server: "other" }, connection),
  ).toBe(false);
  expect(
    branchConnectionMatchesTarget(
      { ...target, contextGeneration: 8 },
      connection,
    ),
  ).toBe(false);

  const streamTarget = {
    server: "localhost:1666",
    user: "alice",
    client: "workspace",
    workspace: "C:/work",
    activeProfileId: "profile-a",
    contextGeneration: 7,
    targetStream: "//depot/dev",
    targetType: "development",
    mode: "viewOnly" as const,
    clientSpecDigest: "c",
    streamSpecDigest: "s",
    riskDigest: "r",
  };
  expect(streamConnectionMatchesTarget(streamTarget, connection)).toBe(true);
  expect(
    streamConnectionMatchesTarget(
      { ...streamTarget, client: "other-ws" },
      connection,
    ),
  ).toBe(false);
});

it("only the readback summary is authority for branch mutations", () => {
  expect(branchObservedSummary(undefined)).toBeUndefined();
  expect(branchObservedSummary(detail)).toEqual({
    name: "atlas-release",
    owner: "alice",
    viewLines: 2,
    locked: false,
  });
});

it("requires verified streamChanged+runtime identity for stream success", () => {
  expect(verifiedStreamSwitch(streamResult)).toEqual({
    stream: "//depot/dev",
    contextGeneration: 8,
    client: "workspace",
  });
  expect(
    verifiedStreamSwitch({ ...streamResult, streamChanged: false }),
  ).toBeUndefined();
  expect(
    verifiedStreamSwitch({ ...streamResult, runtime: undefined }),
  ).toBeUndefined();
  expect(
    verifiedStreamSwitch({ ...streamResult, outcome: "unknown" }),
  ).toBeUndefined();
  expect(verifiedStreamSwitch(undefined)).toBeUndefined();
});

it("synthesized unknowns never carry success or observed authority", () => {
  const branch = unknownBranchMutationResult("op-1", "transport lost");
  expect(branch.outcome).toBe("unknown");
  expect(branch.observed).toBeUndefined();
  expect(branch.refreshBranchMappings).toBe(true);
  expect(branch.operationIds).toEqual(["op-1"]);

  const stream = unknownStreamSwitchResult("op-2", "transport lost");
  expect(stream.outcome).toBe("unknown");
  expect(stream.streamChanged).toBe(false);
  expect(stream.verifiedStream).toBeUndefined();
  expect(stream.operationId).toBe("op-2");
  expect(stream.refresh.workspace).toBe(true);
});
