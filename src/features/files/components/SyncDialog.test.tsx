// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi, beforeEach } from "vitest";
import { dialogButton, dialogHarness } from "../../../app/dialogs/testHarness";
import { backend } from "../../../infrastructure/backend";
import { setMockSyncPreviewScenario } from "../../../infrastructure/backend/mockBackend";
import type {
  SyncIssueCode,
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

function plan(overrides: Partial<SyncPreviewPlan> = {}): SyncPreviewPlan {
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
      force: false,
      skipPreflight: true,
    },
    counts: {
      added: 0,
      updated: 0,
      deleted: 0,
      upToDate: 0,
      warnings: 0,
      conflicts: 0,
    },
    entries: [],
    totalEntries: 0,
    truncated: false,
    partial: false,
    blockers: [],
    warnings: [],
    contentDigest: "digest",
    token: "sync-token",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: [],
    ...overrides,
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

afterEach(() => {
  vi.restoreAllMocks();
  setMockSyncPreviewScenario("normal");
});

// Components translate through the module-level locale.
beforeEach(() => {
  setLocale("zh-CN");
});

async function render(
  request: Partial<Parameters<typeof SyncDialog>[0]["request"]> = {},
  onDismiss = vi.fn(),
) {
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  await harness.render(
    <SyncDialog
      request={{ nodes, revisionMode: "head", source: null, ...request }}
      connectionKey="connection:2"
      demo={false}
      zh
      onDismiss={onDismiss}
      onRefresh={onRefresh}
    />,
  );
  return { onDismiss, onRefresh };
}

/** Let the real mock backend finish its dynamic import and the dialog settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("counts once on open and confirms with that same plan token", async () => {
  const preview = vi.spyOn(backend, "previewSync").mockResolvedValue(plan());
  const confirm = vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  const { onRefresh } = await render();

  expect(document.body.textContent).toContain("安全同步");
  // One silent count-only call while reviewing; no separate preview step.
  expect(preview).toHaveBeenCalledTimes(1);
  expect(preview).toHaveBeenCalledWith(
    expect.objectContaining({
      paths: ["//depot/a.txt"],
      revision: { kind: "head" },
      force: false,
      skipPreflight: true,
    }),
  );
  expect(confirm).not.toHaveBeenCalled();

  await act(async () => dialogButton("确认并执行").click());
  // The confirmation reuses the counted plan: no second `p4 sync -n`.
  expect(preview).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      token: "sync-token",
      target: plan().target,
      acknowledgeForce: false,
    }),
  );
  expect(document.body.textContent).toContain("synced");
  expect(onRefresh).toHaveBeenCalled();
});

it("shows the count in progress and then the affected-file summary", async () => {
  let finish!: (value: SyncPreviewPlan) => void;
  const preview = vi.spyOn(backend, "previewSync").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();

  expect(document.body.textContent).toContain("正在统计将影响的文件");
  await act(async () =>
    finish(
      plan({
        counts: {
          added: 1,
          updated: 2,
          deleted: 1,
          upToDate: 4,
          warnings: 0,
          conflicts: 0,
        },
      }),
    ),
  );
  expect(preview).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("将影响 4 个文件");
  expect(document.body.textContent).toContain("更新 2");
  expect(document.body.textContent).toContain("新增 1");
  expect(document.body.textContent).toContain("删除 1");
  expect(document.body.textContent).not.toContain("正在统计将影响的文件");
});

it("says there is nothing to update when the count is zero", async () => {
  vi.spyOn(backend, "previewSync").mockResolvedValue(plan());
  await render();
  expect(document.body.textContent).toContain("没有需要更新的文件");
});

it("translates host risk warnings by code instead of showing their message", async () => {
  vi.spyOn(backend, "previewSync").mockResolvedValue(
    plan({
      counts: {
        added: 0,
        updated: 1,
        deleted: 0,
        upToDate: 0,
        warnings: 2,
        conflicts: 0,
      },
      warnings: [
        {
          code: "openedFile",
          message: "Opened file //depot/a.txt may be overwritten.",
        },
        {
          code: "diskSpace",
          message: "Low disk space on the local drive.",
        },
      ],
    }),
  );
  await render();

  expect(document.body.textContent).toContain("范围包含正在打开的文件");
  expect(document.body.textContent).toContain("磁盘剩余空间可能不足");
  expect(document.body.textContent).not.toContain("Low disk space");
});

it("falls back to the host message for an unknown warning code", async () => {
  vi.spyOn(backend, "previewSync").mockResolvedValue(
    plan({
      warnings: [
        {
          code: "futureRisk" as SyncIssueCode,
          message: "Host detail only a newer build understands.",
        },
      ],
    }),
  );
  await render();
  expect(document.body.textContent).toContain(
    "Host detail only a newer build understands.",
  );
});

it("reports an uncountable impact when the host's count-only preview failed", async () => {
  const confirm = vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  vi.spyOn(backend, "previewSync").mockResolvedValue(
    plan({
      warnings: [
        {
          code: "previewFailed",
          message: "The count-only p4 sync -n failed on the host.",
        },
      ],
    }),
  );
  await render();

  // Zero counts from a failed count are unknown, not "nothing to update".
  expect(document.body.textContent).toContain("无法统计受影响文件");
  expect(document.body.textContent).not.toContain("没有需要更新的文件");
  expect(document.body.textContent).not.toContain(
    "The count-only p4 sync -n failed on the host.",
  );

  // The plan still carries a usable token, so confirming executes.
  await act(async () => dialogButton("确认并执行").click());
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][0].token).toBe("sync-token");
});

it("keeps the confirmation available when the count cannot run", async () => {
  const preview = vi
    .spyOn(backend, "previewSync")
    .mockRejectedValue(new Error("p4 sync -n failed"));
  const confirm = vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  await render();

  // A transport failure has no ticket, so the notice must not promise execution.
  expect(document.body.textContent).toContain("无法统计受影响文件");
  expect(document.body.textContent).not.toContain("确认后仍会执行");
  const button = dialogButton("确认并执行");
  expect(button.disabled).toBe(false);

  await act(async () => button.click());
  // The retried count failed again, so nothing was confirmed.
  expect(preview).toHaveBeenCalledTimes(2);
  expect(confirm).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("无法统计受影响文件");
});

it("explains why the confirmation did not start when no ticket exists", async () => {
  vi.spyOn(backend, "previewSync").mockRejectedValue(
    new Error("host transport failed"),
  );
  const confirm = vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  await render();

  await act(async () => dialogButton("确认并执行").click());
  // Visible feedback instead of a silent no-op, and the review page stays.
  expect(document.body.textContent).toContain("无法获取同步确认票据");
  expect(document.body.textContent).not.toContain("同步进度");
  expect(dialogButton("确认并执行").disabled).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
});

it("counts again and retries the confirmation when the host rejects the token", async () => {
  const preview = vi
    .spyOn(backend, "previewSync")
    .mockResolvedValueOnce(plan({ token: "stale-token" }))
    .mockResolvedValueOnce(plan({ token: "fresh-token" }));
  const confirm = vi
    .spyOn(backend, "confirmSync")
    .mockResolvedValueOnce({
      ...result(),
      outcome: "rejected",
      failure: "previewChanged",
      message: "The preview went stale.",
    })
    .mockResolvedValueOnce(result());
  const { onRefresh } = await render();

  await act(async () => dialogButton("确认并执行").click());
  expect(preview).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(confirm.mock.calls[0][0].token).toBe("stale-token");
  expect(confirm.mock.calls[1][0].token).toBe("fresh-token");
  expect(document.body.textContent).toContain("synced");
  expect(onRefresh).toHaveBeenCalled();
});

it("counts again before confirming when the cached plan already expired", async () => {
  const preview = vi
    .spyOn(backend, "previewSync")
    .mockResolvedValueOnce(
      plan({ token: "expired-token", expiresAt: Date.now() - 1 }),
    )
    .mockResolvedValueOnce(plan({ token: "fresh-token" }));
  const confirm = vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  await render();

  await act(async () => dialogButton("确认并执行").click());
  expect(preview).toHaveBeenCalledTimes(2);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0][0].token).toBe("fresh-token");
});

it("stops showing the previous target's count when the options change", async () => {
  const pending: Array<(value: SyncPreviewPlan) => void> = [];
  vi.spyOn(backend, "previewSync").mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  await render();

  await act(async () =>
    pending[0]!(
      plan({
        counts: {
          added: 0,
          updated: 2,
          deleted: 0,
          upToDate: 0,
          warnings: 0,
          conflicts: 0,
        },
      }),
    ),
  );
  expect(document.body.textContent).toContain("将影响 2 个文件");

  // Toggling force invalidates that count: never present it as the new target's.
  await act(async () =>
    document
      .querySelector<HTMLInputElement>(".workflow-checkbox input")!
      .click(),
  );
  expect(document.body.textContent).toContain("正在统计将影响的文件");
  expect(document.body.textContent).not.toContain("将影响 2 个文件");

  await act(async () =>
    pending[1]!(
      plan({
        counts: {
          added: 0,
          updated: 1,
          deleted: 0,
          upToDate: 0,
          warnings: 0,
          conflicts: 0,
        },
      }),
    ),
  );
  expect(document.body.textContent).toContain("将影响 1 个文件");
});

it("shows the browser mock count and recovers from its one stale token", async () => {
  setMockSyncPreviewScenario("staleToken");
  const { onRefresh } = await render();
  await settle();

  expect(document.body.textContent).toContain("将影响 1 个文件");
  expect(document.body.textContent).toContain("无法检查本地打开的文件状态");

  await act(async () => dialogButton("确认并执行").click());
  await settle();
  expect(document.body.textContent).toContain(
    "Browser Mock only: sync was simulated",
  );
  expect(onRefresh).toHaveBeenCalled();
});

it("shows the browser mock count failure without blocking the dialog", async () => {
  setMockSyncPreviewScenario("countFailed");
  await render();
  await settle();

  expect(document.body.textContent).toContain("无法统计受影响文件");
  expect(document.body.textContent).not.toContain("没有需要更新的文件");
  expect(dialogButton("确认并执行").disabled).toBe(false);

  await act(async () => dialogButton("确认并执行").click());
  await settle();
  expect(document.body.textContent).toContain(
    "Browser Mock only: sync was simulated",
  );
});

it("cancels without confirming the counted plan", async () => {
  const preview = vi.spyOn(backend, "previewSync").mockResolvedValue(plan());
  const confirm = vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  const { onDismiss } = await render();

  // The silent count is the only backend work a cancelled dialog may do.
  expect(preview).toHaveBeenCalledTimes(1);
  await act(async () => dialogButton("取消").click());
  expect(onDismiss).toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
});

it("pins a fixed revision and warns about overwriting local changes", async () => {
  const preview = vi.spyOn(backend, "previewSync").mockResolvedValue(
    plan({
      target: {
        ...plan().target,
        revision: { kind: "revision", value: "42" },
      },
    }),
  );
  vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  await render({ revisionMode: "choose", fixedRevision: 42 });

  expect(
    document.querySelector<HTMLSelectElement>("dialog select")?.disabled,
  ).toBe(true);
  expect(
    document.querySelector<HTMLInputElement>(
      'dialog input[inputmode="numeric"]',
    )?.value,
  ).toBe("42");
  expect(document.body.textContent).toContain("#42");

  await act(async () => dialogButton("确认并执行").click());
  expect(preview).toHaveBeenCalledWith(
    expect.objectContaining({ revision: { kind: "revision", value: "42" } }),
  );
});

it("passes the force flag and shows the force risk before confirming", async () => {
  const preview = vi
    .spyOn(backend, "previewSync")
    .mockResolvedValue(plan({ target: { ...plan().target, force: true } }));
  const confirm = vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  await render();

  const force = document.querySelector<HTMLInputElement>(
    ".workflow-checkbox input",
  )!;
  await act(async () => force.click());
  expect(document.body.textContent).toContain("writable/clobber");

  await act(async () => dialogButton("确认并执行").click());
  expect(preview).toHaveBeenCalledWith(
    expect.objectContaining({ force: true, skipPreflight: true }),
  );
  // The skipped-preflight confirmation is the acknowledgement; no extra one.
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({ acknowledgeForce: false }),
  );
});

it("shows a rejected target without executing the sync", async () => {
  vi.spyOn(backend, "previewSync").mockResolvedValue(
    plan({
      ready: false,
      token: undefined,
      blockers: [
        { code: "invalidTarget", message: "Target is outside the view." },
      ],
    }),
  );
  const confirm = vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  await render();

  await act(async () => dialogButton("确认并执行").click());
  expect(document.body.textContent).toContain("Target is outside the view.");
  expect(confirm).not.toHaveBeenCalled();
});

it("shows a live processed-file count, hides close and auto-closes on success", async () => {
  vi.spyOn(backend, "previewSync").mockResolvedValue(plan());
  let finish!: (value: SyncResult) => void;
  const confirm = vi.spyOn(backend, "confirmSync").mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let handler: ((event: unknown) => void) | undefined;
  vi.spyOn(backend, "subscribeOperationEvents").mockImplementation(
    async (callback) => {
      handler = callback as (event: unknown) => void;
      return () => undefined;
    },
  );
  const { onDismiss } = await render();

  await act(async () => dialogButton("确认并执行").click());
  expect(document.querySelector(".workflow-dialog-close")).toBeNull();
  expect(
    document.querySelector("dialog .sync-progress progress"),
  ).not.toBeNull();
  expect(document.body.textContent).toContain("已处理 0 个文件");
  const operationId = confirm.mock.calls[0][0].operationId as string;
  await act(async () => {
    handler?.({
      operationId,
      type: "stdout",
      message: "//depot/a.txt#2 - updating C:/work/a.txt",
      timestamp: new Date().toISOString(),
    });
  });
  expect(document.body.textContent).toContain("已处理 1 个文件");
  await act(async () => finish(result()));
  expect(onDismiss).not.toHaveBeenCalled();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1300));
  });
  expect(onDismiss).toHaveBeenCalled();
});

it("keeps a failed sync open with the error instead of auto-closing", async () => {
  vi.spyOn(backend, "previewSync").mockResolvedValue(plan());
  vi.spyOn(backend, "confirmSync").mockResolvedValue({
    ...result(),
    outcome: "failed",
    failure: "commandFailure",
    message: "sync failed",
  });
  const { onDismiss } = await render();
  await act(async () => dialogButton("确认并执行").click());
  expect(document.body.textContent).toContain("sync failed");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1300));
  });
  expect(onDismiss).not.toHaveBeenCalled();
});

it("pins explicit paths to a changelist revision for a submitted CL", async () => {
  const preview = vi.spyOn(backend, "previewSync").mockResolvedValue(
    plan({
      target: {
        ...plan().target,
        paths: ["//depot/a.txt", "//depot/b.txt"],
        revision: { kind: "change", value: "42" },
      },
    }),
  );
  vi.spyOn(backend, "confirmSync").mockResolvedValue(result());
  await harness.render(
    <SyncDialog
      request={{
        nodes: [],
        revisionMode: "change",
        fixedChange: 42,
        paths: ["//depot/a.txt", "//depot/b.txt"],
        scopeLabel: "CL 42",
        source: null,
      }}
      connectionKey="connection:change"
      demo={false}
      zh
      onDismiss={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(document.body.textContent).toContain("CL #42");
  expect(document.body.textContent).toContain("2 个目标");
  expect(
    document.querySelector<HTMLSelectElement>("dialog select")?.disabled,
  ).toBe(true);
  await act(async () => dialogButton("确认并执行").click());
  expect(preview).toHaveBeenCalledWith(
    expect.objectContaining({
      paths: ["//depot/a.txt", "//depot/b.txt"],
      revision: { kind: "change", value: "42" },
      skipPreflight: true,
    }),
  );
});

it("reports a successful CL-selector sync even without per-file proof", async () => {
  vi.spyOn(backend, "previewSync").mockResolvedValue(
    plan({
      target: {
        ...plan().target,
        revision: { kind: "change", value: "42" },
      },
    }),
  );
  vi.spyOn(backend, "confirmSync").mockResolvedValue({
    kind: "syncRevision",
    state: "unknown",
    outcome: "unknown",
    files: [],
    message: "Per-file revision effect is unconfirmed; no automatic retry.",
    legacy: result(),
  } as unknown as SyncResult);
  const dismiss = vi.fn();
  await harness.render(
    <SyncDialog
      request={{
        nodes: [],
        revisionMode: "change",
        fixedChange: 42,
        paths: ["//depot/a.txt"],
        scopeLabel: "CL 42",
        source: null,
      }}
      connectionKey="connection:change"
      demo={false}
      zh
      onDismiss={dismiss}
      onRefresh={vi.fn()}
    />,
  );
  await act(async () => dialogButton("确认并执行").click());
  expect(document.body.textContent).toContain("synced");
  expect(document.body.textContent).not.toContain("Per-file revision effect");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1300));
  });
  expect(dismiss).toHaveBeenCalled();
});

it("reports a partially synced CL where files still need resolve", async () => {
  vi.spyOn(backend, "previewSync").mockResolvedValue(
    plan({
      target: {
        ...plan().target,
        revision: { kind: "change", value: "42" },
      },
    }),
  );
  vi.spyOn(backend, "confirmSync").mockResolvedValue({
    kind: "syncRevision",
    state: "unknown",
    outcome: "unknown",
    files: [],
    message: "partial",
    legacy: {
      ...result(),
      outcome: "partial",
      failure: "uncertainOutcome",
      message:
        "Files with unresolved merges/integrations were not synced; resolve them, then retry.",
    },
  } as unknown as SyncResult);
  const dismiss = vi.fn();
  await harness.render(
    <SyncDialog
      request={{
        nodes: [],
        revisionMode: "change",
        fixedChange: 42,
        paths: ["//depot/a.txt"],
        scopeLabel: "CL 42",
        source: null,
      }}
      connectionKey="connection:change"
      demo={false}
      zh
      onDismiss={dismiss}
      onRefresh={vi.fn()}
    />,
  );
  await act(async () => dialogButton("确认并执行").click());
  expect(document.body.textContent).toContain("resolve them");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1300));
  });
  expect(dismiss).not.toHaveBeenCalled();
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
  await render();

  await act(async () => dialogButton("确认并执行").click());
  expect(document.body.textContent).toContain("同步进度");
  await act(async () => dialogButton("停止").click());
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
