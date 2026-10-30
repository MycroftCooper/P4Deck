import { expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => api);
import { tauriBackend } from "../../infrastructure/backend/tauriBackend";
it.each(["notFound", "storageUnavailable", "scopeMismatch"])(
  "typed lookup forwards exact scope and preserves %s without another command",
  async (kind) => {
    api.invoke.mockReset();
    api.invoke.mockResolvedValue({ kind });
    const request = {
      operationId: "fixture",
      connection: {
        profileId: "fixture",
        generation: "18446744073709551615",
        server: "fixture.invalid",
        user: "u",
        client: "c",
      },
    };
    expect(await tauriBackend.selectedMoveLookup(request)).toEqual({ kind });
    expect(api.invoke).toHaveBeenCalledExactlyOnceWith("selected_move_lookup", {
      request,
    });
  },
);
