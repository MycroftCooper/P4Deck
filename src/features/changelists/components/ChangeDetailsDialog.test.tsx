// @vitest-environment jsdom
import { act } from "react";
import { SubmittedGoTo } from "./SubmittedGoTo";
import { afterEach, expect, it, vi, beforeEach } from "vitest";
import { dialogHarness, dialogButton } from "../../../app/dialogs/testHarness";
import { backend } from "../../../infrastructure/backend";
import type {
  PendingChangeMutationResult,
  RuntimeInfo,
  SubmittedChangeDetail,
  UnshelvePreflight,
} from "../../../shared/contracts";
import {
  ChangeDetailsContext,
  useChangeDetailsDialog,
  type OpenChangeDetails,
} from "./ChangeDetailsDialog";
import { setLocale } from "../../../shared/i18n";
vi.mock("./RevisionFileList", () => ({
  RevisionFileList: ({ files }: { files: { depotPath: string }[] }) => (
    <div data-testid="files">{files.map((f) => f.depotPath).join(" ")}</div>
  ),
}));
const harness = dialogHarness();
let open: OpenChangeDetails;
const runtime = {
  mode: "mock",
  activeProfileId: "a",
  contextGeneration: 1,
  context: { server: "fixture", user: "tester", client: "test" },
  connection: { state: "connected" },
} as RuntimeInfo;
function Host({
  owner = "a",
  generation = 1,
}: {
  owner?: string;
  generation?: number;
}) {
  const state = useChangeDetailsDialog(
    { ...runtime, contextGeneration: generation },
    owner,
    true,
  );
  open = state.open;
  return (
    <ChangeDetailsContext.Provider value={state.open}>
      <SubmittedGoTo zh />
      {state.dialog}
    </ChangeDetailsContext.Provider>
  );
}
const detail = (id: number): SubmittedChangeDetail => ({
  changeId: id,
  description: `DESCRIPTION-${id}\nsecond line`,
  user: "tester",
  client: "test",
  time: "2026-10-26T10:00:00Z",
  jobs: [],
  files: [],
  integrationEvidence: [],
  mergeClassification: "normal",
  inspectionStatus: "complete",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());
// The UI translates through the module-level locale.
beforeEach(() => {
  setLocale("zh-CN");
});

it("reads the exact CL and closing preserves/focuses the original control", async () => {
  const read = vi
    .spyOn(backend, "getSubmittedChangeDetail")
    .mockResolvedValue({ ...detail(17), status: "submitted" });
  vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  const source = document.createElement("button");
  document.body.append(source);
  source.focus();
  await harness.render(<Host />);
  await act(async () => open({ kind: "submitted", changeId: 17 }, source));
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ changeId: 17 }));
  expect(document.querySelector("dialog")?.textContent).toContain(
    "DESCRIPTION-17",
  );
  expect(document.querySelector("dialog")?.textContent).toContain("已提交");
  // The CL status is a colored badge in the title bar, not a metadata row.
  const badge = document.querySelector<HTMLElement>(
    "dialog .workflow-dialog-title .dialog-status-badge",
  );
  expect(badge?.textContent).toBe("已提交");
  expect(badge?.className).toContain("is-submitted");
  expect(
    document.querySelector("dialog .change-details-meta")?.textContent,
  ).not.toContain("状态");
  expect(document.querySelector("dialog")?.textContent).toContain("无文件");
  expect(document.querySelector("dialog")?.textContent).toContain("模拟数据");
  await act(async () => dialogButton("关闭").click());
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(source);
  source.remove();
});
it("ignores a late result after switching CL, and never leaks data across connection generations", async () => {
  const first = deferred<SubmittedChangeDetail>();
  const second = deferred<SubmittedChangeDetail>();
  vi.spyOn(backend, "getSubmittedChangeDetail").mockImplementation(
    ({ changeId }) => (changeId === 17 ? first.promise : second.promise),
  );
  const cancel = vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await harness.render(<Host />);
  await act(async () => open({ kind: "submitted", changeId: 17 }));
  await act(async () => open({ kind: "submitted", changeId: 42 }));
  await act(async () => second.resolve(detail(42)));
  await act(async () => first.resolve(detail(17)));
  expect(document.querySelector("dialog")?.textContent).toContain(
    "DESCRIPTION-42",
  );
  expect(document.querySelector("dialog")?.textContent).not.toContain(
    "DESCRIPTION-17",
  );
  await harness.render(<Host owner="b" generation={2} />);
  expect(document.querySelector("dialog")).toBeNull();
  expect(cancel).toHaveBeenCalled();
});
it("shows error/retry and partial files; Esc closes during loading", async () => {
  const read = vi
    .spyOn(backend, "getSubmittedChangeDetail")
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue({
      ...detail(17),
      inspectionStatus: "partial",
      message: "Partial files",
      files: [{ depotPath: "//depot/a", action: "edit", revision: 3 }],
    });
  vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await harness.render(<Host />);
  await act(async () => open({ kind: "submitted", changeId: 17 }));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "unavailable",
  );
  await act(async () => dialogButton("重试").click());
  expect(read).toHaveBeenCalledTimes(2);
  expect(document.querySelector("dialog")?.textContent).toContain(
    "Partial files",
  );
  await act(async () =>
    document
      .querySelector("dialog")!
      .dispatchEvent(new Event("cancel", { cancelable: true })),
  );
  expect(document.querySelector("dialog")).toBeNull();
});
it("shows loaded pending/default details without misusing submitted queries", async () => {
  const read = vi.spyOn(backend, "getSubmittedChangeDetail");
  vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await harness.render(<Host />);
  await act(async () =>
    open({
      kind: "pending",
      changeId: 0,
      snapshot: {
        id: 0,
        description: "pending text",
        user: "tester",
        client: "test",
        status: "pending",
        jobs: [],
        files: [],
        shelvedFiles: [],
      },
    }),
  );
  expect(read).not.toHaveBeenCalled();
  expect(document.querySelector("dialog")?.textContent).toContain(
    "pending text",
  );
  expect(document.querySelector("dialog")?.textContent).toContain("default");
});

