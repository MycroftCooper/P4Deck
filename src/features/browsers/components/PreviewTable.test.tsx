// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreviewTable } from "./PreviewTable";
import type { FilePreviewTable } from "../../../shared/contracts";
import { setLocale } from "../../../shared/i18n";

const table = (patch: Partial<FilePreviewTable> = {}): FilePreviewTable => ({
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
});

function manyRows(count: number, columns = 3): string[][] {
  return [
    Array.from({ length: columns }, (_, index) => `Col ${index + 1}`),
    ...Array.from({ length: count }, (_, row) =>
      Array.from(
        { length: columns },
        (_, column) => `r${row + 1}c${column + 1}`,
      ),
    ),
  ];
}

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  // Components translate through the module-level locale.
  setLocale("zh-CN");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(
  value: FilePreviewTable,
  options: { headerRows?: number; zh?: boolean } = {},
) {
  await act(async () =>
    root.render(
      <PreviewTable
        table={value}
        zh={options.zh ?? false}
        headerRows={options.headerRows ?? 1}
      />,
    ),
  );
}

const gutterNumbers = () =>
  Array.from(host.querySelectorAll("tbody .preview-table-gutter")).map(
    (cell) => cell.textContent,
  );

it("renders header labels, column letters and physical row numbers", async () => {
  await render(table());
  expect(host.querySelectorAll("thead th")).toHaveLength(4);
  const heads = Array.from(host.querySelectorAll("thead th")).map(
    (cell) => cell.textContent,
  );
  expect(heads[0]).toBe("#");
  expect(heads[1]).toContain("A");
  expect(heads[1]).toContain("名称");
  expect(heads[2]).toContain("B");
  expect(heads[2]).toContain("数量");
  expect(gutterNumbers()).toEqual(["2", "3"]);
  expect(host.textContent).toContain("甲");
  expect(host.textContent).toContain("第一条");
});

it("only renders the virtual window instead of every row", async () => {
  await render(table({ rows: manyRows(200) }));
  const rendered = host.querySelectorAll("tbody tr.preview-table-row");
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.length).toBeLessThan(60);
  expect(gutterNumbers()[0]).toBe("2");
  const spacers = host.querySelectorAll(".preview-table-spacer td");
  expect(spacers.length).toBeGreaterThan(0);
  expect(parseFloat((spacers[0] as HTMLElement).style.height)).toBeGreaterThan(
    0,
  );
});

it("turns every row into data and keeps the grips when nothing is frozen", async () => {
  await render(table(), { headerRows: 0 });
  expect(host.querySelectorAll("thead tr")).toHaveLength(1);
  expect(host.querySelectorAll('thead [role="separator"]')).toHaveLength(4);
  const heads = Array.from(host.querySelectorAll("thead th")).map(
    (cell) => cell.textContent,
  );
  expect(heads[1]).toBe("A");
  expect(heads[1]).not.toContain("名称");
  expect(gutterNumbers()).toEqual(["1", "2", "3"]);
  expect(
    host.querySelector("tbody tr.preview-table-row")?.textContent,
  ).toContain("名称");
});

it("freezes multiple header rows with stacked sticky offsets", async () => {
  await render(
    table({
      rows: [
        ["季度", "Q1", "Q2"],
        ["货币", "CNY", "USD"],
        ["A", "1", "2"],
        ["B", "3", "4"],
      ],
    }),
    { headerRows: 2 },
  );
  const rows = host.querySelectorAll("thead tr");
  expect(rows).toHaveLength(2);
  const firstRow = rows[0].querySelectorAll<HTMLElement>("th");
  expect(firstRow[0].textContent).toBe("#");
  expect(firstRow[1].style.position).toBe("sticky");
  expect(firstRow[1].style.top).toBe("0px");
  expect(firstRow[1].textContent).toContain("A");
  expect(firstRow[1].textContent).toContain("季度");
  const secondRow = rows[1].querySelectorAll<HTMLElement>("th");
  expect(secondRow[0].textContent).toBe("");
  expect(secondRow[1].style.position).toBe("sticky");
  expect(secondRow[1].style.top).toBe("28px");
  expect(secondRow[1].textContent).toBe("货币");
  expect(secondRow[2].textContent).toBe("CNY");
  // Only the first header row carries the resize grips.
  expect(host.querySelectorAll('thead [role="separator"]')).toHaveLength(4);
  expect(gutterNumbers()).toEqual(["3", "4"]);
  expect(
    Array.from(host.querySelectorAll("tbody tr.preview-table-row")).map((row) =>
      row.getAttribute("aria-rowindex"),
    ),
  ).toEqual(["3", "4"]);
});

it("virtualises only the rows that remain after freezing", async () => {
  await render(table({ rows: manyRows(200) }), { headerRows: 2 });
  const rendered = host.querySelectorAll("tbody tr.preview-table-row");
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.length).toBeLessThan(60);
  expect(gutterNumbers()[0]).toBe("3");
});

