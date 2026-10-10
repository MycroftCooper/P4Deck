// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  chooseSelect,
  dialogButton,
  dialogHarness,
} from "../../../app/dialogs/testHarness";
import type {
  ForceUnlockPreflight,
  ForceUnlockResult,
  ForceUnlockTargetSnapshot,
  WorkspaceNode,
} from "../../../shared/contracts/types";
import { ForceUnlockDialog } from "./ForceUnlockDialog";

const harness = dialogHarness();
const nodes: WorkspaceNode[] = ["b", "a", "b"].map((name, index) => ({
  id: `${name}-${index}`,
  name: `${name}.bin`,
  kind: "file",
  state: "controlled",
  absolutePath: `C:\\workspace\\${name}.bin`,
  relativePath: `${name}.bin`,
  depotPath: `//depot/main/${name}.bin`,
}));

const origin = { mode: "openedChangelist" as const, changeId: 71 };
const locks = ["//depot/main/b.bin", "//depot/main/a.bin"].map(
  (depotPath, index) => ({
    depotPath,
    exists: true,
    locked: true,
    lockOwner: index ? "carol@render-2" : "bob@render-1",
    lockUser: index ? "carol" : "bob",
    lockClient: index ? "render-2" : "render-1",
    changeId: 71,
    openedAction: "edit",
    fileType: "binary+l",
    exclusive: true,
    origin,
    originProven: true,
    permission: index ? ("super" as const) : ("admin" as const),
  }),
);
const target: ForceUnlockTargetSnapshot = {
  context: {
    server: "ssl:fixture:1666",
    user: "administrator",
    client: "admin-workspace",
    cwd: "C:\\workspace",
  },
  activeProfileId: "fixture-profile",
  contextGeneration: 9,
  paths: locks.map((lock) => lock.depotPath),
  origin,
  locks,
  expectedAcknowledgement: "FORCE UNLOCK 2 FILES OWNED BY MULTIPLE OWNERS",
};

function ready(): ForceUnlockPreflight {
  return {
    ready: true,
    origin,
    locks,
    blockers: [],
    warnings: [
      {
        code: "stateUnknown",
        message: "Coordinate with both lock owners.",
        paths: target.paths,
      },
    ],
    targetSnapshot: target,
    stateDigest: "force-digest",
    expectedAcknowledgement: target.expectedAcknowledgement,
    token: "force-token",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: ["preflight:opened"],
    simulated: true,
  };
}

