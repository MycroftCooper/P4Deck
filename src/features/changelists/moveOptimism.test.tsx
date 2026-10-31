// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { dialogHarness } from "../../app/dialogs/testHarness";
import {
  startOptimisticMove,
  releaseLocalMoveAdmission,
  unresolvedMove,
  useMoveAttempts,
  projectMoves,
  mergeConfirmedMoves,
  blockedMovePaths,
  blockedPathDetails,
  formatBlockedPaths,
  checkOptimisticMove,
  reconcileMoveCache,
  type MoveAttempt,
} from "./moveOptimism";
import { fileActionLedger, moveLedger } from "../actions/actionStore";
import type { SelectedMoveRequest, SelectedMoveReceipt } from "./selectedMove";
import type { PendingChange } from "../../shared/contracts";
const api = vi.hoisted(() => ({
  selectedMoveExecute: vi.fn(),
  selectedMoveLookup: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({ backend: api }));
const h = dialogHarness();
const base: PendingChange[] = [0, 10, 20].map((id) => ({
  id,
  description: `CL ${id}`,
  status: "pending",
  user: "fixture",
  client: "fixture",
  jobs: [],
  shelvedFiles: [],
  files: (id === 0 ? ["a"] : id === 10 ? ["b"] : ["untouched"]).map((n) => ({
    depotPath: `//fixture/${n}`,
    action: "edit",
  })),
}));
const req = (
  id: string,
  target: SelectedMoveRequest["target"] = { kind: "existing", changeId: 20 },
): SelectedMoveRequest => ({
  operationId: id,
  connection: {
    profileId: "fixture",
    generation: "1",
    server: "synthetic",
    user: "fixture",
    client: "fixture",
  },
  files: [
    { depotPath: "//fixture/a", sourceChangeId: 0 },
    { depotPath: "//fixture/b", sourceChangeId: 10 },
  ],
  target,
});
const receipt = (r: SelectedMoveRequest): SelectedMoveReceipt => ({
  operationId: r.operationId,
  stage: "completed",
  targetCreationUnknown: false,
  targetChangeId: r.target.kind === "existing" ? r.target.changeId : 30,
  files: r.files.map((f) => ({ ...f, state: "moved" })),
  message: "synthetic",
});
function View({
  scope,
  rows = base,
}: {
  scope: string;
  rows?: PendingChange[];
}) {
  const all = useMoveAttempts(),
    v = projectMoves(rows, scope, all);
  return (
    <>
      {v.changes.map((c) => (
        <section data-cl={c.id} key={c.id}>
          {c.files.map((f) => (
            <span key={f.depotPath}>{f.depotPath}</span>
          ))}
        </section>
      ))}
      {v.temporary.map((g) => (
        <section data-temporary key={g.operationId}>
          {g.files.map((f) => f.depotPath).join(",")}
        </section>
      ))}
      <button>Unrelated action</button>
    </>
  );
}
it("regroups rendered files before deferred server response, preserves target extras and ignores stale cache", async () => {
  const r = req("deferred");
  let finish!: (r: SelectedMoveReceipt) => void;
  api.selectedMoveExecute.mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  await h.render(<View scope="deferred" />);
  await act(async () => {
    expect(startOptimisticMove("deferred", r, base)).toBe(true);
  });
  expect(document.querySelector('[data-cl="0"]')!.textContent).toBe("");
  expect(document.querySelector('[data-cl="20"]')!.textContent).toContain(
    "//fixture/a",
  );
  expect(document.querySelector('[data-cl="20"]')!.textContent).toContain(
    "untouched",
  );
  expect(document.querySelector("button")!.disabled).toBe(false);
  await h.render(<View scope="deferred" rows={base.map((c) => ({ ...c }))} />);
  expect(document.querySelector('[data-cl="20"]')!.textContent).toContain(
    "//fixture/b",
  );
  await act(async () => finish(receipt(r)));
  expect(document.querySelector('[data-cl="20"]')!.textContent).toContain(
    "//fixture/b",
  );
  expect(blockedMovePaths("deferred").size).toBe(0);
});
it("new target is an explicit temporary group until exact receipt id arrives", async () => {
  const r = req("new", { kind: "new", description: "Synthetic" });
  let finish!: (r: SelectedMoveReceipt) => void;
  api.selectedMoveExecute.mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  await h.render(<View scope="new" />);
  await act(async () => {
    startOptimisticMove("new", r, base);
  });
  expect(document.querySelector("[data-temporary]")!.textContent).toContain(
    "//fixture/a",
  );
  expect(document.querySelectorAll("[data-cl]")).toHaveLength(3);
  await act(async () => finish(receipt(r)));
  expect(document.querySelector("[data-temporary]")).toBeNull();
  expect(document.querySelector('[data-cl="30"]')!.textContent).toContain(
    "//fixture/a",
  );
});
it("partial results restore only confirmed notMoved, keep unknown projected and block same files", async () => {
  const r = req("partial");
  api.selectedMoveExecute.mockResolvedValue({
    ...receipt(r),
    stage: "stopped",
    files: [
      { ...r.files[0], state: "notMoved" },
      { ...r.files[1], state: "unknown" },
    ],
  });
  await h.render(<View scope="partial" />);
  await act(async () => {
    startOptimisticMove("partial", r, base);
  });
  expect(document.querySelector('[data-cl="0"]')!.textContent).toContain(
    "//fixture/a",
  );
  expect(document.querySelector('[data-cl="20"]')!.textContent).toContain(
    "//fixture/b",
  );
  expect(blockedMovePaths("partial")).toEqual(new Set(["//fixture/b"]));
  expect(startOptimisticMove("partial", req("conflict"), base)).toBe(false);
});
it("failed creation removes temporary grouping only when every file is confirmed not moved", async () => {
  const r = req("createfail", { kind: "new", description: "Draft" });
  api.selectedMoveExecute.mockResolvedValue({
    ...receipt(r),
    stage: "stopped",
    targetCreationUnknown: false,
    targetChangeId: null,
    files: r.files.map((f) => ({ ...f, state: "notMoved" })),
  });
  await h.render(<View scope="createfail" />);
  await act(async () => {
    startOptimisticMove("createfail", r, base);
  });
  expect(document.querySelector("[data-temporary]")).toBeNull();
  expect(document.querySelector('[data-cl="0"]')!.textContent).toContain(
    "//fixture/a",
  );
});
it("lost response queries same id once, never repeats write; other scope stays isolated", async () => {
  const r = req("lost");
  api.selectedMoveExecute.mockRejectedValue(new Error("lost"));
  api.selectedMoveLookup.mockResolvedValue({ kind: "notFound" });
  await h.render(<View scope="lost" />);
  await act(async () => {
    startOptimisticMove("lost", r, base);
  });
  expect(api.selectedMoveLookup).toHaveBeenLastCalledWith({
    operationId: r.operationId,
    connection: r.connection,
  });
  const calls = api.selectedMoveExecute.mock.calls.length;
  await act(async () => checkOptimisticMove("lost"));
  expect(api.selectedMoveExecute).toHaveBeenCalledTimes(calls);
  expect(blockedMovePaths("lost").size).toBe(2);
  await h.render(<View scope="other" />);
  expect(document.querySelector('[data-cl="0"]')!.textContent).toContain(
    "//fixture/a",
  );
});
it("later resolved intent wins per path over previous overlay without clearing unrelated files", () => {
  const a = req("older"),
    b = {
      ...req("newer", { kind: "existing", changeId: 10 }),
      files: [{ depotPath: "//fixture/a", sourceChangeId: 20 }],
    };
  const originals = Object.fromEntries(
    base.flatMap((c) => c.files.map((f) => [f.depotPath, f])),
  );
  const list: MoveAttempt[] = [
    { scope: "s", request: a, originals, busy: false, receipt: receipt(a) },
    { scope: "s", request: b, originals, busy: true },
  ];
  const v = projectMoves(base, "s", list);
  expect(
    v.changes.find((c) => c.id === 10)!.files.map((f) => f.depotPath),
  ).toEqual(["//fixture/a"]);
  expect(
    v.changes.find((c) => c.id === 20)!.files.map((f) => f.depotPath),
  ).toEqual(["//fixture/untouched", "//fixture/b"]);
});

it("retires confirmed overlays once authoritative cache agrees so later external moves are visible", async () => {
  const r = req("reconcile");
  api.selectedMoveExecute.mockResolvedValue(receipt(r));
  await h.render(<View scope="reconcile" />);
  await act(async () => {
    startOptimisticMove("reconcile", r, base);
  });
  const confirmed = base.map((c) => ({
    ...c,
    files:
      c.id === 20 ? [...base[2].files, ...base[0].files, ...base[1].files] : [],
  }));
  await act(async () => reconcileMoveCache("reconcile", confirmed));
  await h.render(<View scope="reconcile" rows={base} />);
  expect(document.querySelector('[data-cl="0"]')!.textContent).toContain(
    "//fixture/a",
  );
});

it("lost create acknowledgement keeps a temporary identity and locks retries even when no reopen occurred", async () => {
  const r = req("create-unknown", {
    kind: "new",
    description: "Unacknowledged draft",
  });
  api.selectedMoveExecute.mockResolvedValue({
    ...receipt(r),
    targetCreationUnknown: true,
    targetChangeId: null,
    stage: "stopped",
    files: r.files.map((f) => ({ ...f, state: "notMoved" })),
  });
  await h.render(<View scope="create-unknown" />);
  await act(async () => {
    startOptimisticMove("create-unknown", r, base);
  });
  expect(document.querySelector("[data-temporary]")).not.toBeNull();
  expect(document.querySelector('[data-cl="0"]')!.textContent).toContain(
    "//fixture/a",
  );
  expect(blockedMovePaths("create-unknown").size).toBe(2);
  expect(
    startOptimisticMove(
      "create-unknown",
      req("must-not-recreate", { kind: "new", description: "Retry" }),
      base,
    ),
  ).toBe(false);
});

// Keep older multi-file recovery records: supersession is per path, not per operation.
it.each(["moved", "notMoved", "unknown"] as const)(
  "latest %s intent never releases an unrelated older unknown file",
  (state) => {
    const older = req(`superseded-${state}`);
    const newer = {
      ...req(`latest-${state}`, { kind: "existing" as const, changeId: 10 }),
      files: [{ depotPath: "//fixture/a", sourceChangeId: 20 }],
    };
    const originals = Object.fromEntries(
      base.flatMap((c) => c.files.map((f) => [f.depotPath, f])),
    );
    const list: MoveAttempt[] = [
      {
        scope: "partial-retire",
        request: older,
        originals,
        busy: false,
        receipt: {
          ...receipt(older),
          stage: "stopped",
          files: [
            { ...older.files[0], state: "moved" },
            { ...older.files[1], state: "unknown" },
          ],
        },
      },
      {
        scope: "partial-retire",
        request: newer,
        originals,
        busy: false,
        receipt: {
          ...receipt(newer),
          stage: state === "moved" ? "completed" : "stopped",
          files: [{ ...newer.files[0], state }],
        },
        reconciled: state !== "unknown",
      },
    ];
    const authoritative = base.map((c) => ({
      ...c,
      files: c.files.filter((f) => f.depotPath !== "//fixture/a"),
    }));
    authoritative
      .find((c) => c.id === (state === "notMoved" ? 20 : 10))!
      .files.push(base[0].files[0]);
    const result = projectMoves(authoritative, "partial-retire", list);
    expect(
      result.changes
        .find((c) => c.id === (state === "notMoved" ? 20 : 10))!
        .files.map((f) => f.depotPath),
    ).toContain("//fixture/a");
    expect(
      result.changes.find((c) => c.id === 20)!.files.map((f) => f.depotPath),
    ).toContain("//fixture/b");
    expect(list[0].receipt!.files[1].state).toBe("unknown");
  },
);
it("three sequential successful moves survive delayed older cache before final retirement", async () => {
  const scope = "three-sequential";
  api.selectedMoveExecute.mockImplementation(async (r: SelectedMoveRequest) =>
    receipt(r),
  );
  await h.render(<View scope={scope} />);
  let rows = base;
  for (const [index, from, to] of [
    [0, 0, 20],
    [1, 20, 10],
    [2, 10, 30],
  ]) {
    const r = {
      ...req(`three-${index}`, { kind: "existing" as const, changeId: to }),
      files: [{ depotPath: "//fixture/a", sourceChangeId: from }],
    };
    await act(async () => {
      expect(startOptimisticMove(scope, r, rows)).toBe(true);
    });
    rows = rows.map((c) => ({
      ...c,
      files: c.files.filter((f) => f.depotPath !== "//fixture/a"),
    }));
    if (!rows.some((c) => c.id === to))
      rows.push({ ...base[0], id: to, files: [] });
    rows.find((c) => c.id === to)!.files.push(base[0].files[0]);
  }
  // A response from before the moves must not retire the latest intent.
  await act(async () => reconcileMoveCache(scope, base));
  await h.render(<View scope={scope} rows={base} />);
  expect(document.querySelector('[data-cl="30"]')!.textContent).toContain(
    "//fixture/a",
  );
  await act(async () => reconcileMoveCache(scope, rows));
  await h.render(<View scope={scope} rows={rows} />);
  expect(document.querySelector('[data-cl="30"]')!.textContent).toContain(
    "//fixture/a",
  );
  expect(document.querySelector('[data-cl="20"]')!.textContent).not.toContain(
    "//fixture/a",
  );
});

it.each(["notFound", "storageUnavailable", "scopeMismatch"])(
  "lookup %s keeps unknown occupancy without replay",
  async (kind) => {
    const r = req(`lookup-${kind}`);
    api.selectedMoveExecute.mockRejectedValue(Error("lost"));
    api.selectedMoveLookup.mockResolvedValue({ kind });
    await h.render(<View scope={r.operationId} />);
    await act(async () => {
      startOptimisticMove(r.operationId, r, base);
    });
    expect(blockedMovePaths(r.operationId).has("//fixture/a")).toBe(true);
    const count = api.selectedMoveExecute.mock.calls.length;
    await act(async () => {
      checkOptimisticMove(r.operationId);
    });
    expect(api.selectedMoveExecute.mock.calls.length).toBe(count);
    expect(api.selectedMoveLookup).toHaveBeenLastCalledWith({
      operationId: r.operationId,
      connection: r.connection,
    });
  },
);
it("committed revision and digest reject stale or foreign authority without reverting projection", async () => {
  const r = req("revision-guard");
  const current: SelectedMoveReceipt = {
    ...receipt(r),
    stage: "stopped",
    execution: {
      schemaVersion: 1,
      payloadDigest: "a".repeat(64),
      revision: "9007199254740994",
      executionState: "interrupted",
      outcome: "unknown",
      dispatchState: "possible",
      recoveryRequired: true,
    },
  };
  api.selectedMoveExecute.mockResolvedValue(current);
  await h.render(<View scope={r.operationId} />);
  await act(async () => {
    startOptimisticMove(r.operationId, r, base);
  });
  const older: SelectedMoveReceipt = {
    ...current,
    files: r.files.map((f) => ({ ...f, state: "notMoved" })),
    execution: { ...current.execution!, revision: "9007199254740993" },
  };
  api.selectedMoveLookup.mockResolvedValue({ kind: "found", receipt: older });
  await act(async () => {
    checkOptimisticMove(r.operationId);
  });
  expect(document.querySelector('[data-cl="20"]')!.textContent).toContain(
    "//fixture/a",
  );
  expect(blockedMovePaths(r.operationId).size).toBe(2);
  api.selectedMoveLookup.mockResolvedValue({
    kind: "found",
    receipt: {
      ...older,
      execution: {
        ...older.execution!,
        revision: "9007199254740995",
        payloadDigest: "b".repeat(64),
      },
    },
  });
  await act(async () => {
    checkOptimisticMove(r.operationId);
  });
  expect(document.querySelector('[data-cl="20"]')!.textContent).toContain(
    "//fixture/a",
  );
});
it("running metadata retains occupancy but permits a subsequent explicit read", async () => {
  const r = req("running-authority");
  api.selectedMoveExecute.mockResolvedValue({
    ...receipt(r),
    stage: "inProgress",
    execution: {
      schemaVersion: 1,
      payloadDigest: "a".repeat(64),
      revision: "1",
      executionState: "running",
      outcome: "unknown",
      dispatchState: "possible",
      recoveryRequired: false,
    },
  });
  await h.render(<View scope={r.operationId} />);
  await act(async () => {
    startOptimisticMove(r.operationId, r, base);
  });
  expect(blockedMovePaths(r.operationId).size).toBe(2);
  api.selectedMoveLookup.mockResolvedValue({
    kind: "found",
    receipt: {
      ...receipt(r),
      execution: {
        schemaVersion: 1,
        payloadDigest: "a".repeat(64),
        revision: "2",
        executionState: "settled",
        outcome: "verified",
        dispatchState: "possible",
        recoveryRequired: false,
      },
    },
  });
  await act(async () => {
    checkOptimisticMove(r.operationId);
  });
  expect(blockedMovePaths(r.operationId).size).toBe(0);
});

it("local cache merge keeps fresh fields and excludes unknown and superseded paths", () => {
  const r = req("merge-facts");
  const known: MoveAttempt = {
    scope: "merge",
    request: r,
    originals: {},
    busy: false,
    receipt: {
      ...receipt(r),
      stage: "stopped",
      files: [
        { ...r.files[0], state: "moved" },
        { ...r.files[1], state: "unknown" },
      ],
    },
  };
  const fresh = base.map((c) => ({
    ...c,
    files: c.files.map((f) => ({ ...f, action: "fresh" })),
  }));
  const merged = mergeConfirmedMoves(fresh, "merge", [known]);
  expect(
    merged
      .find((c) => c.id === 20)!
      .files.find((f) => f.depotPath === "//fixture/a")!.action,
  ).toBe("fresh");
  expect(
    merged
      .find((c) => c.id === 10)!
      .files.some((f) => f.depotPath === "//fixture/b"),
  ).toBe(true);
  const newer: MoveAttempt = {
    ...known,
    request: { ...r, operationId: "newer", files: [r.files[0]] },
    receipt: undefined,
    busy: true,
  };
  expect(mergeConfirmedMoves(fresh, "merge", [known, newer])).toBe(fresh);
  expect(mergeConfirmedMoves(fresh, "other", [known])).toBe(fresh);
});

it("host acknowledgement releases only matching admission, retaining unknown history", async () => {
  const request = req("explicit-release");
  const scope = "release-scope";
  api.selectedMoveExecute.mockRejectedValueOnce(Error("uncertain"));
  api.selectedMoveLookup.mockResolvedValueOnce({ kind: "notFound" });
  startOptimisticMove(scope, request, base);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(blockedMovePaths(scope).size).toBe(2);
  releaseLocalMoveAdmission(request.operationId, {
    ...request.connection,
    client: "other",
  });
  expect(blockedMovePaths(scope).size).toBe(2);
  releaseLocalMoveAdmission(request.operationId, request.connection);
  expect(blockedMovePaths(scope).size).toBe(0);
  const local: MoveAttempt = {
    scope,
    request,
    originals: {},
    busy: false,
    error: "unknown",
    admissionReleased: true,
  };
  expect(unresolvedMove(local, "//fixture/a")).toBe(false);
  expect(local.error).toBe("unknown");
  expect(unresolvedMove({ ...local, busy: true }, "//fixture/a")).toBe(true);
});

const execution = (
  outcome: "notDispatched" | "verified" | "partial" | "unknown",
  overrides: Partial<import("./selectedMove").MoveExecution> = {},
): import("./selectedMove").MoveExecution => ({
  schemaVersion: 1,
  payloadDigest: "a".repeat(64),
  revision: "1",
  executionState: "settled",
  outcome,
  dispatchState: "possible",
  recoveryRequired: false,
  ...overrides,
});
function staleAttempt(
  receipt: SelectedMoveReceipt,
  overrides: Partial<MoveAttempt> = {},
): MoveAttempt {
  return {
    scope: "stale",
    request: req("stale-1"),
    originals: {},
    busy: false,
    receipt,
    ...overrides,
  };
}
it("a settled successful move whose receipt omits the per-file row must not stay unresolved forever", () => {
  const r = req("stale-2");
  const value = {
    ...receipt(r),
    execution: execution("verified"),
    files: [],
  } as unknown as SelectedMoveReceipt;
  expect(unresolvedMove(staleAttempt(value), "//fixture/a")).toBe(false);
  expect(unresolvedMove(staleAttempt(value), "//fixture/b")).toBe(false);
});
it("a terminal not-dispatched new-target move with targetCreationUnknown must not block submission", () => {
  const r = req("stale-3", { kind: "new", description: "Synthetic" });
  const value: SelectedMoveReceipt = {
    operationId: r.operationId,
    stage: "stopped",
    targetCreationUnknown: true,
    targetChangeId: null,
    files: r.files.map((f) => ({ ...f, state: "unknown" as const })),
    message: "aborted before dispatch",
    execution: execution("notDispatched", { dispatchState: "none" }),
  };
  expect(unresolvedMove(staleAttempt(value), "//fixture/a")).toBe(false);
});
it("a real unknown move still blocks submission", () => {
  const r = req("stale-4");
  const unknownReceipt: SelectedMoveReceipt = {
    ...receipt(r),
    files: r.files.map((f) => ({ ...f, state: "unknown" as const })),
    execution: execution("unknown"),
  };
  expect(unresolvedMove(staleAttempt(unknownReceipt), "//fixture/a")).toBe(
    true,
  );
  expect(
    unresolvedMove(
      staleAttempt(
        { ...receipt(r), execution: execution("partial") },
        { error: "lost" },
      ),
      "//fixture/a",
    ),
  ).toBe(false);
  expect(
    unresolvedMove(
      staleAttempt({ ...receipt(r) }, { busy: true }),
      "//fixture/a",
    ),
  ).toBe(true);
});
it("a settled verified receipt with a stale error no longer blocks submission", () => {
  const r = req("stale-error");
  const value: SelectedMoveReceipt = {
    ...receipt(r),
    execution: execution("verified"),
  };
  expect(
    unresolvedMove(
      staleAttempt(value, { error: "lookup failed after settle" }),
      "//fixture/a",
    ),
  ).toBe(false);
});

it("blockedPathDetails names the blocking subsystem and reason for the tooltip", async () => {
  const scope = "details-scope";
  api.selectedMoveExecute.mockRejectedValueOnce(Error("uncertain"));
  api.selectedMoveLookup.mockResolvedValueOnce({ kind: "notFound" });
  startOptimisticMove(scope, req("details-move"), base);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const moveDetail = blockedPathDetails(scope).get("//fixture/a");
  expect(moveDetail).toMatchObject({
    source: "move",
    reason: "unknown",
    operationId: "details-move",
  });
  const zhText = formatBlockedPaths(
    ["//fixture/a"],
    blockedPathDetails(scope),
    true,
  );
  expect(zhText).toContain("移动×1");
  expect(zhText).toContain("结果未知");
  fileActionLedger.admit(scope, "details-file-action", {
    paths: ["//fixture/file-action"],
    busy: false,
    outcome: "unknown",
    admissionReleased: false,
  } as never);
  expect(blockedPathDetails(scope).get("//fixture/file-action")).toMatchObject({
    source: "fileAction",
    reason: "unknown",
    operationId: "details-file-action",
  });
  const enText = formatBlockedPaths(
    ["//fixture/a", "//fixture/file-action"],
    blockedPathDetails(scope),
    false,
  );
  expect(enText).toContain("move×1 (unknown)");
  expect(enText).toContain("file action×1 (unknown)");
});
it("after a settled successful move plus a stale error the CL is submit-eligible again", async () => {
  const scope = "submit-eligible";
  const r = req("eligible-move");
  api.selectedMoveExecute.mockResolvedValue({
    ...receipt(r),
    execution: execution("verified"),
  });
  await h.render(<View scope={scope} />);
  await act(async () => {
    startOptimisticMove(scope, r, base);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(blockedMovePaths(scope).size).toBe(0);
  // Simulate a stale error string left behind by an older/alternate lookup after
  // the move had already settled: it must not re-block the whole CL.
  const attempt = moveLedger.get(r.operationId)!.data;
  moveLedger.update(
    r.operationId,
    { ...attempt, error: "stale lookup" },
    "settled",
  );
  expect(blockedMovePaths(scope).size).toBe(0);
});
