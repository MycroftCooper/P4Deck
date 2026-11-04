import { historyDiffTarget } from "./commandPolicy";
import { expect, it } from "vitest";
import type { WorkspaceNode } from "../../shared/contracts";
import {
  commandReason,
  commandTargetKey,
  type CommandId,
  type CommandTarget,
} from "./commandPolicy";
const file = (
  state: WorkspaceNode["state"],
  kind: WorkspaceNode["kind"] = "file",
): CommandTarget => ({
  type: "file",
  node: {
    id: "a",
    name: "a",
    absolutePath: "/work/a",
    relativePath: "a",
    depotPath: "//depot/a",
    kind,
    state,
  },
});
const allowed = (
  id: CommandId,
  target: CommandTarget,
  busy = false,
  native = true,
) => !commandReason(id, target, busy, native, true);
it("keeps execution snapshot identity independent of the currently focused object", () => {
  const snapshot = file("controlled");
  const other = file("controlled");
  if (other.type !== "file" || snapshot.type !== "file")
    throw new Error("fixture");
  other.node = {
    ...other.node,
    absolutePath: "/work/other",
    depotPath: "//depot/other",
  };
  expect(commandTargetKey(snapshot)).not.toBe(commandTargetKey(other));
  expect(
    commandTargetKey({ ...snapshot, nodes: [snapshot.node, other.node] }),
  ).not.toBe(commandTargetKey(snapshot));
  expect(
    commandTargetKey({
      ...snapshot,
      nodes: [snapshot.node, other.node],
      wholeChangelistId: 0,
    }),
  ).not.toBe(
    commandTargetKey({
      ...snapshot,
      nodes: [snapshot.node, other.node],
    }),
  );
  expect(commandTargetKey({ type: "pending", id: 42, count: 1 })).not.toBe(
    commandTargetKey({ type: "submitted", id: 42 }),
  );
});
it("never mutates a stale file from a global page", () => {
  expect(allowed("checkout", { type: "none" })).toBe(false);
  expect(allowed("refresh", { type: "none" })).toBe(true);
});
it("requires explicit numbered nonempty CL selection for submission", () => {
  expect(allowed("submit", file("openedEdit"))).toBe(false);
  expect(allowed("submit", { type: "pending", id: 0, count: 2 })).toBe(false);
  expect(allowed("submit", { type: "pending", id: 42, count: 0 })).toBe(false);
  expect(allowed("submit", { type: "pending", id: 42, count: 2 })).toBe(true);
});
it("separates local untracked, controlled, opened and conflicted files", () => {
  expect(allowed("add", file("untracked"))).toBe(true);
  expect(allowed("history", file("untracked"))).toBe(false);
  expect(allowed("checkout", file("controlled"))).toBe(true);
  expect(allowed("checkout", file("openedEdit"))).toBe(false);
  expect(allowed("revert", file("openedEdit"))).toBe(true);
  expect(allowed("revert", file("openedMoveAdd"))).toBe(true);
  expect(allowed("revert", file("openedMoveDelete"))).toBe(true);
  expect(allowed("getLatest", file("conflicted"))).toBe(false);
  expect(allowed("diff", file("conflicted"))).toBe(true);
});
it("enables get latest for opened files that are behind depot", () => {
  const opened = file("openedEdit");
  if (opened.type !== "file") throw new Error("fixture");
  opened.node.revision = 79;
  opened.node.headRevision = 80;
  expect(allowed("getLatest", opened)).toBe(true);
  expect(allowed("getRevision", opened)).toBe(true);

  opened.node.status = {
    primary: "openedEdit",
    openedAction: "edit",
    sync: "outOfDate",
    resolve: "none",
    local: "present",
    completeness: "complete",
    evidence: [],
    errors: [],
  };
  opened.node.revision = undefined;
  opened.node.headRevision = undefined;
  expect(allowed("getLatest", opened)).toBe(true);
});

it("enables get latest for opened files even when the sync fact is unavailable", () => {
  const opened = file("openedEdit");
  if (opened.type !== "file") throw new Error("fixture");
  opened.node.revision = 80;
  opened.node.headRevision = 80;
  expect(allowed("getLatest", opened)).toBe(true);
  expect(allowed("getRevision", opened)).toBe(true);
  expect(allowed("getLatest", file("openedAdd"))).toBe(false);
});

