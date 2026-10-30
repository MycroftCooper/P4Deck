import { expect, it } from "vitest";
import type {
  PendingChange,
  WorkflowTargetSnapshot,
} from "../../shared/contracts";
import { mergeWorkflowPending } from "./workflowRefresh";

const change = (
  id: number,
  files: string[] = [],
  shelves: string[] = [],
): PendingChange => ({
  id,
  description: `CL ${id}`,
  user: "tester",
  client: "workspace",
  status: "pending",
  jobs: [],
  files: files.map((depotPath) => ({ depotPath, action: "edit" })),
  shelvedFiles: shelves.map((depotPath) => ({ depotPath, action: "edit" })),
});
const target: WorkflowTargetSnapshot = {
  kind: "unshelve",
  server: "server:1666",
  user: "tester",
  client: "workspace",
  workspace: "/work",
  contextGeneration: 1,
  sourceChangeId: 10,
  targetChangeId: 0,
  depotPaths: ["//depot/a"],
};

it("locally merges only workflow-related changelists and preserves unrelated state", () => {
  const current = [
    change(0),
    change(10, [], ["//depot/a"]),
    change(20, ["//depot/unrelated"]),
  ];
  const unrelated = current[2];
  const merged = mergeWorkflowPending(
    current,
    [
      change(0, ["//depot/a"]),
      change(10, [], ["//depot/a"]),
      change(20, ["//depot/unrelated"]),
    ],
    target,
  );
  expect(merged.find((item) => item.id === 0)?.files).toHaveLength(1);
  expect(merged.find((item) => item.id === 20)).toBe(unrelated);
});
