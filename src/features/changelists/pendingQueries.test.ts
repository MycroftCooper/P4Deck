import { afterEach, expect, it, vi } from "vitest";
import { backend } from "../../infrastructure/backend";
import type {
  PendingChange,
  PendingChangePage,
} from "../../shared/contracts/types";
import {
  pendingQuery,
  pendingQueryKey,
  queryAllPendingChanges,
  filterPendingChanges,
} from "./pendingQueries";

const change = (id: number): PendingChange => ({
  id,
  description: `CL ${id}`,
  user: "u",
  client: "c",
  status: "pending",
  jobs: [],
  files: [],
  shelvedFiles: [],
});
it("searches cached pending CL metadata and files, excluding Jobs", () => {
  const cached = [
    {
      ...change(12),
      description: "Fix water",
      jobs: ["JOB-9"],
      files: [{ depotPath: "//depot/a.mat", action: "edit" }],
    },
  ];
  expect(filterPendingChanges(cached, "water").map((item) => item.id)).toEqual([
    12,
  ]);
  expect(filterPendingChanges(cached, "a.mat").map((item) => item.id)).toEqual([
    12,
  ]);
  expect(filterPendingChanges(cached, "JOB-9")).toEqual([]);
  expect(filterPendingChanges(cached, "").map((item) => item.id)).toEqual([12]);
});

afterEach(() => vi.restoreAllMocks());

it("rejects incomplete CL reads instead of treating an unknown target set as Default-only", async () => {
  vi.spyOn(backend, "queryPendingChanges").mockResolvedValue({
    requestGeneration: 0,
    items: [],
    hasMore: false,
    partial: true,
    stats: { scannedCount: 0, matchedCount: 0, truncatedBySafetyLimit: false },
  });
  await expect(queryAllPendingChanges()).rejects.toThrow("incomplete");
});

it("builds a bounded stable pending query identity", () => {
  const query = pendingQuery(7, "op", " job ", "cursor");
  expect(query).toEqual({
    operationId: "op",
    requestGeneration: 7,
    keyword: " job ",
    sort: "newest",
    pageSize: 100,
    cursor: "cursor",
  });
  expect(pendingQueryKey("connection-a", query)).toEqual([
    "pending-changes",
    "connection-a",
    "job",
    "newest",
    100,
    "cursor",
  ]);
});

it("walks cursor pages and deduplicates stable changelist IDs", async () => {
  const first: PendingChangePage = {
    requestGeneration: 0,
    defaultChange: change(0),
    items: [change(9), change(8)],
    hasMore: true,
    nextCursor: "next",
    partial: false,
    stats: {
      scannedCount: 3,
      matchedCount: 3,
      truncatedBySafetyLimit: false,
    },
  };
  const second: PendingChangePage = {
    ...first,
    defaultChange: undefined,
    items: [change(8), change(7)],
    hasMore: false,
    nextCursor: undefined,
  };
  const query = vi
    .spyOn(backend, "queryPendingChanges")
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);
  expect((await queryAllPendingChanges("op")).map((item) => item.id)).toEqual([
    0, 9, 8, 7,
  ]);
  expect(query.mock.calls[1][0].cursor).toBe("next");
});
