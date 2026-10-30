import { BranchMappingsPage } from "../../src/features/browsers/components/BranchMappingsPage";
import { ShelfDetailPage } from "../../src/features/changelists/components/ShelfDetailPage";
import { createRoot } from "react-dom/client";
import { useRef } from "react";
import { DescriptionTraceDialog } from "../../src/features/changelists/components/DescriptionTraceDialog";
import { HistoryTable } from "../../src/features/browsers/components/HistoryTable";
import { ResizableTable } from "../../src/app/context-menu/ResizableTable";
import { backend } from "../../src/infrastructure/backend";
import type {
  ChangelistSummary,
  FileRevision,
  RuntimeInfo,
} from "../../src/shared/contracts";

if ("__TAURI_INTERNALS__" in window)
  throw new Error(
    "Visual fixture requires a plain browser without a native bridge",
  );
const host = document.createElement("div");
document.body.append(host);
host.style.cssText =
  "height:100vh;display:flex;flex-direction:column;min-height:0";
const root = createRoot(host);
document.getElementById("root")!.style.display = "none";
const runtime = {
  mode: "mock",
  contextGeneration: 1,
  context: {
    server: "synthetic.invalid",
    user: "synthetic",
    client: "synthetic",
  },
  connection: { state: "connected" },
} as RuntimeInfo;
const rows: ChangelistSummary[] = Array.from({ length: 80 }, (_, index) => ({
  id: 200 + index,
  user: `author-${index}`,
  client: `workspace-${index}-` + "long-workspace-name-".repeat(5),
  description: `${("Synthetic long description 中文换行验证 " + index + "\n").repeat(20)}合并来源: //synthetic/main\nCL号: 100`,
  time: "2026-01-02T12:00:00Z",
  status: "submitted",
  jobs: [],
  fileCount: 0,
  hasShelf: false,
  mergeClassification: "unknown",
}));
backend.queryChangelists = async (query) => ({
  requestGeneration: query.requestGeneration,
  items: rows,
  hasMore: false,
  stats: {
    scannedCount: rows.length,
    matchedCount: rows.length,
    hiddenReliableMergeCount: 0,
    truncatedBySafetyLimit: false,
  },
});
backend.cancelOperation = async () => {};
export function showTrace() {
  root.render(
    <DescriptionTraceDialog
      changeId={100}
      sourceChange={{
        description: "Source fixture",
        time: "2026-01-01T12:00:00Z",
      }}
      seedCandidates={rows}
      runtime={runtime}
      zh={false}
      onClose={() => root.render(null)}
    />,
  );
}
function Representatives() {
  const scroll = useRef<HTMLDivElement>(null);
  const history = Array.from({ length: 100 }, (_, index) => ({
    depotPath: "//synthetic/file",
    revision: 100 - index,
    changelistId: 500 - index,
    action: "edit",
    fileType: "text",
    integrations: [],
    time: "2026-01-02T12:00:00Z",
    user: "synthetic",
    description: "History description\n".repeat(8),
  })) as FileRevision[];
  return (
    <main style={{ padding: 20 }}>
      <h2>Shared native table</h2>
      <div style={{ overflow: "auto", maxHeight: 240 }}>
        <ResizableTable
          tableId="visual-native"
          defaults={[300, 200, 260]}
          minimums={[100, 80, 100]}
          className="diagnostic-table"
        >
          <thead>
            <tr>
              <th>Workspace</th>
              <th>Time</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map((row) => (
              <tr key={row.id}>
                <td>{row.client}</td>
                <td>{row.time}</td>
                <td>Native cell wrapping 中文</td>
              </tr>
            ))}
          </tbody>
        </ResizableTable>
      </div>
      <h2>History virtual table</h2>
      <div ref={scroll} style={{ height: 360, overflow: "auto" }}>
        <HistoryTable
          rows={history}
          scroll={scroll}
          zh={false}
          isSelected={() => false}
          onSelect={() => {}}
          rowMenu={() => ({
            "data-menu-object": "H01",
            onContextMenu() {},
            onKeyDown() {},
          })}
        />
      </div>
    </main>
  );
}
export function showRepresentatives() {
  root.render(<Representatives />);
}

export function showShelf() {
  const file = {
    depotPath: "//synthetic/shelved-file.ts",
    action: "edit",
    revision: 3,
    fileType: "text",
    size: 200,
    binary: false,
    symlink: false,
    deleted: false,
  };
  backend.getShelfDetail = async (request) => ({
    requestGeneration: request.requestGeneration,
    scope: {
      server: runtime.context.server,
      user: runtime.context.user,
      client: runtime.context.client,
      workspace: "",
      contextGeneration: 1,
      changeId: 100,
    },
    description: "Synthetic shelf",
    time: "2026-01-01T12:00:00Z",
    owner: "synthetic",
    user: "synthetic",
    client: "synthetic",
    jobs: [],
    files: [file],
    totalFiles: 1,
    hasMore: false,
    truncated: false,
    inspectionStatus: "complete",
    operationIds: [],
    cacheFreshness: "fresh",
  });
  backend.getShelfFilePreview = async () => ({
    side: {
      reference: { kind: "shelf", changeId: 100 },
      label: "Shelf @=100",
      depotPath: file.depotPath,
      fileType: "text",
      size: 200,
      exists: true,
      binary: false,
    },
    content: "const synthetic = true;\n".repeat(30),
    encoding: "UTF-8",
    truncated: false,
    unsupported: false,
    operationIds: [],
  });
  root.render(
    <ShelfDetailPage
      target={`100::${encodeURIComponent(file.depotPath)}`}
      runtime={runtime}
      zh={false}
    />,
  );
}

export function showBranches() {
  backend.queryBranchMappings = async (query) => ({
    requestGeneration: query.requestGeneration,
    scope: {
      server: runtime.context.server,
      user: runtime.context.user,
      client: runtime.context.client,
      contextGeneration: 1,
    },
    items: Array.from({ length: 81 }, (_, index) => ({
      name: `synthetic-branch-${String(index).padStart(3, "0")}-${"long-name-".repeat(index % 4)}`,
      owner: `owner-${index}`,
      description: `Synthetic description ${index} 中文 long text\n`.repeat(
        1 + (index % 8),
      ),
      options: index % 2 ? "locked" : "unlocked",
      update: "2026/10/28 10:00:00",
      access: "2026/10/28 11:00:00",
    })),
    hasMore: false,
    partial: false,
    truncated: false,
    stats: {
      scannedCount: 81,
      matchedCount: 81,
      returnedCount: 81,
      invalidRecordCount: 0,
      safetyLimit: 5000,
    },
    operationIds: [],
    simulated: true,
  });
  root.render(<BranchMappingsPage runtime={runtime} zh={false} />);
}
