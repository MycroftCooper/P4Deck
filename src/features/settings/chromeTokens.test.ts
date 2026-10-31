import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** True when the given selector block declares the expected declaration. */
const blockHas = (css: string, selector: string, declaration: string) =>
  new RegExp(
    `${escape(selector)}\\s*\\{(?:(?!\\}).)*${escape(declaration)}`,
    "s",
  ).test(css);

it("keeps the default theme look through panel aliases", () => {
  const tokens = read("src/app/styles/tokens.css");
  expect(tokens).toMatch(/--chrome:\s*var\(--panel-2\);/);
  expect(tokens).toMatch(/--chrome-2:\s*var\(--panel-3\);/);
  expect(tokens).toMatch(/--chrome-command:\s*var\(--panel\);/);
});

it("applies chrome variables to topbar, sidebar, statusbar, activity bar and command bar", () => {
  const workbench = read("src/app/styles/workbench.css");
  expect(blockHas(workbench, ".topbar", "background: var(--chrome);")).toBe(
    true,
  );
  expect(
    blockHas(workbench, ".resource-explorer", "background: var(--chrome);"),
  ).toBe(true);
  expect(blockHas(workbench, ".statusbar", "background: var(--chrome);")).toBe(
    true,
  );

  const activity = read("src/app/styles/activity.css");
  expect(
    blockHas(activity, ".activity-bar", "background: var(--chrome);"),
  ).toBe(true);

  const commands = read("src/app/styles/commands.css");
  expect(
    blockHas(commands, ".command-center", "background: var(--chrome-command);"),
  ).toBe(true);
});

it("layers the dockview tab strip on chrome and chrome-2", () => {
  const docking = read("src/app/styles/docking.css");
  expect(docking).toMatch(
    /--dv-tabs-and-actions-container-background-color:\s*var\(--chrome\);/,
  );
  expect(docking).toMatch(
    /--dv-inactivegroup-visiblepanel-tab-background-color:\s*var\(--chrome-2\);/,
  );
  expect(docking).toMatch(
    /--dv-activegroup-hiddenpanel-tab-background-color:\s*var\(--chrome\);/,
  );
  // Both the light-specific and the generic dockview theme blocks apply it.
  expect(
    docking.match(
      /--dv-tabs-and-actions-container-background-color:\s*var\(--chrome\);/g,
    ),
  ).toHaveLength(2);
});
