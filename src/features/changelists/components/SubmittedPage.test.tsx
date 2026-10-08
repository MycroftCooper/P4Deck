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

function page(
  items: ChangelistSummary[],
  requestGeneration: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    requestGeneration,
    items,
    hasMore: false,
    stats: {
      scannedCount: items.length,
      matchedCount: items.length,
      hiddenReliableMergeCount: 0,
      truncatedBySafetyLimit: false,
    },
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

function environment(
  mode: RuntimeInfo["mode"],
  locale: "zh-CN" | "en-US" = "zh-CN",
): MenuEnvironmentValue {
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
      locale,
      setLocale: vi.fn(),
      theme: "light",
      setTheme: vi.fn(),
      ui: defaultUi,
      setUi: vi.fn(),
      t: messages[locale],
      zh: locale === "zh-CN",
    },
  };
}

async function render(
  mode: RuntimeInfo["mode"] = "tauri",
  locale: "zh-CN" | "en-US" = "zh-CN",
) {
  const value = { ...runtime, mode };
  await act(async () =>
    root.render(
      <ContextMenuProvider scope={`${mode}:fixture`} zh={locale === "zh-CN"}>
        <MenuEnvironment.Provider value={environment(mode, locale)}>
          <SubmittedPage
            runtime={value}
            t={messages[locale]}
            onOperation={async () => undefined}
          />
        </MenuEnvironment.Provider>
      </ContextMenuProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
}

function row(changeId: number) {
  return [...host.querySelectorAll<HTMLButtonElement>(".cl-row")].find(
    (item) => item.querySelector("strong")?.textContent === String(changeId),
  )!;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function input(label: string) {
  return [...host.querySelectorAll<HTMLLabelElement>("label")]
    .find((item) => item.querySelector(":scope > span")?.textContent === label)!
    .querySelector<HTMLInputElement>("input")!;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.queryChangelists.mockReset();
  backend.getSubmittedChangeDetail.mockReset();
  backend.cancelOperation.mockClear();
  localStorage.clear();
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
    [...host.querySelectorAll<HTMLLabelElement>("label")]
      .find((item) => item.textContent?.includes("仅隐藏 reliable"))!
      .querySelector("input")!,
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
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

it("debounces a full filter mapping, cancels the old request, and ignores stale results", async () => {
  await render();
  backend.queryChangelists.mockClear();
  backend.cancelOperation.mockClear();
  const first = deferred<ReturnType<typeof page>>();
  const second = deferred<ReturnType<typeof page>>();
  backend.queryChangelists
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);

  await enter(input("关键词"), "first");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 320)));
  expect(backend.queryChangelists).toHaveBeenCalledTimes(1);
  await enter(input("关键词"), "second");
  expect(backend.cancelOperation).toHaveBeenCalled();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 320)));
  expect(backend.queryChangelists).toHaveBeenCalledTimes(2);
  const latest = backend.queryChangelists.mock.calls[1][0];
  expect(latest).toMatchObject({
    keyword: "second",
    users: [],
    clients: [],
    jobs: [],
    hasJob: undefined,
    mergeClassifications: [],
    hideReliableMerges: false,
    pageSize: 100,
    cursor: undefined,
  });
  await act(async () =>
    second.resolve(page([changes[1]], latest.requestGeneration)),
  );
  expect(row(102)).toBeTruthy();
  const stale = backend.queryChangelists.mock.calls[0][0];
  await act(async () =>
    first.resolve(page([changes[0]], stale.requestGeneration)),
  );
  expect(row(101)).toBeUndefined();
  expect(row(102)).toBeTruthy();
});

