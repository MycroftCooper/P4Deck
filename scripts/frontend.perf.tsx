import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ContextMenuProvider } from "../src/app/context-menu/ContextMenu";
import {
  MenuEnvironment,
  type MenuEnvironmentValue,
} from "../src/app/context-menu/environment";
import { PendingFileList } from "../src/features/changelists/components/PendingFileList";
import {
  mergePendingMutation,
  PendingPage,
} from "../src/features/changelists/components/PendingPage";
import { backend } from "../src/infrastructure/backend";
import { filterPendingChanges } from "../src/features/changelists/pendingQueries";
import {
  filterWorkspaceNodes,
  searchWorkspaceNodes,
} from "../src/features/files/fileListModel";
import { defaultUi } from "../src/features/settings/preferences";
import { mergeSearchItems } from "../src/features/search/searchModel";
import type {
  GlobalSearchItem,
  PendingChange,
  PendingFile,
  RuntimeInfo,
  WorkspaceNode,
} from "../src/shared/contracts";
import { messages } from "../src/shared/i18n";

const WARMUP_ROUNDS = 7;
const MEASURED_ROUNDS = 25;
const DOCUMENTED_SEARCH_FILTER_THRESHOLD_MS = 50;
let sink: unknown;

interface TimingResult {
  name: string;
  datasetSize: number;
  warmupRounds: number;
  measuredRounds: number;
  p50Ms: number;
  p95Ms: number;
  totalMs: number;
  heapDeltaBytes: number;
  rssDeltaBytes: number;
  thresholdMs: number | null;
  passed: boolean;
  note: string;
}

interface StructuralResult {
  name: string;
  datasetSize: number;
  mountedRows: number;
  maximumMountedRows: number;
  totalVirtualHeightPx: number;
  passed: boolean;
  note: string;
}

const timings: TimingResult[] = [];
const structures: StructuralResult[] = [];

function rounded(value: number) {
  return Number(value.toFixed(3));
}

function percentile(sorted: readonly number[], percentileValue: number) {
  return sorted[Math.ceil(sorted.length * percentileValue) - 1];
}

function benchmark(
  name: string,
  datasetSize: number,
  operation: () => unknown,
  thresholdMs: number | null,
  note: string,
) {
  for (let index = 0; index < WARMUP_ROUNDS; index += 1) sink = operation();
  globalThis.gc?.();
  const memoryBefore = process.memoryUsage();
  const samples: number[] = [];
  for (let index = 0; index < MEASURED_ROUNDS; index += 1) {
    const started = performance.now();
    sink = operation();
    samples.push(performance.now() - started);
  }
  const memoryAfter = process.memoryUsage();
  const sorted = [...samples].sort((left, right) => left - right);
  const result: TimingResult = {
    name,
    datasetSize,
    warmupRounds: WARMUP_ROUNDS,
    measuredRounds: MEASURED_ROUNDS,
    p50Ms: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    totalMs: rounded(samples.reduce((sum, value) => sum + value, 0)),
    heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
    thresholdMs,
    passed: thresholdMs === null || percentile(sorted, 0.95) < thresholdMs,
    note,
  };
  timings.push(result);
  expect(result.passed, `${name} p95 ${result.p95Ms} ms`).toBe(true);
}

