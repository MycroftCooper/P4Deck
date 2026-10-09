import { describe, expect, it } from "vitest";
import {
  graphNodeDiffPair,
  historyDiffPair,
  makeReviewScope,
  mergeHistoryRows,
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
});