it("enables lock and unlock only for explicit opened files with compatible authoritative state", () => {
  const opened = file("openedEdit");
  if (opened.type !== "file") throw new Error("fixture");
  opened.node.status = {
    primary: "openedEdit",
    openedAction: "edit",
    sync: "current",
    resolve: "none",
    local: "present",
    completeness: "complete",
    lockOwnership: "unlocked",
    canLock: true,
    canUnlock: false,
    evidence: [],
    errors: [],
  };
  expect(allowed("lock", opened)).toBe(true);
  expect(allowed("unlock", opened)).toBe(false);
  opened.node.status.lockOwnership = "ours";
  opened.node.status.canLock = false;
  opened.node.status.canUnlock = true;
  expect(allowed("lock", opened)).toBe(false);
  expect(allowed("unlock", opened)).toBe(true);
  expect(allowed("lock", file("controlled"))).toBe(false);
  expect(allowed("lock", file("openedEdit", "directory"))).toBe(false);
});
it("supports recursive folder actions but keeps file-only viewers disabled", () => {
  expect(allowed("checkout", file("controlled", "directory"))).toBe(true);
  expect(allowed("preview", file("controlled", "directory"))).toBe(false);
  expect(allowed("reveal", file("controlled", "directory"))).toBe(true);
});
it("does not enable recursive P4 commands for an unresolved root", () => {
  const target = file("controlled", "directory");
  if (target.type !== "file") throw new Error("fixture");
  target.node.absolutePath = "";
  target.node.depotPath = undefined;
  for (const id of [
    "getLatest",
    "getRevision",
    "checkout",
    "delete",
    "revert",
  ] as const)
    expect(allowed(id, target)).toBe(false);
});
it("gates native operations and missing local files", () => {
  expect(allowed("openWith", file("controlled"), false, false)).toBe(false);
  expect(allowed("preview", file("missing"))).toBe(false);
  expect(allowed("reveal", file("missing"))).toBe(false);
  expect(allowed("getLatest", file("missing"))).toBe(true);
});
it("uses filesystem capabilities rather than P4 status for system actions", () => {
  for (const state of [
    "untracked",
    "controlled",
    "missing",
    "openedDelete",
  ] as const) {
    for (const id of ["reveal", "openWith"] as const) {
      expect(
        commandReason(id, file(state), false, true, true, {
          reveal: true,
          openWith: true,
        }),
      ).toBeUndefined();
      expect(
        commandReason(id, file(state), false, true, true, {
          reveal: false,
          openWith: false,
        }),
      ).toBeTruthy();
      expect(commandReason(id, file(state), false, true, true, null)).toContain(
        "正在检查",
      );
      expect(
        commandReason(id, file(state), false, false, true, {
          reveal: true,
          openWith: true,
        }),
      ).toContain("浏览器");
    }
  }
  expect(
    commandReason("reveal", file("missing", "directory"), false, true, true, {
      reveal: true,
      openWith: false,
    }),
  ).toBeUndefined();
  expect(
    commandReason(
      "openWith",
      file("controlled", "directory"),
      false,
      true,
      true,
      { reveal: true, openWith: false },
    ),
  ).toBeTruthy();
});
it("only permits cancelling while an operation is running", () => {
  expect(allowed("cancel", { type: "none" })).toBe(false);
  expect(allowed("cancel", { type: "none" }, true)).toBe(true);
  expect(allowed("checkout", file("controlled"), true)).toBe(false);
});
it("checks every batch target and does not open a tab per selected file", () => {
  const a = file("controlled");
  const b = file("openedEdit");
  if (a.type !== "file" || b.type !== "file") throw new Error("fixture");
  b.node = {
    ...b.node,
    id: "b",
    name: "b",
    absolutePath: "/work/b",
    depotPath: "//depot/b",
  };
  const batch: CommandTarget = { ...a, nodes: [a.node, b.node] };
  expect(allowed("delete", batch)).toBe(true);
  expect(allowed("checkout", batch)).toBe(false);
  expect(allowed("history", batch)).toBe(false);
  expect(allowed("reveal", batch)).toBe(false);
});
it("folder state is not a descendant status aggregate", () => {
  for (const id of [
    "getLatest",
    "getRevision",
    "checkout",
    "delete",
    "revert",
  ] as CommandId[])
    expect(allowed(id, file("missing", "directory"))).toBe(true);
  expect(allowed("add", file("missing", "directory"))).toBe(false);
  expect(allowed("add", file("controlled", "directory"))).toBe(true);
  for (const id of [
    "diff",
    "history",
    "revgraph",
    "preview",
    "openWith",
  ] as CommandId[])
    expect(allowed(id, file("controlled", "directory"))).toBe(false);
});

