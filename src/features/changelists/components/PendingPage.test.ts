import { expect, it } from "vitest";
import type {
  PendingChange,
  PendingChangeMutationResult,
} from "../../../shared/contracts";
import { mergePendingMutation } from "./PendingPage";

const change = (id: number, description = `CL ${id}`): PendingChange => ({
  id,
  description,
  user: "tester",
  client: "workspace",
  status: "pending",
  jobs: [],
  files: [],
  shelvedFiles: [],
});
const result = (
  affectedChanges: number[],
  refreshedChanges: PendingChange[],
): PendingChangeMutationResult => ({
  operation: {
    operationId: "op",
    exitCode: 0,
    durationMs: 1,
    events: [],
  },
  affectedChanges,
  affectedPaths: [],
  refreshedChanges,
});

it("merges only affected create/edit changelists and preserves unrelated objects", () => {
  const original = [change(0), change(10), change(5)];
  const unrelated = original[2];
  const created = mergePendingMutation(
    original,
    result([20], [change(20, "Created")]),
  );
  const edited = mergePendingMutation(
    created,
    result([10], [{ ...change(10, "Edited"), jobs: ["JOB-1"] }]),
  );
  expect(edited.map((item) => item.id)).toEqual([0, 20, 10, 5]);
  expect(edited.find((item) => item.id === 10)).toMatchObject({
    description: "Edited",
    jobs: ["JOB-1"],
  });
  expect(edited.find((item) => item.id === 5)).toBe(unrelated);
});

it("removes an affected changelist absent from the authoritative refresh", () => {
  expect(
    mergePendingMutation(
      [change(0), change(10), change(5)],
      result([10], []),
    ).map((item) => item.id),
  ).toEqual([0, 5]);
});

it("replaces both source and target snapshots after a move", () => {
  const moved = mergePendingMutation(
    [change(0), change(10), change(5)],
    result(
      [0, 10],
      [
        { ...change(0), files: [] },
        {
          ...change(10),
          files: [{ depotPath: "//depot/a", action: "edit" }],
        },
      ],
    ),
  );
  expect(moved.find((item) => item.id === 10)?.files).toHaveLength(1);
  expect(moved.find((item) => item.id === 5)?.description).toBe("CL 5");
});

it("keeps the previous snapshots when the authoritative refresh failed", () => {
  const original = [change(0), change(10)];
  const incomplete = {
    ...result([0, 10], []),
    refreshError: "server unreachable",
  };
  expect(mergePendingMutation(original, incomplete)).toBe(original);
});
