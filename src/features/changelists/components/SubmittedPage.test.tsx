// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextMenuProvider } from "../../../app/context-menu/ContextMenu";
import {
  MenuEnvironment,
  type MenuEnvironmentValue,
} from "../../../app/context-menu/environment";
import { defaultUi } from "../../settings/preferences";
import { messages } from "../../../shared/i18n";
import type {
  ChangelistSummary,
  RuntimeInfo,
  SubmittedChangeDetail,
} from "../../../shared/contracts/types";
import {
  conservativeDetailClassification,
  SubmittedPage,
} from "./SubmittedPage";

const backend = vi.hoisted(() => ({
  queryChangelists: vi.fn(),
  getSubmittedChangeDetail: vi.fn(),
  cancelOperation: vi.fn(async () => undefined),
  performClAction: vi.fn(),
  mutatePendingChange: vi.fn(),
}));
vi.mock("../../../infrastructure/backend", () => ({ backend }));

const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  context: { server: "fixture:1666", user: "tester", client: "workspace" },
  connection: {
    state: "connected",
    message: "connected",
    recovery: "none",
    server: "fixture:1666",
  },
};

const changes: ChangelistSummary[] = [
  [101, "normal", "Ordinary change"],
  [102, "suspectedMerge", "Merge text only"],
  [103, "suspectedMerge", "Suspected integration"],
  [104, "unknown", "Inspection unknown"],
].map(([id, mergeClassification, description]) => ({
  id: id as number,
  description: description as string,
  user: "tester",
  client: "workspace",
  status: "submitted",
  time: "2026-10-09T01:00:00.000Z",
  fileCount: 1,
  hasShelf: false,
  jobs: [],
  mergeClassification:
    mergeClassification as ChangelistSummary["mergeClassification"],
}));

