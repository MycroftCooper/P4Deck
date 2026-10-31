import { recordFrontendOperationLog } from "../../infrastructure/backend/frontendOperationLog";
vi.mock("../../infrastructure/backend/frontendOperationLog", () => ({
  recordFrontendOperationLog: vi.fn(async () => ({ status: "recorded" })),
}));
// @vitest-environment jsdom
import { act, createRef } from "react";
import { expect, it, vi } from "vitest";
import { dialogHarness } from "../../app/dialogs/testHarness";
import { messages } from "../../shared/i18n";
import { ToolArea, type ToolHandle } from "./ToolArea";
vi.mock("../../infrastructure/backend", () => ({
  backend: {
    subscribeOperationEvents: async () => () => {},
    subscribeDiagnosticAlerts: async () => () => {},
    subscribeLogsCleared: async () => () => {},
  },
  tokenize: () => [],
}));
vi.mock("./components/ToolDrawer", () => ({
  ToolDrawer: ({ open, active }: { open: boolean; active: string }) => (
    <div data-open={open} data-tab={active} />
  ),
}));
const root = dialogHarness();
it("logs frontend failure without opening drawer, showing alert or exposing raw text", async () => {
  const ref = createRef<ToolHandle>();
  await root.render(
    <ToolArea
      ref={ref}
      t={messages["en-US"]}
      zh={false}
      native={false}
      connectionKey="fixture"
      context={{ server: "fixture.invalid", user: "u", client: "c" }}
      onOpenChange={() => {}}
      onOpenSettings={() => {}}
    />,
  );
  await act(async () =>
    ref.current!.open(
      "journal",
      undefined,
      "Synthetic failure · fixture-task-123",
    ),
  );
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('[data-open="true"]')).toBeNull();
  expect(recordFrontendOperationLog).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "failed", code: "operationFailed" }),
  );
  expect(
    JSON.stringify(vi.mocked(recordFrontendOperationLog).mock.calls),
  ).not.toContain("Synthetic failure");
});
