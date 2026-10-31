// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DiffResult, RuntimeInfo } from "../../../shared/contracts";
import { ContextMenuProvider } from "../../../app/context-menu/ContextMenu";
import { DiffView } from "./DiffView";

const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  activeProfileId: "profile-a",
  contextGeneration: 7,
  context: {
    server: "fixture:1666",
    user: "tester",
    client: "workspace",
    cwd: "C:/workspace",
  },
  connection: {
    state: "connected",
    message: "ok",
    recovery: "none",
    server: "fixture:1666",
  },
};

function side(label: string) {
  return {
    reference: { kind: "head" as const },
    label,
    depotPath: "//depot/file.txt",
    exists: true,
    binary: false,
  };
}

const leftText = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
const rightText = "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n";

function result(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    path: "//depot/file.txt",
    left: side("left"),
    right: side("right"),
    unified:
      "--- left\n+++ right\n@@ -2,3 +2,3 @@\n two\n-three\n+THREE\n four\n@@ -9,2 +9,2 @@\n nine\n-ten\n+TEN\n",
    leftText,
    rightText,
    stats: { additions: 2, deletions: 2, hunks: 2 },
    binary: false,
    unsupported: false,
    identical: false,
    truncated: false,
    partial: false,
    operationIds: [],
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;

async function render(diff: DiffResult = result()) {
  await act(async () => {
    root.render(
      <ContextMenuProvider scope="test" zh={false}>
        <DiffView
          diff={diff}
          path="//depot/file.txt"
          loading={false}
          error=""
          left={{ kind: "head" }}
          right={{ kind: "workspace" }}
          onLeftChange={() => undefined}
          onRightChange={() => undefined}
          onRefresh={() => undefined}
          runtime={runtime}
          zh={false}
        />
      </ContextMenuProvider>,
    );
    await Promise.resolve();
  });
}

function container() {
  return host.querySelector<HTMLElement>("diffs-container");
}

function shadowText() {
  return container()?.shadowRoot?.textContent ?? "";
}

async function waitFor(assertion: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (assertion()) return true;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  return false;
}

function hunkCount() {
  return host.querySelector(".diff-hunk-count")?.textContent?.trim();
}

async function click(selector: string) {
  const element = host.querySelector<HTMLElement>(selector);
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

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

it("renders both sides with the library and switches split/unified", async () => {
  await render();
  expect(await waitFor(() => shadowText().includes("THREE"))).toBe(true);
  const shadow = container()!.shadowRoot!;
  expect(shadow.querySelector("code[data-deletions]")?.textContent).toContain(
    "three",
  );
  expect(shadow.querySelector("code[data-additions]")?.textContent).toContain(
    "THREE",
  );
  expect(shadow.querySelector('pre[data-diff-type="split"]')).toBeTruthy();
  await click('button[aria-label="Unified view"]');
  expect(
    await waitFor(
      () => shadow.querySelector('pre[data-diff-type="single"]') !== null,
    ),
  ).toBe(true);
  expect(
    host
      .querySelector('button[aria-label="Unified view"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
});

it("counts hunks and steps through them from the toolbar", async () => {
  await render();
  expect(hunkCount()).toBe("0/2 hunks");
  await click('button[aria-label="Next hunk"]');
  expect(hunkCount()).toBe("1/2 hunks");
  await click('button[aria-label="Next hunk"]');
  expect(hunkCount()).toBe("2/2 hunks");
  await click('button[aria-label="Previous hunk"]');
  expect(hunkCount()).toBe("1/2 hunks");
});

it("searches both sides with a result count and next/previous navigation", async () => {
  await render();
  const input = host.querySelector<HTMLInputElement>(
    'input[aria-label="Find text"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "three");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelector(".diff-match-count")?.textContent).toBe("1/2");
  await click('button[aria-label="Next match"]');
  expect(host.querySelector(".diff-match-count")?.textContent).toBe("2/2");
  expect(
    container()?.shadowRoot?.querySelectorAll("mark[data-p4d-match]").length,
  ).toBeGreaterThan(0);
});

it("focuses the go-to-line input on Ctrl+G and reports out-of-range lines", async () => {
  await render();
  const section = host.querySelector<HTMLElement>(".diff-view")!;
  await act(async () => {
    section.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "g",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = host.querySelector<HTMLInputElement>(
    'input[aria-label="Go to line"]',
  )!;
  expect(document.activeElement).toBe(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "99");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    host
      .querySelector("form.diff-line-tools")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(host.querySelector(".diff-line-error")?.textContent).toBe(
    "Line is not in the current content",
  );

  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "10");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    host
      .querySelector("form.diff-line-tools")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(host.querySelector(".diff-line-error")).toBeNull();
  expect(hunkCount()).toBe("2/2 hunks");
});

it("opens the V04 context menu from a shadow line via composedPath", async () => {
  await render();
  expect(await waitFor(() => shadowText().includes("THREE"))).toBe(true);
  const row = container()!.shadowRoot!.querySelector<HTMLElement>(
    "code[data-additions] [data-line]",
  )!;
  await act(async () => {
    row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        composed: true,
        cancelable: true,
        clientX: 40,
        clientY: 60,
      }),
    );
    await Promise.resolve();
  });
  expect(
    document.querySelector('.p4-context-menu [data-menu-item="V04-01"]'),
  ).toBeTruthy();
});

const LINES = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);

function source(lines: string[], eol = "\n") {
  return lines.join(eol) + eol;
}

function patchAround(lineNumber: number) {
  const start = lineNumber - 3;
  const rows: string[] = [];
  for (let line = start; line < lineNumber; line++) rows.push(` line ${line}`);
  rows.push(`-line ${lineNumber}`);
  rows.push(`+line ${lineNumber} changed`);
  for (let line = lineNumber + 1; line <= lineNumber + 3; line++)
    rows.push(` line ${line}`);
  return `--- left\n+++ right\n@@ -${start},7 +${start},7 @@\n${rows.join("\n")}\n`;
}

function changedLines() {
  const lines = [...LINES];
  lines[99] = "line 100 changed";
  return lines;
}

function largeResult(leftText: string, rightText: string) {
  return result({
    leftText,
    rightText,
    unified: patchAround(100),
    stats: { additions: 1, deletions: 1, hunks: 1 },
  });
}

it("normalizes CRLF depot text against LF workspace text", async () => {
  await render(largeResult(source(LINES, "\r\n"), source(changedLines())));
  expect(await waitFor(() => shadowText().includes("line 100 changed"))).toBe(
    true,
  );
  const shadow = container()!.shadowRoot!;
  const deletions = [
    ...shadow.querySelectorAll<HTMLElement>(
      '[data-line][data-line-type="change-deletion"]',
    ),
  ];
  const additions = [
    ...shadow.querySelectorAll<HTMLElement>(
      '[data-line][data-line-type="change-addition"]',
    ),
  ];
  expect(deletions).toHaveLength(1);
  expect(additions).toHaveLength(1);
  expect(deletions[0].getAttribute("data-line")).toBe("100");
  expect(additions[0].getAttribute("data-line")).toBe("100");
  expect(
    shadow.querySelectorAll('[data-line][data-line-type^="change-"]').length,
  ).toBe(2);
  expect(
    shadow.querySelectorAll('[data-line][data-line-type^="context"]').length,
  ).toBeGreaterThan(0);
});

it("collapses long unchanged regions and expands them on demand", async () => {
  await render(largeResult(source(LINES), source(changedLines())));
  expect(await waitFor(() => shadowText().includes("line 100 changed"))).toBe(
    true,
  );
  const shadow = () => container()!.shadowRoot!;
  expect(shadow().querySelector('[data-separator="line-info"]')).toBeTruthy();
  const label = shadow().querySelector("[data-unmodified-lines]")?.textContent;
  expect(label).toMatch(/^\d+ unmodified lines?$/);
  const contextRows = () =>
    shadow().querySelectorAll('[data-line][data-line-type^="context"]').length;
  const before = contextRows();
  const button = shadow().querySelector(
    '[data-separator="line-info"] [data-expand-button]',
  );
  expect(button).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, composed: true }),
    );
  });
  expect(await waitFor(() => contextRows() > before)).toBe(true);
});