it("maps multi-value, path, stream, Job and four-state controls to the typed query", async () => {
  await render();
  backend.queryChangelists.mockClear();
  await enter(input("User（逗号/换行分隔）"), "alice,buildbot");
  await enter(input("Client（逗号/换行分隔）"), "ws-a,ws-b");
  await enter(input("Depot Path"), "//depot/main/...");
  await enter(input("Stream"), "//depot/main");
  await enter(input("Job（逗号/换行分隔）"), "JOB-1,JOB-2");
  const selects = [...host.querySelectorAll<HTMLSelectElement>("select")];
  const jobSelect = selects.find((item) =>
    item.closest("label")?.textContent?.includes("Job 状态"),
  )!;
  await act(async () => {
    jobSelect.value = "yes";
    jobSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const unknown = [...host.querySelectorAll<HTMLLabelElement>("label")].find(
    (item) => item.textContent === "未知",
  )!;
  await click(unknown.querySelector("input")!);
  const hide = [...host.querySelectorAll<HTMLLabelElement>("label")].find(
    (item) => item.textContent?.includes("仅隐藏 reliable"),
  )!;
  await click(hide.querySelector("input")!);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  const query = backend.queryChangelists.mock.calls.at(-1)![0];
  expect(query).toMatchObject({
    users: ["alice", "buildbot"],
    clients: ["ws-a", "ws-b"],
    depotPath: "//depot/main/...",
    stream: "//depot/main",
    jobs: ["JOB-1", "JOB-2"],
    hasJob: true,
    mergeClassifications: ["unknown"],
    hideReliableMerges: true,
  });
});

it("appends cursor pages without duplicates, preserves detail selection, and retries a failed page", async () => {
  const extra = { ...changes[0], id: 99, description: "Next page" };
  backend.queryChangelists
    .mockImplementationOnce(async (query) =>
      page(changes.slice(0, 2), query.requestGeneration, {
        hasMore: true,
        nextCursor: "cursor-2",
      }),
    )
    .mockRejectedValueOnce(new Error("temporary page failure"))
    .mockImplementationOnce(async (query) =>
      page([changes[1], extra], query.requestGeneration),
    );
  await render();
  await click(row(101));
  expect(host.querySelector(".detail-panel.visible")).toBeTruthy();
  const load = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === "加载更多",
  )!;
  await click(load);
  expect(host.textContent).toContain("temporary page failure");
  expect(row(101)).toBeTruthy();
  expect(host.querySelector(".detail-panel.visible")).toBeTruthy();
  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === "重试加载更多",
  )!;
  await click(retry);
  expect(row(99)).toBeTruthy();
  expect(host.querySelectorAll(".cl-row")).toHaveLength(3);
  expect(host.querySelectorAll(".cl-row strong")[1].textContent).toBe("102");
  expect(host.textContent).toContain("2 页");
  expect(host.querySelector(".detail-panel.visible")).toBeTruthy();
});

it("announces truncated partial results and the 5,000 scan ceiling", async () => {
  backend.queryChangelists.mockImplementationOnce(async (query) =>
    page(changes, query.requestGeneration, {
      hasMore: false,
      stats: {
        scannedCount: 5000,
        matchedCount: changes.length,
        hiddenReliableMergeCount: 3,
        truncatedBySafetyLimit: true,
      },
    }),
  );
  await render();
  expect(host.textContent).toContain("达到 5,000 条扫描上限");
  expect(host.textContent).toContain("扫描 5,000");
  expect(host.textContent).toContain("已隐藏 3 条");
});

it("saves, confirms overwrite, applies, and confirms deletion without storing secrets", async () => {
  await render();
  await enter(input("关键词"), "saved keyword");
  const name = host.querySelector<HTMLInputElement>(
    '[aria-label="过滤器名称"]',
  )!;
  await enter(name, "常用筛选");
  const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.includes("保存"),
  )!;
  await click(save);
  expect(localStorage.getItem("p4deck.submitted.filters")).toContain(
    "常用筛选",
  );
  expect(localStorage.getItem("p4deck.submitted.filters")).not.toContain(
    "password",
  );
  await enter(input("关键词"), "updated keyword");
  await click(save);
  expect(host.textContent).toContain("确认覆盖");
  await click(
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "确认",
    )!,
  );
  await enter(input("关键词"), "temporary");
  await click(
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "应用",
    )!,
  );
  expect(input("关键词").value).toBe("updated keyword");
  await click(
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("重置为默认"),
    )!,
  );
  expect(input("关键词").value).toBe("");
  await click(
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("删除"),
    )!,
  );
  expect(host.textContent).toContain("确认删除");
  await click(
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "确认",
    )!,
  );
  expect(localStorage.getItem("p4deck.submitted.filters")).not.toContain(
    "常用筛选",
  );
});

it("renders English labels and focusable controls in a 390px layout", async () => {
  const previousWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  try {
    await render("tauri", "en-US");
    expect(host.textContent).toContain("Values within a field use OR");
    expect(host.textContent).toContain("Hide reliable merges only");
    expect(host.querySelector('[aria-label="Saved filters"]')).toBeTruthy();
    const reset = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.includes("Reset to default"),
    )!;
    reset.focus();
    expect(document.activeElement).toBe(reset);
    expect(host.querySelector(".submitted-filter-grid")).toBeTruthy();
  } finally {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: previousWidth,
    });
  }
});