it("exposes read-only table semantics without focusable cells", async () => {
  await render(table({ rows: manyRows(20), rowCount: 150_000 }));
  const tableElement = host.querySelector("table")!;
  expect(tableElement.getAttribute("aria-rowcount")).toBe("150000");
  expect(tableElement.getAttribute("aria-colcount")).toBe("3");
  // The corner cell is a column header too; three label columns follow it.
  expect(host.querySelectorAll("thead th[scope='col']")).toHaveLength(4);
  expect(host.querySelectorAll("thead th.preview-table-head")).toHaveLength(3);
  expect(host.querySelectorAll("tbody th[scope='row']").length).toBe(
    gutterNumbers().length,
  );
  const region = host.querySelector(".preview-table-scroll")!;
  expect(region.getAttribute("tabindex")).toBe("0");
  expect(region.getAttribute("role")).toBe("region");
  expect(region.getAttribute("aria-label")).toBe("Table preview");
  expect(host.querySelectorAll("td[tabindex]")).toHaveLength(0);
  expect(
    Array.from(host.querySelectorAll("tbody tr.preview-table-row")).map((row) =>
      row.getAttribute("aria-rowindex"),
    ),
  ).toEqual(gutterNumbers());
});

it("clips over-long cells defensively and keeps the full value in title", async () => {
  const long = "x".repeat(1200);
  await render(
    table({
      rows: [
        ["A", "B"],
        [long, "short"],
      ],
    }),
  );
  const cell = host.querySelector("tbody .preview-table-cell")!;
  expect(cell.textContent).toHaveLength(1000 + "…[cell truncated]".length);
  expect(cell.getAttribute("title")).toBe(long.slice(0, 2000));
  const shortCell = host.querySelectorAll("tbody .preview-table-cell")[1];
  expect(shortCell.getAttribute("title")).toBeNull();
});

it("shows an empty worksheet instead of an empty table", async () => {
  await render(table({ rows: [] }));
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    "This worksheet is empty",
  );
  expect(host.querySelector("table")).toBeNull();
});

it("shows a header-only page with an explicit empty body row", async () => {
  await render(table({ rows: [["名称", "数量"]] }));
  expect(host.querySelectorAll("thead th")).toHaveLength(3);
  expect(host.textContent).toContain("No data rows");
});

it("pads ragged rows to the widest row", async () => {
  await render(
    table({
      rows: [["A", "B", "C"], ["only-one"]],
    }),
  );
  const row = host.querySelector("tbody tr.preview-table-row")!;
  expect(row.querySelectorAll(".preview-table-cell")).toHaveLength(3);
});

it("localises empty-state and row numbers in Chinese", async () => {
  await render(table({ rows: [] }), { zh: true });
  expect(host.textContent).toBe("此工作表为空");
});

const columnWidths = () =>
  Array.from(host.querySelectorAll("col")).map((col) => col.style.width);

it("reuses the shared resizable table with one grip per header cell", async () => {
  await render(table());
  expect(
    host.querySelector('table[data-table-id="file-preview"]'),
  ).not.toBeNull();
  // Row-number gutter + three data columns.
  expect(host.querySelectorAll('thead [role="separator"]')).toHaveLength(4);
  expect(host.querySelectorAll("thead th")).toHaveLength(4);
  expect(host.querySelectorAll("col")).toHaveLength(4);
  // Sticky header cells: the CSS `top`/`z-index` stay effective.
  for (const cell of host.querySelectorAll<HTMLElement>("thead th"))
    expect(cell.style.position).toBe("sticky");
  expect(columnWidths()).toEqual(["56px", "96px", "96px", "96px"]);
});

it("resizes a column with the keyboard and resets it on double click", async () => {
  await render(table());
  const grip = host.querySelectorAll<HTMLElement>(
    'thead [role="separator"]',
  )[1];
  await act(async () => {
    grip.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
      }),
    );
  });
  expect(columnWidths()[1]).toBe("106px");
  expect(grip.getAttribute("aria-valuenow")).toBe("106");
  await act(async () => {
    grip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(columnWidths()).toEqual(["56px", "96px", "96px", "96px"]);
});

it("keeps dragged widths when the same page re-renders", async () => {
  await render(table());
  const grip = host.querySelectorAll<HTMLElement>(
    'thead [role="separator"]',
  )[1];
  await act(async () => {
    grip.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  await render(table());
  expect(columnWidths()[1]).toBe("106px");
});

it("re-initialises widths when the worksheet column count changes", async () => {
  await render(table());
  const grip = host.querySelectorAll<HTMLElement>(
    'thead [role="separator"]',
  )[1];
  await act(async () => {
    grip.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  expect(columnWidths()[1]).toBe("106px");
  await render(
    table({
      sheetIndex: 1,
      rows: [
        ["A", "B"],
        ["1", "2"],
      ],
    }),
  );
  expect(host.querySelectorAll("col")).toHaveLength(3);
  expect(columnWidths()).toEqual(["56px", "96px", "96px"]);
});
