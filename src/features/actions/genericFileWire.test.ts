import { expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { tauriBackend } from "../../infrastructure/backend/tauriBackend";
it("native adapter preserves exact connection at top level for migrated writes", async () => {
  const request = {
    action: "checkout" as const,
    paths: ["//fixture/a"],
    operationId: "fixture-id",
  };
  const connection = {
    profileId: "p",
    generation: "18446744073709551615",
    server: "s",
    user: "u",
    client: "c",
  };
  await tauriBackend.performFileAction(request, connection);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("perform_file_action", {
    request,
    connection,
  });
});
