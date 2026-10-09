import { describe, expect, it, vi } from "vitest";
import type { RuntimeInfo } from "../../shared/contracts/types";
import { makeReviewScope } from "./reviewModel";
import {
  ReviewRequestOwner,
  reviewRequestIdentity,
  reviewRequestIdentityKey,
} from "./reviewRequests";

const runtime: RuntimeInfo = {
  mode: "tauri",
  p4Version: "P4/TEST",
  activeProfileId: "profile-a",
  contextGeneration: 7,
  context: {
    server: "fixture:1666",
    user: "tester",
    client: "workspace",
    cwd: "C:/workspace",
  },
  connection: {
    state: "connected",
    message: "ok",
    recovery: "none",
    server: "fixture:1666",
  },
};

describe("review request owner", () => {
  it("cancels a replaced lease and rejects its late result/error/loading commit", async () => {
    const cancel = vi.fn(async () => undefined);
    const owner = new ReviewRequestOwner(cancel);
    const scope = makeReviewScope(runtime, "//depot/a.txt");
    const first = owner.start(
      "primary",
      reviewRequestIdentity(runtime, scope, "diff", "diff", {
        left: { kind: "have" },
        right: { kind: "workspace" },
      }),
    );
    const second = owner.start(
      "primary",
      reviewRequestIdentity(
        { ...runtime, contextGeneration: 8 },
        { ...scope, contextGeneration: 8, fileIdentity: "//depot/b.txt" },
        "diff",
        "diff",
        { left: { kind: "head" }, right: { kind: "workspace" } },
      ),
    );
    await Promise.resolve();
    expect(first.signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith(first.operationId);
    expect(owner.isCurrent(first)).toBe(false);
    expect(owner.finish(first)).toBe(false);
    expect(owner.isCurrent(second)).toBe(true);
    expect(owner.finish(second)).toBe(true);
  });

  it("binds node, references and cursor into identity and cancels all on unmount", async () => {
    const cancel = vi.fn(async () => undefined);
    const owner = new ReviewRequestOwner(cancel);
    const scope = makeReviewScope(runtime, "//depot/a.txt");
    const firstIdentity = reviewRequestIdentity(
      runtime,
      scope,
      "revgraph",
      "graph-page",
      {
        cursor: "cursor-a",
        nodeId: "node-a",
        expandTarget: "//depot/branch/a.txt",
      },
    );
    const secondIdentity = {
      ...firstIdentity,
      cursor: "cursor-b",
    };
    expect(reviewRequestIdentityKey(firstIdentity)).not.toBe(
      reviewRequestIdentityKey(secondIdentity),
    );
    const first = owner.start("page", firstIdentity);
    const second = owner.start("node", secondIdentity);
    owner.cancelAll();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledWith(first.operationId);
    expect(cancel).toHaveBeenCalledWith(second.operationId);
    expect(owner.isCurrent(first)).toBe(false);
    expect(owner.isCurrent(second)).toBe(false);
  });
});
