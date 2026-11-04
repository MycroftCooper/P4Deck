// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FilePreviewPage } from "./FilePreviewPage";
import type {
  FilePreview,
  FilePreviewTable,
  RuntimeInfo,
} from "../../../shared/contracts";

const backend = vi.hoisted(() => ({ getFilePreview: vi.fn() }));
vi.mock("../../../infrastructure/backend", () => ({ backend }));
vi.mock("../../../app/context-menu/useContentMenu", () => ({
  useContentMenu: () => () => ({}),
}));
vi.mock("../../../app/docking/chrome", async () => ({
  PageRefreshSlotContext: (await import("react")).createContext(null),
}));
let host: HTMLDivElement, root: Root;
const runtime = { mode: "mock", p4Version: "mock", context: {} } as RuntimeInfo;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  // jsdom has no layout: supply a visible viewport, retain the real virtualizer.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(240);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollTo = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(content: string) {
  backend.getFilePreview.mockResolvedValue({
    kind: "text",
    content,
    encoding: "UTF-8",
    size: content.length,
  });
  await act(async () =>
    root.render(
      <FilePreviewPage
        target="synthetic.json"
        locked={false}
        onTargetChange={() => {}}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  expect(host.textContent).toContain("Reading");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
}
it.each([
  ['{"enabled":true}', 1],
  [
    '{\n  "name": "fixture",\n  "enabled": true,\n  "items": [\n    1,\n    2\n  ],\n  "label": "中文 🚀"\n}',
    9,
  ],
  ['{\r\n  "label": "中文 🚀"\r\n}', 3],
  ["{ invalid JSON :", 1],
])(
  "renders raw JSON text after asynchronous loading: %s",
  async (content, count) => {
    await render(content);
    expect(host.querySelectorAll(".preview-line")).toHaveLength(count);
    expect(host.querySelector("code")?.textContent).toBe(
      content.split(/\r?\n/)[0],
    );
    expect(host.textContent).toContain(`${count} lines`);
  },
);
it("keeps long single-line JSON bounded and explicitly marks truncation", async () => {
  await render(JSON.stringify({ value: "a".repeat(10000) }));
  expect(host.querySelector("code")?.textContent).toHaveLength(4024);
  expect(host.textContent).toContain("long line truncated");
});
it("distinguishes an empty file from an invisible text viewport", async () => {
  await render("");
  expect(host.textContent).toContain("File is empty");
});
it("shows a read failure instead of a blank body", async () => {
  backend.getFilePreview.mockRejectedValue(new Error("synthetic read failure"));
  await act(async () =>
    root.render(
      <FilePreviewPage
        target="error.json"
        locked={false}
        onTargetChange={() => {}}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "synthetic read failure",
  );
});

function tablePreview(patch: Partial<FilePreviewTable> = {}): FilePreview {
  return {
    kind: "table",
    content: "",
    size: 2048,
    encoding: "UTF-8",
    table: {
      format: "csv",
      delimiter: ",",
      sheetName: null,
      sheetIndex: null,
      sheetNames: null,
      rows: [
        ["名称", "数量", "备注"],
        ["甲", "1", "第一条"],
        ["乙", "2", ""],
      ],
      rowCount: null,
      rowCountSource: null,
      hasMore: false,
      truncated: false,
      truncatedReason: null,
      ...patch,
    },
  };
}

async function renderPreview(preview: FilePreview, target = "synthetic.csv") {
  backend.getFilePreview.mockResolvedValue(preview);
  await act(async () =>
    root.render(
      <FilePreviewPage
        target={target}
        locked={false}
        onTargetChange={() => {}}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  expect(host.textContent).toContain("Reading");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
}

async function clickButton(label: string) {
  const button = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const stepValue = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

it("renders a table page with format, stats, encoding and adaptive size", async () => {
  await renderPreview(tablePreview());
  expect(host.querySelector("table.preview-table")).not.toBeNull();
  expect(
    host.querySelector("thead th.preview-table-head")?.textContent,
  ).toContain("A");
  expect(
    host.querySelector("thead th.preview-table-head")?.textContent,
  ).toContain("名称");
  expect(host.textContent).toContain("CSV");
  expect(host.textContent).toContain("3 cols × 2 rows");
  expect(host.textContent).toContain("Encoding UTF-8");
  expect(host.textContent).toContain("Delimiter ,");
  expect(host.textContent).toContain("2.0 KiB");
});

it("formats large table sizes in MiB instead of huge KiB values", async () => {
  await renderPreview(
    {
      ...tablePreview({ format: "xlsx", delimiter: null }),
      size: 110_179_268,
    },
    "synthetic.xlsx",
  );
  expect(host.textContent).toContain("XLSX");
  expect(host.textContent).toContain("105.1 MiB");
  expect(host.textContent).not.toContain("107597");
});

it("explains row truncation from the backend truncation reason", async () => {
  await renderPreview(
    tablePreview({
      format: "xlsx",
      delimiter: null,
      rowCount: 150_000,
      rowCountSource: "dimension",
      hasMore: true,
      truncated: true,
      truncatedReason: "rowCap",
    }),
    "synthetic.xlsx",
  );
  expect(host.querySelector('[role="note"]')?.textContent).toContain(
    "Showing the first 500 rows of about 150,000",
  );
});

it("explains column truncation when the total column count is known", async () => {
  await renderPreview(
    tablePreview({
      truncated: true,
      truncatedReason: "colCap",
      totalColumns: 100,
    }),
  );
  expect(host.querySelector('[role="note"]')?.textContent).toContain(
    "Showing the first 64 columns of about 100",
  );
});

it("switches worksheets by sending the sheet index as the second argument", async () => {
  const sheets = ["Summary", "明细", "空表"];
  const first = tablePreview({
    format: "xlsx",
    delimiter: null,
    sheetName: "Summary",
    sheetIndex: 0,
    sheetNames: sheets,
    rowCount: 150_000,
    rowCountSource: "dimension",
    hasMore: true,
    truncated: true,
    truncatedReason: "rowCap",
  });
  const second = tablePreview({
    format: "xlsx",
    delimiter: null,
    sheetName: "明细",
    sheetIndex: 1,
    sheetNames: sheets,
    rows: [
      ["编号", "名称"],
      ["1", "条目一"],
    ],
  });
  backend.getFilePreview.mockImplementation(async (_path, options) =>
    options?.sheetIndex === 1 ? second : first,
  );
  await act(async () =>
    root.render(
      <FilePreviewPage
        target="synthetic.xlsx"
        locked={false}
        onTargetChange={() => {}}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
  expect(backend.getFilePreview).toHaveBeenCalledTimes(1);
  expect(backend.getFilePreview).toHaveBeenNthCalledWith(
    1,
    "synthetic.xlsx",
    undefined,
  );
  const select = host.querySelector<HTMLSelectElement>("select")!;
  expect(select.options).toHaveLength(3);
  await clickButton("More frozen header rows");
  expect(host.textContent).toContain("Frozen header rows: 2");
  await act(async () => {
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
  expect(backend.getFilePreview).toHaveBeenCalledTimes(2);
  expect(backend.getFilePreview).toHaveBeenLastCalledWith("synthetic.xlsx", {
    sheetIndex: 1,
  });
  expect(host.textContent).toContain("条目一");
  expect(host.querySelector<HTMLSelectElement>("select")?.value).toBe("1");
  // Switching worksheets restores the default single frozen header row.
  expect(host.textContent).toContain("Frozen header rows: 1");
});

it("never sends a previous target's worksheet index to a new target", async () => {
  const sheets = ["S0", "S1", "S2"];
  backend.getFilePreview.mockResolvedValue(
    tablePreview({
      format: "xlsx",
      delimiter: null,
      sheetName: "S0",
      sheetIndex: 0,
      sheetNames: sheets,
    }),
  );
  await act(async () =>
    root.render(
      <FilePreviewPage
        target="first.xlsx"
        locked={false}
        onTargetChange={() => {}}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
  const select = host.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    select.value = "2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
  expect(backend.getFilePreview).toHaveBeenLastCalledWith("first.xlsx", {
    sheetIndex: 2,
  });
  await act(async () =>
    root.render(
      <FilePreviewPage
        target="second.xlsx"
        locked={false}
        onTargetChange={() => {}}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
  expect(backend.getFilePreview).toHaveBeenLastCalledWith(
    "second.xlsx",
    undefined,
  );
});

it("hides the worksheet picker when the workbook has a single sheet", async () => {
  await renderPreview(
    tablePreview({
      format: "xlsx",
      delimiter: null,
      sheetName: "Sheet1",
      sheetIndex: 0,
      sheetNames: ["Sheet1"],
    }),
    "synthetic.xlsx",
  );
  expect(host.querySelector("select")).toBeNull();
});

it("steps the frozen header rows without re-reading the file", async () => {
  await renderPreview(tablePreview());
  expect(host.textContent).toContain("Frozen header rows: 1");
  expect(
    host.querySelectorAll("tbody .preview-table-gutter")[0]?.textContent,
  ).toBe("2");
  const calls = backend.getFilePreview.mock.calls.length;
  await clickButton("More frozen header rows");
  expect(host.textContent).toContain("Frozen header rows: 2");
  expect(host.querySelectorAll("thead tr")).toHaveLength(2);
  expect(
    host.querySelectorAll("tbody .preview-table-gutter")[0]?.textContent,
  ).toBe("3");
  await clickButton("Fewer frozen header rows");
  await clickButton("Fewer frozen header rows");
  expect(host.textContent).toContain("Frozen header rows: 0");
  expect(host.querySelectorAll("thead tr")).toHaveLength(1);
  expect(
    host.querySelectorAll("tbody .preview-table-gutter")[0]?.textContent,
  ).toBe("1");
  expect(stepValue("Fewer frozen header rows")?.disabled).toBe(true);
  expect(backend.getFilePreview).toHaveBeenCalledTimes(calls);
});

it("disables the frozen-row stepper at both bounds", async () => {
  await renderPreview(tablePreview());
  // The fixture returns a header plus two data rows, so at most three rows freeze.
  await clickButton("More frozen header rows");
  await clickButton("More frozen header rows");
  expect(host.textContent).toContain("Frozen header rows: 3");
  expect(stepValue("More frozen header rows")?.disabled).toBe(true);
  expect(host.textContent).toContain("No data rows");
  await clickButton("Fewer frozen header rows");
  expect(host.textContent).toContain("Frozen header rows: 2");
  expect(stepValue("More frozen header rows")?.disabled).toBe(false);
  await clickButton("Fewer frozen header rows");
  await clickButton("Fewer frozen header rows");
  expect(host.textContent).toContain("Frozen header rows: 0");
  expect(stepValue("Fewer frozen header rows")?.disabled).toBe(true);
});

it("resets the frozen header rows when the target changes", async () => {
  backend.getFilePreview.mockResolvedValue(
    tablePreview({
      rows: [
        ["名称", "数量"],
        ["甲", "1"],
        ["乙", "2"],
      ],
    }),
  );
  await act(async () =>
    root.render(
      <FilePreviewPage
        target="first.csv"
        locked={false}
        onTargetChange={() => {}}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
  await clickButton("More frozen header rows");
  expect(host.textContent).toContain("Frozen header rows: 2");
  await act(async () =>
    root.render(
      <FilePreviewPage
        target="second.csv"
        locked={false}
        onTargetChange={() => {}}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
  expect(host.textContent).toContain("Frozen header rows: 1");
});

it("shows an empty worksheet state for a table without rows", async () => {
  await renderPreview(tablePreview({ rows: [] }));
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    "This worksheet is empty",
  );
});

it("reports a malformed table payload instead of leaving the body blank", async () => {
  await renderPreview({ kind: "table", content: "", size: 10 });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Table data is incomplete",
  );
});

it("reports an unknown preview kind instead of leaving the body blank", async () => {
  await renderPreview({
    kind: "video",
    content: "",
    size: 10,
  } as unknown as FilePreview);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "cannot display this preview type",
  );
});
