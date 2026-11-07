// @vitest-environment jsdom
import { expect, it, beforeEach } from "vitest";
import { dialogHarness } from "../../../app/dialogs/testHarness";
import { FileStatusIcon } from "./FileStatusIcon";
import { setLocale } from "../../../shared/i18n";

const view = dialogHarness();
// The UI translates through the module-level locale.
beforeEach(() => {
  setLocale("en-US");
});

it("limits visible badges while preserving every status in accessible text", async () => {
  await view.render(
    <FileStatusIcon
      facts={{
        state: "conflicted",
        action: "edit",
        revision: 1,
        headRevision: 2,
        badges: [{ id: "locked", owner: "other", detail: "alice" }],
      }}
    />,
  );
  const icon = document.querySelector('[role="img"]')!;
  expect(icon.querySelectorAll(".file-badge")).toHaveLength(3);
  expect(icon.textContent).toContain("+2");
  expect(icon.getAttribute("aria-label")).toContain("alice");
  expect(icon.getAttribute("aria-label")).toContain("已签出编辑");
  expect(icon.getAttribute("aria-label")).toContain("版本落后");
  expect(icon.getAttribute("title")).toBe(icon.getAttribute("aria-label"));
});
it("localizes self and other actions without creating row tab stops", async () => {
  await view.render(
    <FileStatusIcon
      zh={false}
      facts={{ state: "openedAdd", badges: [{ id: "edit", owner: "other" }] }}
    />,
  );
  const icon = document.querySelector('[role="img"]')!;
  expect(icon.getAttribute("aria-label")).toContain("You: Open for add");
  expect(icon.getAttribute("aria-label")).toContain(
    "Other workspace/user: Open for edit",
  );
  expect(icon.hasAttribute("tabindex")).toBe(false);
});
