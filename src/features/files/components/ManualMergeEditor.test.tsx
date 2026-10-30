// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backend } from "../../../infrastructure/backend";
const closeGuard = vi.hoisted(() => ({
  state: vi.fn((_state: string, _scope?: string) => () => {}),
}));
vi.mock("../../../app/closeGuard", () => ({
  useUnsavedEditor: closeGuard.state,
}));
import type { ManualMergeSession } from "../../../shared/contracts";
import {
  ManualMergeEditor,
  manualMergeBlocksForTest,
  resolveManualMergeBlock,
} from "./ManualMergeEditor";

const conflict = (id: number, yours: string, theirs: string, eol = "\n") =>
  `<<<<<<< P4DECK YOURS:${id}${eol}${yours}${eol}======= P4DECK${eol}${theirs}${eol}>>>>>>> P4DECK THEIRS:${id}${eol}`;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

const session = (id: string, result: string): ManualMergeSession => ({
  sessionId: id,
  activeProfileId: id,
  target: {
    kind: "resolve",
    server: "ssl:server:1666",
    user: "user",
    client: "client",
    workspace: "C:\\workspace",
    contextGeneration: 1,
    depotPaths: ["//depot/file.txt"],
  },
  depotPath: "//depot/file.txt",
  localPath: "C:\\workspace\\file.txt",
  baseSource: { depotPath: "//depot/file.txt", revision: 1 },
  theirsSource: { depotPath: "//depot/file.txt", revision: 3 },
  fileSnapshot: { size: result.length, modifiedMs: 1, contentDigest: id },
  resolveDigest: id,
  base: "base\n",
  theirs: "theirs\n",
  yours: "yours\n",
  result,
  encoding: "UTF-8",
  lineEnding: "LF",
  hadBom: false,
  unresolvedBlocks: 0,
  expiresAt: Date.now() + 60_000,
  operationIds: [],
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

it("compares the merge result against disk Yours, then advances the baseline only after successful save", async () => {
  vi.spyOn(backend, "openManualMerge").mockResolvedValue(
    session("save", "merged\n"),
  );
  vi.spyOn(backend, "cancelOperation").mockResolvedValue(undefined);
  vi.spyOn(backend, "validateManualMerge").mockResolvedValue({
    valid: true,
    unresolvedBlocks: 0,
    resultDigest: "digest",
    token: "token",
    expiresAt: Date.now() + 60000,
    message: "ok",
  });
  vi.spyOn(backend, "confirmManualMergeSave").mockResolvedValue({
    outcome: "succeeded",
    message: "saved",
    resultDigest: "digest",
    resolveExpiresAt: 0,
    operationId: "synthetic-save",
    refresh: {
      pendingChanges: false,
      workspaceStatus: false,
      depotPaths: [],
      reason: "synthetic",
    },
  });
  await act(async () =>
    root.render(
      <ManualMergeEditor
        depotPath="//synthetic/file"
        connectionKey="save"
        zh={false}
      />,
    ),
  );
  expect(closeGuard.state.mock.lastCall?.[0]).toBe("dirty");
  const click = async (text: string) =>
    act(async () =>
      [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === text)!
        .click(),
    );
  await click("Validate result");
  await click("Confirm atomic save");
  expect(closeGuard.state.mock.lastCall?.[0]).toBe("clean");
});

it("resolves only the selected block when surrounding text repeats", () => {
  const value = `same\n${conflict(1, "left", "right")}same\n${conflict(2, "left", "right")}`;
  const next = resolveManualMergeBlock(value, 1, "theirs");
  expect(manualMergeBlocksForTest(next)).toHaveLength(1);
  expect(next).toContain("<<<<<<< P4DECK YOURS:1");
  expect(next).toContain("same\nright\n");
});

it("supports CRLF and accept both without touching another block", () => {
  const value = `${conflict(1, "ours", "theirs", "\r\n")}${conflict(2, "a", "b", "\r\n")}`;
  const next = resolveManualMergeBlock(value, 0, "both");
  expect(next.startsWith("ours\r\ntheirs\r\n")).toBe(true);
  expect(manualMergeBlocksForTest(next).map((block) => block.id)).toEqual([
    "2",
  ]);
});

it("cancels the old group and ignores a late load after connection drift", async () => {
  const first = deferred<ManualMergeSession>();
  const second = deferred<ManualMergeSession>();
  vi.spyOn(backend, "openManualMerge")
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const cancel = vi.spyOn(backend, "cancelOperation").mockResolvedValue();

  await act(async () => {
    root.render(
      <ManualMergeEditor
        depotPath="//depot/file.txt"
        connectionKey="connection-a"
        zh={false}
      />,
    );
  });
  await act(async () => {
    root.render(
      <ManualMergeEditor
        depotPath="//depot/file.txt"
        connectionKey="connection-b"
        zh={false}
      />,
    );
  });
  await act(async () => second.resolve(session("latest", "LATEST\n")));
  expect(
    (host.querySelector('[aria-label="Result"]') as HTMLTextAreaElement).value,
  ).toBe("LATEST\n");

  await act(async () => first.resolve(session("stale", "STALE\n")));
  expect(
    (host.querySelector('[aria-label="Result"]') as HTMLTextAreaElement).value,
  ).toBe("LATEST\n");
  expect(cancel).toHaveBeenCalledTimes(1);
});
