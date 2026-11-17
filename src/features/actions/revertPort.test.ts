import { expect, it, vi } from "vitest";
// Revert used to call `invoke("confirm_revert_action")` straight from the
// renderer, which the browser mock cannot serve: the demo build could not revert
// anything and no test could observe the write. The port must go through the
// backend contract like every other write.
const deps = vi.hoisted(() => ({
  confirmRevertAction: vi.fn(),
  companySubmitConnectionSnapshot: vi.fn(),
  listWorkspaceChildren: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({
  backend: {
    confirmRevertAction: deps.confirmRevertAction,
    companySubmitConnectionSnapshot: deps.companySubmitConnectionSnapshot,
    listWorkspaceChildren: deps.listWorkspaceChildren,
  },
}));
const { revertPort } = await import("./revertTask");

it("routes the revert write through the backend contract", async () => {
  const request = {
    action: "revert",
    operationId: "op-1",
    paths: ["//depot/a.txt"],
  } as never;
  const connection = {
    profileId: "profile",
    generation: "1",
    server: "s",
    user: "u",
    client: "c",
  };
  deps.confirmRevertAction.mockResolvedValue({ outcome: "succeeded" });
  await revertPort.execute(request, connection);
  expect(deps.confirmRevertAction).toHaveBeenCalledWith(request, connection);
});