function seeded(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function workspaceDataset(size: number): WorkspaceNode[] {
  const random = seeded(0x5044_4543);
  const states: WorkspaceNode["state"][] = [
    "controlled",
    "openedEdit",
    "openedAdd",
    "openedDelete",
    "outOfDate",
    "conflicted",
    "untracked",
  ];
  return Array.from({ length: size }, (_, index) => {
    const unicode = index % 17 === 0 ? "世界-данные-résumé-" : "";
    const deep = Array.from(
      { length: 3 + Math.floor(random() * 7) },
      (_value, segment) => `segment-${segment}-${index % 997}`,
    ).join("/");
    const name = `${unicode}asset-${String(index).padStart(6, "0")}.${index % 9 === 0 ? "uasset" : "cpp"}`;
    return {
      id: `node-${index}`,
      name,
      kind: "file",
      absolutePath: `C:\\workspace\\${deep.replaceAll("/", "\\")}\\${name}`,
      relativePath: `${deep}/${name}`,
      depotPath: `//depot/main/${deep}/${name}`,
      state: states[index % states.length],
      revision: index % 211,
      headRevision: (index % 211) + 1,
      changelistId: index % 13 === 0 ? index % 500 : undefined,
    };
  });
}

function searchDataset(size: number, offset = 0): GlobalSearchItem[] {
  const kinds: GlobalSearchItem["kind"][] = [
    "submittedChange",
    "pendingChange",
    "workspaceFile",
    "depotFile",
    "job",
  ];
  return Array.from({ length: size }, (_, localIndex) => {
    const index = localIndex + offset;
    const kind = kinds[index % kinds.length];
    return {
      identity: `${kind}:${index}`,
      kind,
      title: `世界-${kind}-${index}`,
      summary: `${"long description / ".repeat(index % 11)}JOB-${index % 4000}`,
      target: { type: "job", jobId: `JOB-${index}` },
      matchedFields: ["title", "summary"],
      highlights: [{ field: "title", start: 0, end: 2 }],
      rank: index % 101,
    } as GlobalSearchItem;
  });
}

function pendingDataset(size: number): PendingChange[] {
  return Array.from({ length: size }, (_, index) => ({
    id: index,
    description:
      index % 29 === 0
        ? `${"极端描述 with Unicode and long content ".repeat(12)}${index}`
        : `Change ${index}`,
    user: index % 3 === 0 ? "测试用户" : `user-${index % 31}`,
    client: `client-${index % 47}`,
    status: "pending",
    jobs: Array.from(
      { length: index % 6 },
      (_value, job) => `JOB-${job}-${index}`,
    ),
    files: [
      {
        depotPath: `//depot/main/路径/${index}/file-${index}.cpp`,
        action: ["add", "edit", "delete", "branch"][index % 4],
        state: index % 4 === 0 ? "openedAdd" : "openedEdit",
      },
    ],
    shelvedFiles: [],
  }));
}

const fiftyThousand = workspaceDataset(50_000);
const hundredThousand = workspaceDataset(100_000);
const currentSearch = searchDataset(50_000);
const incomingSearch = [
  ...searchDataset(25_000),
  ...searchDataset(25_000, 50_000),
];
const pendingChanges = pendingDataset(50_000);

describe("documented frontend performance targets", () => {
  it("gates 50,000-row production filtering at p95 < 50 ms", () => {
    benchmark(
      "workspace status filter (50k)",
      50_000,
      () => filterWorkspaceNodes(fiftyThousand, "changed"),
      DOCUMENTED_SEARCH_FILTER_THRESHOLD_MS,
      "Project charter: 50,000-row search/filter must complete in under 50 ms.",
    );
  });

  it("gates 50,000-row production Unicode search at p95 < 50 ms", () => {
    benchmark(
      "resource Unicode name search (50k)",
      50_000,
      () => searchWorkspaceNodes(fiftyThousand, "世界"),
      DOCUMENTED_SEARCH_FILTER_THRESHOLD_MS,
      "Uses the ResourceExplorer production search function.",
    );
  });

  it("gates production search-page deduplication at p95 < 50 ms", () => {
    benchmark(
      "global search merge/deduplicate (50k + 50k)",
      100_000,
      () => mergeSearchItems(currentSearch, incomingSearch),
      DOCUMENTED_SEARCH_FILTER_THRESHOLD_MS,
      "Half the incoming identities overlap; expected output is 75,000 rows.",
    );
    expect((sink as GlobalSearchItem[]).length).toBe(75_000);
  });

  it("records 100,000-row production filtering without inventing a numeric target", () => {
    benchmark(
      "workspace status filter (100k, informational)",
      100_000,
      () => filterWorkspaceNodes(hundredThousand, "incoming"),
      null,
      "The charter defines a numeric threshold for 50k only; this 100k result is informational.",
    );
  });

  it("records production Pending merge/sort cost", () => {
    const refreshed = pendingChanges.slice(10_000, 10_064).map((change) => ({
      ...change,
      description: `${change.description} refreshed`,
    }));
    benchmark(
      "pending changelist merge/sort (50k)",
      50_000,
      () =>
        mergePendingMutation(pendingChanges, {
          operation: {
            operationId: "perf",
            exitCode: 0,
            events: [],
            durationMs: 0,
          },
          affectedChanges: refreshed.map((change) => change.id),
          affectedPaths: refreshed.flatMap((change) =>
            change.files.map((file) => file.depotPath),
          ),
          refreshedChanges: refreshed,
        }),
      null,
      "Production merge, replacement, and descending CL sort; no documented numeric limit.",
    );
  });

  it("gates 50,000 Pending combination filtering at p95 < 50 ms", () => {
    benchmark(
      "pending changelist combination filter (50k)",
      50_000,
      () => filterPendingChanges(pendingChanges, "世界 job-4 path"),
      DOCUMENTED_SEARCH_FILTER_THRESHOLD_MS,
      "Production Pending keyword matcher over ID, description, jobs, and depot paths.",
    );
  });
});

const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/PERF",
  contextGeneration: 1,
  context: { server: "fixture:1666", user: "perf", client: "perf-client" },
  connection: {
    state: "connected",
    message: "connected",
    recovery: "none",
    server: "fixture:1666",
  },
};
const environment: MenuEnvironmentValue = {
  runtime,
  connectionKey: "perf",
  commandBusy: false,
  openPage: vi.fn(),
  searchInDirectory: vi.fn(),
  navigate: vi.fn(),
  openFilePage: vi.fn(),
  preferences: {
    locale: "en-US",
    setLocale: vi.fn(),
    theme: "light",
    setTheme: vi.fn(),
    ui: defaultUi,
    setUi: vi.fn(),
    t: messages["en-US"],
    zh: false,
  },
};
let host: HTMLDivElement;
let root: Root;