it("allows checkout and read-only viewers for locally modified files but blocks get latest", () => {
  for (const id of ["checkout", "diff", "history", "revgraph"] as CommandId[])
    expect(
      commandReason(id, file("modified"), false, true, true),
    ).toBeUndefined();
  for (const id of ["getLatest", "getRevision"] as CommandId[]) {
    expect(commandReason(id, file("modified"), false, true, true)).toBe(
      "本地有未签出修改，请先签出/还原/对账后再获取最新",
    );
    expect(commandReason(id, file("modified"), false, true, false)).toBe(
      "Local un-checked-out edits exist; checkout/revert/reconcile before getting latest",
    );
  }
  expect(allowed("revert", file("modified"))).toBe(false);
});

it("keeps get latest disabled for modified files even when status claims they are behind", () => {
  const modified = file("modified");
  if (modified.type !== "file") throw new Error("fixture");
  modified.node.status = {
    primary: "modified",
    sync: "outOfDate",
    resolve: "none",
    local: "modified",
    completeness: "complete",
    evidence: [],
    errors: [],
  };
  modified.node.revision = 79;
  modified.node.headRevision = 80;
  for (const id of ["getLatest", "getRevision"] as CommandId[])
    expect(commandReason(id, modified, false, true, true)).toBe(
      "本地有未签出修改，请先签出/还原/对账后再获取最新",
    );
});

it("points an unknown or loading file state at refresh", () => {
  const gatedIds: CommandId[] = [
    "getLatest",
    "getRevision",
    "checkout",
    "diff",
    "history",
    "revgraph",
    "revert",
    "add",
    "delete",
    "moveFiles",
    "shelve",
    "resolve",
  ];
  for (const state of ["unknown", "loading"] as const) {
    expect(allowed("refresh", file(state))).toBe(true);
    for (const id of gatedIds) {
      expect(commandReason(id, file(state), false, true, true)).toBe(
        "文件状态未知，请点击刷新重新检查",
      );
      expect(commandReason(id, file(state), false, true, false)).toBe(
        "File status unknown; refresh to re-check",
      );
    }
  }
});

it("allows history and revision graph for not-synced files", () => {
  expect(allowed("history", file("notSynced"))).toBe(true);
  expect(allowed("revgraph", file("notSynced"))).toBe(true);
  expect(allowed("diff", file("notSynced"))).toBe(false);
});

it("keeps refresh usable while another operation is busy", () => {
  expect(
    commandReason("refresh", file("modified"), true, true, true),
  ).toBeUndefined();
  expect(
    commandReason("refresh", { type: "none" }, true, true, true),
  ).toBeUndefined();
  expect(commandReason("refresh", file("unknown"), true, true, true)).toBe(
    undefined,
  );
  expect(commandReason("getLatest", file("controlled"), true, true, true)).toBe(
    "请等待当前任务完成，或取消任务",
  );
  expect(
    commandReason("getLatest", file("controlled"), true, true, false),
  ).toBe("Wait for or cancel the current operation");
  expect(commandReason("cancel", { type: "none" }, true, true, true)).toBe(
    undefined,
  );
});

it("routes exactly two historical revisions in ascending order and disables mutations", () => {
  const target = {
    type: "history" as const,
    path: "//mock/config.toml",
    revisions: [8, 7],
  };
  expect(historyDiffTarget(target)).toEqual({
    path: target.path,
    left: 7,
    right: 8,
  });
  expect(commandReason("diff", target, false, false, true)).toBeUndefined();
  expect(commandReason("checkout", target, false, false, true)).toBeTruthy();
  for (const revisions of [[], [8], [8, 7, 6], [8, 8], [0, 1]]) {
    expect(historyDiffTarget({ ...target, revisions })).toBeUndefined();
    expect(
      commandReason("diff", { ...target, revisions }, false, false, true),
    ).toBeTruthy();
  }
});
