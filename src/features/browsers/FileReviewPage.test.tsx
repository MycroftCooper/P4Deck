import { appCache } from "../../shared/cache/appCache";
// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { PageRenderer } from "../../app/PageRenderer";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  DiffResult,
  RevisionGraph,
  RuntimeInfo,
} from "../../shared/contracts/types";
import { FileReviewPage, type ReviewKind } from "./FileReviewPage";
import { PageRefreshSlotContext } from "../../app/docking/chrome";

const backend = vi.hoisted(() => ({
  getDiff: vi.fn(),
  getRevisionGraph: vi.fn(),
  cancelOperation: vi.fn(async () => undefined),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    scrollToIndex: vi.fn(),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 24,
        size: 24,
      })),
  }),
}));

const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  activeProfileId: "profile-a",
  contextGeneration: 7,
  context: {
    server: "fixture:1666",
    user: "tester",
    client: "workspace",
    cwd: "C:/workspace",
  },
  connection: {
    state: "connected",
    message: "ok",
    recovery: "none",
    server: "fixture:1666",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function graph(
  labels: string[],
  overrides: Partial<RevisionGraph> = {},
): RevisionGraph {
  return {
    nodes: labels.map((label, index) => ({
      id: label,
      depotPath: `//depot/${label}.txt`,
      revision: index + 2,
      changelistId: index + 10,
      action: "edit",
      fileType: "text",
      label,
      x: 40 + index * 100,
      y: 70,
      missing: false,
    })),
    edges: [],
    hasMore: false,
    partial: false,
    truncated: false,
    operationIds: [],
    ...overrides,
  };
}

function diff(text: string): DiffResult {
  const side = (label: string) => ({
    reference: { kind: "head" as const },
    label,
    depotPath: "//depot/file.txt",
    exists: true,
    binary: false,
  });
  return {
    path: "//depot/file.txt",
    left: side("left"),
    right: side("right"),
    unified: `@@ -0,0 +1 @@\n+${text}\n`,
    stats: { additions: 1, deletions: 0, hunks: 1 },
    binary: false,
    unsupported: false,
    identical: false,
    truncated: false,
    partial: false,
    operationIds: [],
  };
}

let host: HTMLDivElement;
let root: Root;

async function render(
  kind: ReviewKind,
  target: string,
  nextRuntime: RuntimeInfo = runtime,
) {
  await act(async () => {
    root.render(
      <FileReviewPage
        kind={kind}
        target={target}
        locked={false}
        onTargetChange={() => undefined}
        runtime={nextRuntime}
        zh={false}
      />,
    );
    await Promise.resolve();
  });
}

function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  )!;
}

