// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  IntegrationTraceBatch,
  RuntimeInfo,
  SubmittedChangeDetail,
} from "../../../shared/contracts";
import { appCache } from "../../../shared/cache/appCache";
const api = vi.hoisted(() => ({
  getIntegrationTrace: vi.fn(),
  cancelOperation: vi.fn(),
  detail: vi.fn(),
}));
vi.mock("../../../infrastructure/backend", () => ({ backend: api }));
vi.mock("../../browsers/graphReads", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readGraphChange: api.detail,
}));
vi.mock("../../../app/dialogs/Dialog", () => ({
  Dialog: ({
    children,
    footer,
  }: {
    children: ReactNode;
    footer: ReactNode;
  }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
import {
  IntegrationTraceDialog,
  readIntegrationBatch,
} from "./IntegrationTraceDialog";
import { setLocale } from "../../../shared/i18n";
const runtime = {
  mode: "mock",
  context: { server: "mock", user: "u", client: "c" },
  contextGeneration: 1,
} as RuntimeInfo;
const detail: SubmittedChangeDetail = {
  changeId: 10,
  description: "Simulated",
  user: "u",
  client: "c",
  time: "2026-01-01",
  jobs: [],
  files: [{ depotPath: "//mock/main/a", revision: 4, action: "edit" }],
  integrationEvidence: [],
  mergeClassification: "normal",
  inspectionStatus: "complete",
};
const batch: IntegrationTraceBatch = {
  records: [
    {
      sourcePath: "//mock/main/a",
      targetPath: "//mock/release/a",
      sourceStart: 3,
      sourceEnd: 4,
      targetStart: 0,
      targetEnd: 1,
      how: "merge into",
      recordChange: 20,
    },
  ],
  incomplete: false,
  warnings: [],
  readAt: 1000,
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  // Components translate through the module-level locale.
  setLocale("en-US");
  appCache.clear();
  vi.clearAllMocks();
  api.detail.mockResolvedValue(detail);
  api.getIntegrationTrace.mockResolvedValue(batch);
  api.cancelOperation.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  appCache.clear();
});
async function render(value = runtime) {
  await act(async () =>
    root.render(
      <IntegrationTraceDialog
        changeId={10}
        runtime={value}
        zh={false}
        onClose={() => {}}
      />,
    ),
  );
}
async function click(label: string) {
  await act(async () => {
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    );
    expect(button).toBeTruthy();
    button!.click();
  });
}
it("queries only explicitly, displays partial honestly, and retains evidence after refresh failure", async () => {
  api.getIntegrationTrace.mockResolvedValue({
    ...batch,
    incomplete: true,
    warnings: ["Truncated simulated batch"],
  });
  await render();
  expect(api.getIntegrationTrace).not.toHaveBeenCalled();
  await click("Query integration records");
  expect(host.textContent).toContain("Partial records / unknown");
  expect(host.textContent).toContain("Truncated simulated batch");
  expect(host.textContent).not.toContain("Full file record coverage");
  expect(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Read next file batch",
    )?.disabled,
  ).toBe(true);
  api.getIntegrationTrace.mockRejectedValue(new Error("Offline simulated"));
  await click("Refresh investigation");
  expect(host.textContent).toContain("//mock/release/a");
  expect(host.textContent).toContain("Offline simulated");
});
it("reuses cache without requests and sends only frozen wire fields", async () => {
  const request = {
    scope: {
      server: "mock",
      user: "u",
      client: "c",
      workspace: "",
      contextGeneration: 1,
      fileIdentity: "//change/10",
    },
    paths: ["//mock/main/a"],
  };
  await readIntegrationBatch(request, "mock", new AbortController().signal);
  await readIntegrationBatch(request, "mock", new AbortController().signal);
  expect(api.getIntegrationTrace).toHaveBeenCalledTimes(1);
  expect(Object.keys(api.getIntegrationTrace.mock.calls[0][0]).sort()).toEqual([
    "operationId",
    "paths",
    "refresh",
    "scope",
  ]);
});
it("drops prior-connection evidence and rejects a late response after unmount", async () => {
  let resolve!: (value: IntegrationTraceBatch) => void;
  api.getIntegrationTrace.mockImplementation(
    () =>
      new Promise<IntegrationTraceBatch>((done) => {
        resolve = done;
      }),
  );
  await render();
  await click("Query integration records");
  await render({ ...runtime, contextGeneration: 2 });
  await act(async () => resolve(batch));
  expect(host.textContent).not.toContain("//mock/release/a");
  expect(api.cancelOperation).toHaveBeenCalledTimes(1);
});
it("passes CL detail P4 escapes unchanged and never decodes literal filespec characters", async () => {
  const depotPath = "//mock/main/a%40b%23c%2Ad%25e%2540";
  api.detail.mockResolvedValue({
    ...detail,
    files: [{ ...detail.files[0], depotPath }],
  });
  api.getIntegrationTrace.mockResolvedValue({ ...batch, records: [] });
  await render();
  await click("Query integration records");
  expect(api.getIntegrationTrace.mock.calls[0][0].paths).toEqual([depotPath]);
});
it("cancels in-flight reads and never presents their late response as complete coverage", async () => {
  let resolve!: (value: IntegrationTraceBatch) => void;
  api.getIntegrationTrace.mockImplementation(
    () =>
      new Promise<IntegrationTraceBatch>((done) => {
        resolve = done;
      }),
  );
  await render();
  await click("Query integration records");
  await click("Cancel reads");
  await act(async () => resolve(batch));
  expect(api.cancelOperation).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Cancelled; current results incomplete");
  expect(host.textContent).not.toContain("Full file record coverage");
  expect(host.textContent).not.toContain("//mock/release/a");
});
it("retains earlier successful batches when a later batch fails and resumes that batch", async () => {
  api.detail.mockResolvedValue({
    ...detail,
    files: Array.from({ length: 21 }, (_, index) => ({
      ...detail.files[0],
      depotPath: index === 0 ? "//mock/main/a" : `//mock/main/file-${index}`,
    })),
  });
  api.getIntegrationTrace
    .mockResolvedValueOnce(batch)
    .mockRejectedValueOnce(new Error("simulated second batch failure"));
  await render();
  await click("Query integration records");
  expect(host.textContent).toContain("//mock/release/a");
  expect(host.textContent).toContain("20/21");
  expect(host.textContent).toContain("simulated second batch failure");
  expect(host.textContent).not.toContain("Full file record coverage");
  api.getIntegrationTrace.mockResolvedValue({ ...batch, records: [] });
  await click("Read next file batch");
  expect(api.getIntegrationTrace.mock.calls[2][0].paths).toEqual([
    "//mock/main/file-20",
  ]);
  expect(host.textContent).toContain("//mock/release/a");
});
it("finds a forward destination in an eleven-file CL and refreshes cached empty results", async () => {
  api.detail.mockResolvedValue({
    ...detail,
    files: Array.from({ length: 11 }, (_, index) => ({
      ...detail.files[0],
      depotPath: index === 0 ? "//mock/main/a" : `//mock/main/file-${index}`,
    })),
  });
  api.getIntegrationTrace
    .mockResolvedValueOnce({ ...batch, records: [] })
    .mockResolvedValueOnce(batch);
  await render();
  await click("Query integration records");
  expect(host.textContent).toContain("11/11");
  expect(host.textContent).toContain("Backend returned 0 records");
  await click("Refresh investigation");
  expect(api.getIntegrationTrace).toHaveBeenCalledTimes(2);
  expect(api.getIntegrationTrace.mock.calls[1][0].refresh).toBe(true);
  expect(host.textContent).toContain("//mock/release/a");
  expect(host.textContent).toContain("Record CL 20");
});
it("reports incompatible responses and missing native commands as errors, not empty results", async () => {
  api.getIntegrationTrace.mockResolvedValue({ records: [] });
  await render();
  await click("Query integration records");
  expect(host.textContent).toContain("response is incompatible");
  expect(host.textContent).not.toContain("Backend returned 0 records");
  api.getIntegrationTrace.mockRejectedValue(
    new Error("Command get_integration_trace not found"),
  );
  await click("Refresh investigation");
  expect(host.textContent).toContain("Command get_integration_trace not found");
  expect(host.textContent).not.toContain("Backend returned 0 records");
});
it("distinguishes returned records rejected by exact source revision from a backend empty response", async () => {
  api.getIntegrationTrace.mockResolvedValue({
    ...batch,
    records: [{ ...batch.records[0], sourceStart: 4, sourceEnd: 5 }],
  });
  await render();
  await click("Query integration records");
  expect(host.textContent).toContain(
    "1 records returned, but their source paths or revision ranges do not match this CL",
  );
  expect(host.textContent).not.toContain("Backend returned 0 records");
});
