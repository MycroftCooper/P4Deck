// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandFamily } from "./commandWatchdog";
import {
  startOperation,
  useOperationWatchdog,
  type ActiveOperation,
} from "./useOperationWatchdog";
import { WORKSPACE_BOUNDS_MS } from "../../shared/operationBounds.generated";

/**
 * R9's original bug was behavioural, not numeric: the toolbar watchdog reported
 * an "unknown outcome" while the host was still entitled to let the command run.
 * `operationBounds.test.ts` covers the bound tables; this file drives the real
 * hook under fake timers to prove the behaviour itself.
 */
type Kind = Parameters<typeof startOperation>[2]["kind"];

function op(kind: Kind, id = "op-1"): ActiveOperation {
  return startOperation(id, "label", {
    kind,
    cancellable: true,
    targetCount: 1,
  });
}

describe("useOperationWatchdog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onTimeout: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    onTimeout = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const Probe = ({ operation }: { operation: ActiveOperation | undefined }) => {
    useOperationWatchdog(operation, onTimeout);
    return null;
  };

  function mount(operation: ActiveOperation) {
    act(() => root.render(<Probe operation={operation} />));
  }
  function advance(ms: number) {
    act(() => vi.advanceTimersByTime(ms));
  }

  it("stays quiet while the host may still finish a mutating command", () => {
    // checkout/add/delete run under the host's 660 s mutation family. Before R9
    // the watchdog gave up on them at 180 s.
    mount(op(commandFamily("checkout")));
    advance(WORKSPACE_BOUNDS_MS.workspaceCommand);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("fires once the watchdog's own limit passes", () => {
    const operation = op("refresh");
    mount(operation);
    advance(operation.limitMs - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    advance(5_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0][0].id).toBe("op-1");
  });

  it("follows a shorter operation that replaces a longer one", () => {
    mount(op("sync", "long"));
    const short = op("refresh", "short");
    act(() => root.render(<Probe operation={short} />));
    advance(short.limitMs + 5_000);
    // The hook re-notifies on every tick past the limit by design (the consumer
    // de-duplicates by id); what matters is that it only ever reports the
    // operation that is actually current.
    expect(onTimeout.mock.calls.length).toBeGreaterThan(0);
    expect(new Set(onTimeout.mock.calls.map((call) => call[0].id))).toEqual(
      new Set(["short"]),
    );
  });

  it("stops ticking once the operation clears", () => {
    const operation = op("refresh");
    mount(operation);
    act(() => root.render(<Probe operation={undefined} />));
    advance(operation.limitMs * 2);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
