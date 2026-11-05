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
  WATCHDOG_TICK_MS,
  WORKSPACE_BOUNDS_MS,
} from "../../shared/operationBounds.generated";

/**
 * R9: the frontend watchdog and the backend runner must agree on one number.
 * The Rust `p4::bounds` table is the only owner; the generated module mirrors it
 * (checked by `scripts/generate-io-bounds.mjs --check`, which runs before every
 * `test:web`), and these assertions cover the policy built on top of it.
 *
 * There is deliberately no `FAMILY_OF_KIND` copy here: `operationBound()` is the
 * production mapping, so the invariants below read it instead of restating it.
 */
describe("workspace command bounds mirror the host runner", () => {
  it("keeps the host defaults the runner clamps against", () => {
    expect(WORKSPACE_BOUNDS_MS.workspaceRead).toBe(30_000);
    expect(WORKSPACE_BOUNDS_MS.workspaceReadLong).toBe(300_000);
    expect(WORKSPACE_BOUNDS_MS.workspaceCommand).toBe(660_000);
    expect(WORKSPACE_BOUNDS_MS.workspaceSync).toBe(600_000);
    expect(WORKSPACE_BOUNDS_MS.workspacePreview).toBe(60_000);
    expect(WORKSPACE_BOUNDS_MS.workspaceBootstrap).toBe(10_000);
    expect(WORKSPACE_BOUNDS_MS.workspaceOther).toBe(180_000);
  });

  it("derives every watchdog limit from its host family plus the headroom", () => {
    for (const kind of Object.keys(OPERATION_LIMITS) as OperationKind[]) {
      expect(operationLimit(kind)).toBe(
        WORKSPACE_BOUNDS_MS[operationBound(kind)] + IO_DEADLINE_HEADROOM_MS,
      );
    }
  });

  it("never lets the UI give up on a command the host may still finish", () => {
    // The R9 bug: checkout/add/delete run under the host's mutation family
    // (660 s), but the watchdog gave up at 180 s. Every watched operation must
    // outlive its own host family by exactly the headroom.
    for (const kind of Object.keys(OPERATION_LIMITS) as OperationKind[]) {
      const hostMs = WORKSPACE_BOUNDS_MS[operationBound(kind)];
      expect(operationLimit(kind)).toBeGreaterThanOrEqual(hostMs);
    }
  });

  it("never waits past the widest host family plus the headroom", () => {
    const ceiling =
      WORKSPACE_BOUNDS_MS.workspaceCommand + IO_DEADLINE_HEADROOM_MS;
    for (const kind of Object.keys(OPERATION_LIMITS) as OperationKind[]) {
      expect(operationLimit(kind)).toBeLessThanOrEqual(ceiling);
    }
  });

  it("keeps the tick far below the shortest limit and the headroom", () => {
    expect(WATCHDOG_TICK_MS).toBeLessThan(OPERATION_LIMITS.refresh / 4);
    // The tick is the watchdog's sampling granularity: if it approached the
    // headroom, a healthy command could still trip the "unknown" path.
    expect(WATCHDOG_TICK_MS).toBeLessThan(IO_DEADLINE_HEADROOM_MS / 2);
  });
});

describe("toolbar commands map to the family the host actually enforces", () => {
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
    "pairs %s with its host family (%s)",
    (id, family) => {
      expect(commandFamily(id)).toBe(family);
    },
  );

  it("watches every mutating toolbar command for at least the mutation family", () => {
    // These dispatch a backend command the runner bounds at `workspaceCommand`.
    for (const id of [
      "checkout",
      "add",
      "delete",
      "revert",
      "revertUnchanged",
      "lock",
      "unlock",
    ] as CommandId[]) {
      expect(operationLimit(commandFamily(id))).toBeGreaterThanOrEqual(
        WORKSPACE_BOUNDS_MS.workspaceCommand,
      );
    }
  });

  it("keeps refresh on its own narrow family", () => {
    expect(operationLimit(commandFamily("refresh"))).toBeLessThan(
      WORKSPACE_BOUNDS_MS.workspaceCommand,
    );
  });
});
