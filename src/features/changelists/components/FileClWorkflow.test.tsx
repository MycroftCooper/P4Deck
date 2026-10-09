// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  dialogHarness,
  dialogButton,
  chooseSelect,
} from "../../../app/dialogs/testHarness";
import { FileClWorkflow } from "./FileClWorkflow";
import { backend } from "../../../infrastructure/backend";
import type {
  PendingChange,
  PendingChangePage,
  WorkspaceNode,
} from "../../../shared/contracts/types";
const harness = dialogHarness();
afterEach(() => vi.restoreAllMocks());
const nodes: WorkspaceNode[] = ["a", "b"].map((name) => ({
  id: name,
  name,
  kind: "file",
  state: "openedEdit",
  absolutePath: `/work/${name}`,
  relativePath: name,
  depotPath: `//depot/${name}`,
}));
const changes: PendingChange[] = [0, 10].map((id, index) => ({
  id,
  description: "CL",
  user: "tester",
  client: "workspace",
  status: "pending",
  jobs: [],
  files: [
    { depotPath: nodes[index].depotPath!, action: "edit", state: "openedEdit" },
  ],
  shelvedFiles: [],
}));
const page = (value: PendingChange[]): PendingChangePage => ({
  requestGeneration: 0,
  defaultChange: value.find((change) => change.id === 0),
  items: value.filter((change) => change.id > 0),
  hasMore: false,
  partial: false,
  stats: {
    scannedCount: value.length,
    matchedCount: value.length,
    truncatedBySafetyLimit: false,
  },
});
it("loads once and skips selected files already in the move destination", async () => {
  const query = vi
    .spyOn(backend, "queryPendingChanges")
    .mockResolvedValue(page(changes));
  await harness.render(
    <FileClWorkflow
      nodes={nodes}
      mode="moveFiles"
      source={null}
      client="workspace"
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
    />,
  );
  await chooseSelect("10");
  expect(document.body.textContent).toContain(
    "已跳过本来就在目标 CL 的文件：1",
  );
  expect(document.body.textContent).toContain(
    "Default, CL 10 → CL 10 · 1 个文件",
  );
  expect(query).toHaveBeenCalledOnce();
});
it("makes cross-CL shelving choose an explicit group without closing the parent", async () => {
  vi.spyOn(backend, "queryPendingChanges").mockResolvedValue(page(changes));
  const close = vi.fn();
  await harness.render(
    <FileClWorkflow
      nodes={nodes}
      mode="shelve"
      source={null}
      client="workspace"
      connectionKey="connection-a"
      zh
      onDismiss={close}
    />,
  );
  expect(document.body.textContent).toContain("所选文件分属多个 CL");
  await act(async () => dialogButton("CL 10 · 1 个文件").click());
  expect(document.body.textContent).toContain("搁置文件");
  await act(async () => dialogButton("返回 CL 分组").click());
  expect(document.body.textContent).toContain("请选择本次搁置的来源组");
  expect(close).not.toHaveBeenCalled();
});
it("shows query failures and does not silently discard unknown files", async () => {
  const query = vi
    .spyOn(backend, "queryPendingChanges")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(page([]));
  await harness.render(
    <FileClWorkflow
      nodes={nodes}
      mode="moveFiles"
      source={null}
      client="workspace"
      connectionKey="connection-a"
      zh
      onDismiss={vi.fn()}
    />,
  );
  expect(document.body.textContent).toContain("offline");
  await act(async () => dialogButton("重试").click());
  expect(document.body.textContent).toContain("不会忽略这些文件后操作其余文件");
  expect(query).toHaveBeenCalledTimes(2);
});