async function click(element: Element) {
  await act(async () =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

beforeEach(() => {
  appCache.clear();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.getDiff.mockReset();
  backend.getRevisionGraph.mockReset();
  backend.cancelOperation.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it.each(["diff", "revgraph"] as const)(
  "renders an accessible icon-only %s refresh in the path slot",
  async (kind) => {
    const slot = document.createElement("span");
    document.body.append(slot);
    backend.getDiff.mockResolvedValue(diff("content"));
    backend.getRevisionGraph.mockResolvedValue(graph(["file"]));
    try {
      await act(async () => {
        root.render(
          <PageRefreshSlotContext.Provider value={slot}>
            <FileReviewPage
              kind={kind}
              target="//depot/file.txt"
              locked={false}
              onTargetChange={() => undefined}
              runtime={runtime}
              zh={false}
            />
          </PageRefreshSlotContext.Provider>,
        );
      });
      const refresh = slot.querySelector<HTMLButtonElement>(
        'button[aria-label="Refresh"]',
      )!;
      expect(refresh.title).toBe("Refresh");
      expect(refresh.textContent).toBe("");
      expect(refresh.disabled).toBe(false);
      const read = kind === "diff" ? backend.getDiff : backend.getRevisionGraph;
      const before = read.mock.calls.length;
      await click(refresh);
      expect(read.mock.calls.length).toBe(before + 1);
    } finally {
      slot.remove();
    }
  },
);

it("renders source lines on their own side and synchronizes scrolling without reading P4 again", async () => {
  const result = diff("");
  result.unified =
    "@@ -8,3 +8,4 @@\n shared before\n-old value\n+new value\n+extra line\n shared after\n";
  backend.getDiff.mockResolvedValue(result);
  await render("diff", "//depot/file.txt");
  const left = host.querySelector<HTMLElement>('.diff-pane[data-side="left"]')!;
  const right = host.querySelector<HTMLElement>(
    '.diff-pane[data-side="right"]',
  )!;
  expect(left.textContent).toContain("old value");
  expect(left.textContent).not.toContain("new value");
  expect(left.textContent).not.toContain("extra line");
  expect(right.textContent).toContain("new value");
  expect(right.textContent).toContain("extra line");
  expect(right.textContent).not.toContain("old value");
  expect(
    [...left.querySelectorAll(".diff-line-number")].map(
      (line) => line.textContent,
    ),
  ).toEqual(["", "8", "9", "", "10"]);
  expect(
    [...right.querySelectorAll(".diff-line-number")].map(
      (line) => line.textContent,
    ),
  ).toEqual(["", "8", "9", "10", "11"]);
  expect(left.querySelector(".empty")?.textContent).toBe("");
  const leftScroll = left.querySelector<HTMLDivElement>(".diff-side-scroll")!;
  const rightScroll = right.querySelector<HTMLDivElement>(".diff-side-scroll")!;
  await act(async () => {
    leftScroll.scrollTop = 240;
    leftScroll.dispatchEvent(new Event("scroll"));
  });
  expect(rightScroll.scrollTop).toBe(240);
  await act(async () => {
    rightScroll.scrollTop = 96;
    rightScroll.dispatchEvent(new Event("scroll"));
  });
  expect(leftScroll.scrollTop).toBe(96);
  expect(backend.getDiff).toHaveBeenCalledTimes(1);
});

it("shows missing final newlines on the affected side", async () => {
  const result = diff("");
  result.unified = "@@ -1 +1 @@\n-same\n+same\n\\ No newline at end of file\n";
  backend.getDiff.mockResolvedValue(result);
  await render("diff", "//depot/file.txt");
  expect(
    host.querySelector('.diff-pane[data-side="left"] .diff-eof-marker'),
  ).toBeNull();
  expect(
    host.querySelector('.diff-pane[data-side="right"] .diff-eof-marker')
      ?.textContent,
  ).toBe("No newline at end of file");
});

it("keeps identical and binary results out of the text panes", async () => {
  backend.getDiff.mockResolvedValueOnce({
    ...diff(""),
    unified: "",
    identical: true,
  });
  await render("diff", "//depot/same.txt");
  expect(host.textContent).toContain("Both sides are identical");
  expect(host.querySelector(".diff-split")).toBeNull();

  backend.getDiff.mockResolvedValueOnce({
    ...diff(""),
    unified: "",
    binary: true,
    reason: "Binary file",
  });
  await render("diff", "//depot/image.bin");
  expect(host.textContent).toContain("Binary file");
  expect(host.querySelector(".diff-split")).toBeNull();
});

it("hides an old path immediately, cancels it, and ignores its late graph result", async () => {
  const first = deferred<RevisionGraph>();
  const second = deferred<RevisionGraph>();
  backend.getRevisionGraph
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await render("revgraph", "//depot/a.txt");
  const firstOperation = backend.getRevisionGraph.mock.calls[0][0].operationId;
  await render("revgraph", "//depot/b.txt");
  expect(host.textContent).not.toContain("A-OLD");
  expect(backend.cancelOperation).toHaveBeenCalledWith(firstOperation);
  await act(async () => second.resolve(graph(["B-LATEST"])));
  expect(host.textContent).toContain("B-LATEST");
  await act(async () => first.resolve(graph(["A-OLD"])));
  expect(host.textContent).not.toContain("A-OLD");
  expect(host.textContent).toContain("B-LATEST");
});

it("lets only the latest node diff own result, error and loading", async () => {
  backend.getRevisionGraph.mockResolvedValue(graph(["NODE-A", "NODE-B"]));
  const first = deferred<DiffResult>();
  const second = deferred<DiffResult>();
  backend.getDiff
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await render("revgraph", "//depot/root.txt");
  await act(async () => Promise.resolve());
  for (const checkbox of host.querySelectorAll<HTMLInputElement>(
    '.graph-lane-picker input[type="checkbox"]',
  )) {
    if (!checkbox.checked) await click(checkbox);
  }
  const nodes = host.querySelectorAll<SVGGElement>('g[role="button"]');
  await click(nodes[0]);
  await click(button("Diff selected"));
  const firstOperation = backend.getDiff.mock.calls[0][0].operationId;
  await click(nodes[1]);
  expect(backend.cancelOperation).toHaveBeenCalledWith(firstOperation);
  await click(button("Diff selected"));
  await act(async () => second.resolve(diff("LATEST NODE DIFF")));
  expect(host.textContent).toContain("LATEST NODE DIFF");
  await act(async () => first.reject(new Error("OLD NODE ERROR")));
  expect(host.textContent).not.toContain("OLD NODE ERROR");
  expect(host.textContent).toContain("LATEST NODE DIFF");
});

it("cancels load-more on path drift and preserves trusted graph on failure or repeated cursor", async () => {
  const page = deferred<RevisionGraph>();
  backend.getRevisionGraph
    .mockResolvedValueOnce(
      graph(["BASE"], { hasMore: true, nextCursor: "cursor-1" }),
    )
    .mockImplementationOnce(() => page.promise)
    .mockResolvedValueOnce(graph(["NEW-PATH"]));
  await render("revgraph", "//depot/a.txt");
  await act(async () => Promise.resolve());
  await click(button("Expand more"));
  const pageOperation = backend.getRevisionGraph.mock.calls[1][0].operationId;
  await render("revgraph", "//depot/b.txt");
  await act(async () => Promise.resolve());
  expect(backend.cancelOperation).toHaveBeenCalledWith(pageOperation);
  await act(async () => page.resolve(graph(["OLD-PAGE"])));
  expect(host.textContent).toContain("NEW-PATH");
  expect(host.textContent).not.toContain("OLD-PAGE");

  backend.getRevisionGraph
    .mockResolvedValueOnce(
      graph(["SAFE-BASE"], { hasMore: true, nextCursor: "same" }),
    )
    .mockResolvedValueOnce(
      graph(["SAFE-BASE", "PAGE"], { hasMore: true, nextCursor: "same" }),
    );
  await render("revgraph", "//depot/c.txt");
  await act(async () => Promise.resolve());
  await click(button("Expand more"));
  await act(async () => Promise.resolve());
  expect(host.textContent).toContain("SAFE-BASE");
  expect(host.textContent).toContain("repeated cursor");
  expect(button("Expand more")).toBeUndefined();
});

it("serializes page and placeholder expansion without duplicates", async () => {
  const pageRequest = deferred<RevisionGraph>();
  const expandRequest = deferred<RevisionGraph>();
  const initial = graph(["BASE"], { hasMore: true, nextCursor: "cursor-1" });
  initial.nodes.push({
    id: "PLACEHOLDER",
    depotPath: "//depot/branch.txt",
    revision: 3,
    changelistId: 0,
    action: "referenced",
    fileType: "",
    label: "PLACEHOLDER",
    x: 20,
    y: 180,
    missing: true,
  });
  backend.getRevisionGraph
    .mockResolvedValueOnce(initial)
    .mockImplementationOnce(() => pageRequest.promise)
    .mockImplementationOnce(() => expandRequest.promise);
  await render("revgraph", "//depot/root.txt");
  await act(async () => Promise.resolve());
  for (const checkbox of host.querySelectorAll<HTMLInputElement>(
    '.graph-lane-picker input[type="checkbox"]',
  )) {
    if (!checkbox.checked) await click(checkbox);
  }
  const placeholder = [
    ...host.querySelectorAll<SVGGElement>('g[role="button"]'),
  ].find((node) => node.textContent?.includes("PLACEHOLDER"))!;
  await click(placeholder);
  await click(button("Expand more"));
  expect(button("Expand selected reference").disabled).toBe(true);
  await act(async () => pageRequest.resolve(graph(["BASE", "PAGE"])));
  await click(button("Expand selected reference"));
  const expanded = graph(["EXPANDED"]);
  expanded.nodes.push({
    ...initial.nodes[1],
    missing: false,
    changelistId: 33,
  });
  await act(async () => expandRequest.resolve(expanded));
  expect(host.textContent).toContain("BASE");
  expect(host.textContent).toContain("PAGE");
  expect(host.textContent).toContain("EXPANDED");
  expect(
    [...host.querySelectorAll<SVGGElement>('g[role="button"]')].filter((node) =>
      node.getAttribute("aria-label")?.startsWith("PLACEHOLDER"),
    ),
  ).toHaveLength(1);
});

it("keeps the trusted graph when a continuation page fails", async () => {
  backend.getRevisionGraph
    .mockResolvedValueOnce(
      graph(["TRUSTED"], { hasMore: true, nextCursor: "cursor-1" }),
    )
    .mockRejectedValueOnce(new Error("PAGE FAILED"));
  await render("revgraph", "//depot/root.txt");
  await act(async () => Promise.resolve());
  await click(button("Expand more"));
  await act(async () => Promise.resolve());
  expect(host.textContent).toContain("TRUSTED");
  expect(host.textContent).toContain("PAGE FAILED");
  expect(button("Expand more")).toBeTruthy();
});

it("cancels selector and generation owners; a late old error cannot hide the new diff", async () => {
  const first = deferred<DiffResult>();
  const second = deferred<DiffResult>();
  const third = deferred<DiffResult>();
  backend.getDiff
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
    .mockImplementationOnce(() => third.promise);
  await render("diff", "//depot/a.txt");
  const selector = host.querySelector<HTMLSelectElement>(
    'select[aria-label="Left reference"]',
  )!;
  await act(async () => {
    selector.value = "head";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => second.resolve(diff("SELECTOR LATEST")));
  await act(async () => first.reject(new Error("SELECTOR OLD ERROR")));
  expect(host.textContent).toContain("SELECTOR LATEST");
  expect(host.textContent).not.toContain("SELECTOR OLD ERROR");

  await render("diff", "//depot/a.txt", {
    ...runtime,
    activeProfileId: "profile-b",
    contextGeneration: 8,
  });
  expect(host.textContent).not.toContain("SELECTOR LATEST");
  await act(async () => third.resolve(diff("GENERATION LATEST")));
  expect(host.textContent).toContain("GENERATION LATEST");
});

it("cancels the active backend operation when unmounted", async () => {
  backend.getRevisionGraph.mockReturnValue(new Promise(() => undefined));
  await render("revgraph", "//depot/a.txt");
  const operationId = backend.getRevisionGraph.mock.calls[0][0].operationId;
  await act(async () => root.unmount());
  expect(backend.cancelOperation).toHaveBeenCalledWith(operationId);
  root = createRoot(host);
});

it("initializes a historical Diff with the supplied revisions, never have/workspace", async () => {
  backend.getDiff.mockResolvedValue(diff("HISTORY PAIR"));
  await act(async () =>
    root.render(
      <FileReviewPage
        kind="diff"
        target="//depot/file.txt"
        comparison={{ left: 7, right: 8 }}
        locked
        onTargetChange={() => undefined}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  expect(backend.getDiff).toHaveBeenCalled();
  for (const [request] of backend.getDiff.mock.calls) {
    expect(request.left).toEqual({ kind: "revision", revision: 7 });
    expect(request.right).toEqual({ kind: "revision", revision: 8 });
  }
});

it("passes explicit historical revisions through the real PageRenderer to backend and controls", async () => {
  backend.getDiff.mockResolvedValue(diff("EXPLICIT 17 TO 42"));
  const props = {
    page: "diff",
    target: {
      target: "//depot/exact.txt",
      locked: true,
      comparison: { left: 17, right: 42 },
    },
    runtime,
    connectionKey: "fixture-connection",
    preferences: { zh: false },
    changeTarget: vi.fn(),
  } as unknown as ComponentProps<typeof PageRenderer>;
  await act(async () => root.render(<PageRenderer {...props} />));
  expect(backend.getDiff).toHaveBeenCalled();
  for (const [request] of backend.getDiff.mock.calls) {
    expect(request.scope.fileIdentity).toBe("//depot/exact.txt");
    expect(request.left).toEqual({ kind: "revision", revision: 17 });
    expect(request.right).toEqual({ kind: "revision", revision: 42 });
  }
  expect(
    [...host.querySelectorAll<HTMLInputElement>('input[type="number"]')].map(
      (input) => input.value,
    ),
  ).toContain("17");
  expect(
    [...host.querySelectorAll<HTMLInputElement>('input[type="number"]')].map(
      (input) => input.value,
    ),
  ).toContain("42");
  await act(async () =>
    root.render(
      <PageRenderer
        {...props}
        selectedFile={{ depotPath: "//depot/unrelated.txt" } as never}
      />,
    ),
  );
  for (const [request] of backend.getDiff.mock.calls)
    expect(request.scope.fileIdentity).toBe("//depot/exact.txt");
});

it("focus mode and lane controls never fetch; explicit target reads share cache", async () => {
  const initial = graph(["source"]);
  const target = graph(["target"]);
  backend.getRevisionGraph
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(target);
  await render("revgraph", "//depot/source.txt");
  expect(backend.getRevisionGraph).toHaveBeenCalledTimes(1);
  const mode = host.querySelector<HTMLSelectElement>(
    ".graph-focus-controls select",
  )!;
  await act(async () => {
    mode.value = "sources";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click(button("Solo"));
  await click(button("Restore query focus"));
  expect(backend.getRevisionGraph).toHaveBeenCalledTimes(1);
  await act(async () => {
    mode.value = "target";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const input = host.querySelector<HTMLInputElement>(
    ".graph-target-input input",
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "//depot/target.txt");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Read target"));
  expect(backend.getRevisionGraph).toHaveBeenCalledTimes(2);
  expect(backend.getRevisionGraph.mock.calls[1][0].scope.fileIdentity).toBe(
    "//depot/target.txt",
  );
  await click(button("Read target"));
  expect(backend.getRevisionGraph).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("does not prove absence");
});
