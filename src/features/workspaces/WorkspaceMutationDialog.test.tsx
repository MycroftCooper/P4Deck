// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { WorkspaceMutationDialog } from "./WorkspaceMutationDialog";
import { setLocale } from "../../shared/i18n";
const backend = vi.hoisted(() => ({
  preflightWorkspaceMutation: vi.fn(),
  confirmWorkspaceMutation: vi.fn(),
  cancelOperation: vi.fn(async () => undefined),
  companySubmitConnectionSnapshot: vi.fn(async () => ({
    profileId: "profile-a",
    generation: "1",
    server: "server:1666",
    user: "tester",
    client: "workspace",
  })),
}));
const connectionSnapshot = {
  profileId: "profile-a",
  generation: "1",
  server: "server:1666",
  user: "tester",
  client: "workspace",
};
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
beforeEach(() => {
  // Components translate through the module-level locale.
  setLocale("zh-CN");
  vi.clearAllMocks();
  backend.companySubmitConnectionSnapshot.mockResolvedValue(connectionSnapshot);
});
const stubs = {
  showModal: Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "showModal",
  ),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
};
function stubDialog() {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {},
  });
}
function restoreDialog() {
  if (stubs.showModal)
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "showModal",
      stubs.showModal,
    );
  else
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)
      .showModal;
  if (stubs.close)
    Object.defineProperty(HTMLDialogElement.prototype, "close", stubs.close);
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === text,
  )!;
}
vi.mock("../../infrastructure/backend", () => ({ backend }));
it("opening and cancelling Delete never preflights or writes", async () => {
  const originalShow = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "showModal",
  );
  const originalClose = Object.getOwnPropertyDescriptor(
    HTMLDialogElement.prototype,
    "close",
  );
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {},
  });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  await act(async () =>
    root.render(
      <WorkspaceMutationDialog
        request={{
          action: "delete",
          workspace: "mock-other",
          expectedGeneration: 1,
        }}
        zh
        onClose={close}
        onDone={vi.fn()}
      />,
    ),
  );
  const cancel = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((b) => b.textContent === "取消")!;
  await act(async () => cancel.click());
  expect(close).toHaveBeenCalledOnce();
  expect(backend.preflightWorkspaceMutation).not.toHaveBeenCalled();
  expect(backend.confirmWorkspaceMutation).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  if (originalShow)
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "showModal",
      originalShow,
    );
  else
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)
      .showModal;
  if (originalClose)
    Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  host.remove();
});

async function renderMutation(
  action: "rename" | "delete",
  overrides: Record<string, unknown> = {},
) {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  stubDialog();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  const onDone = vi.fn();
  const onRefresh = vi.fn();
  await act(async () =>
    root.render(
      <WorkspaceMutationDialog
        request={{
          action,
          workspace: "mock-other",
          expectedGeneration: 1,
        }}
        zh={false}
        onClose={onClose}
        onDone={onDone}
        onRefresh={onRefresh}
        {...overrides}
      />,
    ),
  );
  return {
    root,
    host,
    onClose,
    onDone,
    onRefresh,
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
      restoreDialog();
    },
  };
}
const preview = {
  token: "one-use-token",
  request: {
    action: "delete" as const,
    workspace: "mock-other",
    expectedGeneration: 1,
  },
  root: "D:/work/other",
  stream: "//depot/main",
  expiresAt: Date.now() + 60_000,
};

it("requires the dangerous-delete acknowledgement, then shows only the readback authority", async () => {
  backend.preflightWorkspaceMutation.mockResolvedValue(preview);
  const confirm = backend.confirmWorkspaceMutation.mockResolvedValue({
    outcome: "succeeded",
    message:
      "Workspace definition change verified from a post-write workspace readback.",
    workspace: "mock-other",
    action: "delete",
    verified: true,
    observedExists: false,
  });
  const ctx = await renderMutation("delete");
  await act(async () => {
    button("Review").click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(document.body.textContent).not.toContain(
    "Verified by server readback",
  );
  expect(button("Confirm").disabled).toBe(true);
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  expect(button("Confirm").disabled).toBe(false);
  await act(async () => {
    button("Confirm").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  const [token, operationId] = confirm.mock.calls[0] as [string, string];
  expect(token).toBe("one-use-token");
  expect(operationId).toMatch(uuidPattern);
  expect(document.body.textContent).toContain("Verified by server readback");
  expect(document.body.textContent).toContain("no longer exists");
  expect(ctx.onDone).toHaveBeenCalledOnce();
  expect(ctx.onRefresh).not.toHaveBeenCalled();
  await ctx.cleanup();
});

it("keeps an unknown mutation uncertain, looks up the SAME id once and refreshes without closing", async () => {
  backend.preflightWorkspaceMutation.mockResolvedValue(preview);
  const confirm = backend.confirmWorkspaceMutation.mockResolvedValue({
    outcome: "unknown",
    failure: "readback inconclusive",
    message: "Workspace operation outcome is uncertain.",
    workspace: "mock-other",
    action: "delete",
    verified: false,
  });
  const lookup = vi.fn(async () => ({ kind: "notFound" as const }));
  const ctx = await renderMutation("delete", { lookup });
  await act(async () => {
    button("Review").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => {
    button("Confirm").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  const operationId = (confirm.mock.calls[0] as [string, string])[1];
  expect(lookup).toHaveBeenCalledExactlyOnceWith({
    operationId,
    connection: connectionSnapshot,
  });
  expect(confirm).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Outcome uncertain");

  expect(document.body.textContent).not.toContain(
    "Verified by server readback",
  );
  expect(ctx.onRefresh).toHaveBeenCalledOnce();
  expect(ctx.onDone).not.toHaveBeenCalled();
  await ctx.cleanup();
});

it("turns a transport failure into uncertainty and looks up the same operation id", async () => {
  backend.preflightWorkspaceMutation.mockResolvedValue(preview);
  const confirm = backend.confirmWorkspaceMutation.mockRejectedValue(
    new Error("transport lost"),
  );
  const lookup = vi.fn(async () => ({ kind: "notFound" as const }));
  const ctx = await renderMutation("delete", { lookup });
  await act(async () => {
    button("Review").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => {
    button("Confirm").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  const operationId = (confirm.mock.calls[0] as [string, string])[1];
  expect(lookup).toHaveBeenCalledExactlyOnceWith({
    operationId,
    connection: connectionSnapshot,
  });
  expect(ctx.onRefresh).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Outcome uncertain");
  await ctx.cleanup();
});

it("refuses to dispatch when the dispatching generation no longer matches", async () => {
  backend.preflightWorkspaceMutation.mockResolvedValue(preview);
  const confirm = backend.confirmWorkspaceMutation;
  const ctx = await renderMutation("delete", {
    connection: async () => ({ ...connectionSnapshot, generation: "2" }),
  });
  await act(async () => {
    button("Review").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => {
    button("Confirm").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(confirm).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    "no workspace mutation was dispatched",
  );
  await ctx.cleanup();
});
