import { expect, it } from "vitest";
import type { ConnectionSnapshot } from "../companySubmit/model";
import type { SubmitResult } from "../../shared/contracts";
import {
  submitConnectionMatchesTarget,
  submitLifecycle,
  unknownSubmitResult,
  validSubmittedChangeId,
} from "./submitLifecycle";

const operationId = "0f6e3a1c-8f0a-4b1f-9c1e-2c4a8b6d1f23";
const refresh = {
  pendingChanges: true,
  submittedChanges: true,
  workspaceStatus: true,
  depotPaths: ["//depot/a"],
  reason: "refresh",
};
const result = (overrides: Partial<SubmitResult> = {}): SubmitResult => ({
  outcome: "submitted",
  changeId: 10,
  submittedChangeId: 42,
  message: "submitted",
  refresh,
  ...overrides,
});
const envelope = (
  state: "commandCompleted" | "unknown",
  overrides: Partial<SubmitResult> = {},
): SubmitResult =>
  result({
    execution: {
      kind: "submit",
      operationId,
      state,
      outcome: overrides.outcome ?? "submitted",
      files: [],
    },
    ...overrides,
  });

it("accepts only a positive safe-integer submitted change id", () => {
  expect(validSubmittedChangeId(42)).toBe(true);
  expect(validSubmittedChangeId(0)).toBe(false);
  expect(validSubmittedChangeId(-1)).toBe(false);
  expect(validSubmittedChangeId(1.5)).toBe(false);
  expect(validSubmittedChangeId(undefined)).toBe(false);
});

it("presents authority only for commandCompleted + submitted + submittedChangeId", () => {
  const ok = submitLifecycle(envelope("commandCompleted"), operationId);
  expect(ok.state).toBe("submitted");
  expect(ok.authoritativeSubmitted).toBe(true);
  expect(ok.submittedChangeId).toBe(42);

  const noId = submitLifecycle(
    envelope("commandCompleted", { submittedChangeId: undefined }),
    operationId,
  );
  expect(noId.state).toBe("unknown");
  expect(noId.authoritativeSubmitted).toBe(false);

  const unknownState = submitLifecycle(envelope("unknown"), operationId);
  expect(unknownState.state).toBe("unknown");
  expect(unknownState.authoritativeSubmitted).toBe(false);

  const mismatchedId = submitLifecycle(
    envelope("commandCompleted", {
      execution: {
        kind: "submit",
        operationId: "another-id",
        state: "commandCompleted",
        outcome: "submitted",
        files: [],
      },
    }),
    operationId,
  );
  expect(mismatchedId.state).toBe("unknown");
  expect(mismatchedId.authoritativeSubmitted).toBe(false);
});

it("keeps legacy payload semantics without inventing submission", () => {
  const legacy = submitLifecycle(result(), operationId);
  expect(legacy.state).toBe("submitted");
  expect(legacy.envelope).toBe(false);
  expect(legacy.authoritativeSubmitted).toBe(true);

  const legacyNoId = submitLifecycle(
    result({ submittedChangeId: undefined }),
    operationId,
  );
  expect(legacyNoId.state).toBe("unknown");

  const rejected = submitLifecycle(
    result({
      outcome: "rejected",
      submittedChangeId: undefined,
      failure: "tokenExpired",
    }),
    operationId,
  );
  expect(rejected.state).toBe("rejected");
  expect(rejected.envelope).toBe(false);
});

it("never reports failure or cancellation as submitted", () => {
  for (const outcome of ["failed", "cancelled"] as const)
    expect(
      submitLifecycle(
        result({ outcome, submittedChangeId: undefined }),
        operationId,
      ).state,
    ).toBe(outcome);
});

it("matches the reviewed target identity", () => {
  const connection: ConnectionSnapshot = {
    profileId: "fixture",
    generation: "1",
    server: "server:1666",
    user: "tester",
    client: "workspace",
  };
  const target = {
    server: "server:1666",
    user: "tester",
    client: "workspace",
    workspace: "/work",
    changeId: 10,
    contextGeneration: 1,
  };
  expect(submitConnectionMatchesTarget(target, connection)).toBe(true);
  expect(
    submitConnectionMatchesTarget({ ...target, server: "other" }, connection),
  ).toBe(false);
  expect(
    submitConnectionMatchesTarget(
      { ...target, contextGeneration: 2 },
      connection,
    ),
  ).toBe(false);
});

it("the synthesized transport-unknown result carries no new CL id and no success", () => {
  const unknown = unknownSubmitResult(10, operationId, ["//depot/a"]);
  expect(unknown.outcome).toBe("unknown");
  expect(unknown.submittedChangeId).toBeUndefined();
  expect(unknown.operationId).toBe(operationId);
  expect(unknown.failure).toBe("uncertainOutcome");
  expect(submitLifecycle(unknown, operationId).state).toBe("unknown");
});
