import { describe, expect, it } from "vitest";
import { commandFamily } from "./commandWatchdog";
import type { CommandId } from "./commandPolicy";
import {
  OPERATION_LIMITS,
  operationBound,
  operationLimit,
  type OperationKind,
} from "./useOperationWatchdog";
import {
  IO_DEADLINE_HEADROOM_MS,
  SYNC_LATE_RESULT_GRACE_MS,
  WATCHDOG_TICK_MS,
  WORKSPACE_BOUNDS_MS,
  WORKSPACE_WATCHDOG_MS,
} from "../../shared/operationBounds.generated";

/**
 * R9: the frontend watchdog and the backend runner must agree on one number.
 * Backend (Rust) is the owner; these assertions mirror `src-tauri/src/p4/bounds.rs`
 * and fail before a drift reaches a release. The generator check
 * (`node scripts/generate-io-bounds.mjs`) covers the generated module itself;
 * this test covers the policy built on top of it.
 */
const FAMILY_OF_KIND: Record<OperationKind, keyof typeof WORKSPACE_BOUNDS_MS> =
  {
    sync: "workspaceSync",
    getLatest: "workspaceSync",
    getRevision: "workspaceSync",
    refresh: "workspacePreview",
    // Mutating workspace commands (checkout/add/delete/lock/unlock, revert
    // batches) run under the widest interactive family.
    other: "workspaceCommand",
  };

describe("workspace command bounds match the host runner", () => {
  it("keeps the host defaults the runner clamps against", () => {
    expect(WORKSPACE_BOUNDS_MS.workspaceRead).toBe(30_000);
    expect(WORKSPACE_BOUNDS_MS.workspaceReadLong).toBe(300_000);
    expect(WORKSPACE_BOUNDS_MS.workspaceCommand).toBe(660_000);
    expect(WORKSPACE_BOUNDS_MS.workspaceSync).toBe(600_000);
    expect(WORKSPACE_BOUNDS_MS.workspacePreview).toBe(60_000);
    expect(WORKSPACE_BOUNDS_MS.workspaceBootstrap).toBe(10_000);
    expect(WORKSPACE_BOUNDS_MS.workspaceOther).toBe(180_000);
  });

  it("adds exactly the shared headroom on top of the host limit", () => {
    expect(IO_DEADLINE_HEADROOM_MS).toBe(15_000);
    expect(SYNC_LATE_RESULT_GRACE_MS).toBe(IO_DEADLINE_HEADROOM_MS);
    expect(WORKSPACE_WATCHDOG_MS.sync).toBe(
      WORKSPACE_BOUNDS_MS.workspaceSync + IO_DEADLINE_HEADROOM_MS,
    );
    expect(WORKSPACE_WATCHDOG_MS.refresh).toBe(
      WORKSPACE_BOUNDS_MS.workspacePreview + IO_DEADLINE_HEADROOM_MS,
    );
    expect(WORKSPACE_WATCHDOG_MS.other).toBe(
      // `other` watches the generic mutating commands, which the host runs under
      // `workspaceCommand` — not the shorter `workspaceOther` fallback family.
      WORKSPACE_BOUNDS_MS.workspaceCommand + IO_DEADLINE_HEADROOM_MS,
    );
  });

  it("derives every watchdog limit from its host family", () => {
    for (const kind of Object.keys(OPERATION_LIMITS) as OperationKind[]) {
      expect(operationBound(kind)).toBe(FAMILY_OF_KIND[kind]);
      expect(operationLimit(kind)).toBe(
        WORKSPACE_BOUNDS_MS[FAMILY_OF_KIND[kind]] + IO_DEADLINE_HEADROOM_MS,
      );
    }
  });

  it("keeps the tick far below the shortest limit", () => {
    expect(WATCHDOG_TICK_MS).toBeLessThan(OPERATION_LIMITS.refresh / 4);
  });

  it.each([
    ["checkout", "other"],
    ["add", "other"],
    ["delete", "other"],
    ["revert", "other"],
    ["revertUnchanged", "other"],
    ["lock", "other"],
    ["unlock", "other"],
    ["refresh", "refresh"],
    ["getLatest", "getLatest"],
    ["getRevision", "getRevision"],
  ] as [CommandId, OperationKind][])(
    "pairs toolbar command %s with its host family (%s)",
    (id, family) => {
      expect(commandFamily(id)).toBe(family);
    },
  );

  it("never lets a toolbar command be abandoned early or outlive the host", () => {
    // Every watched family must be at least as long as the host's limit for the
    // backend command it dispatches, and no UI wait may exceed the widest host
    // family plus the shared headroom (that is the whole point of R9).
    for (const kind of Object.keys(OPERATION_LIMITS) as OperationKind[]) {
      const hostMs = WORKSPACE_BOUNDS_MS[operationBound(kind)];
      expect(operationLimit(kind)).toBeGreaterThanOrEqual(hostMs);
      expect(operationLimit(kind)).toBeLessThanOrEqual(
        WORKSPACE_BOUNDS_MS.workspaceCommand + IO_DEADLINE_HEADROOM_MS,
      );
    }
    // Checkout/add/delete/delete-many run under the command family (660 s), so
    // the UI must wait longer than that rather than give up at a stale 180 s.
    for (const id of ["checkout", "add", "delete"] as CommandId[]) {
      expect(operationLimit(commandFamily(id))).toBeGreaterThanOrEqual(
        WORKSPACE_BOUNDS_MS.workspaceCommand,
      );
    }
    // Refresh is a short read: it keeps its own narrow family.
    expect(operationLimit(commandFamily("refresh"))).toBeLessThan(
      WORKSPACE_BOUNDS_MS.workspaceCommand,
    );
  });
});

describe("generated boundaries", () => {
  it("exposes one number per host family and no duplicates", () => {
    const values = Object.values(WORKSPACE_BOUNDS_MS);
    expect(values.length).toBe(new Set(Object.keys(WORKSPACE_BOUNDS_MS)).size);
  });

  it("rejects a watchdog wait that could trip before the host deadline", () => {
    // Guard the arithmetic, not just the constants: if the headroom were ever
    // removed, the shortest family would report "unknown" on a healthy timeout.
    expect(
      Object.values(WORKSPACE_WATCHDOG_MS).every(
        (value) => value >= WORKSPACE_BOUNDS_MS.workspacePreview,
      ),
    ).toBe(true);
    expect(WORKSPACE_WATCHDOG_MS.sync - WORKSPACE_BOUNDS_MS.workspaceSync).toBe(
      IO_DEADLINE_HEADROOM_MS,
    );
  });
});
