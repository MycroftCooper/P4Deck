// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogButton, dialogHarness } from "../../app/dialogs/testHarness";
import type {
  BranchMappingDetail,
  BranchMutationPreflightRequest,
  RuntimeInfo,
} from "../../shared/contracts/types";
import { BranchMappingMutationDialog } from "./BranchMappingMutationDialog";

const backend = vi.hoisted(() => ({
  preflightBranchMappingMutation: vi.fn(),
  confirmBranchMappingMutation: vi.fn(),
  cancelOperation: vi.fn(async () => undefined),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));

const runtime: RuntimeInfo = {
  mode: "mock",
  p4Version: "P4/MOCK",
  activeProfileId: "profile-a",
  contextGeneration: 7,
  context: {
    server: "mock:1666",
    user: "tester",
    client: "workspace",
    cwd: "C:/workspace",
  },
  connection: {
    state: "connected",
    message: "ok",
    recovery: "none",
    server: "mock:1666",
  },
};

const detail: BranchMappingDetail = {
  name: "atlas-release",
  owner: "tester",
  description: "release",
  locked: false,
  view: [
    {
      modifier: "map",
      source: "//atlas/main/...",
      target: "//atlas/release/...",
    },
  ],
  unknownFields: [],
  editable: true,
  operationIds: [],
  simulated: true,
};

const target = (request: BranchMutationPreflightRequest) => ({
  activeProfileId: runtime.activeProfileId,
  contextGeneration: runtime.contextGeneration,
  server: runtime.context.server,
  user: runtime.context.user,
  client: runtime.context.client,
  mode: request.mode,
  name: request.name,
  currentExists: request.mode !== "create",
  desired: request.desired,
  desiredDigest: request.desired ? "desired" : undefined,
  currentDigest: request.mode !== "create" ? "current" : undefined,
});

const harness = dialogHarness();

async function input(label: string, value: string) {
  const control = document.querySelector<HTMLInputElement>(
    `dialog input[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  backend.preflightBranchMappingMutation.mockReset();
  backend.confirmBranchMappingMutation.mockReset();
  backend.cancelOperation.mockReset().mockResolvedValue(undefined);
  backend.preflightBranchMappingMutation.mockImplementation(
    async (request: BranchMutationPreflightRequest) => ({
      ready: true,
      mode: request.mode,
      name: request.name,
      desired: request.desired,
      current: request.mode === "create" ? undefined : detail,
      blockers: [],
      warnings:
        request.mode === "delete"
          ? [
              {
                code: "destructiveDelete" as const,
                message: "Permanent delete",
              },
            ]
          : [],
      target: target(request),
      previewDigest: "preview-digest",
      token: "one-use-token",
      expiresAt: Date.now() + 120_000,
      ttlMs: 120_000,
      operationIds: [request.operationId ?? "preflight"],
    }),
  );
  backend.confirmBranchMappingMutation.mockResolvedValue({
    outcome: "succeeded",
    message: "Verified after write",
    observed: detail,
    operationIds: ["confirm"],
    refreshBranchMappings: true,
  });
});

it("creates only through preflight and one-use confirmation while preserving ordered View", async () => {
  const onResult = vi.fn();
  await harness.render(
    <BranchMappingMutationDialog
      mode="create"
      runtime={runtime}
      connectionKey="profile-a:7"
      source={null}
      zh={false}
      onDismiss={vi.fn()}
      onResult={onResult}
    />,
  );
  expect(document.body.textContent).toContain("Browser Mock");
  expect(dialogButton("Preflight and review").disabled).toBe(true);
  await input("Branch Mapping name", "created-map");
  await input("View line 1 source", "//atlas/main/...");
  await input("View line 1 target", "//atlas/created/...");
  expect(dialogButton("Preflight and review").disabled).toBe(false);
  await act(async () => dialogButton("Preflight and review").click());
  expect(backend.preflightBranchMappingMutation).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "create",
      name: "created-map",
      desired: expect.objectContaining({
        name: "created-map",
        owner: "tester",
        view: [
          {
            modifier: "map",
            source: "//atlas/main/...",
            target: "//atlas/created/...",
          },
        ],
      }),
    }),
  );
  await act(async () => dialogButton("Confirm save").click());
  expect(backend.confirmBranchMappingMutation).toHaveBeenCalledWith(
    expect.objectContaining({
      token: "one-use-token",
      previewDigest: "preview-digest",
      acknowledgeDangerousDelete: false,
    }),
  );
  expect(onResult).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "succeeded" }),
    "created-map",
  );
  expect(document.body.textContent).toContain("Verified after write");
});

it("blocks unknown/unroundtrippable edits before preflight", async () => {
  await harness.render(
    <BranchMappingMutationDialog
      mode="edit"
      detail={{
        ...detail,
        editable: false,
        view: [{ modifier: "unknown", unknown: "future syntax" }],
      }}
      runtime={runtime}
      connectionKey="profile-a:7"
      source={null}
      zh={false}
      onDismiss={vi.fn()}
      onResult={vi.fn()}
    />,
  );
  expect(document.body.textContent).toContain("Editing is blocked");
  expect(dialogButton("Preflight and review").disabled).toBe(true);
  expect(backend.preflightBranchMappingMutation).not.toHaveBeenCalled();
});

it("requires explicit destructive acknowledgement and never labels rejection as success", async () => {
  const onResult = vi.fn();
  backend.confirmBranchMappingMutation.mockResolvedValueOnce({
    outcome: "rejected",
    failure: "tokenExpired",
    message: "Token expired; nothing was changed.",
    operationIds: ["confirm"],
    refreshBranchMappings: false,
  });
  await harness.render(
    <BranchMappingMutationDialog
      mode="delete"
      detail={detail}
      runtime={runtime}
      connectionKey="profile-a:7"
      source={null}
      zh={false}
      onDismiss={vi.fn()}
      onResult={onResult}
    />,
  );
  await act(async () => dialogButton("Preflight and review").click());
  expect(dialogButton("Confirm permanent delete").disabled).toBe(true);
  const acknowledgement = document.querySelector<HTMLInputElement>(
    'dialog input[type="checkbox"]',
  )!;
  await act(async () => acknowledgement.click());
  await act(async () => dialogButton("Confirm permanent delete").click());
  expect(backend.confirmBranchMappingMutation).toHaveBeenCalledWith(
    expect.objectContaining({ acknowledgeDangerousDelete: true }),
  );
  expect(document.body.textContent).toContain(
    "Token expired; nothing was changed.",
  );
  expect(onResult).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Verified after write");
});

it("cancels and ignores a late preflight after connection generation changes", async () => {
  let resolve!: (value: unknown) => void;
  backend.preflightBranchMappingMutation.mockImplementationOnce(
    () => new Promise((done) => (resolve = done)),
  );
  const props = {
    mode: "edit" as const,
    detail,
    runtime,
    source: null,
    zh: false,
    onDismiss: vi.fn(),
    onResult: vi.fn(),
  };
  await harness.render(
    <BranchMappingMutationDialog {...props} connectionKey="profile-a:7" />,
  );
  await act(async () => dialogButton("Preflight and review").click());
  await harness.render(
    <BranchMappingMutationDialog {...props} connectionKey="profile-a:8" />,
  );
  await act(async () =>
    resolve({
      ready: true,
      mode: "edit",
      name: detail.name,
      blockers: [],
      warnings: [],
      target: target({ mode: "edit", name: detail.name, desired: detail }),
      previewDigest: "late",
      token: "late-token",
      expiresAt: Date.now() + 1000,
      ttlMs: 1000,
      operationIds: [],
    }),
  );
  expect(backend.cancelOperation).toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("late-token");
  expect(dialogButton("Preflight and review")).toBeTruthy();
});
