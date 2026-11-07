// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  components,
  Actions,
  CloseAllContext,
  LanguageContext,
  OpenContext,
  FixedPageHeader,
  PageHeaderActionsContext,
} from "./chrome";
import { isMultiPage, pageIds, pageLabels } from "../panels";
import { setLocale } from "../../shared/i18n";

// Test only the shared chrome: never mount a page, mapping query or backend.
vi.mock("./DiffPathInput", () => ({
  DiffPathInput: ({ children }: { children: ReactNode }) => (
    <div className="diff-path-field">
      <input />
      {children}
    </div>
  ),
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  // Components translate through the module-level locale.
  setLocale("zh-CN");
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it.each(pageIds.filter(isMultiPage))(
  "%s uses icon actions with localized state-aware tooltips",
  async (kind) => {
    const Page = components.page;
    const open = vi.fn();
    const updateParameters = vi.fn();
    for (const zh of [true, false]) {
      for (const locked of [true, false]) {
        const props = {
          api: {
            id: `${kind}--test`,
            isVisible: false,
            updateParameters,
            onDidVisibilityChange: () => ({ dispose() {} }),
          },
          params: { target: "fixture-target", locked },
        } as unknown as ComponentProps<typeof Page>;
        await act(async () =>
          root.render(
            <LanguageContext.Provider value={zh}>
              <OpenContext.Provider value={open}>
                <Page {...props} />
              </OpenContext.Provider>
            </LanguageContext.Provider>,
          ),
        );
        expect(host.querySelector(".target-page-title")?.textContent).toBe(
          pageLabels(zh)[kind],
        );
        const buttons = host.querySelectorAll<HTMLButtonElement>(
          ".target-icon-button",
        );
        expect(buttons).toHaveLength(2);
        const [lock, newTab] = buttons;
        const label = locked
          ? zh
            ? "目标已锁定；点击恢复跟随文件选择"
            : "Target locked; click to follow file selection"
          : zh
            ? "正在跟随文件选择；点击锁定当前目标"
            : "Following file selection; click to lock current target";
        expect(lock.title).toBe(label);
        expect(lock.getAttribute("aria-label")).toBe(label);
        expect(lock.getAttribute("aria-pressed")).toBe(String(locked));
        expect(newTab.title).toBe(zh ? "新页签" : "New tab");
        for (const button of buttons) {
          expect(button.textContent).toBe("");
          expect(button.getAttribute("aria-label")).toBe(button.title);
          expect(
            button.querySelector('svg[aria-hidden="true"]'),
          ).not.toBeNull();
          button.focus();
          expect(document.activeElement).toBe(button);
        }
        expect(host.querySelectorAll(".target-refresh-slot")).toHaveLength(1);
        expect(
          host.querySelector(".target-refresh-slot")?.parentElement?.className,
        ).toBe(kind === "shelf" ? "target-control-value" : "diff-path-field");
        await act(async () => {
          lock.click();
          newTab.click();
        });
        expect(updateParameters).toHaveBeenLastCalledWith({
          target: "fixture-target",
          locked: !locked,
        });
        expect(open).toHaveBeenLastCalledWith(kind, "fixture-target", true);
      }
    }
  },
);

it.each(pageIds.filter((kind) => !isMultiPage(kind)))(
  "%s uses the fixed compact title without multi-instance actions",
  async (kind) => {
    const Page = components.page;
    const props = {
      api: {
        id: kind,
        isVisible: false,
        onDidVisibilityChange: () => ({ dispose() {} }),
      },
      params: { target: "", locked: false },
    } as unknown as ComponentProps<typeof Page>;
    for (const zh of [true, false]) {
      await act(async () =>
        root.render(
          <LanguageContext.Provider value={zh}>
            <Page {...props} />
          </LanguageContext.Provider>,
        ),
      );
      expect(host.querySelectorAll(".page-title-controls h1")).toHaveLength(1);
      expect(host.querySelector("h1")?.textContent).toBe(pageLabels(zh)[kind]);
      expect(
        host.querySelector(
          ".target-icon-button, .diff-path-field, .target-refresh-slot",
        ),
      ).toBeNull();
    }
  },
);

it("portals fixed page tools and keeps descriptions keyboard accessible", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const click = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PageHeaderActionsContext.Provider value={target}>
          <FixedPageHeader description="Saved connections require verification">
            <button onClick={click}>Refresh</button>
          </FixedPageHeader>
        </PageHeaderActionsContext.Provider>,
      ),
    );
    expect(host.textContent).toBe("");
    expect(target.querySelector("summary")?.getAttribute("aria-label")).toBe(
      "Saved connections require verification",
    );
    expect(target.querySelector("details p")?.textContent).toBe(
      "Saved connections require verification",
    );
    await act(async () => target.querySelector("button")!.click());
    expect(click).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.render(null));
    target.remove();
  }
});

it("keeps Close all last in the tab actions and preserves its disabled state", async () => {
  const run = vi.fn();
  const props = { group: { panels: [] } } as unknown as ComponentProps<
    typeof Actions
  >;
  const render = async (enabled: boolean) =>
    act(async () =>
      root.render(
        <LanguageContext.Provider value={true}>
          <CloseAllContext.Provider value={{ run, enabled }}>
            <Actions {...props} />
          </CloseAllContext.Provider>
        </LanguageContext.Provider>,
      ),
    );
  await render(false);
  const button = host.querySelector<HTMLButtonElement>(
    '[aria-label="关闭所有页签"]',
  )!;
  expect(button.disabled).toBe(true);
  expect(button).toBe(host.querySelector(".dock-actions")!.lastElementChild);
  await render(true);
  await act(async () => button.click());
  expect(run).toHaveBeenCalledTimes(1);
});