it("shows a pending CL reached from the submitted page as pending with shelved files, not an error", async () => {
  const onLoaded = vi.fn();
  vi.spyOn(backend, "getSubmittedChangeDetail").mockResolvedValue({
    ...detail(17),
    status: "pending",
    inspectionStatus: "partial",
    mergeClassification: "unknown",
    message:
      "This changelist is pending; opened files belong to its owner's client and only shelved files are listed.",
    files: [
      {
        depotPath: "//depot/shelved/a.txt",
        action: "edit",
        revision: 7,
        fileType: "text",
      },
    ],
  });
  vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await harness.render(<Host />);
  await act(async () => open({ kind: "submitted", changeId: 17, onLoaded }));
  const text = document.querySelector("dialog")?.textContent ?? "";
  expect(text).toContain("待提交");
  expect(text).not.toContain("已提交");
  const badge = document.querySelector<HTMLElement>(
    "dialog .workflow-dialog-title .dialog-status-badge",
  );
  expect(badge?.textContent).toBe("待提交");
  expect(badge?.className).toContain("is-pending");
  expect(text).toContain("1 个搁置文件");
  expect(text).toContain("搁置文件");
  expect(text).toContain("a.txt");
  expect(text).toContain("This changelist is pending");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(text).not.toContain("重试");
  // A pending answer must not be replayed as a submitted-row classification.
  expect(onLoaded).not.toHaveBeenCalled();
});

