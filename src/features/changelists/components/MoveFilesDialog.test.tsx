// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../../../app/dialogs/testHarness";
import { MoveFilesDialog, type MoveFilesRequest } from "./MoveFilesDialog";
import type { PendingChange } from "../../../shared/contracts/types";

const root = dialogHarness();
const dismiss = vi.fn();
beforeEach(() => {
  dismiss.mockClear();
});
const changes: PendingChange[] = [0, 10, 20].map((id) => ({
  id,
  description: `Change ${id}`,
  user: "tester",
  client: "workspace",
  status: "pending",
  jobs: [],
  files: [],
  shelvedFiles: [],
}));
async function render(
  request: MoveFilesRequest = {
    from: 10,
    paths: ["//depot/a", "//depot/a"],
    source: null,
  },
  candidates = changes,
) {
  await act(async () =>
    root.render(
      <MoveFilesDialog
        request={request}
        changes={candidates}
        client="workspace"
        zh
        onDismiss={dismiss}
      />,
    ),
  );
}
function checkButton() {
  return [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "检查选择（不执行）",
  )!;
}
it("excludes the source CL, includes Default, and requires an explicit target", async () => {
  await render();
  expect(
    [...document.querySelectorAll("option")].map((option) => option.value),
  ).toEqual(["", "0", "20"]);
  expect(checkButton().disabled).toBe(true);
  expect(document.activeElement).toBe(document.querySelector("input"));
  await act(async () => {
    const select = document.querySelector("select")!;
    select.value = "0";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(checkButton().disabled).toBe(false);
  await act(async () => checkButton().click());
  expect(document.body.textContent).toContain("尚未移动任何文件");
  expect(dismiss).not.toHaveBeenCalled();
});
it("freezes and deduplicates the exact file subset and candidate snapshot", async () => {
  await render();
  await render(
    { from: 20, paths: ["//different/a", "//different/b"], source: null },
    [],
  );
  expect(document.body.textContent).toContain("来源 CL 10 · 1 个文件");
  expect(document.querySelector('option[value="20"]')).not.toBeNull();
});
it("explains empty candidate snapshots and disables empty file scope", async () => {
  await render({ from: 10, paths: [], source: null }, [changes[1]]);
  expect(document.body.textContent).toContain("没有选择文件");
  expect(document.body.textContent).toContain("没有其他目标 CL");
  expect(checkButton().disabled).toBe(true);
});
it("filters candidates without changing the selected target", async () => {
  await render();
  await act(async () => {
    const select = document.querySelector("select")!;
    select.value = "20";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const input = document.querySelector("input")!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "no-match");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.body.textContent).toContain("没有匹配项");
  expect(document.querySelector("select")!.value).toBe("20");
  expect(document.body.textContent).toContain("CL 10 → CL 20");
});
