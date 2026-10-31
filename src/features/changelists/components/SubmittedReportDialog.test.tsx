// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { dialogHarness, dialogButton } from "../../../app/dialogs/testHarness";
import { backend } from "../../../infrastructure/backend";
import * as clipboard from "../../../infrastructure/clipboard";
import type { RuntimeInfo, ClQueryResult } from "../../../shared/contracts";
import { SubmittedReportDialog } from "./SubmittedReportDialog";
const harness = dialogHarness();
const runtime = {
  mode: "mock",
  contextGeneration: 7,
  context: { user: "alice" },
  connection: { state: "connected" },
} as RuntimeInfo;
const page = (description = "[CODE] Work"): ClQueryResult => ({
  requestGeneration: 7,
  items: [
    {
      id: 42,
      description,
      time: new Date().toISOString(),
      user: "alice",
      client: "alice_v2d1_main",
      status: "submitted",
      hasShelf: false,
      jobs: [],
      fileCount: 1,
      mergeClassification: "unknown",
    },
  ],
  hasMore: false,
  stats: {
    scannedCount: 1,
    matchedCount: 1,
    hiddenReliableMergeCount: 0,
    truncatedBySafetyLimit: false,
  },
});
const render = () =>
  harness.render(
    <SubmittedReportDialog
      runtime={runtime}
      zh
      source={null}
      initialUser="alice"
      onClose={() => {}}
    />,
  );
afterEach(() => vi.restoreAllMocks());
it("does not fetch or copy on open, reads independently on click and only copies explicitly", async () => {
  const read = vi.spyOn(backend, "queryChangelists").mockResolvedValue(page());
  const copy = vi.spyOn(clipboard, "writeClipboardText").mockResolvedValue();
  vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await render();
  expect(
    [...document.querySelectorAll("footer button")].some(
      (button) => button.textContent === "关闭",
    ),
  ).toBe(false);
  expect(
    document.querySelector('button[aria-label="关闭对话框"]'),
  ).not.toBeNull();
  expect(document.body.textContent).not.toContain("本机时区");
  expect(document.body.textContent).not.toContain("仅本地生成");
  expect(document.body.textContent).not.toContain("精确描述签名仅为启发式");
  expect(
    document.querySelectorAll('input[type="datetime-local"]'),
  ).toHaveLength(2);
  expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
  expect(read).not.toHaveBeenCalled();
  expect(copy).not.toHaveBeenCalled();
  await act(async () => dialogButton("读取并生成").click());
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({
      users: ["alice"],
      clients: [],
      keyword: "",
      hideReliableMerges: false,
    }),
  );
  expect(copy).not.toHaveBeenCalled();
  const output = document.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(output.readOnly).toBe(true);
  expect(output.value).toContain("CL 42");
  await act(async () => dialogButton("复制提示词").click());
  expect(copy).toHaveBeenCalledWith(output.value);
});
it("stopping marks output incomplete and ignores the outstanding response", async () => {
  let resolve!: (value: ClQueryResult) => void;
  vi.spyOn(backend, "queryChangelists").mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const cancel = vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await render();
  await act(async () => dialogButton("读取并生成").click());
  await act(async () => dialogButton("停止读取").click());
  await act(async () => resolve(page("LATE RESPONSE")));
  const output = document.querySelector<HTMLTextAreaElement>("textarea")!.value;
  expect(output).toContain("不完整");
  expect(output).not.toContain("LATE RESPONSE");
  expect(cancel).toHaveBeenCalled();
});
it("editing scope cancels old collection; unmount prevents further pagination", async () => {
  let resolve!: (value: ClQueryResult) => void;
  const read = vi.spyOn(backend, "queryChangelists").mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const cancel = vi.spyOn(backend, "cancelOperation").mockResolvedValue();
  await render();
  await act(async () => dialogButton("读取并生成").click());
  await harness.render(null);
  await act(async () =>
    resolve({ ...page(), hasMore: true, nextCursor: "next" }),
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalled();
});
