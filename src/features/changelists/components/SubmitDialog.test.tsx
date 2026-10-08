// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { dialogHarness } from "../../../app/dialogs/testHarness";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubmitDialog, type SubmitCheck } from "./SubmitDialog";
import type { SubmitResult } from "../../../shared/contracts/types";

const root = dialogHarness();
const dismiss = vi.fn();
beforeEach(() => {
  dismiss.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});
function result(): SubmitCheck {
  return {
    ready: true,
    change: {
      id: 10,
      description: "Changes",
      user: "tester",
      client: "workspace",
      status: "pending",
      jobs: [],
      files: [{ depotPath: "//depot/a", action: "edit", state: "openedEdit" }],
      shelvedFiles: [],
    },
    blockers: [],
    warnings: [
      {
        code: "jobPolicyUnknown",
        certainty: "unknown",
        message: "Review warning",
      },
    ],
    target: {
      server: "server:1666",
      user: "tester",
      client: "workspace",
      workspace: "/workspace",
      changeId: 10,
      contextGeneration: 1,
    },
    fileSummary: {
      fileCount: 1,
      depotPaths: ["//depot/a"],
      actionCounts: { edit: 1 },
      contentDigest: "digest",
    },
    token: "snapshot-token",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: ["preflight-op"],
    logReference: "preflight-op",
    refreshRecommended: false,
  };
}
async function render(
  overrides: Partial<ComponentProps<typeof SubmitDialog>> = {},
) {
  await act(async () =>
    root.render(
      <SubmitDialog
        changeId={10}
        count={1}
        client="workspace"
        connectionKey="a"
        zh
        onDismiss={dismiss}
        loadSummary={async () => result().change}
        {...overrides}
      />,
    ),
  );
}
function button(text: string) {
  return [...document.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  )!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function acknowledge() {
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
}
it("never treats a file summary as preflight or enables an unconnected submission", async () => {
  await render();
  expect(document.body.textContent).toContain("尚未预检");
  expect(button("重新预检").disabled).toBe(true);
  expect(button("确认提交整个 CL").disabled).toBe(true);
});
it("shows loading before a summary arrives and failure if it is missing", async () => {
  let finish!: (value: undefined) => void;
  await render({
    loadSummary: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  expect(document.body.textContent).toContain("正在加载文件摘要");
  await act(async () => finish(undefined));
  expect(document.body.textContent).toContain("找不到此 CL");
  expect(button("确认提交整个 CL").disabled).toBe(true);
});
it("requires explicit whole-CL acknowledgement and passes the exact checked target to an adapter", async () => {
  const submit = vi.fn(async () => ({
    outcome: "submitted" as const,
    changeId: 10,
    submittedChangeId: 10,
    message: "Submitted CL 10",
    refresh: {
      pendingChanges: true,
      submittedChanges: true,
      workspaceStatus: true,
      depotPaths: ["//depot/a"],
      reason: "refresh",
    },
  }));
  await render({ check: async () => result(), submit });
  await click("重新预检");
  expect(document.body.textContent).toContain("Review warning");
  expect(button("确认提交整个 CL").disabled).toBe(true);
  await acknowledge();
  await click("确认提交整个 CL");
  expect(submit).toHaveBeenCalledExactlyOnceWith({
    token: "snapshot-token",
    target: result().target,
  });
  expect(document.body.textContent).toContain("Submitted CL 10");
  expect(button("确认提交整个 CL").disabled).toBe(true);
});
it("blocks preflight failures and requires fresh preflight after a submit failure", async () => {
  const check = vi.fn(async (): Promise<SubmitCheck> => ({
    ...result(),
    ready: false,
    blockers: [
      {
        code: "unresolvedFiles",
        certainty: "confirmed",
        message: "Unresolved files",
      },
    ],
  }));
  const submit = vi.fn(async () => {
    throw new Error("offline");
  });
  await render({ check, submit });
  await click("重新预检");
  expect(document.body.textContent).toContain("Unresolved files");
  expect(button("确认提交整个 CL").disabled).toBe(true);
  check.mockImplementation(async () => result());
  await click("重新预检");
  await acknowledge();
  await click("确认提交整个 CL");
  expect(document.body.textContent).toContain("offline");
  expect(button("确认提交整个 CL").disabled).toBe(true);
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
});
it("renders blocker, warning, and unknown facts even when a blocked preflight has no token", async () => {
  await render({
    check: async () => ({
      ...result(),
      ready: false,
      token: undefined,
      blockers: [
        {
          code: "outOfDateFiles",
          certainty: "confirmed",
          message: "Out of date",
        },
      ],
      warnings: [
        {
          code: "shelvedFilesPresent",
          certainty: "confirmed",
          message: "Shelf remains",
        },
        {
          code: "permissionUnknown",
          certainty: "unknown",
          message: "Permission could not be verified",
        },
      ],
    }),
  });
  await click("重新预检");
  expect(document.body.textContent).toContain("阻塞：Out of date");
  expect(document.body.textContent).toContain("警告：Shelf remains");
  expect(document.body.textContent).toContain(
    "未知：Permission could not be verified",
  );
  expect(document.body.textContent).not.toContain("预检结果与目标不匹配");
  expect(button("确认提交整个 CL").disabled).toBe(true);
});
it("shows a change-not-found blocker instead of misreporting target mismatch", async () => {
  await render({
    check: async () => ({
      ...result(),
      ready: false,
      change: undefined,
      token: undefined,
      blockers: [
        {
          code: "changeNotFound",
          certainty: "confirmed",
          message: "The changelist was not found",
        },
      ],
    }),
  });
  await click("重新预检");
  expect(document.body.textContent).toContain("The changelist was not found");
  expect(document.body.textContent).not.toContain("预检结果与目标不匹配");
});
it("expires a checked snapshot and invalidates acknowledgement", async () => {
  vi.useFakeTimers();
  await render({
    check: async () => result(),
    submit: vi.fn(async () => ({
      outcome: "submitted" as const,
      changeId: 10,
      message: "done",
      refresh: {
        pendingChanges: true,
        submittedChanges: true,
        workspaceStatus: true,
        depotPaths: [],
        reason: "refresh",
      },
    })),
  });
  await click("重新预检");
  await acknowledge();
  await act(async () => vi.advanceTimersByTime(60_001));
  expect(document.body.textContent).toContain("预检已过期");
  expect(button("确认提交整个 CL").disabled).toBe(true);
});
it("rejects mismatched preflight identities", async () => {
  await render({
    check: async () => ({
      ...result(),
      change: { ...result().change!, id: 20 },
    }),
  });
  await click("重新预检");
  expect(document.body.textContent).toContain("预检结果与目标不匹配");
});
it("shows structured target mismatch and uncertain execution outcomes without success", async () => {
  const submit = vi.fn(async () => ({
    outcome: "unknown" as const,
    changeId: 10,
    failure: "uncertainOutcome" as const,
    message: "Server outcome is unknown",
    operationId: "submit-op",
    logReference: "submit-log",
    refresh: {
      pendingChanges: true,
      submittedChanges: true,
      workspaceStatus: true,
      depotPaths: ["//depot/a"],
      reason: "Refresh all submit views before retrying.",
    },
  }));
  await render({ check: async () => result(), submit });
  await click("重新预检");
  await acknowledge();
  await click("确认提交整个 CL");
  expect(document.body.textContent).toContain("unknown · uncertainOutcome");
  expect(document.body.textContent).toContain("submit-op");
  expect(document.body.textContent).toContain("submit-log");
  expect(button("确认提交整个 CL").disabled).toBe(true);
});
it("prevents duplicate submit execution while confirmation is in flight", async () => {
  let finish!: (value: SubmitResult) => void;
  const submit = vi.fn(
    () =>
      new Promise<SubmitResult>((resolve) => {
        finish = resolve;
      }),
  );
  await render({ check: async () => result(), submit });
  await click("重新预检");
  await acknowledge();
  const confirm = button("确认提交整个 CL");
  await act(async () => {
    confirm.click();
    confirm.click();
  });
  expect(submit).toHaveBeenCalledOnce();
  await act(async () =>
    finish({
      outcome: "submitted",
      changeId: 10,
      message: "Submitted",
      refresh: {
        pendingChanges: true,
        submittedChanges: true,
        workspaceStatus: true,
        depotPaths: [],
        reason: "refresh",
      },
    }),
  );
});
it("locks duplicate checks and lets the user close after a connection change", async () => {
  let finish!: (value: SubmitCheck) => void;
  const check = vi.fn(
    () =>
      new Promise<SubmitCheck>((resolve) => {
        finish = resolve;
      }),
  );
  await render({ check });
  await click("重新预检");
  await click("重新预检");
  expect(check).toHaveBeenCalledOnce();
  expect(button("关闭").disabled).toBe(true);
  await render({ check, connectionKey: "b" });
  expect(button("关闭").disabled).toBe(false);
  await act(async () => finish(result()));
  expect(document.body.textContent).toContain("连接已改变");
  expect(button("确认提交整个 CL").disabled).toBe(true);
});
