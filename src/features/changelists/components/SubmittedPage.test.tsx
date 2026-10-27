import { PageHeaderActionsContext } from "../../../app/docking/chrome";
import { ChangeDetailsContext } from "./ChangeDetailsDialog";
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
  isSubmittedSnapshot,
  SubmittedPage,
} from "./SubmittedPage";

const backend = vi.hoisted(() => ({
  queryChangelists: vi.fn(),
  listStreams: vi.fn(),
  getSubmittedChangeDetail: vi.fn(),
  cancelOperation: vi.fn(async () => undefined),
  performClAction: vi.fn(),
  mutatePendingChange: vi.fn(),
}));
vi.mock("../../../infrastructure/backend", () => ({ backend }));

const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  contextGeneration: 1,
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

const openDetails = vi.fn();
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
  navigation?: { changeId: number; nonce: number },
  overrides: Partial<RuntimeInfo> = {},
  headerTarget: HTMLElement | null = null,
) {
  const value = { ...runtime, mode, ...overrides };
  await act(async () =>
    root.render(
      <ContextMenuProvider scope={`${mode}:fixture`} zh={locale === "zh-CN"}>
        <MenuEnvironment.Provider
          value={{ ...environment(mode, locale), runtime: value }}
        >
          <ChangeDetailsContext.Provider value={openDetails}>
            <PageHeaderActionsContext.Provider value={headerTarget}>
              <SubmittedPage
                runtime={value}
                t={messages[locale]}
                onOperation={async () => undefined}
                navigation={navigation}
              />
            </PageHeaderActionsContext.Provider>
          </ChangeDetailsContext.Provider>
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

it("keeps submitted rows and selection visible until a refresh succeeds, including after a failed refresh", async () => {
  await render();
  await click(row(102));
  const previousRow = row(102);
  const next = deferred<ReturnType<typeof page>>();
  backend.queryChangelists.mockImplementationOnce((query) =>
    next.promise.then((value) => ({
      ...value,
      requestGeneration: query.requestGeneration,
    })),
  );
  await act(async () =>
    window.dispatchEvent(new Event("p4deck:submitted-refresh")),
  );
  expect(row(102)).toBe(previousRow);
  expect(row(102).classList.contains("selected")).toBe(true);
  await act(async () =>
    next.resolve(
      page(
        changes.map((change) => ({
          ...change,
          description: `Refreshed ${change.description}`,
        })),
        0,
      ),
    ),
  );
  expect(host.textContent).toContain("Refreshed Merge text only");
  backend.queryChangelists.mockRejectedValueOnce(
    new Error("Refresh unavailable"),
  );
  await act(async () =>
    window.dispatchEvent(new Event("p4deck:submitted-refresh")),
  );
  expect(host.textContent).toContain("Refresh unavailable");
  expect(host.textContent).toContain("Refreshed Merge text only");
});

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  openDetails.mockClear();
  backend.queryChangelists.mockReset();
  backend.listStreams.mockReset();
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

it("reopens from the cache without P4 and revalidates behind the rows after a reconnect", async () => {
  await render();
  expect(backend.queryChangelists).toHaveBeenCalledTimes(1);
  const remount = async () => {
    await act(async () => root.unmount());
    root = createRoot(host);
  };
  await remount();
  await render();
  expect(backend.queryChangelists).toHaveBeenCalledTimes(1);
  expect(row(101)).toBeTruthy();

  // A new connection generation invalidates the cursor, not the visible rows.
  const next = deferred<ReturnType<typeof page>>();
  backend.queryChangelists.mockImplementationOnce((query) =>
    next.promise.then((value) => ({
      ...value,
      requestGeneration: query.requestGeneration,
    })),
  );
  await remount();
  await render("tauri", "zh-CN", undefined, { contextGeneration: 2 });
  expect(backend.queryChangelists).toHaveBeenCalledTimes(2);
  expect(row(101)).toBeTruthy();
  await act(async () =>
    next.resolve(page([{ ...changes[0], description: "Revalidated" }], 0)),
  );
  expect(host.textContent).toContain("Revalidated");
  expect(row(102)).toBeUndefined();
});

it("validates persisted rows, dates and query metadata before restoration", async () => {
  await render();
  const { appCache } = await import("../../../shared/cache/appCache");
  const snapshot = appCache.getQueriesData({
    queryKey: ["snapshot", "submitted"],
  })[0][1] as Record<string, unknown>;
  expect(isSubmittedSnapshot(snapshot)).toBe(true);
  for (const value of [
    null,
    {},
    { ...snapshot, changes: [null] },
    { ...snapshot, changes: [{ ...changes[0], time: "not-a-date" }] },
    { ...snapshot, changes: [{ ...changes[0], jobs: {} }] },
    { ...snapshot, base: {} },
    { ...snapshot, stats: {} },
  ])
    expect(isSubmittedSnapshot(value)).toBe(false);
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

it("uses a single user and cached current context without Job controls or extra queries", async () => {
  const { appCache } = await import("../../../shared/cache/appCache");
  const { workspaceListKey } = await import("../../workspaces/workspaceList");
  appCache.setQueryData(workspaceListKey(runtime), [
    { name: "workspace", root: "test", host: "", stream: "//depot/main" },
  ]);
  await render();
  await enter(input("用户"), "alice");
  await click(
    host.querySelector<HTMLInputElement>(".submitted-stream-options input")!,
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  const query = backend.queryChangelists.mock.calls.at(-1)![0];
  expect(query).toMatchObject({
    users: ["alice"],
    clients: [],
    streams: ["//depot/main"],
  });
  expect(query).not.toHaveProperty("jobs");
  expect(query).not.toHaveProperty("hasJob");
  expect(host.textContent).not.toMatch(/Job 状态|逗号|换行/);
  expect(host.querySelector("textarea")).toBeNull();
});
it("disables unknown current stream and blocks a multiuser query", async () => {
  await render();
  expect(
    host.querySelector<HTMLInputElement>(".submitted-stream-options input")!
      .disabled,
  ).toBe(true);
  backend.queryChangelists.mockClear();
  await enter(input("用户"), "alice,bob");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  expect(backend.queryChangelists).not.toHaveBeenCalled();
  expect(host.textContent).toContain("请输入单一用户名");
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
  expect(row(101).classList.contains("selected")).toBe(true);
  const load = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === "加载更多",
  )!;
  await click(load);
  expect(host.textContent).toContain("temporary page failure");
  expect(row(101)).toBeTruthy();
  expect(row(101).classList.contains("selected")).toBe(true);
  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === "重试加载更多",
  )!;
  await click(retry);
  expect(row(99)).toBeTruthy();
  expect(host.querySelectorAll(".cl-row")).toHaveLength(3);
  expect(host.querySelectorAll(".cl-row strong")[1].textContent).toBe("102");
  expect(host.textContent).toContain("2 页");
  expect(row(101).classList.contains("selected")).toBe(true);
});

it.each([
  "invalid submitted query cursor",
  "submitted query cursor does not match this query or connection",
  { code: "cursorExpired", message: "cursor expired" },
  { code: "invalidCursor", message: "invalid cursor" },
])(
  "silently replaces an expired paging session while keeping rows visible (%j)",
  async (failure) => {
    const replacement = deferred<ReturnType<typeof page>>();
    backend.queryChangelists
      .mockImplementationOnce(async (query) =>
        page(changes, query.requestGeneration, {
          hasMore: true,
          nextCursor: "expired",
        }),
      )
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce((query) =>
        replacement.promise.then((result) => ({
          ...result,
          requestGeneration: query.requestGeneration,
        })),
      );
    await render("tauri", "en-US");
    const more = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "Load more",
    )!;
    await click(more);
    expect(backend.queryChangelists).toHaveBeenCalledTimes(3);
    expect(backend.queryChangelists.mock.calls[1][0].cursor).toBe("expired");
    expect(backend.queryChangelists.mock.calls[2][0].cursor).toBeUndefined();
    expect(row(101)).toBeTruthy();
    expect(host.textContent).not.toMatch(
      /expired|invalid cursor|restarted from the first page/i,
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () =>
      replacement.resolve(
        page([{ ...changes[0], description: "Fresh first page" }], 0),
      ),
    );
    expect(host.querySelectorAll(".cl-row")).toHaveLength(1);
    expect(host.textContent).toContain("Fresh first page");
    expect(backend.queryChangelists).toHaveBeenCalledTimes(3);
  },
);

it("reports a failed first-page recovery once and retains the cached rows", async () => {
  backend.queryChangelists
    .mockImplementationOnce(async (query) =>
      page(changes, query.requestGeneration, {
        hasMore: true,
        nextCursor: "expired",
      }),
    )
    .mockRejectedValueOnce("invalid submitted query cursor")
    .mockRejectedValueOnce(new Error("Server unavailable"));
  await render("tauri", "en-US");
  await click(
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "Load more",
    )!,
  );
  expect(backend.queryChangelists).toHaveBeenCalledTimes(3);
  expect(row(101)).toBeTruthy();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Server unavailable",
  );
  expect(host.textContent).not.toContain("invalid submitted query cursor");
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
  const preset = host.querySelector<HTMLSelectElement>(
    'select[aria-label="保存的过滤器"]',
  )!;
  const savedId = preset.value;
  await act(async () => {
    preset.value = "";
    preset.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(input("关键词").value).toBe("temporary");
  await act(async () => {
    preset.value = savedId;
    preset.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(
    [...host.querySelectorAll("button")].some(
      (button) => button.textContent === "应用",
    ),
  ).toBe(false);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  const calls = backend.queryChangelists.mock.calls.length;
  await act(async () =>
    preset.dispatchEvent(new Event("change", { bubbles: true })),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  expect(backend.queryChangelists).toHaveBeenCalledTimes(calls);
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
    expect(host.textContent).not.toContain("Current Client only");
    expect(host.textContent).toContain("Current stream");
    expect(host.textContent).not.toContain("Hide reliable merges only");
    expect(host.textContent).toContain("Submission type");
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

it("opens shared CL details by double-click without navigating or losing selection", async () => {
  await render();
  await click(row(101));
  expect(backend.getSubmittedChangeDetail).not.toHaveBeenCalled();
  await act(async () =>
    row(101).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(openDetails).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "submitted", changeId: 101 }),
    row(101),
  );
  expect(row(101).classList.contains("selected")).toBe(true);
  expect(host.querySelector(".detail-panel")).toBeNull();
});

it("Go To opens the exact CL independently of active filters and rejects invalid numbers", async () => {
  await render();
  await enter(input("关键词"), "unrelated");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  const count = backend.queryChangelists.mock.calls.length;
  const target = host.querySelector<HTMLInputElement>("#submitted-go-to")!;
  const submit = () =>
    act(async () => {
      host
        .querySelector(".submitted-go-to")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
  for (const value of ["0", "-1", "1.2", "1e3", "abc"]) {
    await enter(target, value);
    await submit();
  }
  expect(openDetails).not.toHaveBeenCalled();
  await enter(target, "12345");
  await submit();
  await enter(target, "67890");
  await submit();
  expect(openDetails.mock.calls.map(([value]) => value.changeId)).toEqual([
    12345, 67890,
  ]);
  expect(input("关键词").value).toBe("unrelated");
  expect(backend.queryChangelists).toHaveBeenCalledTimes(count);
});
const expand = (id: number) =>
  host.querySelector<HTMLButtonElement>(
    `.submitted-expand[aria-label$="CL ${id}"]`,
  )!;
it("expands files on demand without changing selection or opening details, caches independent rows", async () => {
  await render();
  await click(row(101));
  expect(backend.getSubmittedChangeDetail).not.toHaveBeenCalled();
  await click(expand(102));
  expect(host.textContent).toContain("integrated.ts");
  expect(row(101).classList.contains("selected")).toBe(true);
  expect(openDetails).not.toHaveBeenCalled();
  await click(expand(103));
  expect(host.querySelectorAll(".submitted-change-files")).toHaveLength(2);
  await click(expand(102));
  await click(expand(102));
  expect(
    backend.getSubmittedChangeDetail.mock.calls.filter(
      ([q]) => q.changeId === 102,
    ),
  ).toHaveLength(1);
});
it("ignores collapsed stale file responses and allows retry", async () => {
  await render();
  const stale = deferred<SubmittedChangeDetail>();
  backend.getSubmittedChangeDetail
    .mockImplementationOnce(() => stale.promise)
    .mockRejectedValueOnce(new Error("file access denied"));
  await click(expand(101));
  await click(expand(101));
  await click(expand(101));
  expect(host.textContent).toContain("file access denied");
  await act(async () =>
    stale.resolve(
      detail(101, { message: "STALE", inspectionStatus: "partial" }),
    ),
  );
  expect(host.textContent).not.toContain("STALE");
  const retry = host.querySelector<HTMLButtonElement>(
    ".submitted-change-files button",
  )!;
  await click(retry);
  expect(host.textContent).not.toContain("file access denied");
  expect(host.textContent).toContain("没有可显示的文件");
});
it("invalidates expanded file requests and cache on connection change", async () => {
  await render();
  const stale = deferred<SubmittedChangeDetail>();
  backend.getSubmittedChangeDetail.mockImplementationOnce(() => stale.promise);
  await click(expand(101));
  await render("tauri", "zh-CN", undefined, { contextGeneration: 2 });
  await act(async () =>
    stale.resolve(
      detail(101, { message: "OLD-CONNECTION", inspectionStatus: "partial" }),
    ),
  );
  expect(host.textContent).not.toContain("OLD-CONNECTION");
  expect(host.querySelector(".submitted-change-files")).toBeNull();
  await click(expand(101));
  expect(backend.getSubmittedChangeDetail).toHaveBeenCalledTimes(2);
});

it("filters loaded submission kinds using exact signatures and retains ordinary manual merge descriptions", async () => {
  backend.queryChangelists.mockImplementation(async (query) =>
    page(
      [
        { ...changes[0], description: "Manually merge feature" },
        { ...changes[1], description: "Work\n合并来源: main" },
        { ...changes[2], description: "[AutoGen] generated" },
      ],
      query.requestGeneration,
    ),
  );
  await render();
  const select = host.querySelector<HTMLSelectElement>(
    ".submitted-kind-filter select",
  )!;
  await act(async () => {
    select.value = "ordinary";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(row(101)).toBeTruthy();
  expect(row(102)).toBeUndefined();
  await act(async () => {
    select.value = "ciMerge";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(row(102)).toBeTruthy();
  expect(row(101)).toBeUndefined();
  expect(host.textContent).toContain("已加载 3 条中显示 1 条");
});

it("keeps Go To in the title action slot and groups submission type with filters", async () => {
  await render();
  const go = host.querySelector(".submitted-go-to")!;
  expect(go.parentElement?.classList.contains("target-controls")).toBe(true);
  expect(go.textContent).not.toContain("周报提示词");
  expect(go.textContent).not.toContain("打开已提交 CL 详情");
  expect(go.querySelector("small")).toBeNull();
  expect(
    host.querySelector(".submitted-filter-grid .submitted-kind-filter select"),
  ).toBeTruthy();
  expect(host.querySelector(".submitted-page-actions")?.textContent).toContain(
    "周报提示词",
  );
});

it("portals the CL address into the fixed title bar and preserves exact Go To behavior", async () => {
  const header = document.createElement("div");
  header.className = "target-controls page-title-controls";
  document.body.append(header);
  try {
    await render("tauri", "zh-CN", undefined, {}, header);
    expect(host.querySelector(".submitted-go-to")).toBeNull();
    const form = header.querySelector<HTMLFormElement>(".submitted-go-to")!;
    expect(form.classList.contains("diff-path-field")).toBe(true);
    expect(
      form.querySelector(".target-refresh-slot button[title='转到 CL']"),
    ).toBeTruthy();
    expect(
      header.querySelector("button[aria-label='周报提示词']"),
    ).toBeTruthy();
    expect(header.querySelector("button[aria-label='刷新']")).toBeTruthy();
    await enter(form.querySelector("input")!, "12345");
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(openDetails).toHaveBeenCalledWith(
      { kind: "submitted", changeId: 12345 },
      form.querySelector("input"),
    );
    expect(
      host.querySelector(".submitted-filter-grid .submitted-kind-filter"),
    ).toBeTruthy();
  } finally {
    header.remove();
  }
});

it("has one classification control, resets it to All and does not hide integrations in the query", async () => {
  await render();
  const select = host.querySelector<HTMLSelectElement>(
    ".submitted-kind-filter select",
  )!;
  expect(Array.from(select.options).map((option) => option.value)).toEqual([
    "all",
    "ordinary",
    "ciMerge",
    "autoGenerated",
  ]);
  expect(host.querySelector(".submitted-merge-filters")).toBeNull();
  await act(async () => {
    select.value = "ciMerge";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  expect(host.querySelectorAll(".cl-row")).toHaveLength(0);
  await click(
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("重置为默认过滤器"),
    )!,
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  expect(select.value).toBe("all");
  expect(host.querySelectorAll(".cl-row")).toHaveLength(changes.length);
  expect(backend.queryChangelists.mock.calls.at(-1)![0]).toMatchObject({
    mergeClassifications: [],
    hideReliableMerges: false,
  });
});

it("multi-selects cached streams, deduplicates current and clears all filters", async () => {
  const { appCache } = await import("../../../shared/cache/appCache");
  const { serverScope, snapshotKey } =
    await import("../../../shared/cache/policy");
  const { workspaceListKey } = await import("../../workspaces/workspaceList");
  appCache.setQueryData(workspaceListKey(runtime), [
    { name: "workspace", root: "x", host: "", stream: "//d/main" },
  ]);
  appCache.setQueryData(
    snapshotKey("streams", serverScope(runtime)),
    ["//d/main", "//d/dev"].map((stream) => ({
      stream,
      name: stream,
      parent: "none",
      kind: "mainline",
    })),
  );
  await render();
  expect(host.textContent).not.toContain("仅当前 Client");
  const options = host.querySelectorAll<HTMLInputElement>(
    ".submitted-stream-options input",
  );
  for (const option of options) await click(option);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  expect(backend.queryChangelists.mock.calls.at(-1)![0]).toMatchObject({
    clients: [],
    streams: ["//d/dev", "//d/main"],
  });
  await click(
    [
      ...host.querySelectorAll<HTMLButtonElement>(
        ".submitted-stream-options button",
      ),
    ].find((button) => button.textContent === "清空")!,
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  expect(backend.queryChangelists.mock.calls.at(-1)![0]).toMatchObject({
    clients: [],
    streams: [],
  });
});

it("loads Stream options only on request and exposes failures for retry", async () => {
  await render();
  expect(backend.listStreams).not.toHaveBeenCalled();
  const load = () =>
    [
      ...host.querySelectorAll<HTMLButtonElement>(
        ".submitted-stream-options button",
      ),
    ].find((button) => button.textContent === "读取列表")!;
  const pending = deferred<never>();
  backend.listStreams.mockReturnValueOnce(pending.promise);
  await click(load());
  expect(load().disabled).toBe(true);
  expect(host.textContent).toContain("正在读取");
  await act(async () => pending.reject(new Error("Stream fixture failure")));
  expect(host.textContent).toContain("Stream fixture failure");
  backend.listStreams.mockResolvedValueOnce([]);
  await click(load());
  expect(backend.listStreams).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("暂无缓存的 Stream 选项");
});

it("clears explicit streams across connections and resolves the current shortcut again", async () => {
  const { appCache } = await import("../../../shared/cache/appCache");
  const { workspaceListKey } = await import("../../workspaces/workspaceList");
  const { serverScope, snapshotKey } =
    await import("../../../shared/cache/policy");
  appCache.setQueryData(workspaceListKey(runtime), [
    { name: "workspace", root: "x", host: "", stream: "//old/main" },
  ]);
  appCache.setQueryData(snapshotKey("streams", serverScope(runtime)), [
    { stream: "//old/dev", name: "Dev", parent: "none", kind: "mainline" },
  ]);
  await render();
  for (const option of host.querySelectorAll<HTMLInputElement>(
    ".submitted-stream-options input",
  ))
    await click(option);
  const next = {
    ...runtime,
    contextGeneration: 2,
    context: { ...runtime.context, server: "other-fixture:1666" },
  };
  appCache.setQueryData(workspaceListKey(next), [
    { name: "workspace", root: "x", host: "", stream: "//new/main" },
  ]);
  await render("tauri", "zh-CN", undefined, next);
  expect(backend.queryChangelists.mock.calls.at(-1)![0]).toMatchObject({
    clients: [],
    streams: ["//new/main"],
  });
  expect(
    host.querySelector(".submitted-stream-picker")?.textContent,
  ).not.toContain("//old/");
});

it("keeps the loaded/displayed summary above results when filters collapse", async () => {
  await render();
  const filters = host.querySelector<HTMLDetailsElement>(".submitted-filters")!;
  const summary = host.querySelector(".submitted-result-summary")!;
  expect(summary.textContent).toContain(
    `已加载 ${changes.length} 条中显示 ${changes.length} 条`,
  );
  expect(filters.contains(summary)).toBe(false);
  expect(summary.nextElementSibling?.classList.contains("cl-layout")).toBe(
    true,
  );
  await act(async () => {
    filters.open = false;
  });
  expect(summary.closest("details")).toBeNull();
  expect(summary.isConnected).toBe(true);
});

it("keeps Depot Path and Stream together, with both dates in their own paired row", async () => {
  await render();
  const scope = host.querySelector(".submitted-scope-row")!;
  expect(
    scope.querySelectorAll(":scope > .submitted-filter-field"),
  ).toHaveLength(2);
  expect(scope.contains(input("Depot Path"))).toBe(true);
  expect(scope.querySelector(".submitted-stream-picker")).toBeTruthy();
  expect(
    host.querySelectorAll(".submitted-date-range input[type='datetime-local']"),
  ).toHaveLength(2);
});

it("keeps distinct fixed-height result rows across expansion, collapse and resize", async () => {
  await render();
  const boxes = () => [
    ...host.querySelectorAll<HTMLElement>(".submitted-change-row"),
  ];
  const assertSeparated = () => {
    const items = boxes();
    expect(items.length).toBeGreaterThan(1);
    for (let index = 1; index < items.length; index++) {
      const y = (node: HTMLElement) =>
        Number(node.style.transform.match(/translateY\(([-\d.]+)px\)/)![1]);
      expect(y(items[index])).toBeGreaterThanOrEqual(
        y(items[index - 1]) + Number.parseFloat(items[index - 1].style.height),
      );
    }
  };
  assertSeparated();
  await click(
    boxes()[0].querySelector<HTMLButtonElement>(".submitted-expand")!,
  );
  expect(boxes()[0].style.height).toBe("324px");
  assertSeparated();
  await act(async () => {
    host.querySelector<HTMLDetailsElement>(".submitted-filters")!.open = false;
    window.dispatchEvent(new Event("resize"));
  });
  assertSeparated();
  await click(
    boxes()[0].querySelector<HTMLButtonElement>(".submitted-expand")!,
  );
  expect(boxes()[0].style.height).toBe("64px");
  assertSeparated();
});
