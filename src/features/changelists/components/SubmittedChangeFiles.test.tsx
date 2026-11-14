// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type {
  RuntimeInfo,
  SubmittedChangeDetail,
} from "../../../shared/contracts";
import { SubmittedChangeFiles } from "./SubmittedChangeFiles";
const backend = vi.hoisted(() => ({
  getSubmittedChangeDetail: vi.fn(),
  cancelOperation: vi.fn(async () => {}),
}));
vi.mock("../../../infrastructure/backend", () => ({ backend }));
vi.mock("./RevisionFileList", () => ({
  RevisionFileList: () => <div>mock file list</div>,
}));
const runtime = {
  mode: "mock",
  contextGeneration: 1,
  context: { server: "mock", user: "u", client: "c" },
  connection: { state: "connected" },
} as RuntimeInfo;
const detail = (
  status: SubmittedChangeDetail["inspectionStatus"],
  count: number,
): SubmittedChangeDetail => ({
  changeId: 1,
  description: "mock",
  user: "u",
  client: "c",
  time: "2026-01-01T00:00:00Z",
  jobs: [],
  files: Array.from({ length: count }, (_, i) => ({
    depotPath: `//mock/f${i}`,
    revision: 1,
    action: "edit",
  })),
  integrationEvidence: [],
  mergeClassification: "unknown",
  inspectionStatus: status,
});
let host: HTMLDivElement, root: Root, cache: Map<number, SubmittedChangeDetail>;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom has no modal dialog implementation; the sync dialog is real here.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  cache = new Map();
  backend.getSubmittedChangeDetail.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function show() {
  await act(async () => {
    root.render(
      <SubmittedChangeFiles
        changeId={1}
        scope="mock:1"
        connectionKey="mock-connection"
        cache={cache}
        runtime={runtime}
        zh
      />,
    );
    await Promise.resolve();
  });
}
it("does not show a numeric count during loading or failure", async () => {
  let reject!: (e: Error) => void;
  backend.getSubmittedChangeDetail.mockReturnValue(
    new Promise((_, no) => {
      reject = no;
    }),
  );
  await show();
  expect(host.querySelector(".submitted-files-count")).toBeNull();
  await act(async () => reject(new Error("mock failed")));
  expect(host.querySelector(".submitted-files-count")).toBeNull();
  expect(host.textContent).toContain("mock failed");
});
it.each([
  ["complete", 2, "2 个文件"],
  ["complete", 0, "0 个文件"],
  ["partial", 2, "已加载 2 个文件 · 总数未知"],
  ["partial", 0, "已加载 0 个文件 · 总数未知"],
] as const)(
  "labels %s / %s honestly and reuses expanded cache",
  async (status, count, label) => {
    backend.getSubmittedChangeDetail.mockResolvedValue(detail(status, count));
    await show();
    expect(host.querySelector(".submitted-files-count")?.textContent).toBe(
      label,
    );
    await act(async () => root.render(null));
    await show();
    expect(backend.getSubmittedChangeDetail).toHaveBeenCalledTimes(1);
  },
);
it("offers syncing this CL's files to the CL revision", async () => {
  backend.getSubmittedChangeDetail.mockResolvedValue(detail("complete", 2));
  await show();
  await act(async () => {
    await Promise.resolve();
  });
  const button = [...host.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("拉取到此 CL 版本"),
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
  expect(document.body.textContent).toContain("CL #1");
  expect(document.body.textContent).toContain("2 个目标");
});
