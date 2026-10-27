// @vitest-environment jsdom
import { act } from "react";
import { SubmittedGoTo } from "./SubmittedGoTo";
import { afterEach, expect, it, vi } from "vitest";
import { dialogHarness, dialogButton } from "../../../app/dialogs/testHarness";
import { backend } from "../../../infrastructure/backend";
import type {
  RuntimeInfo,
  SubmittedChangeDetail,
} from "../../../shared/contracts/types";
import {
  ChangeDetailsContext,
  useChangeDetailsDialog,
  type OpenChangeDetails,
} from "./ChangeDetailsDialog";
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
it("reads the exact CL and closing preserves/focuses the original control", async () => {
  const read = vi
    .spyOn(backend, "getSubmittedChangeDetail")
    .mockResolvedValue(detail(17));
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
