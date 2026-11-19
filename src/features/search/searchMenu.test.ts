import { describe, expect, it, vi } from "vitest";
import type {
  GlobalSearchItem,
  GlobalSearchTarget,
} from "../../shared/contracts";
import {
  changelistDescription,
  changelistSearchResultId,
  fileResultNodes,
  parentStreamPath,
  searchResultNode,
  workspaceRelativePath,
} from "./searchMenu";

const backend = vi.hoisted(() => ({
  getSubmittedChangeDetail: vi.fn(),
  queryPendingChanges: vi.fn(),
  getShelfDetail: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));

function item(
  target: GlobalSearchTarget,
  kind: GlobalSearchItem["kind"],
): GlobalSearchItem {
  return {
    identity: `${kind}:id`,
    kind,
    title: "row",
    summary: "summary",
    target,
    matchedFields: [],
    highlights: [],
    rank: 1,
  };
}

const workspace = item(
  { type: "workspaceFile", absolutePath: "C:\\ws\\src\\alpha.ts" },
  "workspaceFile",
);
const depot = item(
  { type: "depotFile", depotPath: "//depot/main/beta.ts" },
  "depotFile",
);

describe("search result identity", () => {
  it("derives a controlled file node from a workspace hit", () => {
    expect(searchResultNode(workspace, "C:\\ws")).toEqual({
      id: "C:\\ws\\src\\alpha.ts",
      name: "alpha.ts",
      kind: "file",
      absolutePath: "C:\\ws\\src\\alpha.ts",
      relativePath: "src\\alpha.ts",
      state: "controlled",
    });
  });

  it("derives a depot-only node that is missing locally", () => {
    expect(searchResultNode(depot, "C:\\ws")).toEqual({
      id: "//depot/main/beta.ts",
      name: "beta.ts",
      kind: "file",
      absolutePath: "",
      relativePath: "",
      depotPath: "//depot/main/beta.ts",
      state: "missing",
    });
  });

  it("never invents a file for a changelist or stream hit", () => {
    expect(
      searchResultNode(
        item({ type: "pendingChange", changeId: 7 }, "pendingChange"),
      ),
    ).toBeUndefined();
    expect(
      searchResultNode(
        item({ type: "stream", streamPath: "//atlas/dev" }, "stream"),
      ),
    ).toBeUndefined();
    expect(
      searchResultNode(
        item({ type: "workspaceFile", absolutePath: "" }, "workspaceFile"),
      ),
    ).toBeUndefined();
  });

  it("keeps one node per path in a multi-selection", () => {
    expect(
      fileResultNodes([workspace, workspace, depot], "C:\\ws"),
    ).toHaveLength(2);
    expect(
      fileResultNodes([workspace, depot], "C:\\ws").map((node) => node.id),
    ).toEqual(["C:\\ws\\src\\alpha.ts", "//depot/main/beta.ts"]);
  });

  it("reads the numbered changelist of CL rows only", () => {
    expect(
      changelistSearchResultId(
        item({ type: "submittedChange", changeId: 101 }, "submittedChange"),
      ),
    ).toBe(101);
    expect(
      changelistSearchResultId(item({ type: "shelf", changeId: 404 }, "shelf")),
    ).toBe(404);
    expect(changelistSearchResultId(workspace)).toBeUndefined();
  });
});

describe("workspaceRelativePath", () => {
  it("strips the root and keeps the host separators", () => {
    expect(workspaceRelativePath("C:\\ws\\src\\alpha.ts", "C:\\ws")).toBe(
      "src\\alpha.ts",
    );
    expect(workspaceRelativePath("C:\\WS\\src\\alpha.ts", "c:/ws")).toBe(
      "src\\alpha.ts",
    );
  });

  it("stays empty when the path is outside the workspace", () => {
    expect(workspaceRelativePath("D:\\other\\alpha.ts", "C:\\ws")).toBe("");
    // A sibling directory sharing the prefix is not inside the root.
    expect(workspaceRelativePath("C:\\workspace2\\a.ts", "C:\\workspace")).toBe(
      "",
    );
    expect(workspaceRelativePath("C:\\ws\\a.ts", undefined)).toBe("");
  });
});

describe("parentStreamPath", () => {
  it("strips the last segment", () => {
    expect(parentStreamPath("//atlas/dev/task-render")).toBe("//atlas/dev");
    expect(parentStreamPath("//atlas/main/")).toBe("//atlas");
    expect(parentStreamPath("//atlas/main")).toBe("//atlas");
  });

  it("has no parent on a top-level stream", () => {
    expect(parentStreamPath("//main")).toBe("");
    expect(parentStreamPath("//")).toBe("");
  });
});

describe("changelistDescription", () => {
  it("re-reads a submitted description instead of splitting display text", async () => {
    backend.getSubmittedChangeDetail.mockResolvedValueOnce({
      description: "fix the login flow",
    });
    await expect(
      changelistDescription(
        item({ type: "submittedChange", changeId: 101 }, "submittedChange"),
        false,
      ),
    ).resolves.toBe("fix the login flow");
    expect(backend.getSubmittedChangeDetail).toHaveBeenCalledWith(
      expect.objectContaining({ changeId: 101 }),
    );
  });

  it("looks a pending CL up by number and reports a missing description", async () => {
    backend.queryPendingChanges.mockResolvedValueOnce({
      items: [
        {
          id: 202,
          description: "wire the menu",
          user: "tester",
          client: "workspace",
          status: "pending",
          jobs: [],
          files: [],
          shelvedFiles: [],
        },
      ],
      hasMore: false,
      partial: false,
    });
    await expect(
      changelistDescription(
        item({ type: "pendingChange", changeId: 202 }, "pendingChange"),
        false,
      ),
    ).resolves.toBe("wire the menu");
    expect(backend.queryPendingChanges).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: "202" }),
    );

    backend.queryPendingChanges.mockResolvedValueOnce({
      items: [],
      hasMore: false,
      partial: false,
    });
    await expect(
      changelistDescription(
        item({ type: "pendingChange", changeId: 999 }, "pendingChange"),
        false,
      ),
    ).rejects.toThrow(/no CL description/i);
  });
});
