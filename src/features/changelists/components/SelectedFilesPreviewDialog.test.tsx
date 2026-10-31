// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { dialogHarness, dialogButton } from "../../../app/dialogs/testHarness";
import { SelectedFilesPreviewDialog } from "./SelectedFilesPreviewDialog";
const dirtyGuard = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock("../../../app/closeGuard", () => ({
  useUnsavedEditor: () => dirtyGuard.clear,
}));
const harness = dialogHarness();
async function setup() {
  const onConfirm = vi.fn(),
    onDismiss = vi.fn();
  await harness.render(
    <SelectedFilesPreviewDialog
      files={[
        { depotPath: "//test/a", originalChangeId: 0 },
        { depotPath: "//test/b", originalChangeId: 25 },
      ]}
      workspace="fixture"
      routeLabel="Native"
      zh={false}
      onConfirm={onConfirm}
      onDismiss={onDismiss}
    />,
  );
  return { onConfirm, onDismiss };
}
async function submit() {
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function type(text: string) {
  await act(async () => {
    const field = document.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("shows only selected origins and clearly preserves a new CL after cancellation", async () => {
  await setup();
  expect(document.querySelectorAll("li")).toHaveLength(2);
  expect(document.body.textContent).toContain("Default");
  expect(document.body.textContent).toContain("CL 25");
  expect(document.body.textContent).toContain("leaves files in the new CL");
});
it("rejects empty descriptions; confirms trimmed input once", async () => {
  const { onConfirm } = await setup();
  await submit();
  expect(onConfirm).not.toHaveBeenCalled();
  await type("  selected work  ");
  await submit();
  await submit();
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith("selected work");
});
it("cancels without invoking any operation", async () => {
  const { onConfirm, onDismiss } = await setup();
  await act(async () => dialogButton("Cancel").click());
  expect(onDismiss).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});
it("requires discard confirmation for an edited description", async () => {
  dirtyGuard.clear.mockClear();
  const { onConfirm, onDismiss } = await setup();
  await type("draft");
  await act(async () => dialogButton("Cancel").click());
  expect(onDismiss).not.toHaveBeenCalled();
  await act(async () => dialogButton("Discard and close").click());
  expect(dirtyGuard.clear).toHaveBeenCalledOnce();
  expect(onDismiss).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});
