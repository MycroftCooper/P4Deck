// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../../../app/dialogs/testHarness";
import { MoveFilesDialog } from "./MoveFilesDialog";
import type { SelectedMoveRequest, SelectedMoveReceipt } from "../selectedMove";
import { setLocale } from "../../../shared/i18n";
const api = vi.hoisted(() => ({
  companySubmitConnectionSnapshot: vi.fn(),
  selectedMoveExecute: vi.fn(),
  selectedMoveStatus: vi.fn(),
  cancelOperation: vi.fn(),
}));
vi.mock("../../../infrastructure/backend", () => ({ backend: api }));
const close = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock("../../../app/closeGuard", () => ({
  useUnsavedEditor: () => close.clear,
}));
const root = dialogHarness(),
  dismiss = vi.fn();
const connection = {
  profileId: "fixture",
  generation: "9007199254740993",
  server: "synthetic",
  user: "fixture",
  client: "workspace",
};
const changes = [0, 10, 20].map((id) => ({
  id,
  description: `Change ${id}`,
  user: "fixture",
  client: "workspace",
  status: "pending" as const,
  jobs: [],
  files: [],
  shelvedFiles: [],
}));
const props: ComponentProps<typeof MoveFilesDialog> = {
  request: {
    from: 10,
    origins: { "//synthetic/a": 0, "//synthetic/b": 10 },
    paths: ["//synthetic/a", "//synthetic/b", "//synthetic/a"],
    source: null,
  },
  changes,
  client: "workspace",
  connectionKey: "a",
  zh: false,
  onDismiss: dismiss,
};
const result = (
  r: SelectedMoveRequest,
  extra: Partial<SelectedMoveReceipt> = {},
): SelectedMoveReceipt => ({
  operationId: r.operationId,
  targetCreationUnknown: false,
  targetChangeId: r.target.kind === "existing" ? r.target.changeId : 30,
  stage: "completed",
  files: r.files.map((f) => ({ ...f, state: "moved" })),
  message: "Synthetic result",
  ...extra,
});
async function render(overrides: Partial<typeof props> = {}) {
  await act(async () =>
    root.render(<MoveFilesDialog {...props} {...overrides} />),
  );
}
async function click(text: string) {
  const b = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === text || b.textContent?.startsWith(text),
  );
  expect(b, text).toBeDefined();
  await act(async () => b!.click());
}
async function type(text: string) {
  await act(async () => {
    const n = document.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(n, text);
    n.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  // Components translate through the module-level locale.
  setLocale("en-US");
  vi.clearAllMocks();
  api.companySubmitConnectionSnapshot.mockResolvedValue(connection);
  api.selectedMoveExecute.mockImplementation(async (r) => result(r));
  api.selectedMoveStatus.mockResolvedValue(null);
  api.cancelOperation.mockResolvedValue(undefined);
});
it("previews exact cross-CL selection and moves only after explicit confirmation, without footer cancellation", async () => {
  await render();
  await click("CL 20");
  expect(api.selectedMoveExecute).not.toHaveBeenCalled();
  expect(document.querySelector(".workflow-dialog-footer")?.textContent).toBe(
    "",
  );
  await click("Confirm move");
  const r = api.selectedMoveExecute.mock.calls[0][0];
  expect(r.files).toEqual([
    { depotPath: "//synthetic/a", sourceChangeId: 0 },
    { depotPath: "//synthetic/b", sourceChangeId: 10 },
  ]);
  expect(r.connection).toEqual(connection);
  expect(r.target).toEqual({ kind: "existing", changeId: 20 });
  expect(document.body.textContent).toContain("Selected files move completed.");
});
it("requires new description, captures it once and never submits", async () => {
  await render();
  await click("New changelist");
  expect(
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Confirm move",
    )!.disabled,
  ).toBe(true);
  await type("  New description  ");
  await click("Confirm move");
  expect(api.selectedMoveExecute.mock.calls[0][0].target).toEqual({
    kind: "new",
    description: "New description",
  });
  expect(api.selectedMoveExecute).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("CL 30");
});
it("X before confirmation makes zero writes even for direct drop target", async () => {
  await render({ request: { ...props.request, target: 20 } });
  expect(api.selectedMoveExecute).not.toHaveBeenCalled();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(".workflow-dialog-close")!
      .click(),
  );
  expect(dismiss).toHaveBeenCalledOnce();
  expect(api.selectedMoveExecute).not.toHaveBeenCalled();
});
it("lost response only checks same operation and never re-executes", async () => {
  api.selectedMoveExecute.mockRejectedValue(new Error("lost"));
  await render();
  await click("CL 20");
  await click("Confirm move");
  const r = api.selectedMoveExecute.mock.calls[0][0];
  api.selectedMoveStatus.mockResolvedValue(result(r));
  await click("Check this attempt");
  expect(api.selectedMoveStatus).toHaveBeenCalledWith({
    operationId: r.operationId,
    connection,
  });
  expect(api.selectedMoveExecute).toHaveBeenCalledOnce();
});
it("partial results retain file states and target; closing never rolls back", async () => {
  api.selectedMoveExecute.mockImplementation(async (r) =>
    result(r, {
      stage: "stopped",
      files: r.files.map(
        (f: SelectedMoveRequest["files"][number], i: number) => ({
          ...f,
          state: i ? "unknown" : "moved",
        }),
      ),
    }),
  );
  await render();
  await click("CL 20");
  await click("Confirm move");
  expect(document.body.textContent).toContain("Move not confirmed complete");
  expect(document.body.textContent).toContain("Unknown");
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(".workflow-dialog-close")!
      .click(),
  );
  expect(dismiss).toHaveBeenCalledOnce();
  expect(api.cancelOperation).not.toHaveBeenCalled();
});
it("same-target selection remains explicit and reports already in target", async () => {
  api.selectedMoveExecute.mockImplementation(async (r) =>
    result(r, {
      files: r.files.map((f: SelectedMoveRequest["files"][number]) => ({
        ...f,
        state: f.sourceChangeId === 0 ? "alreadyInTarget" : "moved",
      })),
    }),
  );
  await render();
  await click("Default");
  expect(document.body.textContent).toContain("Already in target");
  await click("Confirm move");
  expect(api.selectedMoveExecute.mock.calls[0][0].files).toHaveLength(2);
});
it("connection switch blocks execute and status; late receipt cannot refresh new context", async () => {
  let finish!: (r: SelectedMoveReceipt) => void;
  const onResult = vi.fn();
  api.selectedMoveExecute.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  await render({ onResult });
  await click("CL 20");
  await click("Confirm move");
  const r = api.selectedMoveExecute.mock.calls[0][0];
  await render({ onResult, connectionKey: "b" });
  await act(async () => finish(result(r)));
  expect(onResult).not.toHaveBeenCalled();
  await click("Check this attempt");
  expect(api.selectedMoveStatus).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Connection changed");
});
it("duplicate confirmation while running dispatches once and cancel uses same operation", async () => {
  let finish!: (r: SelectedMoveReceipt) => void;
  api.selectedMoveExecute.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  await render();
  await click("CL 20");
  await click("Confirm move");
  const r = api.selectedMoveExecute.mock.calls[0][0];
  await click("Stop remaining operations");
  expect(api.cancelOperation).toHaveBeenCalledWith(r.operationId);
  expect(api.selectedMoveExecute).toHaveBeenCalledOnce();
  await act(async () => finish(result(r)));
});
it("rejects malformed success instead of displaying a complete move", async () => {
  api.selectedMoveExecute.mockImplementation(async (r) =>
    result(r, { files: [] }),
  );
  await render();
  await click("CL 20");
  await click("Confirm move");
  expect(document.body.textContent).toContain("Outcome unknown");
  expect(document.body.textContent).not.toContain(
    "Selected files move completed",
  );
});

it("hands confirmed work to background owner before closing, without starting a duplicate request", async () => {
  const onStart = vi.fn(() => true);
  await render({ onStart });
  await click("CL 20");
  await click("Confirm move");
  expect(onStart).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledOnce();
  expect(api.selectedMoveExecute).not.toHaveBeenCalled();
});
