import { afterEach, expect, it, vi } from "vitest";
import { backend } from "../../infrastructure/backend";
import type {
  WorkspaceFileStatus,
  WorkspaceNode,
} from "../../shared/contracts";
import {
  canOfferResolve,
  canReResolve,
  needsResolve,
  resolveSelection,
} from "./resolveSelection";
import { workspaceCache } from "./workspaceQueries";
afterEach(() => {
  workspaceCache.clear();
  vi.restoreAllMocks();
});
const file = (overrides: Partial<WorkspaceNode> = {}): WorkspaceNode => ({
  id: "a",
  name: "a.txt",
  kind: "file",
  absolutePath: "/root/a.txt",
  relativePath: "a.txt",
  depotPath: "//depot/a.txt",
  state: "controlled",
  ...overrides,
});
const status = (
  overrides: Partial<WorkspaceFileStatus> = {},
): WorkspaceFileStatus => ({
  primary: "controlled",
  sync: "current",
  resolve: "none",
  local: "present",
  completeness: "complete",
  evidence: [],
  errors: [],
  ...overrides,
});
it("needsResolve only accepts real unresolved conflicts on files", () => {
  // Conflicted workspace state.
  expect(needsResolve([file({ state: "conflicted" })])).toBe(true);
  // Authoritative resolve preview fact (only present when truly unresolved).
  expect(
    needsResolve([file({ status: status({ resolve: "unresolved" }) })]),
  ).toBe(true);
  // Clean files never offer resolve.
  expect(needsResolve([file()])).toBe(false);
  expect(needsResolve([file({ status: status() })])).toBe(false);
  expect(needsResolve([file({ status: status({ resolve: "unknown" }) })])).toBe(
    false,
  );
  // Directories are not resolvable targets even if a stale state says conflicted.
  expect(needsResolve([file({ kind: "directory", state: "conflicted" })])).toBe(
    false,
  );
  expect(needsResolve([])).toBe(false);
  // A single conflicted file among a larger clean selection still counts.
  expect(
    needsResolve([
      file({ id: "b", state: "controlled" }),
      file({ state: "conflicted" }),
    ]),
  ).toBe(true);
  // An already resolved record is not an unresolved conflict.
  expect(
    needsResolve([file({ status: status({ resolve: "resolved" }) })]),
  ).toBe(false);
});
it("canReResolve only accepts files with an already resolved record", () => {
  expect(
    canReResolve([file({ status: status({ resolve: "resolved" }) })]),
  ).toBe(true);
  expect(
    canReResolve([file({ status: status({ resolve: "unresolved" }) })]),
  ).toBe(false);
  expect(canReResolve([file({ status: status({ resolve: "none" }) })])).toBe(
    false,
  );
  expect(canReResolve([file({ status: status({ resolve: "unknown" }) })])).toBe(
    false,
  );
  expect(canReResolve([file()])).toBe(false);
  expect(
    canReResolve([
      file({ kind: "directory", status: status({ resolve: "resolved" }) }),
    ]),
  ).toBe(false);
  expect(canReResolve([])).toBe(false);
  expect(
    canReResolve([
      file({ id: "b", state: "openedEdit" }),
      file({ status: status({ resolve: "resolved" }) }),
    ]),
  ).toBe(true);
});
it("offers the resolve entry for unresolved or re-resolvable files only", () => {
  expect(canOfferResolve([file({ state: "conflicted" })])).toBe(true);
  expect(
    canOfferResolve([file({ status: status({ resolve: "resolved" }) })]),
  ).toBe(true);
  expect(
    canOfferResolve([file({ status: status({ resolve: "unresolved" }) })]),
  ).toBe(true);
  // Clean selection: the context-menu entry must be hidden.
  expect(canOfferResolve([file()])).toBe(false);
  expect(canOfferResolve([file({ status: status() })])).toBe(false);
  expect(canOfferResolve([file({ kind: "directory" })])).toBe(false);
  expect(canOfferResolve([])).toBe(false);
});
it("resolves thousands of depot selections with one mapping and one shared directory query", async () => {
  const nodes: WorkspaceNode[] = Array.from({ length: 2000 }, (_, i) => ({
    id: String(i),
    name: `${i}.txt`,
    kind: "file",
    depotPath: `//depot/main/${i}.txt`,
    absolutePath: "",
    relativePath: `${i}.txt`,
    state: "missing",
  }));
  const mapping = vi.spyOn(backend, "resolvePath").mockResolvedValue({
    found: true,
    inputKind: "depot",
    absolutePath: "/root",
  });
  const listing = vi.spyOn(backend, "listWorkspaceChildren").mockResolvedValue({
    items: nodes.map((n) => ({
      ...n,
      absolutePath: `/root/${n.name}`,
      state: "controlled",
    })),
    completeness: "complete",
    errors: [],
    operationIds: [],
    truncated: false,
    safetyLimit: 10_000,
    cacheFreshness: "fresh",
  });
  const result = await resolveSelection(nodes, "connection", "/root");
  expect(result).toHaveLength(2000);
  expect(result.every((n) => n.state === "controlled")).toBe(true);
  expect(mapping).toHaveBeenCalledTimes(1);
  expect(listing).toHaveBeenCalledTimes(1);
});
it("does not pretend an unmapped depot path has a local copy", async () => {
  vi.spyOn(backend, "resolvePath").mockResolvedValue({
    found: false,
    inputKind: "depot",
  });
  const node: WorkspaceNode = {
    id: "a",
    name: "a",
    kind: "file",
    depotPath: "//depot/a",
    relativePath: "a",
    absolutePath: "",
    state: "missing",
  };
  expect(await resolveSelection([node], "c", "/root")).toEqual([node]);
});

it("keeps a pending row's conflicted flag when the workspace listing loses it", async () => {
  const node: WorkspaceNode = {
    id: "a",
    name: "a.txt",
    kind: "file",
    depotPath: "//depot/a.txt",
    absolutePath: "",
    relativePath: "a.txt",
    state: "conflicted",
  };
  vi.spyOn(backend, "resolvePath").mockResolvedValue({
    found: true,
    inputKind: "depot",
    absolutePath: "/root",
  });
  vi.spyOn(backend, "listWorkspaceChildren").mockResolvedValue({
    items: [{ ...node, absolutePath: "/root/a.txt", state: "openedEdit" }],
    completeness: "complete",
    errors: [],
    operationIds: [],
    truncated: false,
    safetyLimit: 10_000,
    cacheFreshness: "fresh",
  });
  const [result] = await resolveSelection([node], "c", "/root");
  expect(result.state).toBe("conflicted");
  expect(canOfferResolve([result])).toBe(true);
});

it("requests authoritative workspace facts when refreshing a selection", async () => {
  const node: WorkspaceNode = {
    id: "a",
    name: "a.txt",
    kind: "file",
    depotPath: "//depot/a.txt",
    absolutePath: "/root/a.txt",
    relativePath: "a.txt",
    state: "controlled",
  };
  const listing = vi.spyOn(backend, "listWorkspaceChildren").mockResolvedValue({
    items: [{ ...node }],
    completeness: "complete",
    errors: [],
    operationIds: [],
    truncated: false,
    safetyLimit: 10_000,
    cacheFreshness: "fresh",
  });
  await resolveSelection([node], "c", "/root", true);
  expect(listing).toHaveBeenCalledWith(undefined, true, expect.any(String));
});
