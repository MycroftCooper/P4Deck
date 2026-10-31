// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import { resetCustomSubmitSessions } from "../../features/companySubmit/customSubmitSessions";
import { CommandBar } from "./CommandBar";
import type { CommandId, CommandTarget } from "./commandPolicy";
import type { RuntimeInfo } from "../../shared/contracts";
const deps = vi.hoisted(() => ({
  open: vi.fn(),
  snapshot: vi.fn(),
  profiles: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({
  backend: {
    companySubmitConnectionSnapshot: deps.snapshot,
    listConnectionProfiles: deps.profiles,
    customSubmitStart: deps.start,
    customSubmitStatus: deps.status,
    subscribeOperationEvents: async () => () => {},
  },
}));
vi.mock("../context-menu/ContextMenu", () => ({
  useContextMenu: () => () => ({}),
}));
vi.mock("../context-menu/environment", () => ({
  useMenuEnvironment: () => ({
    preferences: { ui: { toolbarText: true } },
    openPage: vi.fn(),
  }),
}));
vi.mock("../dialogs/useCommandDialogs", () => ({
  useCommandDialogs: () => ({ pending: false, element: null, open: deps.open }),
  refreshFileLockFacts: vi.fn(),
}));
vi.mock("./useLocalPathCapabilities", () => ({
  useLocalPathCapabilities: () => ({ reveal: false, openWith: false }),
}));
const root = dialogHarness();
const connection = {
  profileId: "fixture",
  generation: "18446744073709551615",
  server: "fixture.invalid",
  user: "u",
  client: "c",
};
const runtime: RuntimeInfo = {
  mode: "mock",
  contextGeneration: 1,
  p4Version: "synthetic",
  context: { server: "fixture.invalid", user: "u", client: "c" },
  connection: {
    server: "fixture.invalid",
    state: "connected",
    message: "mock",
    recovery: "none",
  },
};
let handler:
  | ((id: CommandId, target?: CommandTarget, source?: HTMLElement) => void)
  | undefined;
beforeEach(() => {
  // The per-CL custom-submit claim is module state that must not leak between
  // cases; keep product dedupe intact while isolating this test file.
  resetCustomSubmitSessions();
  Object.values(deps).forEach((v) => v.mockReset());
  deps.snapshot.mockResolvedValue(connection);
  deps.start.mockImplementation(async (request) => ({
    ...request,
    state: "started",
    executablePath: "C:\\fixture\\submit.exe",
    exitCode: null,
    reason: null,
  }));
});
async function mount(path: string) {
  deps.profiles.mockResolvedValue({
    schemaVersion: 3,
    revision: 1,
    activeProfileId: "fixture",
    profiles: [
      {
        id: "fixture",
        name: "Fixture",
        context: { ...runtime.context, customSubmitExecutablePath: path },
      },
    ],
  });
  await root.render(
    <CommandBar
      runtime={runtime}
      zh={false}
      connectionKey="fixture"
      target={{ type: "pending", id: 42, count: 1 }}
      targetError=""
      onBusyChange={vi.fn()}
      onOpenOperations={vi.fn()}
      registerCommand={(h) => {
        handler = h;
      }}
      onNavigate={vi.fn()}
      onFocus={vi.fn()}
      onReview={vi.fn()}
    />,
  );
}
async function submit() {
  await act(async () => {
    handler!("submit", { type: "pending", id: 42, count: 1 });
    await new Promise((r) => setTimeout(r, 0));
  });
}
it("keeps the original native confirmation route only with empty saved configuration", async () => {
  await mount("");
  await submit();
  expect(deps.open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "submit", id: 42, count: 1 }),
  );
  expect(deps.start).not.toHaveBeenCalled();
});
it("original Submit invokes the new host launcher exactly once without native preflight", async () => {
  await mount("C:\\fixture\\submit.exe");
  expect(deps.start).not.toHaveBeenCalled();
  await submit();
  await submit();
  expect(deps.start).toHaveBeenCalledTimes(1);
  expect(deps.start).toHaveBeenCalledWith({
    changeId: "42",
    connection,
    requestId: expect.any(String),
  });
  expect(deps.open).not.toHaveBeenCalled();
  // No modal: launch intent stays silent (outcomes go to the frontend operation log only).
  expect(document.querySelector("dialog")).toBeNull();
});
it.each(["notStarted", "outcomeUnknown"])(
  "%s never falls back or claims submit success",
  async (state) => {
    await mount("invalid-but-configured");
    deps.start.mockImplementation(async (r) => ({
      ...r,
      state,
      executablePath: "invalid-but-configured",
      exitCode: 0,
      reason: "synthetic failure",
    }));
    await submit();
    expect(deps.open).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Submission succeeded");
  },
);
it("IPC failure never invokes native submit", async () => {
  await mount("configured");
  deps.start.mockRejectedValue(Error("transport unavailable"));
  await submit();
  await submit();
  expect(deps.start).toHaveBeenCalledTimes(1);
  expect(deps.open).not.toHaveBeenCalled();
  // Failure is silent in the UI (no dialog); it is recorded in the operation log instead.
  expect(document.querySelector("dialog")).toBeNull();
});
