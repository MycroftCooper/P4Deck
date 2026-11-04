// @vitest-environment jsdom
import { act } from "react";
import {afterEach, expect, it, vi, beforeEach} from "vitest";
import { dialogHarness, dialogButton } from "../../../app/dialogs/testHarness";
import { backend } from "../../../infrastructure/backend";
import { UndoDialog } from "./UndoDialog";
import { setLocale } from "../../../shared/i18n";
const harness = dialogHarness();
const target = { depotPath: "//depot/f.txt", revision: 17, changelistId: 901 };
const plan = () => ({
  target,
  token: "one-use",
  expiresAt: Date.now() + 120000,
  messages: ["single-file edit"],
});
afterEach(() => vi.restoreAllMocks());
// Components translate through the module-level locale.
beforeEach(() => {
  setLocale("zh-CN");
});

it("does nothing on open or close and cancels a reviewed preview without execution", async () => {
  const preview = vi.spyOn(backend, "previewUndo").mockResolvedValue(plan());
  const confirm = vi.spyOn(backend, "confirmUndo");
  const dismiss = vi.fn();
  await harness.render(
    <UndoDialog
      request={{ ...target, source: null }}
      zh
      onDismiss={dismiss}
      onRefresh={vi.fn()}
    />,
  );
  expect(preview).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  await act(async () => dialogButton("预览").click());
  expect(preview).toHaveBeenCalledWith(target);
  await act(async () => dialogButton("关闭").click());
  expect(dismiss).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
});
it("confirms exactly the previewed single revision, with no range or CL execution target", async () => {
  vi.spyOn(backend, "previewUndo").mockResolvedValue(plan());
  const confirm = vi.spyOn(backend, "confirmUndo").mockResolvedValue({
    operationId: "undo-1",
    exitCode: 0,
    events: [],
    durationMs: 1,
  });
  const refresh = vi.fn();
  await harness.render(
    <UndoDialog
      request={{ ...target, source: null }}
      zh={false}
      onDismiss={vi.fn()}
      onRefresh={refresh}
    />,
  );
  expect(dialogButton("Confirm Undo")).toBeUndefined();
  await act(async () => dialogButton("Preview").click());
  expect(confirm).not.toHaveBeenCalled();
  await act(async () => dialogButton("Confirm Undo").click());
  expect(confirm).toHaveBeenCalledExactlyOnceWith({
    target,
    token: "one-use",
    operationId: expect.any(String),
  });
  // S4a-FE: mock backend returns a legacy payload, so the dialog keeps the legacy message.
  expect(document.body.textContent).toMatch(/not submitted|legacy result/i);
  expect(refresh).toHaveBeenCalledOnce();
  expect(dialogButton("Confirm Undo")).toBeUndefined();
});
it("rejects a mismatched preview and never enables confirmation", async () => {
  vi.spyOn(backend, "previewUndo").mockResolvedValue({
    ...plan(),
    target: { ...target, revision: 42 },
  });
  const confirm = vi.spyOn(backend, "confirmUndo");
  await harness.render(
    <UndoDialog
      request={{ ...target, source: null }}
      zh={false}
      onDismiss={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  await act(async () => dialogButton("Preview").click());
  expect(document.body.textContent).toContain("Preview target differs");
  expect(dialogButton("Confirm Undo")).toBeUndefined();
  expect(confirm).not.toHaveBeenCalled();
});
