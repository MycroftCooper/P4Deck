// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  dialogHarness,
  dialogButton,
  chooseSelect,
} from "../../../app/dialogs/testHarness";
import { ResolveDialog } from "./ResolveDialog";
import type { WorkspaceNode } from "../../../shared/contracts/types";
const harness = dialogHarness();
const nodes: WorkspaceNode[] = ["a", "b"].map((name) => ({
  id: name,
  name,
  kind: "file",
  state: "conflicted",
  absolutePath: `/workspace/${name}`,
  relativePath: name,
  depotPath: `//depot/${name}`,
}));
it("shows unknown versions honestly and cannot execute without conflict data", async () => {
  await harness.render(
    <ResolveDialog nodes={nodes} source={null} zh onDismiss={vi.fn()} />,
  );
  expect(document.body.textContent).toContain(
    "实际冲突类型、基线、双方版本及可用工具仍未知",
  );
  expect(document.body.textContent!.match(/版本未知/g)).toHaveLength(3);
  expect(dialogButton("执行当前项").disabled).toBe(true);
  await act(async () => dialogButton("检查计划（不执行）").click());
  expect(document.body.textContent).toContain("未解决任何冲突");
});
it("retains per-file plans while navigating and protects plans on close", async () => {
  const close = vi.fn();
  await harness.render(
    <ResolveDialog nodes={nodes} source={null} zh onDismiss={close} />,
  );
  await chooseSelect("yours");
  expect(document.body.textContent).toContain("选择一侧可能丢弃");
  await act(async () => dialogButton("下一项").click());
  expect(document.querySelector("select")!.value).toBe("skip");
  await chooseSelect("theirs");
  await act(async () => dialogButton("上一项").click());
  expect(document.querySelector("select")!.value).toBe("yours");
  await act(async () => dialogButton("关闭").click());
  expect(close).not.toHaveBeenCalled();
  await act(async () => dialogButton("放弃计划并关闭").click());
  expect(close).toHaveBeenCalledOnce();
});
it("supports keyboard navigation without conflating unknown targets with resolved files", async () => {
  await harness.render(
    <ResolveDialog nodes={nodes} source={null} zh onDismiss={vi.fn()} />,
  );
  await act(async () =>
    document
      .querySelector('[role="listbox"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
  );
  expect(document.body.textContent).toContain("2/2");
  expect(dialogButton("下一项").disabled).toBe(true);
});
it("displays supplied versions and failure results without enabling unsafe execution", async () => {
  await harness.render(
    <ResolveDialog
      nodes={nodes}
      source={null}
      zh
      onDismiss={vi.fn()}
      details={{
        "//depot/a": {
          kind: "binary",
          base: { label: "#1" },
          yours: { label: "workspace", content: "Local content" },
          theirs: { label: "#2" },
          result: { state: "failed", message: "tool unavailable" },
        },
      }}
    />,
  );
  expect(document.body.textContent).toContain("Local content");
  expect(document.body.textContent).toContain("二进制文件不能使用文本合并");
  expect(document.body.textContent).toContain("tool unavailable");
  expect(dialogButton("执行当前项").disabled).toBe(true);
});
