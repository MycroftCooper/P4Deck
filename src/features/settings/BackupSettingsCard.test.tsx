// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackupSettingsCard } from "./BackupSettingsCard";
import type { ControlPlaneActionResult } from "../../shared/contracts";

const backend = vi.hoisted(() => ({
  listConfigBackups: vi.fn(),
  createConfigBackup: vi.fn(),
  restoreConfigBackup: vi.fn(),
  openConfigBackupsFolder: vi.fn(),
  companySubmitConnectionSnapshot: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));

const connection = {
  profileId: "fixture",
  generation: "1",
  server: "server:1666",
  user: "tester",
  client: "workspace",
};
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const overview = {
  directory: "C:/backups",
  backups: [
    {
      fileName: "p4deck-config-manual-1.json",
      createdAt: "2026-10-30T00:00:00.000Z",
      sizeBytes: 2048,
      kind: "manual" as const,
      includesConnection: true,
      includesWindowPlacement: true,
      localStorageKeys: ["p4deck.ui"],
    },
  ],
};
const committedCreate = (): ControlPlaneActionResult => ({
  kind: "backupCreate",
  operationId: "op-create",
  state: "committed",
  outcome: "succeeded",
  artifact: {
    path: "C:/backups/p4deck-config-manual-2.json",
    fileName: "p4deck-config-manual-2.json",
    exists: true,
    sizeBytes: 2048,
    sha256: "A".repeat(64),
  },
  details: null,
  optimistic: "intentOnly",
  message: "verified",
  legacy: null,
});
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  backend.listConfigBackups.mockResolvedValue(overview);
  backend.createConfigBackup.mockResolvedValue(committedCreate());
  backend.companySubmitConnectionSnapshot.mockResolvedValue(connection);
  backend.openConfigBackupsFolder.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  )!;
}
async function render() {
  await act(async () =>
    root.render(
      <BackupSettingsCard
        zh={false}
        native
        connection={async () => connection}
      />,
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
}

it("shows only readback authority after creating a backup and refreshes once", async () => {
  await render();
  await act(async () => button("Create local backup").click());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const call = backend.createConfigBackup.mock.calls[0][0] as {
    request: unknown;
    operationId: string;
  };
  expect(call.request).toEqual({ localStorage: expect.any(Array) });
  expect(call.operationId).toMatch(uuidPattern);
  expect(host.textContent).toContain("Backup artifact verified by readback");
  expect(host.textContent).toContain("sha256 AAAAAAAAAAAA");
  // one initial list + one bounded refresh after the operation
  expect(backend.listConfigBackups).toHaveBeenCalledTimes(2);
});

it("keeps an unconfirmed backup explicitly uncertain and looks up the SAME id", async () => {
  backend.createConfigBackup.mockResolvedValue({
    ...committedCreate(),
    state: "unknown",
    outcome: "unknown",
  });
  const lookup = vi.fn(async (value: { operationId: string }) => ({
    kind: "notFound" as const,
    value,
  }));
  await act(async () =>
    root.render(
      <BackupSettingsCard
        zh={false}
        native
        connection={async () => connection}
        lookup={lookup as never}
      />,
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => button("Create local backup").click());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const operationId = (
    backend.createConfigBackup.mock.calls[0][0] as { operationId: string }
  ).operationId;
  expect(lookup).toHaveBeenCalledExactlyOnceWith({
    operationId,
    connection,
  });
  expect(host.textContent).toContain("Outcome uncertain");
  expect(host.textContent).not.toContain(
    "Backup artifact verified by readback",
  );
});

it("requires an explicit confirm for restore and only ever shows pending (staged)", async () => {
  backend.restoreConfigBackup.mockResolvedValue({
    kind: "backupRestore",
    operationId: "op-restore",
    state: "pending",
    outcome: "unknown",
    artifact: {
      path: "C:/backups/rollback.json",
      fileName: "rollback.json",
      exists: true,
      sizeBytes: 1024,
      sha256: "D".repeat(64),
    },
    details: {
      sourceFileName: "p4deck-config-manual-1.json",
      rollbackFileName: "rollback.json",
      restartRequired: true,
      pendingStaged: true,
    },
    optimistic: "intentOnly",
    message: "staged",
    legacy: {
      sourceFileName: "p4deck-config-manual-1.json",
      rollbackFileName: "rollback.json",
      localStorage: [],
      restartRequired: true,
    },
  });
  await render();
  await act(async () => button("Restore").click());
  expect(backend.restoreConfigBackup).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Continue?");
  await act(async () => button("Confirm staged restore").click());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(backend.restoreConfigBackup).toHaveBeenCalledOnce();
  const call = backend.restoreConfigBackup.mock.calls[0][0] as {
    request: { fileName: string };
    operationId: string;
  };
  expect(call.request.fileName).toBe("p4deck-config-manual-1.json");
  expect(call.operationId).toMatch(uuidPattern);
  expect(host.textContent).toContain("Restore staged");
  expect(host.textContent).toContain("applies on next start");
  expect(host.textContent).not.toContain("Restore completed");
  expect(host.textContent).toContain("rollback.json");
});
