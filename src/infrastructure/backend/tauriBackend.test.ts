import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { tauriBackend } from "./tauriBackend";

beforeEach(() => invoke.mockReset());

it("passes only the narrow submitted-detail request through the Tauri adapter", async () => {
  const request = { changeId: 42, operationId: "detail-42" };
  invoke.mockResolvedValue({ changeId: 42 });
  await tauriBackend.getSubmittedChangeDetail(request);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "get_submitted_change_detail",
    { request },
  );
  expect(JSON.stringify(invoke.mock.calls[0])).not.toContain('"files"');
});