it("explains a pending CL with no shelved files and no backend message", async () => {
  vi.spyOn(backend, "getSubmittedChangeDetail").mockResolvedValue({
    ...detail(17),
    status: "pending",
    inspectionStatus: "partial",
    mergeClassification: "unknown",
    files: [],
  });
  vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await harness.render(<Host />);
  await act(async () => open({ kind: "submitted", changeId: 17 }));
  const text = document.querySelector("dialog")?.textContent ?? "";
  expect(text).toContain("待提交");
  expect(text).toContain("该 CL 尚未提交，仅能查看搁置(shelved)文件。");
  expect(text).toContain("该 CL 没有搁置文件");
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("opens unshelve into a new CL from a pending CL's shelved files", async () => {
  vi.spyOn(backend, "getSubmittedChangeDetail").mockResolvedValue({
    ...detail(17),
    status: "pending",
    inspectionStatus: "partial",
    mergeClassification: "unknown",
    message:
      "This changelist is pending; opened files belong to its owner's client and only shelved files are listed.",
    files: [
      {
        depotPath: "//depot/shelved/a.txt",
        action: "edit",
        revision: 7,
        fileType: "text",
      },
    ],
  });
  vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  const mutation: PendingChangeMutationResult = {
    operation: {
      operationId: "create-op",
      exitCode: 0,
      durationMs: 1,
      events: [],
    },
    createdChangeId: 4242,
    affectedChanges: [4242],
    affectedPaths: [],
    refreshedChanges: [],
  };
  const create = vi
    .spyOn(backend, "mutatePendingChange")
    .mockResolvedValue(mutation);
  const preflight: UnshelvePreflight = {
    ready: false,
    mappings: [],
    blockers: [
      {
        code: "fileNotShelved",
        certainty: "confirmed",
        message: "Source shelf does not contain every selected file.",
        paths: ["//depot/shelved/a.txt"],
      },
    ],
    warnings: [],
    target: {
      kind: "unshelve",
      server: "fixture",
      user: "tester",
      client: "test",
      workspace: "",
      contextGeneration: 1,
      sourceChangeId: 17,
      targetChangeId: 4242,
      depotPaths: ["//depot/shelved/a.txt"],
    },
    contentDigest: "digest",
    expiresAt: Date.now() + 60_000,
    ttlMs: 60_000,
    operationIds: [],
  };
  const check = vi
    .spyOn(backend, "preflightUnshelve")
    .mockResolvedValue(preflight);
  await harness.render(<Host />);
  await act(async () => open({ kind: "submitted", changeId: 17 }));
  expect(document.querySelector("dialog")?.textContent).toContain(
    "Unshelve 到新 CL…",
  );
  await act(async () => dialogButton("Unshelve 到新 CL…").click());
  // Details closed; the reused UnshelveDialog carries the exact source and an
  // auto-generated description for a brand-new numbered CL.
  const text = document.querySelector("dialog")?.textContent ?? "";
  expect(text).not.toContain("CL 详情");
  expect(text).toContain("来源搁置 CL 17");
  expect(
    [...document.querySelectorAll<HTMLInputElement>("dialog input")]
      .map((input) => input.value)
      .join(" | "),
  ).toContain("Unshelved from CL17");
  expect(dialogButton("确认 Unshelve").disabled).toBe(true);
  // The default create-then-preflight path: one creation, then the exact frozen
  // source subset and the created CL id go to the existing preflight.
  await act(async () => dialogButton("运行预检").click());
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "create",
      description: "Unshelved from CL17",
      jobs: [],
    }),
  );
  expect(check).toHaveBeenCalledWith({
    sourceChangeId: 17,
    depotPaths: ["//depot/shelved/a.txt"],
    targetWorkspace: "test",
    targetChangeId: 4242,
  });
  expect(document.body.textContent).toContain("已创建 CL #4242");
});

it("does not offer unshelve into a new CL for submitted details", async () => {
  vi.spyOn(backend, "getSubmittedChangeDetail").mockResolvedValue({
    ...detail(17),
    status: "submitted",
    files: [{ depotPath: "//depot/a.txt", action: "edit", revision: 3 }],
  });
  vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await harness.render(<Host />);
  await act(async () => open({ kind: "submitted", changeId: 17 }));
  expect(document.querySelector("dialog")?.textContent).not.toContain(
    "Unshelve 到新 CL",
  );
});

it("rejects a mismatched CL response and allows Esc while a read is pending", async () => {
  const pending = deferred<SubmittedChangeDetail>();
  vi.spyOn(backend, "getSubmittedChangeDetail")
    .mockResolvedValueOnce(detail(42))
    .mockReturnValueOnce(pending.promise);
  const cancel = vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await harness.render(<Host />);
  await act(async () => open({ kind: "submitted", changeId: 17 }));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "返回的 CL 与目标不符",
  );
  expect(document.querySelector("dialog")?.textContent).not.toContain(
    "DESCRIPTION-42",
  );
  await act(async () => dialogButton("重试").click());
  expect(document.querySelector("dialog")?.textContent).toContain("正在加载");
  await act(async () =>
    document
      .querySelector("dialog")!
      .dispatchEvent(new Event("cancel", { cancelable: true })),
  );
  await act(async () => pending.resolve(detail(17)));
  expect(document.querySelector("dialog")).toBeNull();
  expect(cancel).toHaveBeenCalled();
});

