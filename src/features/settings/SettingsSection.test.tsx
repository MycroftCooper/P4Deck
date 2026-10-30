// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsSection } from "./SettingsSection";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
function section(expanded: boolean, onToggle = vi.fn()) {
  root.render(
    <SettingsSection
      id="backup"
      title="本地配置备份"
      expanded={expanded}
      onToggle={onToggle}
      zh
      icon={<span data-testid="icon" />}
    >
      <p>body content</p>
    </SettingsSection>,
  );
  return onToggle;
}
it("renders a titled, collapsible section with accessible controls", async () => {
  let toggle = vi.fn();
  await act(async () => {
    toggle = section(true);
  });
  const button = host.querySelector<HTMLButtonElement>(
    ".settings-section-toggle",
  )!;
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(button.getAttribute("aria-controls")).toBe(
    "settings-section-backup-body",
  );
  expect(button.getAttribute("aria-label")).toBe("折叠本地配置备份");
  expect(host.querySelector("h2")?.textContent).toContain("本地配置备份");
  expect(
    host.querySelector<HTMLElement>("#settings-section-backup-body")!.hidden,
  ).toBe(false);
  button.click();
  expect(toggle).toHaveBeenCalledOnce();
});
it("hides the body when collapsed and labels the control for expansion", async () => {
  await act(async () => section(false));
  const button = host.querySelector<HTMLButtonElement>(
    ".settings-section-toggle",
  )!;
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(button.getAttribute("aria-label")).toBe("展开本地配置备份");
  expect(
    host.querySelector<HTMLElement>("#settings-section-backup-body")!.hidden,
  ).toBe(true);
  expect(
    host
      .querySelector('[data-settings-section="backup"]')
      ?.getAttribute("data-expanded"),
  ).toBe("false");
});
it("supports the wide layout class and English labels", async () => {
  await act(async () =>
    root.render(
      <SettingsSection
        id="connection"
        title="Saved connections"
        expanded={false}
        onToggle={vi.fn()}
        zh={false}
        wide
      >
        <div />
      </SettingsSection>,
    ),
  );
  expect(
    host
      .querySelector(".settings-section")
      ?.classList.contains("settings-section--wide"),
  ).toBe(true);
  expect(
    host.querySelector(".settings-section-toggle")?.getAttribute("aria-label"),
  ).toBe("Expand Saved connections");
});
