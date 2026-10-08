// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogHarness, dialogButton } from "../../../app/dialogs/testHarness";
import type { PendingChange } from "../../../shared/contracts/types";
import { DeleteChangelistDialog } from "./DeleteChangelistDialog";

const harness = dialogHarness();
const dismiss = vi.fn();
const empty: PendingChange = {
  id: 42,
  description: "Empty",
  user: "tester",
  client: "workspace",
  status: "pending",
  jobs: [],
  files: [],
  shelvedFiles: [],
};
beforeEach(() => dismiss.mockClear());
async function render(
  overrides: Partial<ComponentProps<typeof DeleteChangelistDialog>> = {},
) {
  await harness.render(
    <DeleteChangelistDialog
      change={empty}
      zh
      onDismiss={dismiss}
      onDelete={async () => {}}
      {...overrides}
    />,
  );
}
it("requires explicit confirmation and reports successful deletion", async () => {
  const remove = vi.fn(async () => {});
  await render({ onDelete: remove });
  expect(remove).not.toHaveBeenCalled();
  await act(async () => dialogButton("确认删除").click());
  expect(remove).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledOnce();
});
it("keeps the dialog open and exposes a backend non-empty rejection", async () => {
  const remove = vi.fn(async () => {
    throw new Error(
      "clear Jobs, move/revert opened files, and delete shelves first",
    );
  });
  await render({
    change: {
      ...empty,
      jobs: ["JOB-1"],
      shelvedFiles: [{ depotPath: "//depot/shelf", action: "edit" }],
    },
    onDelete: remove,
  });
  expect(document.body.textContent).toContain("当前快照显示此 CL 非空");
  await act(async () => dialogButton("确认删除").click());
  expect(document.body.textContent).toContain("clear Jobs");
  expect(dismiss).not.toHaveBeenCalled();
});
it("never allows deleting Default", async () => {
  const remove = vi.fn(async () => {});
  await render({ change: { ...empty, id: 0 }, onDelete: remove });
  expect(dialogButton("确认删除").disabled).toBe(true);
  await act(async () => dialogButton("确认删除").click());
  expect(remove).not.toHaveBeenCalled();
});
