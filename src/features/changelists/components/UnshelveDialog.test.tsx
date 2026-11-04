// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { dialogHarness, dialogButton } from "../../../app/dialogs/testHarness";
import type {
  UnshelvePreflight,
  UnshelvePreflightRequest,
  WorkflowResult,
} from "../../../shared/contracts";
import type { ShelfRequest } from "./ShelfDialog";
import { UnshelveDialog } from "./UnshelveDialog";

const invalidateData = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../../shared/cache/dataEffects", () => ({ invalidateData }));

const connectionSnapshot = {
  profileId: "fixture",
  generation: "1",
  server: "server:1666",
  user: "tester",
  client: "workspace",
};
const provideConnection = async () => connectionSnapshot;
const harness = dialogHarness();

const request: ShelfRequest = {
  changeId: 7,
  paths: ["//depot/a"],
  mode: "shelve",
  hasShelf: true,
  source: null,
};
const target = {
  kind: "unshelve" as const,
  server: "server:1666",
  user: "tester",
  client: "workspace",
  workspace: "/work",
  contextGeneration: 1,
  sourceChangeId: 7,
  depotPaths: ["//depot/a"],
};

const unshelveCheck = (
  targetWorkspace: string,
  targetChangeId: number,
): UnshelvePreflight => ({
  ready: true,
  mappings: [
    {
      depotPath: "//depot/a",
      targetPath: `C:/${targetWorkspace}/a`,
      mapped: true,
      locallyModified: false,
      locked: false,
      resolveRisk: "none",
    },
  ],
  blockers: [],
  warnings: [],
  target: {
    ...target,
    client: targetWorkspace,
    targetChangeId,
  },
  contentDigest: "digest",
  token: "unshelve-token",
  expiresAt: Date.now() + 60_000,
  ttlMs: 60_000,
  operationIds: [],
});

const success = (message = "done"): WorkflowResult => ({
  outcome: "succeeded",
  message,
  operationIds: ["op-1"],
  files: [
    {
      depotPath: "//depot/a",
      state: "succeeded",
      message: "verified",
    },
  ],
  refresh: {
    pendingChanges: true,
    workspaceStatus: true,
    depotPaths: ["//depot/a"],
    reason: "refresh",
  },
});

function renderDialog(overrides: {
  createChange: (description: string) => Promise<number>;
  deleteChange: (changeId: number) => Promise<void>;
  check: ReturnType<typeof vi.fn>;
  execute?: ReturnType<typeof vi.fn>;
  connectionKey?: string;
}) {
  return harness.render(
    <UnshelveDialog
      request={request}
      changes={[]}
      currentWorkspace="workspace"
      connectionKey={overrides.connectionKey ?? "connection-a"}
      zh
      onDismiss={vi.fn()}
      newChangeDescription="Unshelved from CL7"
      createChange={overrides.createChange}
      deleteChange={overrides.deleteChange}
      check={
        overrides.check as (
          value: UnshelvePreflightRequest,
        ) => Promise<UnshelvePreflight>
      }
      execute={overrides.execute ?? vi.fn()}
      connection={provideConnection}
    />,
  );
}

it("creates the changelist once before preflight and reuses it on re-check", async () => {
  const createChange = vi.fn().mockResolvedValue(31899);
  const deleteChange = vi.fn().mockResolvedValue(undefined);
  const check = vi
    .fn()
    .mockImplementation((requestValue: UnshelvePreflightRequest) =>
      Promise.resolve(
        unshelveCheck(
          requestValue.targetWorkspace,
          requestValue.targetChangeId,
        ),
      ),
    );
  await renderDialog({ createChange, deleteChange, check });
  const initialValues = [
    ...document.querySelectorAll<HTMLInputElement>("dialog input"),
  ].map((input) => input.value);
  expect(initialValues.join(" | ")).toContain("Unshelved from CL7");
  expect(document.body.textContent).not.toContain("已创建 CL");
  await act(async () => dialogButton("运行预检").click());
  expect(createChange).toHaveBeenCalledTimes(1);
  expect(createChange).toHaveBeenCalledWith("Unshelved from CL7");
  expect(check).toHaveBeenCalledTimes(1);
  expect(check.mock.calls[0][0]).toMatchObject({
    sourceChangeId: 7,
    depotPaths: ["//depot/a"],
    targetWorkspace: "workspace",
    targetChangeId: 31899,
  });
  expect(document.body.textContent).toContain("已创建 CL #31899");
  expect(document.body.textContent).toContain("CL 31899");
  expect(
    [...document.querySelectorAll<HTMLInputElement>("dialog input")]
      .map((input) => input.value)
      .join(" | "),
  ).toContain("CL 31899");
  await act(async () => dialogButton("运行预检").click());
  expect(createChange).toHaveBeenCalledTimes(1);
  expect(check).toHaveBeenCalledTimes(2);
  expect(check.mock.calls[1][0]).toMatchObject({ targetChangeId: 31899 });
});

