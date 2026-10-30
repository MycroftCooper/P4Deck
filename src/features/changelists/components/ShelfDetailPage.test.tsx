// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RuntimeInfo, ShelfDetail } from "../../../shared/contracts";
import { ShelfDetailPage } from "./ShelfDetailPage";
import { PageRefreshSlotContext } from "../../../app/docking/chrome";

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
  requestGeneration: 1,
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

it("puts an icon-only shelf refresh in the shared target slot", async () => {
  const slot = document.createElement("span");
  document.body.append(slot);
  try {
    await act(async () =>
      root.render(
        <PageRefreshSlotContext.Provider value={slot}>
          <ShelfDetailPage target="42" runtime={runtime} zh={false} />
        </PageRefreshSlotContext.Provider>,
      ),
    );
    const refresh = slot.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh"]',
    )!;
    expect(refresh.title).toBe("Refresh");
    expect(refresh.textContent).toBe("");
    expect(host.querySelector('button[aria-label="Refresh"]')).toBeNull();
    expect(host.textContent).toContain("Cancel");
    const before = backend.getShelfDetail.mock.calls.length;
    await act(async () => refresh.click());
    expect(backend.getShelfDetail.mock.calls.length).toBe(before + 1);
  } finally {
    slot.remove();
  }
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
    expect.objectContaining({
      changeId: 42,
      requestGeneration: 1,
      pageSize: 500,
    }),
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

it("paginates more than 500 shelved files with an opaque cursor and no offset", async () => {
  const files = Array.from({ length: 501 }, (_, index) => ({
    ...detail.files[0],
    depotPath: `//depot/file-${String(index).padStart(3, "0")}.txt`,
  }));
  backend.getShelfDetail
    .mockResolvedValueOnce({
      ...detail,
      files: files.slice(0, 500),
      totalFiles: 501,
      hasMore: true,
      nextCursor: "server-snapshot-cursor",
    })
    .mockResolvedValueOnce({
      ...detail,
      files: files.slice(500),
      totalFiles: 501,
      hasMore: false,
    });
  await act(async () =>
    root.render(<ShelfDetailPage target="42" runtime={runtime} zh={false} />),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const loadMore = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Load more",
  );
  expect(loadMore).toBeDefined();
  await act(async () => loadMore!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(backend.getShelfDetail).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      changeId: 42,
      requestGeneration: 1,
      cursor: "server-snapshot-cursor",
      pageSize: 500,
    }),
  );
  expect(backend.getShelfDetail.mock.calls[1][0]).not.toHaveProperty("offset");
  expect(host.textContent).not.toContain("Load more");
});

it("preserves loaded rows on cursor expiry and restarts from a fresh snapshot", async () => {
  backend.getShelfDetail
    .mockResolvedValueOnce({
      ...detail,
      totalFiles: 501,
      hasMore: true,
      nextCursor: "expiring-cursor",
    })
    .mockRejectedValueOnce({
      code: "cursorExpired",
      message: "The shelf cursor expired; refresh from the first page.",
    })
    .mockResolvedValueOnce({ ...detail, requestGeneration: 2 });
  await act(async () =>
    root.render(<ShelfDetailPage target="42" runtime={runtime} zh={false} />),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  const loadMore = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Load more",
  );
  await act(async () => loadMore!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(host.textContent).toContain("cursor expired");
  expect(host.textContent).toContain("501 files");
  const restart = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Restart",
  );
  await act(async () => restart!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(backend.getShelfDetail).toHaveBeenLastCalledWith(
    expect.objectContaining({
      requestGeneration: 2,
      refresh: true,
    }),
  );
});

it("cancels and isolates stale shelf responses across a runtime generation change", async () => {
  let resolveOld: (value: ShelfDetail) => void = () => undefined;
  const oldResult = new Promise<ShelfDetail>((resolve) => {
    resolveOld = resolve;
  });
  const nextRuntime = { ...runtime, contextGeneration: 8 };
  backend.getShelfDetail.mockReturnValueOnce(oldResult).mockResolvedValueOnce({
    ...detail,
    requestGeneration: 2,
    description: "current generation",
    scope: { ...detail.scope, contextGeneration: 8 },
  });
  await act(async () =>
    root.render(<ShelfDetailPage target="42" runtime={runtime} zh={false} />),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () =>
    root.render(
      <ShelfDetailPage target="42" runtime={nextRuntime} zh={false} />,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  expect(host.textContent).toContain("current generation");
  await act(async () =>
    resolveOld({ ...detail, description: "stale generation" }),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(host.textContent).toContain("current generation");
  expect(host.textContent).not.toContain("stale generation");
  expect(backend.cancelOperation).toHaveBeenCalled();
});

it("keeps resizing in the shelf file list and leaves code-preview columns independent", async () => {
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
  expect(
    host.querySelectorAll('.shelf-file-scroll [role="separator"]'),
  ).toHaveLength(2);
  expect(host.querySelectorAll('.diff-scroll [role="separator"]')).toHaveLength(
    0,
  );
  const code = host.querySelector<HTMLElement>(".diff-line")!;
  expect(code).not.toBeNull();
  expect(code.style.gridTemplateColumns).toBe("");
  const before = code.style.cssText;
  await act(async () =>
    host
      .querySelector('.shelf-file-scroll [role="separator"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
  );
  expect(host.querySelector<HTMLElement>(".diff-line")!.style.cssText).toBe(
    before,
  );
});
