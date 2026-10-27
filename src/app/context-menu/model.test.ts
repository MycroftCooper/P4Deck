import spec from "../../../ForAIDoc/Designer/右键菜单对象与菜单项总表.md?raw";
import { expect, it } from "vitest";
import { menuLabel } from "./labels";
import { menuCatalog, type MenuObjectId } from "./catalog";
import { buildMenu, clampMenu, type MenuItem } from "./model";

const leaves = (items: MenuItem[]): MenuItem[] =>
  items.flatMap((item) => (item.children ? leaves(item.children) : [item]));

const documented = spec
  .split("\n")
  .filter((line) => /^\| [FHCVSW TU]\d{2} \|/.test(line));

it("registers every object and every leaf from the product inventory in order", () => {
  expect(documented).toHaveLength(Object.keys(menuCatalog).length);
  for (const line of documented) {
    const cells = line.split("|").map((value) => value.trim());
    const object = cells[1] as MenuObjectId;
    const labels = [...cells[3].split("；"), ...cells[4].split("；")]
      .map((v) => v.trim())
      .filter((v) => /^[☐☑]/u.test(v))
      .map((v) => v.replace(/^[☐☑]\s*/u, ""));
    expect(
      menuCatalog[object].items.map((item) => item.label),
      object,
    ).toEqual(labels);
    expect(menuCatalog[object].items.map((item) => item.id)).toEqual(
      labels.map((_, i) => `${object}-${String(i + 1).padStart(2, "0")}`),
    );
  }
});

for (const object of Object.keys(menuCatalog) as MenuObjectId[]) {
  it(`${object}: exposes all planned leaves with explicit unavailable reasons until bound`, () => {
    const items = leaves(buildMenu(object));
    expect(items.map((item) => item.id).sort()).toEqual(
      menuCatalog[object].items.map((item) => item.id).sort(),
    );
    for (const item of items) {
      expect(item.reason, item.id).toBeTruthy();
      expect(item.run, item.id).toBeUndefined();
    }
  });
}

it("shares a single copy submenu and groups pending workflows without dropping IDs", () => {
  const items = buildMenu("F01");
  expect(items.find((item) => item.label === "复制")?.children).toHaveLength(4);
  expect(
    items.find((item) => item.label === "更多操作（待接入）")?.children?.length,
  ).toBeGreaterThan(10);
});
it("preserves explicitly bound callbacks and unavailable reasons", () => {
  let path = "a";
  const snapshot = path;
  const selected: string[] = [];
  const items = leaves(
    buildMenu("F01", {
      文件预览: {
        run: () => {
          selected.push(snapshot);
        },
      },
      "签出…": {
        run: () => {
          selected.push("bad");
        },
        reason: "不允许",
      },
    }),
  );
  path = "b";
  items[0].run!();
  expect(selected).toEqual(["a"]);
  expect(path).toBe("b");
  expect(items.find((item) => item.label === "签出…")?.reason).toBe("不允许");
});
it("can exclude already-open singleton tabs without hiding other items", () => {
  const items = leaves(
    buildMenu("T03", { "打开全局页签 › 设置": { hidden: true } }),
  );
  expect(items.some((item) => item.id === "T03-07")).toBe(false);
  expect(items).toHaveLength(8);
});
it("clamps menus to all viewport edges including narrow windows", () => {
  expect(clampMenu(900, 600, 320, 400, 1000, 700)).toEqual({
    left: 676,
    top: 296,
  });
  expect(clampMenu(-20, -10, 300, 100, 280, 200)).toEqual({ left: 4, top: 4 });
});
it("translates every menu label in the inventory without Chinese fallback", () => {
  for (const group of Object.values(menuCatalog))
    for (const item of group.items)
      expect(menuLabel(item.label, false), item.label).not.toMatch(
        /[\u3400-\u9fff]/,
      );
});
