// @vitest-environment jsdom
import { act } from "react";
import {afterEach, expect, it, vi, beforeEach} from "vitest";
import { dialogButton, dialogHarness } from "../../../app/dialogs/testHarness";
import { backend } from "../../../infrastructure/backend";
import type {
  SyncPreviewPlan,
  SyncResult,
  WorkspaceNode,
} from "../../../shared/contracts";
import { SyncDialog } from "./SyncDialog";
import { setLocale } from "../../../shared/i18n";

const harness = dialogHarness();
const nodes: WorkspaceNode[] = [
  {
    id: "a",
    name: "a.txt",
    kind: "file",
    state: "outOfDate",
    absolutePath: "C:/work/a.txt",
    relativePath: "a.txt",
    depotPath: "//depot/a.txt",
  },
];

function plan(force = false): SyncPreviewPlan {
  return {
    ready: true,
    target: {
      server: "server:1666",
      user: "alice",
      client: "main",
      workspace: "C:/work",
      contextGeneration: 2,
      paths: ["//depot/a.txt"],
      revision: { kind: "head" },
      force,
    },
    counts: {
      added: 0,
      updated: 1,
      deleted: 0,
      upToDate: 0,
      warnings: force ? 1 : 0,
      conflicts: 0,
    },
    entries: [
      {
        kind: "updated",
        depotPath: "//depot/a.txt",
        clientPath: "C:/work/a.txt",
        revision: 2,
        message: "updated",
      },
    ],
    totalEntries: 1,
    truncated: false,
    partial: false,
    blockers: [],
    warnings: force
      ? [{ code: "forceOverwrite", message: "Force is risky." }]
      : [],
    contentDigest: "digest",
    token: "sync-token",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: ["preview-op"],
  };
}

function result(): SyncResult {
  return {
    outcome: "succeeded",
    message: "synced",
    operationId: "sync-op",
    affectedPaths: ["C:/work/a.txt"],
    counts: plan().counts,
    refreshWorkspace: true,
    refreshDepot: true,
  };
}

afterEach(() => vi.restoreAllMocks());

// Components translate through the module-level locale.
beforeEach(() => {
  setLocale("zh-CN");
});

it("requires a real preview token before confirming and reports the result", async () => {
  const preview = vi.spyOn(backend, "previewSync").mockResolvedValue(plan());
  const confirm = vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  const refresh = vi.fn().mockResolvedValue(undefined);
  await harness.render(
    <SyncDialog
      request={{ nodes, revisionMode: "head", source: null }}
      connectionKey="connection:2"
      demo={false}
      zh
      onDismiss={vi.fn()}
      onRefresh={refresh}
    />,
  );
  expect(document.body.textContent).toContain("真实 p4 sync -n");
  await act(async () => dialogButton("预览").click());
  expect(preview).toHaveBeenCalledWith(
    expect.objectContaining({
      paths: ["//depot/a.txt"],
      revision: { kind: "head" },
      force: false,
    }),
  );
  expect(document.body.textContent).toContain("更新 1");
  await act(async () => dialogButton("确认并执行").click());
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      token: "sync-token",
      target: plan().target,
      acknowledgeForce: false,
    }),
  );
  expect(document.body.textContent).toContain("synced");
  expect(refresh).toHaveBeenCalled();
});

it("shows the confirmed result without waiting for background refresh", async () => {
  vi.spyOn(backend, "previewSync").mockResolvedValue(plan());
  vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  const refresh = vi.fn(() => new Promise<void>(() => {}));
  await harness.render(
    <SyncDialog
      request={{ nodes, revisionMode: "head", source: null }}
      connectionKey="connection:2"
      demo={false}
      zh
      onDismiss={vi.fn()}
      onRefresh={refresh}
    />,
  );
  await act(async () => dialogButton("预览").click());
  await act(async () => dialogButton("确认并执行").click());
  expect(document.body.textContent).toContain("synced");
  expect(dialogButton("关闭").disabled).toBe(false);
  expect(refresh).toHaveBeenCalledOnce();
});

