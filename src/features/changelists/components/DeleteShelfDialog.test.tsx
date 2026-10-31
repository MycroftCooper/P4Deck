// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { dialogHarness, dialogButton } from "../../../app/dialogs/testHarness";
import { backend } from "../../../infrastructure/backend";
import {
  MenuEnvironment,
  type MenuEnvironmentValue,
} from "../../../app/context-menu/environment";
import { DeleteShelfDialog } from "./DeleteShelfDialog";
vi.mock("../workflowRefresh", () => ({
  publishWorkflowResult: vi.fn().mockResolvedValue(undefined),
  publishWorkflowFailure: vi.fn().mockResolvedValue(undefined),
}));
const h = dialogHarness();

it("confirms through the dialog without any FE preflight and calls the direct delete once", async () => {
  const connection = {
    profileId: "fixture",
    generation: "1",
    server: "s",
    user: "u",
    client: "c",
  };
  vi.spyOn(backend, "companySubmitConnectionSnapshot").mockResolvedValue(
    connection,
  );
  const preflight = vi.spyOn(backend, "preflightShelf");
  const direct = vi
    .spyOn(backend, "deleteShelvedRevisions")
    .mockImplementation(async (request) => ({
      outcome: "succeeded",
      message: "Deleted",
      operationIds: [request.operationId!],
      files: request.depotPaths.map((depotPath: string) => ({
        depotPath,
        state: "succeeded" as const,
        message: "ok",
      })),
      refresh: {
        pendingChanges: true,
        workspaceStatus: true,
        depotPaths: [...request.depotPaths],
        reason: "direct",
      },
    }));
  const env = {
    runtime: {
      context: { server: "s", user: "u", client: "c", cwd: "C:/fixture" },
      contextGeneration: 1,
    },
    getOperationContext: () => ({
      connectionKey: "dialog",
      runtime: env.runtime,
    }),
    reportOperationError: vi.fn(),
  } as unknown as MenuEnvironmentValue;
  await h.render(
    <MenuEnvironment.Provider value={env}>
      <DeleteShelfDialog
        request={{
          changeId: 20,
          paths: ["//synthetic/x"],
          mode: "delete",
          hasShelf: true,
          source: null,
        }}
        connectionKey="dialog"
        zh
        onDismiss={vi.fn()}
      />
    </MenuEnvironment.Provider>,
  );
  // Confirmation dialog is kept; no FE preflight is called.
  expect(document.querySelector("dialog")).toBeTruthy();
  expect(preflight).not.toHaveBeenCalled();
  await act(async () => dialogButton("确认删除所选搁置版本").click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(preflight).not.toHaveBeenCalled();
  expect(direct).toHaveBeenCalledOnce();
  preflight.mockRestore();
  direct.mockRestore();
});
