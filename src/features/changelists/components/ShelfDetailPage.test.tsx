// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RuntimeInfo, ShelfDetail } from "../../../shared/contracts/types";
import { ShelfDetailPage } from "./ShelfDetailPage";

const backend = vi.hoisted(() => ({
  getShelfDetail: vi.fn(),
  getShelfFilePreview: vi.fn(),
  getDiff: vi.fn(),
  cancelOperation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../infrastructure/backend", () => ({ backend }));

const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  activeProfileId: "profile",
  contextGeneration: 7,
  context: {
    server: "fixture:1666",
    user: "tester",
    client: "workspace",
    cwd: "/workspace",
  },
  connection: {
    state: "connected",
    message: "connected",
    recovery: "none",
    server: "fixture:1666",
  },
};
const detail: ShelfDetail = {
  scope: {
    server: "fixture:1666",
    user: "tester",
    client: "workspace",
    workspace: "/workspace",
    activeProfileId: "profile",
    contextGeneration: 7,
    changeId: 42,
  },
  description: "Shelf detail",
  time: "2026-10-09T00:00:00Z",
  owner: "tester",
  user: "tester",
  client: "workspace",
  jobs: ["JOB-1"],
  files: [
    {
      depotPath: "//depot/a b@#%.txt",
      action: "edit",
      revision: 3,
      fileType: "text",
      size: 16,
      digest: "ABC",
      binary: false,
      symlink: false,
      deleted: false,
    },
    {
      depotPath: "//depot/bin.dat",
      action: "edit",
      fileType: "binary",
      size: 1024,
      digest: "BIN",
      binary: true,
      symlink: false,
      deleted: false,
    },
  ],
  totalFiles: 2,
  offset: 0,
  hasMore: false,
  truncated: false,
  inspectionStatus: "complete",
  operationIds: ["detail"],
  cacheFreshness: "fresh",
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.getShelfDetail.mockReset().mockResolvedValue(detail);
  backend.getShelfFilePreview.mockReset().mockResolvedValue({
    side: {
      reference: { kind: "shelf", changeId: 42 },
      label: "Shelf @=42",
      depotPath: detail.files[0].depotPath,
      fileType: "text",
      size: 16,
      digest: "ABC",
      exists: true,
      binary: false,
    },
    content: "shelved text\n第二行",
    encoding: "UTF-8",
    truncated: false,
    unsupported: false,
    operationIds: ["preview"],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("loads an independent shelf, selects an encoded path, and previews authoritative content", async () => {
  await act(async () =>
    root.render(
      <ShelfDetailPage
        target={`42::${encodeURIComponent(detail.files[0].depotPath)}`}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(backend.getShelfDetail).toHaveBeenCalledWith(
    expect.objectContaining({ changeId: 42, pageSize: 500 }),
  );
  expect(backend.getShelfFilePreview).toHaveBeenCalledWith(
    expect.objectContaining({
      changeId: 42,
      scope: expect.objectContaining({
        contextGeneration: 7,
        fileIdentity: "//depot/a b@#%.txt",
      }),
    }),
  );
  expect(host.textContent).toContain("shelved text");
  expect(host.textContent).toContain("2 files");
});

it("renders partial metadata and unsupported binary preview without treating bytes as text", async () => {
  backend.getShelfDetail.mockResolvedValue({
    ...detail,
    inspectionStatus: "partial",
    message: "Metadata is unavailable for 1 shelved file(s).",
  });
  backend.getShelfFilePreview.mockResolvedValue({
    side: {
      reference: { kind: "shelf", changeId: 42 },
      label: "Shelf @=42",
      depotPath: detail.files[1].depotPath,
      fileType: "binary",
      size: 1024,
      digest: "BIN",
      exists: true,
      binary: true,
    },
    encoding: "UTF-8",
    truncated: false,
    unsupported: true,
    reason: "Shelved binary content is shown as metadata only.",
    operationIds: ["preview"],
  });
  await act(async () =>
    root.render(
      <ShelfDetailPage
        target={`42::${encodeURIComponent(detail.files[1].depotPath)}`}
        runtime={runtime}
        zh={false}
      />,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(host.textContent).toContain("Metadata is unavailable");
  expect(host.textContent).toContain("metadata only");
  expect(host.textContent).not.toContain("shelved text");
});
