// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPanelScroll,
  rememberedScroll,
  rememberPanelScroll,
  rememberScrollElement,
  restorePanelScroll,
} from "./scrollMemory";

function scrollable(className: string, height = 120): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
  node.style.overflow = "auto";
  node.style.height = `${height}px`;
  return node;
}

function page() {
  const root = document.createElement("div");
  root.className = "dock-page";
  document.body.append(root);
  return root;
}

beforeEach(() => {
  document.body.replaceChildren();
  // Module-level memory outlives a test; start each case clean.
  clearPanelScroll("panel-a");
  clearPanelScroll("panel-b");
});

describe("docked page scroll memory", () => {
  it("restores the offset of an inner scroll container after a detach", () => {
    const root = page();
    const wrapper = document.createElement("section");
    const list = scrollable("virtual-scroll");
    wrapper.append(list);
    root.append(wrapper);
    list.scrollTop = 240;

    rememberScrollElement("panel-a", root, list);
    expect(rememberedScroll("panel-a")).toEqual([{ top: 240, left: 0 }]);

    // Dockview detaching the page resets the DOM offset.
    list.scrollTop = 0;
    expect(restorePanelScroll("panel-a", root)).toBe(true);
    expect(list.scrollTop).toBe(240);
  });

  it("keeps separate memory per panel id", () => {
    const first = page();
    const second = page();
    const listA = scrollable("a");
    const listB = scrollable("b");
    first.append(listA);
    second.append(listB);
    listA.scrollTop = 30;
    listB.scrollTop = 90;
    rememberScrollElement("panel-a", first, listA);
    rememberScrollElement("panel-b", second, listB);

    listA.scrollTop = 0;
    listB.scrollTop = 0;
    expect(restorePanelScroll("panel-a", first)).toBe(true);
    expect(restorePanelScroll("panel-b", second)).toBe(true);
    expect(listA.scrollTop).toBe(30);
    expect(listB.scrollTop).toBe(90);
  });

  it("drops an entry when the user scrolls back to the top", () => {
    const root = page();
    const list = scrollable("list");
    root.append(list);
    list.scrollTop = 120;
    rememberScrollElement("panel-a", root, list);
    expect(rememberedScroll("panel-a")).toHaveLength(1);

    list.scrollTop = 0;
    rememberScrollElement("panel-a", root, list);
    expect(rememberedScroll("panel-a")).toEqual([]);
    expect(restorePanelScroll("panel-a", root)).toBe(true);
    expect(list.scrollTop).toBe(0);
  });

  it("replays a scroll event so virtualized lists re-read the offset", () => {
    const root = page();
    const list = scrollable("virtual-scroll");
    root.append(list);
    list.scrollTop = 50;
    rememberScrollElement("panel-a", root, list);

    const onScroll = vi.fn();
    list.addEventListener("scroll", onScroll);
    list.scrollTop = 0;
    restorePanelScroll("panel-a", root);
    expect(onScroll).toHaveBeenCalled();
  });

  it("retries when the first assignment is clamped, then settles", () => {
    const root = page();
    const list = scrollable("virtual-scroll");
    root.append(list);
    list.scrollTop = 400;
    rememberScrollElement("panel-a", root, list);

    // Simulate a virtual list whose spacer has not grown yet: writes are
    // ignored (clamped to 0) until the list accepts the full offset.
    let allow = false;
    let stored = 0;
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => stored,
      set: (value: number) => {
        if (allow) stored = value;
      },
    });
    expect(restorePanelScroll("panel-a", root)).toBe(false);
    allow = true;
    expect(restorePanelScroll("panel-a", root)).toBe(true);
    expect(list.scrollTop).toBe(400);
  });

  it("keeps the entry while the page content is still mounting", () => {
    const root = page();
    const list = scrollable("virtual-scroll");
    root.append(list);
    list.scrollTop = 210;
    rememberScrollElement("panel-a", root, list);
    // The page content unmounts/detaches on tab switch: retry instead of
    // forgetting the offset.
    list.remove();
    expect(restorePanelScroll("panel-a", root)).toBe(false);
    expect(rememberedScroll("panel-a")).toEqual([{ top: 210, left: 0 }]);
    root.append(list);
    expect(restorePanelScroll("panel-a", root)).toBe(true);
    expect(list.scrollTop).toBe(210);
  });

  it("forgets a panel when its tab closes", () => {
    const root = page();
    const list = scrollable("list");
    root.append(list);
    list.scrollTop = 10;
    rememberScrollElement("panel-a", root, list);
    clearPanelScroll("panel-a");
    expect(rememberedScroll("panel-a")).toEqual([]);
  });

  it("captures every scrolled descendant before an unmount", () => {
    const root = page();
    const outer = scrollable("outer", 200);
    const inner = scrollable("inner", 100);
    outer.append(inner);
    root.append(outer);
    outer.scrollTop = 60;
    inner.scrollLeft = 15;
    rememberPanelScroll("panel-a", root);
    expect(rememberedScroll("panel-a")).toEqual([
      { top: 60, left: 0 },
      { top: 0, left: 15 },
    ]);
  });
});