it("requires a separate acknowledgement for force and marks Mock as simulated", async () => {
  vi.spyOn(backend, "previewSync").mockResolvedValue(plan(true));
  const confirm = vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  await harness.render(
    <SyncDialog
      request={{ nodes, revisionMode: "head", source: null }}
      connectionKey="connection:2"
      demo
      zh={false}
      onDismiss={vi.fn()}
      onRefresh={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  const force = document.querySelector<HTMLInputElement>(
    ".workflow-checkbox input",
  )!;
  await act(async () => force.click());
  await act(async () => dialogButton("Preview").click());
  expect(document.body.textContent).toContain("Browser Mock");
  expect(dialogButton("Confirm and sync").disabled).toBe(true);
  const acknowledgements = document.querySelectorAll<HTMLInputElement>(
    ".workflow-checkbox input",
  );
  await act(async () => acknowledgements[0].click());
  expect(dialogButton("Confirm and sync").disabled).toBe(false);
  await act(async () => dialogButton("Confirm and sync").click());
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({ acknowledgeForce: true }),
  );
});

it("cancels the exact in-flight sync operation without claiming rollback", async () => {
  vi.spyOn(backend, "previewSync").mockResolvedValue(plan());
  let finish!: (value: SyncResult) => void;
  vi.spyOn(backend, "confirmSync").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const cancel = vi
    .spyOn(backend, "cancelOperation")
    .mockResolvedValue(undefined);
  await harness.render(
    <SyncDialog
      request={{ nodes, revisionMode: "head", source: null }}
      connectionKey="connection:2"
      demo={false}
      zh={false}
      onDismiss={vi.fn()}
      onRefresh={vi.fn().mockResolvedValue(undefined)}
    />,
  );
  await act(async () => dialogButton("Preview").click());
  await act(async () => dialogButton("Confirm and sync").click());
  expect(document.body.textContent).toContain("does not roll back");
  await act(async () => dialogButton("Cancel sync").click());
  expect(cancel).toHaveBeenCalledWith(expect.any(String));
  await act(async () =>
    finish({
      ...result(),
      outcome: "cancelled",
      failure: "cancelled",
      message: "cancelled without rollback",
    }),
  );
});

it("pins a History Get to its file revision and cancellation never confirms", async () => {
  const preview = vi.spyOn(backend, "previewSync").mockResolvedValue(plan());
  const confirm = vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  const dismiss = vi.fn();
  await harness.render(
    <SyncDialog
      request={{
        nodes,
        revisionMode: "choose",
        fixedRevision: 42,
        source: null,
      }}
      connectionKey="history-42"
      demo
      zh={false}
      onDismiss={dismiss}
      onRefresh={vi.fn()}
    />,
  );
  expect(preview).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(
    document.querySelector<HTMLSelectElement>("dialog select")?.disabled,
  ).toBe(true);
  expect(
    document.querySelector<HTMLInputElement>(
      'dialog input[inputmode="numeric"]',
    )?.value,
  ).toBe("42");
  await act(async () => dialogButton("Cancel").click());
  expect(dismiss).toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

it("previews the exact file revision rather than a CL or head and does not auto-confirm", async () => {
  const preview = vi.spyOn(backend, "previewSync").mockResolvedValue(plan());
  const confirm = vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  await harness.render(
    <SyncDialog
      request={{
        nodes,
        revisionMode: "choose",
        fixedRevision: 42,
        source: null,
      }}
      connectionKey="history-preview"
      demo
      zh={false}
      onDismiss={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  await act(async () => dialogButton("Preview").click());
  expect(preview).toHaveBeenCalledWith(
    expect.objectContaining({
      paths: ["//depot/a.txt"],
      revision: { kind: "revision", value: "42" },
      force: false,
    }),
  );
  expect(confirm).not.toHaveBeenCalled();
});