it("Go To sends exact numbers, reports not found and ignores a slower previous number", async () => {
  const stale = deferred<SubmittedChangeDetail>();
  const read = vi
    .spyOn(backend, "getSubmittedChangeDetail")
    .mockRejectedValueOnce(new Error("CL not found / no permission"))
    .mockImplementationOnce(() => stale.promise)
    .mockResolvedValueOnce(detail(42));
  vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await harness.render(<Host />);
  async function go(value: string) {
    const input = document.querySelector<HTMLInputElement>("#submitted-go-to")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector(".submitted-go-to")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
  }
  await go("999");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "CL not found",
  );
  await act(async () => dialogButton("关闭").click());
  await go("17");
  await act(async () => dialogButton("关闭").click());
  await go("42");
  await act(async () => stale.resolve(detail(17)));
  expect(read.mock.calls.map(([q]) => q.changeId)).toEqual([999, 17, 42]);
  expect(document.querySelector("dialog")?.textContent).toContain(
    "DESCRIPTION-42",
  );
  expect(document.querySelector("dialog")?.textContent).not.toContain(
    "DESCRIPTION-17",
  );
});

it("renders CL files through the shared ResizableTable with draggable, aligned columns", async () => {
  localStorage.clear();
  vi.spyOn(backend, "getSubmittedChangeDetail").mockResolvedValue({
    ...detail(17),
    files: [
      {
        depotPath: "//depot/a.txt",
        action: "edit",
        revision: 3,
        fileType: "text",
      },
      { depotPath: "//depot/b.bin", action: "move/add", revision: 4 },
    ],
  });
  vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await harness.render(<Host />);
  await act(async () => open({ kind: "submitted", changeId: 17 }));
  const table = document.querySelector<HTMLTableElement>(
    'table[data-table-id="change-details-files"]',
  )!;
  expect(table).toBeTruthy();
  expect(
    [...table.querySelectorAll("thead th")].map((cell) => cell.textContent),
  ).toEqual(["文件名称", "路径", "类型", "动作", "版本"]);
  // Shared ColumnResizer handles are injected into every header cell.
  const resizers = [
    ...table.querySelectorAll<HTMLElement>(
      'thead [role="separator"].history-column-resizer',
    ),
  ];
  expect(resizers).toHaveLength(5);
  expect(resizers[0].getAttribute("aria-label")).toContain("Resize 文件名称");
  expect(resizers[0].getAttribute("aria-valuenow")).toBe("220");
  expect(resizers[1].getAttribute("aria-label")).toContain("Resize 路径");
  // Colgroup carries the resizable widths (table-layout: fixed).
  expect(table.style.tableLayout).toBe("fixed");
  const cols = [...table.querySelectorAll<HTMLTableColElement>("colgroup col")];
  expect(cols).toHaveLength(5);
  expect(cols[0].getAttribute("style")).toContain("220px");
  expect(cols[1].getAttribute("style")).toContain("300px");
  // Live resize: keyboard arrow widens the file-name column and rewrites colgroup.
  await act(async () =>
    resizers[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(
    document
      .querySelector<HTMLTableElement>(
        'table[data-table-id="change-details-files"]',
      )!
      .querySelector<HTMLTableColElement>("colgroup col")!
      .getAttribute("style"),
  ).toContain("230px");
  // Double-click resets back to the shared defaults.
  await act(async () =>
    resizers[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(
    document
      .querySelector<HTMLTableElement>(
        'table[data-table-id="change-details-files"]',
      )!
      .querySelector<HTMLTableColElement>("colgroup col")!
      .getAttribute("style"),
  ).toContain("220px");
  // A dedicated file-name column shows the basename (with status icon/title),
  // while the path column carries only the directory and never repeats the name.
  const rows = [...table.querySelectorAll<HTMLTableRowElement>("tbody tr")];
  expect(rows).toHaveLength(2);
  expect(rows[0].querySelector(".file-status-icon")).toBeTruthy();
  expect(
    rows[0].querySelector<HTMLElement>('[title="a.txt · text"]')?.textContent,
  ).toBe("a.txt");
  const cells = [...rows[0].querySelectorAll("td")].map(
    (cell) => cell.textContent,
  );
  expect(cells[0]).toBe("a.txt");
  expect(cells[1]).toBe("//depot/");
  expect(cells[1]).not.toContain("a.txt");
  expect(cells[2]).toContain("text");
  expect(cells[3]).toContain("edit");
  expect(cells[4]).toContain("#3");
  expect(rows[0].querySelectorAll("td")[1].getAttribute("title")).toBe(
    "//depot/a.txt",
  );
  expect(rows[1].querySelectorAll("td")[0].textContent).toBe("b.bin");
  expect(rows[1].querySelectorAll("td")[4].textContent).toBe("#4");
});
