import { expect, it } from "vitest";
import { tableMenuBindings } from "./TableHeader";
import { buildMenu } from "./model";

it("expands actual columns with stable IDs instead of a placeholder", () => {
  const columns = [
    { id: "name", label: "File" },
    { id: "revision", label: "Revision" },
  ];
  const items = buildMenu("T08", tableMenuBindings(columns, columns[1]));
  const display = items.find((item) => item.children)!;
  expect(display.label).toBe("显示列");
  expect(display.children?.map((item) => item.id)).toEqual([
    "T08:column:name",
    "T08:column:revision",
  ]);
  expect(
    display.children?.every((item) => item.checked && item.reason && !item.run),
  ).toBe(true);
  // Sorting and layout items are still unconnected, so they are not offered: the
  // menu lists the column inventory only.
  expect(items.map((item) => item.label)).toEqual(["显示列"]);
});
