// @vitest-environment jsdom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useOperationSession } from "./useOperationSession";
import type { OperationLease, OperationSessionOwner } from "./session";

const backend = vi.hoisted(() => ({
  cancelOperation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));

let host: HTMLDivElement;
let root: Root;
let captured: OperationSessionOwner | undefined;
let started: OperationLease[] = [];

function Probe() {
  captured = useOperationSession();
  return null;
}

function LeasingProbe() {
  const session = useOperationSession();
  useEffect(() => {
    const lease = session.start("detail");
    started.push(lease);
    return () => {
      session.abandon(lease);
    };
  }, [session]);
  return null;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  backend.cancelOperation.mockClear();
  captured = undefined;
  started = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("cancels every live lease when the owning component unmounts", async () => {
  await act(async () => root.render(<Probe />));
  const lease = captured!.start("detail");
  await act(async () => root.unmount());
  expect(backend.cancelOperation).toHaveBeenCalledWith(lease.operationId);
  expect(lease.signal.aborted).toBe(true);
});

it("keeps the same owner across renders", async () => {
  await act(async () => root.render(<Probe />));
  const first = captured;
  await act(async () => root.render(<Probe />));
  expect(captured).toBe(first);
});

it("survives the StrictMode mount/cleanup/mount cycle with one live lease", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <LeasingProbe />
      </StrictMode>,
    ),
  );
  // StrictMode re-runs effects: the discarded lease is cancelled exactly once
  // and the surviving lease is the live one for the channel.
  expect(started).toHaveLength(2);
  expect(started[0].signal.aborted).toBe(true);
  expect(started[1].signal.aborted).toBe(false);
  expect(backend.cancelOperation).toHaveBeenCalledTimes(1);
  expect(backend.cancelOperation).toHaveBeenCalledWith(started[0].operationId);
});