function detail(
  changeId: number,
  overrides: Partial<SubmittedChangeDetail> = {},
): SubmittedChangeDetail {
  const change = changes.find((item) => item.id === changeId)!;
  return {
    changeId,
    description: change.description,
    user: change.user,
    client: change.client,
    time: change.time,
    jobs: [],
    files: [],
    integrationEvidence: [],
    mergeClassification: "normal",
    inspectionStatus: "complete",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let root: Root;

function environment(mode: RuntimeInfo["mode"]): MenuEnvironmentValue {
  const value = { ...runtime, mode };
  return {
    runtime: value,
    connectionKey: `${mode}:fixture`,
    commandBusy: false,
    openPage: vi.fn(),
    searchInDirectory: vi.fn(),
    navigate: vi.fn(),
    openFilePage: vi.fn(),
    preferences: {
      locale: "zh-CN",
      setLocale: vi.fn(),
      theme: "light",
      setTheme: vi.fn(),
      ui: defaultUi,
      setUi: vi.fn(),
      t: messages["zh-CN"],
      zh: true,
    },
  };
}

async function render(mode: RuntimeInfo["mode"] = "tauri") {
  const value = { ...runtime, mode };
  await act(async () =>
    root.render(
      <ContextMenuProvider scope={`${mode}:fixture`} zh>
        <MenuEnvironment.Provider value={environment(mode)}>
          <SubmittedPage
            runtime={value}
            t={messages["zh-CN"]}
            onOperation={async () => undefined}
          />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function row(changeId: number) {
  return [...host.querySelectorAll<HTMLButtonElement>(".cl-row")].find(
    (item) => item.querySelector("strong")?.textContent === String(changeId),
  )!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.queryChangelists.mockReset();
  backend.getSubmittedChangeDetail.mockReset();
  backend.cancelOperation.mockClear();
  backend.queryChangelists.mockImplementation(async (query) => ({
    requestGeneration: query.requestGeneration,
    items: [...changes],
    hasMore: false,
    stats: {
      scannedCount: changes.length,
      matchedCount: changes.length,
      hiddenReliableMergeCount: 0,
      truncatedBySafetyLimit: false,
    },
  }));
  backend.getSubmittedChangeDetail.mockImplementation(async ({ changeId }) => {
    if (changeId === 102)
      return detail(102, {
        jobs: ["JOB-102"],
        files: [
          {
            depotPath: "//depot/main/integrated.ts",
            action: "integrate",
            revision: 7,
            fileType: "text",
          },
        ],
        integrationEvidence: [
          {
            source: "filelog",
            depotPath: "//depot/main/integrated.ts",
            relationship: "merge from",
            relatedPath: "//depot/dev/integrated.ts",
          },
        ],
        mergeClassification: "reliableMerge",
      });
    if (changeId === 103)
      return detail(103, {
        mergeClassification: "suspectedMerge",
        inspectionStatus: "partial",
        message: "filelog was truncated",
      });
    if (changeId === 104)
      return detail(104, {
        mergeClassification: "unknown",
        inspectionStatus: "unavailable",
        message: "describe failed",
      });
    return detail(changeId);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("renders ordinary, evidence-backed reliable, text-only suspected, and unavailable detail states", async () => {
  await render();

  await click(row(101));
  expect(host.textContent).toContain("普通提交");
  expect(host.textContent).toContain("此提交没有文件");

  await click(row(102));
  expect(host.textContent).toContain("JOB-102");
  expect(host.textContent).toContain("filelog");
  expect(host.textContent).toContain("merge from");
  expect(host.textContent).toContain("//depot/main/integrated.ts");
  expect(host.textContent).toContain("integrate");
  expect(host.textContent).toContain("#7");

  await click(row(103));
  expect(host.textContent).toContain("疑似项保持可见");
  expect(host.textContent).toContain("filelog was truncated");

  await click(row(104));
  expect(host.textContent).toContain("无法加载提交详情");
  expect(host.textContent).toContain("describe failed");
  expect(row(104).textContent).toContain("分类未知");
});

it("never promotes unproven reliable or incomplete normal classifications", () => {
  expect(
    conservativeDetailClassification(
      detail(103, {
        mergeClassification: "reliableMerge",
        integrationEvidence: [],
      }),
      "suspectedMerge",
    ),
  ).toBe("suspectedMerge");
  expect(
    conservativeDetailClassification(
      detail(104, {
        mergeClassification: "normal",
        inspectionStatus: "partial",
      }),
      "unknown",
    ),
  ).toBe("unknown");
});

it("cancels and ignores a stale response after a rapid row switch", async () => {
  const first = deferred<SubmittedChangeDetail>();
  const second = deferred<SubmittedChangeDetail>();
  backend.getSubmittedChangeDetail.mockImplementation(({ changeId }) =>
    changeId === 101 ? first.promise : second.promise,
  );
  await render();
  await click(row(101));
  expect(host.textContent).toContain("正在加载真实提交详情");
  await click(row(102));
  await act(async () =>
    second.resolve(
      detail(102, {
        files: [{ depotPath: "//depot/new.ts", action: "edit", revision: 2 }],
      }),
    ),
  );
  expect(host.textContent).toContain("//depot/new.ts");
  await act(async () =>
    first.resolve(
      detail(101, {
        files: [{ depotPath: "//depot/stale.ts", action: "edit", revision: 1 }],
      }),
    ),
  );
  expect(host.textContent).not.toContain("//depot/stale.ts");
  expect(backend.cancelOperation).toHaveBeenCalled();
});

it("hides only a row upgraded to reliable and keeps the hidden count and selection consistent", async () => {
  await render();
  await click(
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("隐藏可靠合并"),
    )!,
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(row(103)).toBeTruthy();
  expect(row(104)).toBeTruthy();
  await click(row(102));
  expect(row(102)).toBeUndefined();
  expect(host.textContent).toContain("已隐藏 1 条");
  expect(host.textContent).toContain("选择一个 CL 查看详情");
  expect(row(103).textContent).toContain("疑似合并");
  expect(row(104).textContent).toContain("分类未知");
});

it("shows detail errors, retries, and renders an empty success", async () => {
  backend.getSubmittedChangeDetail
    .mockRejectedValueOnce(new Error("temporary failure"))
    .mockResolvedValueOnce(detail(101));
  await render();
  await click(row(101));
  expect(host.textContent).toContain("temporary failure");
  await click(
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "重试",
    )!,
  );
  expect(host.textContent).toContain("此提交没有文件");
  expect(backend.getSubmittedChangeDetail).toHaveBeenCalledTimes(2);
});

it("labels Browser Mock detail as simulated and isolated from real networking", async () => {
  await render("mock");
  await click(row(101));
  expect(host.textContent).toContain("模拟数据 · 未访问真实 P4 Server 或网络");
  expect(backend.getSubmittedChangeDetail).toHaveBeenCalledWith(
    expect.objectContaining({ changeId: 101 }),
  );
});

it("keeps the responsive detail structure and virtual file viewport at 390px", async () => {
  const previousWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  try {
    await render();
    await click(row(102));
    expect(host.querySelector(".cl-layout")).toBeTruthy();
    expect(host.querySelector(".detail-panel.visible")).toBeTruthy();
    expect(
      host.querySelector('[data-testid="revision-file-virtual-list"]'),
    ).toBeTruthy();
    expect(host.querySelector(".integration-evidence")).toBeTruthy();
  } finally {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: previousWidth,
    });
  }
});
