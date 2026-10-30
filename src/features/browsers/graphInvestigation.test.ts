import { expect, it, vi } from "vitest";
import {
  investigateFiles,
  mapBranchFile,
  mapBranchRoots,
  newInvestigationBudget,
} from "./graphInvestigation";
import type {
  RevisionGraph,
  SubmittedChangeFile,
} from "../../shared/contracts";
const empty: RevisionGraph = {
  nodes: [],
  edges: [],
  hasMore: false,
  partial: false,
  truncated: false,
  operationIds: [],
};
const files: SubmittedChangeFile[] = ["a", "b"].map((name) => ({
  depotPath: `//d/main/${name}`,
  revision: 7,
  action: "edit",
  fileType: "text",
}));
const map = (path: string) => mapBranchRoots(path, "//d/main", "//d/release");
const options = () => ({
  signal: new AbortController().signal,
  budget: newInvestigationBudget(),
  fileListComplete: true,
  intermediates: false,
});
it("maps exact roots without matching similarly named siblings", () => {
  expect(map("//d/main/a").target).toBe("//d/release/a");
  expect(map("//d/mainly/a").target).toBeUndefined();
  const rule = {
    modifier: "map" as const,
    source: "//d/main/...",
    target: "//d/release/...",
  };
  expect(mapBranchFile("//d/main/a", [rule]).target).toBe("//d/release/a");
  expect(mapBranchFile("//d/release/a", [rule], true).target).toBe(
    "//d/main/a",
  );
  expect(
    mapBranchFile("//d/main/a", [rule, { ...rule, modifier: "exclude" }])
      .target,
  ).toBeUndefined();
  expect(
    mapBranchFile("//d/main/a", [rule, { ...rule, target: "//d/other/..." }])
      .target,
  ).toBeUndefined();
  expect(
    mapBranchFile("//d/main/a", [{ ...rule, modifier: "overlay" }]).target,
  ).toBeUndefined();
});
it("queries each CL file independently and never calls absence not-integrated", async () => {
  const read = vi.fn(async () => ({ graph: empty, updatedAt: 1 }));
  const report = await investigateFiles(files, 100, map, read, options());
  expect(read.mock.calls).toHaveLength(2);
  expect(report.rows.map((r) => r.status)).toEqual(["unknown", "unknown"]);
  expect(report.total).toBe(2);
});
it("honours the shared budget including metadata reads", async () => {
  const read = vi.fn(async () => ({ graph: empty, updatedAt: 1 }));
  const opts = options();
  opts.budget.used = 19;
  const report = await investigateFiles(files, 100, map, read, opts);
  expect(read).toHaveBeenCalledTimes(1);
  expect(report.reads).toBe(20);
  expect(report.limited).toBe(true);
  expect(report.rows).toHaveLength(2);
});
it("cancellation before starting makes zero requests", async () => {
  const c = new AbortController();
  c.abort();
  const read = vi.fn(async () => ({ graph: empty, updatedAt: 1 }));
  const report = await investigateFiles(files, 100, map, read, {
    ...options(),
    signal: c.signal,
  });
  expect(read).not.toHaveBeenCalled();
  expect(report.interrupted).toBe(true);
});
it("stops repeated pagination cursors and marks evidence incomplete", async () => {
  const read = vi.fn(async () => ({
    graph: { ...empty, hasMore: true, nextCursor: "same" },
    updatedAt: 1,
  }));
  const report = await investigateFiles(
    files.slice(0, 1),
    100,
    map,
    read,
    options(),
  );
  expect(read).toHaveBeenCalledTimes(2);
  expect(report.rows[0].graph?.partial).toBe(true);
});

it("uses a direct range record for one file without declaring the entire CL integrated", async () => {
  const source = {
    id: "//d/main/a#7",
    depotPath: "//d/main/a",
    revision: 7,
    changelistId: 100,
    action: "edit",
    fileType: "text",
    label: "#7",
    x: 0,
    y: 0,
    missing: false,
  };
  const target = {
    ...source,
    id: "//d/release/a#3",
    depotPath: "//d/release/a",
    revision: 3,
    changelistId: 222,
  };
  const read = vi.fn(async (path: string) => ({
    graph: path.endsWith("/a")
      ? {
          ...empty,
          nodes: [source, target],
          edges: [
            {
              id: "merge",
              source: source.id,
              target: target.id,
              kind: "merge" as const,
              relationship: "merge from",
              startRevision: 6,
              endRevision: 7,
            },
          ],
        }
      : empty,
    updatedAt: 1,
  }));
  const report = await investigateFiles(files, 100, map, read, {
    ...options(),
    intermediates: true,
  });
  expect(report.rows[0].status).toBe("records");
  expect(report.rows[1].status).toBe("unknown");
  expect(read.mock.calls.map((args) => args[0])).toEqual([
    "//d/release/a",
    "//d/release/b",
    "//d/main/b",
  ]);
  expect(report.rows[0].reason).toContain("content inclusion remains unknown");
});