async function fill(label: string, value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(
      `input[aria-label="${label}"]`,
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("preserves target order and binds typed acknowledgement to the dedicated confirmation", async () => {
  const check = vi.fn().mockResolvedValue(ready());
  const execute = vi.fn().mockResolvedValue({
    outcome: "succeeded",
    message: "Both files verified unlocked.",
    files: target.paths.map((depotPath, index) => ({
      depotPath,
      outcome: "unlocked" as const,
      previousOwner: locks[index].lockOwner,
      message: "No lock remains.",
    })),
    operationId: "force-op",
    operationIds: ["force-op:file-0", "force-op:file-1"],
    refresh: {
      workspaceStatus: true,
      pendingChanges: true,
      search: true,
      review: true,
      depotPaths: target.paths,
      localPaths: [],
      reason: "Force unlock executed; refresh lock facts.",
    },
    simulated: true,
  } satisfies ForceUnlockResult);
  const refresh = vi.fn();
  await harness.render(
    <ForceUnlockDialog
      nodes={nodes}
      source={null}
      connectionKey="a"
      zh={false}
      simulated
      onDismiss={vi.fn()}
      onRefresh={refresh}
      check={check}
      execute={execute}
    />,
  );
  await fill("Origin changelist", "71");
  await act(async () => dialogButton("High-risk preflight and review").click());
  expect(document.body.textContent).toContain("ssl:fixture:1666");
  expect(document.body.textContent).toContain("bob@render-1");
  expect(document.body.textContent).toContain("admin");
  expect(dialogButton("Confirm administrator force unlock").disabled).toBe(
    true,
  );
  await fill("Force unlock acknowledgement", target.expectedAcknowledgement);
  await act(async () =>
    dialogButton("Confirm administrator force unlock").click(),
  );
  expect(check).toHaveBeenCalledWith({
    paths: ["//depot/main/b.bin", "//depot/main/a.bin"],
    origin,
    operationId: expect.any(String),
  });
  expect(execute).toHaveBeenCalledWith({
    token: "force-token",
    target,
    stateDigest: "force-digest",
    acknowledgement: target.expectedAcknowledgement,
    operationId: expect.any(String),
  });
  expect(document.body.textContent).toContain(
    "Force unlock completely verified",
  );
  expect(refresh).toHaveBeenCalledOnce();
});

it("shows authoritative default, shelved, orphan, and permission blockers without an override", async () => {
  const check = vi.fn(async (request) => ({
    ...ready(),
    ready: false,
    origin: request.origin,
    locks: request.origin.mode === "openedChangelist" ? [] : locks,
    blockers: [
      {
        code:
          request.origin.mode === "openedChangelist"
            ? ("invalidTarget" as const)
            : request.origin.mode === "shelvedChangelist"
              ? ("originUnproven" as const)
              : ("unsupportedServerTopology" as const),
        message:
          request.origin.mode === "openedChangelist"
            ? "another client's default changelist cannot be addressed safely"
            : request.origin.mode === "shelvedChangelist"
              ? "-s is blocked because origin is unproven"
              : "-x requires proven distributed topology and orphan origin",
        paths: target.paths,
      },
      {
        code: "adminPermissionRequired" as const,
        message: "admin or super proof is required",
        paths: target.paths,
      },
    ],
    targetSnapshot: undefined,
    token: undefined,
  }));
  const render = (key: string) =>
    harness.render(
      <ForceUnlockDialog
        key={key}
        nodes={nodes}
        source={null}
        connectionKey="a"
        zh={false}
        simulated
        onDismiss={vi.fn()}
        check={check}
      />,
    );
  await render("default");
  await fill("Origin changelist", "default");
  await act(async () => dialogButton("High-risk preflight and review").click());
  expect(document.body.textContent).toContain(
    "another client's default changelist cannot be addressed safely",
  );
  expect(document.body.textContent).toContain(
    "admin or super proof is required",
  );
  expect(dialogButton("Confirm administrator force unlock").disabled).toBe(
    true,
  );

  await render("shelved");
  await chooseSelect("shelvedChangelist");
  await fill("Origin changelist", "71");
  await act(async () => dialogButton("High-risk preflight and review").click());
  expect(document.body.textContent).toContain("-s is blocked");
  expect(dialogButton("Confirm administrator force unlock").disabled).toBe(
    true,
  );

  await render("orphan");
  await chooseSelect("orphanDistributed");
  await act(async () => dialogButton("High-risk preflight and review").click());
  expect(document.body.textContent).toContain("-x requires proven");
  expect(dialogButton("Confirm administrator force unlock").disabled).toBe(
    true,
  );
});

it("never reports replay, TOCTOU, or partial verification as success and refreshes facts", async () => {
  const refreshResult = {
    workspaceStatus: true,
    pendingChanges: true,
    search: true,
    review: true,
    depotPaths: target.paths,
    localPaths: [],
    reason: "Refresh before retry.",
  };
  const execute = vi
    .fn()
    .mockResolvedValueOnce({
      outcome: "partial",
      failure: "stateChanged",
      message: "Owner or origin changed after review.",
      files: [
        {
          depotPath: target.paths[0],
          outcome: "stillLocked",
          previousOwner: "bob@render-1",
          observedOwner: "dave@render-3",
          message: "TOCTOU mismatch",
        },
        {
          depotPath: target.paths[1],
          outcome: "unverifiable",
          message: "Verification timed out",
        },
      ],
      operationIds: [],
      refresh: refreshResult,
      simulated: true,
    } satisfies ForceUnlockResult)
    .mockResolvedValueOnce({
      outcome: "rejected",
      failure: "tokenUnknown",
      message: "The one-use token is unknown or already used.",
      files: [],
      operationIds: [],
      refresh: refreshResult,
      simulated: true,
    } satisfies ForceUnlockResult);
  const refresh = vi.fn();
  await harness.render(
    <ForceUnlockDialog
      nodes={nodes}
      source={null}
      connectionKey="a"
      zh={false}
      simulated
      onDismiss={vi.fn()}
      onRefresh={refresh}
      check={vi.fn().mockResolvedValue(ready())}
      execute={execute}
    />,
  );
  await fill("Origin changelist", "71");
  await act(async () => dialogButton("High-risk preflight and review").click());
  await fill("Force unlock acknowledgement", target.expectedAcknowledgement);
  await act(async () =>
    dialogButton("Confirm administrator force unlock").click(),
  );
  expect(document.body.textContent).toContain(
    "Not verified as complete success",
  );
  expect(document.body.textContent).toContain("stateChanged");
  expect(document.body.textContent).toContain("stillLocked");
  expect(document.body.textContent).toContain("unverifiable");
  expect(refresh).toHaveBeenCalledOnce();

  await act(async () => dialogButton("Preflight again").click());
  await act(async () => dialogButton("High-risk preflight and review").click());
  await fill("Force unlock acknowledgement", target.expectedAcknowledgement);
  await act(async () =>
    dialogButton("Confirm administrator force unlock").click(),
  );
  expect(document.body.textContent).toContain("tokenUnknown");
  expect(document.body.textContent).toContain(
    "Not verified as complete success",
  );
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("aborts an active preflight and isolates its late response", async () => {
  let resolve!: (value: ForceUnlockPreflight) => void;
  const check = vi.fn(
    () => new Promise<ForceUnlockPreflight>((done) => (resolve = done)),
  );
  const cancelOperation = vi.fn().mockResolvedValue(undefined);
  await harness.render(
    <ForceUnlockDialog
      nodes={nodes}
      source={null}
      connectionKey="a"
      zh={false}
      simulated
      onDismiss={vi.fn()}
      check={check}
      cancelOperation={cancelOperation}
    />,
  );
  await fill("Origin changelist", "71");
  await act(async () => dialogButton("High-risk preflight and review").click());
  await act(async () => dialogButton("Cancel preflight").click());
  expect(cancelOperation).toHaveBeenCalledWith(expect.any(String));
  await act(async () => resolve(ready()));
  expect(document.body.textContent).not.toContain("bob@render-1");
  expect(dialogButton("High-risk preflight and review")).toBeTruthy();
});
