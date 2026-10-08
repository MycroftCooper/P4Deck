// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  dialogHarness,
  dialogButton,
  chooseSelect,
} from "../../../app/dialogs/testHarness";
import {
  PreflightStatus,
  type PreflightState,
} from "../../../app/dialogs/PreflightStatus";
import { ShelfDialog, type ShelfRequest } from "./ShelfDialog";
import { UnshelveDialog } from "./UnshelveDialog";
const harness = dialogHarness();
const request: ShelfRequest = {
  changeId: 10,
  paths: ["//depot/a"],
  mode: "shelve",
  hasShelf: true,
  source: null,
};
it("requires risk acknowledgement before checking replacement or deletion", async () => {
  await harness.render(
    <ShelfDialog request={request} zh onDismiss={vi.fn()} />,
  );
  await chooseSelect("replace");
  expect(dialogButton("检查选择（不执行）").disabled).toBe(true);
  expect(document.body.textContent).toContain(
    "替换会覆盖所选文件已有的搁置版本",
  );
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => dialogButton("检查选择（不执行）").click());
  expect(document.body.textContent).toContain("尚未更改任何搁置内容");
  await chooseSelect("preserve");
  await chooseSelect("replace");
  expect(dialogButton("检查选择（不执行）").disabled).toBe(true);
});
it("rejects Default and empty file scopes", async () => {
  await harness.render(
    <ShelfDialog
      request={{ ...request, changeId: 0, paths: [] }}
      zh
      onDismiss={vi.fn()}
    />,
  );
  expect(document.body.textContent).toContain("需要先创建编号 CL");
  expect(document.body.textContent).toContain("没有可操作的文件");
  expect(dialogButton("检查选择（不执行）").disabled).toBe(true);
});
it("deletes only the specified shelf subset and never claims workspace deletion", async () => {
  await harness.render(
    <ShelfDialog
      request={{ ...request, mode: "delete" }}
      zh
      onDismiss={vi.fn()}
    />,
  );
  expect(document.body.textContent).toContain("CL 10 · 1 个文件");
  expect(document.body.textContent).toContain(
    "不会同时删除工作区文件或整个 CL",
  );
  expect(dialogButton("检查选择（不执行）").disabled).toBe(true);
});
it("allows source and target CL to coincide but never enables unverified unshelve", async () => {
  const changes = [
    {
      id: 10,
      description: "Same CL",
      user: "tester",
      client: "workspace",
      status: "pending" as const,
      jobs: [],
      files: [],
      shelvedFiles: [],
    },
  ];
  await harness.render(
    <UnshelveDialog
      request={request}
      changes={changes}
      zh
      onDismiss={vi.fn()}
    />,
  );
  await chooseSelect("10");
  expect(document.body.textContent).toContain("CL 10 → CL 10");
  await act(async () => dialogButton("检查选择（不执行）").click());
  expect(document.body.textContent).toContain("未执行 Unshelve");
  expect(dialogButton("确认 Unshelve").disabled).toBe(true);
});
it("explains missing unshelve targets and empty source files", async () => {
  await harness.render(
    <UnshelveDialog
      request={{ ...request, paths: [] }}
      changes={[]}
      zh
      onDismiss={vi.fn()}
    />,
  );
  expect(document.body.textContent).toContain("没有可用的目标 CL");
  expect(document.body.textContent).toContain("预检范围内没有文件");
  expect(dialogButton("检查选择（不执行）").disabled).toBe(true);
});
it("renders all shared preflight states with explicit status/error information", async () => {
  const states: PreflightState[] = [
    { kind: "unavailable" },
    { kind: "idle" },
    { kind: "checking" },
    { kind: "empty" },
    { kind: "stale" },
    { kind: "offline" },
    { kind: "failed", message: "network error" },
    { kind: "blocked", blockers: ["locked"], warnings: [] },
    { kind: "ready", blockers: [], warnings: ["resolve required"] },
  ];
  for (const state of states) {
    await harness.render(<PreflightStatus state={state} zh />);
    expect(document.querySelector("section")!.getAttribute("aria-busy")).toBe(
      String(state.kind === "checking"),
    );
    const expected = {
      unavailable: "预检尚未接通",
      idle: "尚未预检",
      checking: "正在预检",
      empty: "没有文件",
      stale: "预检已过期",
      offline: "连接不可用",
      failed: "预检失败",
      blocked: "存在阻塞项",
      ready: "预检结果已就绪",
    };
    expect(document.body.textContent).toContain(expected[state.kind]);
    if (state.kind === "failed")
      expect(document.body.textContent).toContain("network error");
    if (state.kind === "blocked")
      expect(document.body.textContent).toContain("阻塞：locked");
    if (state.kind === "ready")
      expect(document.body.textContent).toContain("警告：resolve required");
  }
});
