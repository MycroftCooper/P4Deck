// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolDrawer } from "./ToolDrawer";
import { messages } from "../../../shared/i18n";
import type { OperationResult } from "../../../shared/contracts";

vi.mock("../../../app/closeGuard", () => ({
  useUnsavedEditor: vi.fn(() => () => {}),
}));
vi.mock("../../../infrastructure/backend", () => ({ backend: {} }));
vi.mock("../../../app/context-menu/ContextMenu", () => ({
  useContextMenu: () => () => ({}),
}));

let host: HTMLDivElement;
let root: Root;

const result = (operationId: string): OperationResult =>
  ({
    operationId,
    exitCode: 0,
    durationMs: 1,
    events: [{ type: "stdout", message: "ok" }],
  }) as OperationResult;

function props(overrides: Partial<ComponentProps<typeof ToolDrawer>> = {}) {
  return {
    t: messages["en-US"],
    zh: false,
    native: false,
    connectionKey: "synthetic-window",
    logRefreshKey: 0,
    open: true,
    active: "terminal" as const,
    unread: 0,
    context: {
      server: "synthetic.invalid",
      user: "fixture",
      client: "workspace",
    },
    operationEvents: [],
    onOpenChange: vi.fn(),
    onActiveChange: vi.fn(),
    onOperationFilter: vi.fn(),
    onJournalOperation: vi.fn(),
    onRun: vi.fn(),
    onCancel: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
}

async function submit(command: string) {
  const input = host.querySelector<HTMLInputElement>(".terminal-input input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, command);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const run = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.includes(messages["en-US"].run),
  )!;
  await act(async () => run.click());
}

const cancelButton = () =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes(messages["en-US"].cancel),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("runs with a caller-minted id and keeps it when the host echoes it back", async () => {
  let minted: string | undefined;
  const run = vi.fn(async (_raw: string, operationId: string) => {
    minted = operationId;
    // The host adopts the supplied id (runner.rs), so it echoes the same value.
    return result(operationId);
  });
  const cancel = vi.fn();
  await act(async () =>
    root.render(<ToolDrawer {...props({ onRun: run, onCancel: cancel })} />),
  );
  await submit("status");

  expect(run).toHaveBeenCalledTimes(1);
  expect(minted).toMatch(/^[0-9a-f-]{36}$/);
  // Once the run settles the Cancel affordance is gone, which proves the
  // echoed id still identified this run rather than clearing it mid-flight.
  expect(cancelButton()).toBeUndefined();
  expect(cancel).not.toHaveBeenCalled();
});

it("keeps its own id when the host echoes an empty operation id", async () => {
  const run = vi.fn(async () => result(""));
  const cancel = vi.fn();
  await act(async () =>
    root.render(<ToolDrawer {...props({ onRun: run, onCancel: cancel })} />),
  );
  await submit("status");
  expect(run).toHaveBeenCalledTimes(1);
  // An empty echo must not erase the run identity: a later cancel still has an
  // id to send, and the finished run leaves no cancel affordance behind.
  expect(cancelButton()).toBeUndefined();
  expect(cancel).not.toHaveBeenCalled();
});

it("sends exactly one cancel when the button is clicked twice", async () => {
  let finish!: (value: OperationResult) => void;
  const run = vi.fn(
    () =>
      new Promise<OperationResult>((resolve) => {
        finish = resolve;
      }),
  );
  const cancel = vi.fn();
  await act(async () =>
    root.render(<ToolDrawer {...props({ onRun: run, onCancel: cancel })} />),
  );
  await submit("status");
  const button = cancelButton()!;
  expect(button).toBeTruthy();
  await act(async () => {
    button.click();
    button.click();
  });
  // One run, one cancel: the second click must not ask the host again.
  expect(cancel).toHaveBeenCalledTimes(1);
  await act(async () => finish(result("ignored")));
  expect(cancel).toHaveBeenCalledTimes(1);
});