describe("100,000-row production virtual-list structure", () => {
  beforeAll(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  it("mounts only the Pending file window", async () => {
    const files: PendingFile[] = hundredThousand.map((node, index) => ({
      depotPath: node.depotPath!,
      action: ["add", "edit", "delete", "move/add"][index % 4],
      state: node.state,
    }));
    await act(async () =>
      root.render(
        <ContextMenuProvider scope="perf-pending" zh={false}>
          <MenuEnvironment.Provider value={environment}>
            <PendingFileList files={files} changeId={99} refresh={vi.fn()} />
          </MenuEnvironment.Provider>
        </ContextMenuProvider>,
      ),
    );
    await act(
      async () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const list = host.querySelector<HTMLElement>(
      '[data-testid="pending-file-virtual-list"]',
    )!;
    // PendingFileList renders ARIA grid rows (role="row"), not listbox options.
    const mountedRows = list.querySelectorAll("[data-pending-file-index]").length;
    const totalVirtualHeightPx = Number.parseInt(
      list.querySelector<HTMLElement>(".pending-file-spacer")!.style.height,
      10,
    );
    const result: StructuralResult = {
      name: "PendingFileList DOM window",
      datasetSize: 100_000,
      mountedRows,
      maximumMountedRows: 40,
      totalVirtualHeightPx,
      passed:
        mountedRows > 0 &&
        mountedRows < 40 &&
        // 100,000 rows at the production 30px estimate.
        totalVirtualHeightPx === 3_000_000,
      note: "Structural DOM bound only; it is not a native scrolling/FPS or screen-reader result.",
    };
    structures.push(result);
    expect(result.passed).toBe(true);
  });

  it("mounts only the Pending changelist card window", async () => {
    const changes = pendingDataset(100_000);
    const query = vi
      .spyOn(backend, "queryPendingChanges")
      .mockImplementation((request) =>
        Promise.resolve({
          requestGeneration: request.requestGeneration,
          defaultChange: changes[0],
          items: changes.slice(1),
          hasMore: false,
          partial: false,
          stats: {
            scannedCount: 100_000,
            matchedCount: 99_999,
            truncatedBySafetyLimit: false,
          },
        }),
      );
    await act(async () =>
      root.render(
        <ContextMenuProvider scope="perf-pending-changes" zh={false}>
          <MenuEnvironment.Provider value={environment}>
            <PendingPage
              t={messages["en-US"]}
              clientName="perf-client"
              connectionKey="perf"
              demo={false}
              ready
            />
          </MenuEnvironment.Provider>
        </ContextMenuProvider>,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    const list = host.querySelector<HTMLElement>(
      '[data-testid="pending-change-virtual-list"]',
    )!;
    const mountedRows = list.querySelectorAll(".pending-card").length;
    const totalVirtualHeightPx = Number.parseInt(
      list.querySelector<HTMLElement>(".pending-change-spacer")!.style.height,
      10,
    );
    const result: StructuralResult = {
      name: "PendingPage changelist DOM window",
      datasetSize: 100_000,
      mountedRows,
      maximumMountedRows: 40,
      totalVirtualHeightPx,
      passed:
        mountedRows > 0 &&
        mountedRows < 40 &&
        // Dynamic card measurement keeps an average card above 50px for 100k rows.
        totalVirtualHeightPx > 5_000_000,
      note: "Production PendingPage with dynamic card measurement; structural DOM bound only.",
    };
    structures.push(result);
    query.mockRestore();
    expect(result.passed).toBe(true);
  });
});

afterAll(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  const generatedAt = new Date().toISOString();
  const cpu = os.cpus()[0];
  const vitestVersion = (
    JSON.parse(
      readFileSync(
        path.join(process.cwd(), "node_modules", "vitest", "package.json"),
        "utf8",
      ),
    ) as { version: string }
  ).version;
  const metadata = {
    generatedAt,
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: cpu?.model ?? "unknown",
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
    vitest: vitestVersion,
    seed: "0x50444543",
    warmupRounds: WARMUP_ROUNDS,
    measuredRounds: MEASURED_ROUNDS,
    caveat:
      "Local synthetic result only; not Windows/macOS fixed-device certification or native Tauri FPS/accessibility evidence.",
  };
  const passed =
    timings.every((result) => result.passed) &&
    structures.every((result) => result.passed);
  const report = { schemaVersion: 1, passed, metadata, timings, structures };
  const outputDirectory = path.join(process.cwd(), "artifacts", "performance");
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    path.join(outputDirectory, "frontend-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const timingRows = timings
    .map(
      (result) =>
        `| ${result.name} | ${result.datasetSize.toLocaleString("en-US")} | ${result.p50Ms} | ${result.p95Ms} | ${result.thresholdMs === null ? "informational" : `< ${result.thresholdMs}`} | ${result.passed ? "PASS" : "FAIL"} |`,
    )
    .join("\n");
  const structureRows = structures
    .map(
      (result) =>
        `| ${result.name} | ${result.datasetSize.toLocaleString("en-US")} | ${result.mountedRows} | < ${result.maximumMountedRows} | ${result.passed ? "PASS" : "FAIL"} |`,
    )
    .join("\n");
  const markdown = `# P4Deck frontend performance report\n\nGenerated: ${generatedAt}\n\n> ${metadata.caveat}\n\n## Environment\n\n- OS: ${metadata.platform} ${metadata.release} (${metadata.arch})\n- Runtime: Node ${metadata.node}; Vitest ${metadata.vitest}\n- CPU: ${metadata.cpu} (${metadata.logicalCpuCount} logical CPUs)\n- Warmup/measured rounds: ${WARMUP_ROUNDS}/${MEASURED_ROUNDS}; fixed seed ${metadata.seed}\n\n## Timings\n\n| Production path | Rows | p50 ms | p95 ms | Gate | Result |\n|---|---:|---:|---:|---:|---|\n${timingRows}\n\nMemory deltas are available in the JSON report. They are sampled before/after each case and are not a process peak guarantee.\n\n## Structural assertions\n\n| Production component | Rows | Mounted rows | Bound | Result |\n|---|---:|---:|---:|---|\n${structureRows}\n\nThis verifies bounded DOM structure only. Native Tauri scrolling/FPS, focus behavior under a real accessibility tree, and Windows/macOS fixed-device certification remain unverified.\n`;
  writeFileSync(path.join(outputDirectory, "frontend-latest.md"), markdown);
  console.log(`\nP4Deck performance: ${passed ? "PASS" : "FAIL"}`);
  for (const result of timings)
    console.log(
      `  ${result.name}: p50=${result.p50Ms}ms p95=${result.p95Ms}ms ${result.thresholdMs === null ? "(informational)" : `(gate <${result.thresholdMs}ms)`}`,
    );
  for (const result of structures)
    console.log(
      `  ${result.name}: ${result.mountedRows}/${result.datasetSize.toLocaleString("en-US")} rows mounted`,
    );
  console.log(`  JSON: ${path.join(outputDirectory, "frontend-latest.json")}`);
  console.log(
    `  Markdown: ${path.join(outputDirectory, "frontend-latest.md")}`,
  );
});
