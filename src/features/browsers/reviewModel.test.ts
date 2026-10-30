import { historyMenuQueue } from "./reviewModel";
import type { FileRevision } from "../../shared/contracts";
import { describe, expect, it } from "vitest";
import {
  graphNodeDiffPair,
  historyDiffPair,
  makeReviewScope,
  mergeHistoryRows,
  mergeRevisionGraphs,
} from "./reviewModel";

describe("file review model", () => {
  it("binds review selectors to profile, generation, workspace and file identity", () => {
    const scope = makeReviewScope(
      {
        mode: "tauri",
        p4Version: "P4/NTX64/2026.1",
        activeProfileId: "profile-a",
        contextGeneration: 9,
        context: {
          server: "localhost:1666",
          user: "alice",
          client: "ws",
          cwd: "C:/ws",
        },
        connection: {
          state: "connected",
          message: "ok",
          recovery: "none",
          server: "localhost:1666",
        },
      },
      "//depot/世界 @#%.txt",
    );
    expect(scope).toMatchObject({
      activeProfileId: "profile-a",
      contextGeneration: 9,
      workspace: "C:/ws",
      fileIdentity: "//depot/世界 @#%.txt",
    });
  });

  it("deduplicates stable history pages and creates a graph-node diff pair", () => {
    const row = (revision: number) => ({
      depotPath: "//depot/a.txt",
      revision,
      changelistId: revision,
      user: "alice",
      action: "edit",
      fileType: "text",
      time: "",
      description: "",
      integrations: [],
    });
    expect(
      mergeHistoryRows([row(3), row(2)], [row(2), row(1)]).map(
        (item) => item.revision,
      ),
    ).toEqual([3, 2, 1]);
    expect(historyDiffPair([row(4), row(2)])).toEqual({
      left: { kind: "revision", revision: 2 },
      right: { kind: "revision", revision: 4 },
    });
    expect(
      graphNodeDiffPair({
        id: "a#4",
        depotPath: "//depot/a.txt",
        revision: 4,
        changelistId: 40,
        action: "edit",
        fileType: "text",
        label: "#4",
        x: 0,
        y: 0,
        missing: false,
      }),
    ).toEqual({
      left: { kind: "revision", revision: 3 },
      right: { kind: "revision", revision: 4 },
    });
  });

  it("merges concurrent graph pages by semantic node and edge identity", () => {
    const node = (id: string, missing = false) => ({
      id,
      depotPath: `//depot/${id}.txt`,
      revision: 1,
      changelistId: missing ? 0 : 1,
      action: missing ? "referenced" : "edit",
      fileType: "text",
      label: "#1",
      x: 0,
      y: 0,
      missing,
    });
    const edge = {
      id: "unstable-id",
      source: "a",
      target: "b",
      kind: "merge" as const,
      relationship: "merge from",
    };
    const merged = mergeRevisionGraphs(
      {
        nodes: [node("a"), node("b", true)],
        edges: [edge],
        nextCursor: "cursor-2",
        hasMore: true,
        partial: true,
        truncated: false,
        operationIds: ["first"],
      },
      {
        nodes: [node("b"), node("c")],
        edges: [{ ...edge, id: "different-id" }],
        hasMore: false,
        partial: false,
        truncated: false,
        operationIds: ["second", "first"],
      },
    );
    expect(merged.nodes.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(merged.nodes.find(({ id }) => id === "b")?.missing).toBe(false);
    expect(merged.edges).toHaveLength(1);
    expect(merged.operationIds).toEqual(["first", "second"]);
    expect(merged.partial).toBe(false);
  });
});

it("right-click preserves selected FIFO order and comparison rejects mixed files", () => {
  const row = (revision: number, depotPath = "//depot/a.txt") =>
    ({ revision, depotPath, changelistId: revision * 100 }) as FileRevision;
  const first = row(42),
    last = row(17),
    third = row(73);
  expect(historyMenuQueue([first, last], first)).toEqual([first, last]);
  expect(historyMenuQueue([first, last], third)).toEqual([last, third]);
  expect(historyDiffPair([first, last])).toEqual({
    left: { kind: "revision", revision: 17 },
    right: { kind: "revision", revision: 42 },
  });
  expect(
    historyDiffPair([first, row(17, "//depot/other.txt")]),
  ).toBeUndefined();
  expect(historyDiffPair([first, first])).toBeUndefined();
});
