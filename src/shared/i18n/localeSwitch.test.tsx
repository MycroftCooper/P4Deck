/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { changeLocale, setLocale } from "../../shared/i18n";
import { useIsZh } from "../../shared/i18n";
import { getLocale } from "../../shared/i18n/t";

/**
 * Language switching is the behaviour users actually exercise, and it was the
 * one path with no coverage: every other test pre-sets the locale with
 * setLocale(), which never notifies subscribers.
 *
 * These tests render first, then switch, and assert the UI follows.
 */

function LocaleProbe() {
  // The pattern every page container used to get wrong: read the locale during
  // render so the store notifies this component of a change.
  const zh = useIsZh();
  return createElement("span", null, zh ? "中文界面" : "English UI");
}

afterEach(() => {
  setLocale("zh-CN");
});

it("re-renders when the locale changes after mount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(createElement(LocaleProbe));
  });
  expect(host.textContent).toBe("中文界面");

  await act(async () => {
    changeLocale("en-US");
  });
  expect(getLocale()).toBe("en-US");
  // The regression: before the fix this still read "中文界面".
  expect(host.textContent).toBe("English UI");

  await act(async () => {
    changeLocale("zh-CN");
  });
  expect(host.textContent).toBe("中文界面");

  await act(async () => root.unmount());
  host.remove();
});

it("keeps module-level t() in step with the switched locale", async () => {
  // t() has no subscription by design, but it must read the current locale the
  // moment it is called, otherwise a re-render renders stale copy.
  setLocale("zh-CN");
  const { t } = await import("../../shared/i18n");
  const chinese = t("common.refresh");
  changeLocale("en-US");
  const english = t("common.refresh");
  expect(english).not.toBe(chinese);
});