it("renders no change rows when only the line endings differ", async () => {
  const text = source(LINES);
  await render(
    result({
      leftText: source(LINES, "\r\n"),
      rightText: text,
      unified:
        "--- left\n+++ right\n@@ -1,3 +1,3 @@\n line 1\n line 2\n line 3\n",
      stats: { additions: 0, deletions: 0, hunks: 1 },
    }),
  );
  expect(await waitFor(() => container() !== null)).toBe(true);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(
    container()!.shadowRoot!.querySelectorAll('[data-line-type^="change-"]')
      .length,
  ).toBe(0);
});

it("renders a patch that is missing its trailing newline", async () => {
  await render(
    result({
      leftText: undefined,
      rightText: undefined,
      unified: "--- left\n+++ right\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three",
      stats: { additions: 1, deletions: 1, hunks: 1 },
    }),
  );
  expect(await waitFor(() => shadowText().includes("TWO"))).toBe(true);
  expect(host.querySelector(".diff-fallback")).toBeNull();
  const shadow = container()!.shadowRoot!;
  expect(
    shadow.querySelectorAll('[data-line][data-line-type="change-deletion"]')
      .length,
  ).toBe(1);
  expect(
    shadow.querySelectorAll('[data-line][data-line-type="change-addition"]')
      .length,
  ).toBe(1);
});

it("keeps the no-newline marker from the backend patch", async () => {
  await render(
    result({
      leftText: undefined,
      rightText: undefined,
      unified:
        "--- left\n+++ right\n@@ -1 +1 @@\n-same\n+same\n\\ No newline at end of file",
      stats: { additions: 1, deletions: 1, hunks: 1 },
    }),
  );
  expect(await waitFor(() => shadowText().includes("same"))).toBe(true);
  expect(host.querySelector(".diff-fallback")).toBeNull();
  const marker = container()!.shadowRoot!.querySelector(
    "code[data-additions] [data-no-newline]",
  ) as HTMLElement | null;
  expect(marker?.textContent).toBe("No newline at end of file");
});

it("degrades to a readable raw patch preview when parsing fails", async () => {
  await render(
    result({
      leftText: undefined,
      rightText: undefined,
      unified: "--- left\n+++ right\n@@ -broken header\nnonsense\n",
      stats: { additions: 0, deletions: 0, hunks: 1 },
    }),
  );
  expect(host.querySelector(".diff-fallback")?.getAttribute("role")).toBe(
    "alert",
  );
  expect(host.querySelector(".diff-patch-fallback")?.textContent).toContain(
    "@@ -broken header",
  );
  expect(document.querySelector("diffs-container")).toBeNull();
});

it("searches lines parsed from the backend patch when full texts are unavailable", async () => {
  await render(
    result({
      leftText: undefined,
      rightText: undefined,
      unified: "--- left\n+++ right\n@@ -1,2 +1,2 @@\n shared\n-alpha\n+beta\n",
      stats: { additions: 1, deletions: 1, hunks: 1 },
    }),
  );
  expect(await waitFor(() => shadowText().includes("beta"))).toBe(true);
  const input = host.querySelector<HTMLInputElement>(
    'input[aria-label="Find text"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "beta");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelector(".diff-match-count")?.textContent).toBe("1/1");
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')
      ?.disabled,
  ).toBe(false);
});