it("deletes the newly created empty CL when it closes before confirm", async () => {
  const createChange = vi.fn().mockResolvedValue(31899);
  const deleteChange = vi.fn().mockResolvedValue(undefined);
  const check = vi
    .fn()
    .mockImplementation((requestValue: UnshelvePreflightRequest) =>
      Promise.resolve(
        unshelveCheck(
          requestValue.targetWorkspace,
          requestValue.targetChangeId,
        ),
      ),
    );
  await renderDialog({ createChange, deleteChange, check });
  await act(async () => dialogButton("运行预检").click());
  expect(createChange).toHaveBeenCalledTimes(1);
  expect(deleteChange).not.toHaveBeenCalled();
  await act(async () => harness.render(<div />));
  expect(deleteChange).toHaveBeenCalledTimes(1);
  expect(deleteChange).toHaveBeenCalledWith(31899);
});

it("keeps the created CL after confirm even when the dialog closes", async () => {
  const createChange = vi.fn().mockResolvedValue(31899);
  const deleteChange = vi.fn().mockResolvedValue(undefined);
  const check = vi
    .fn()
    .mockImplementation((requestValue: UnshelvePreflightRequest) =>
      Promise.resolve(
        unshelveCheck(
          requestValue.targetWorkspace,
          requestValue.targetChangeId,
        ),
      ),
    );
  const execute = vi.fn().mockResolvedValue(success("Unshelved"));
  await renderDialog({ createChange, deleteChange, check, execute });
  await act(async () => dialogButton("运行预检").click());
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => dialogButton("确认 Unshelve").click());
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0][0]).toMatchObject({
    token: "unshelve-token",
    target: expect.objectContaining({
      targetChangeId: 31899,
      client: "workspace",
    }),
  });
  await act(async () => harness.render(<div />));
  expect(deleteChange).not.toHaveBeenCalled();
});

it("never deletes the created CL through a different connection", async () => {
  const createChange = vi.fn().mockResolvedValue(31899);
  const deleteChange = vi.fn().mockResolvedValue(undefined);
  const check = vi
    .fn()
    .mockImplementation((requestValue: UnshelvePreflightRequest) =>
      Promise.resolve(
        unshelveCheck(
          requestValue.targetWorkspace,
          requestValue.targetChangeId,
        ),
      ),
    );
  await renderDialog({ createChange, deleteChange, check });
  await act(async () => dialogButton("运行预检").click());
  expect(createChange).toHaveBeenCalledTimes(1);
  // The connection changes before the user confirms: the CL id now belongs to
  // another scope, so closing must not ask the new connection to delete it.
  await renderDialog({
    createChange,
    deleteChange,
    check,
    connectionKey: "connection-b",
  });
  expect(document.body.textContent).toContain("已创建 CL #31899");
  await act(async () => harness.render(<div />));
  expect(deleteChange).not.toHaveBeenCalled();
});

it("does not run preflight when creating the changelist is unconfirmed", async () => {
  const createChange = vi
    .fn()
    .mockRejectedValue(new Error("unconfirmed creation"));
  const deleteChange = vi.fn().mockResolvedValue(undefined);
  const check = vi.fn();
  await renderDialog({ createChange, deleteChange, check });
  await act(async () => dialogButton("运行预检").click());
  expect(createChange).toHaveBeenCalledTimes(1);
  expect(check).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("unconfirmed creation");
  expect(dialogButton("确认 Unshelve").disabled).toBe(true);
  await act(async () => harness.render(<div />));
  expect(deleteChange).not.toHaveBeenCalled();
});
