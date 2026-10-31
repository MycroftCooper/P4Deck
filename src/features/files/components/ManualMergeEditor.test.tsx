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
import type {
  ExternalMergeResult,
  ManualMergeSession,
} from "../../../shared/contracts";
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

const externalButton = () =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    ["Merge with P4Merge", "Waiting for P4Merge…"].includes(
      button.textContent ?? "",
    ),
  )!;

const renderEditor = async (connectionKey: string) => {
  await act(async () =>
    root.render(
      <ManualMergeEditor
        depotPath="//depot/file.txt"
        connectionKey={connectionKey}
        zh={false}
      />,
    ),
  );
};

it("runs P4Merge with the editor result, fills Result, and never validates or saves", async () => {
  vi.spyOn(backend, "detectExternalMergeTool").mockResolvedValue({
    available: true,
    executable: "C:\\Program Files\\Perforce\\p4merge.exe",
    source: "commonPath",
    reason:
      "P4MERGE points to a non-.exe wrapper (for example .bat/.cmd); set P4MERGE to p4merge.exe.",
  });
  vi.spyOn(backend, "openManualMerge").mockResolvedValue(
    session("p4merge", "draft result\n"),
  );
  vi.spyOn(backend, "cancelOperation").mockResolvedValue(undefined);
  const validate = vi.spyOn(backend, "validateManualMerge");
  const save = vi.spyOn(backend, "confirmManualMergeSave");
  const pending = deferred<ExternalMergeResult>();
  const run = vi
    .spyOn(backend, "runExternalMerge")
    .mockReturnValue(pending.promise);
  await renderEditor("p4merge");

  expect(externalButton().disabled).toBe(false);
  // A skipped Windows `.bat` wrapper still lets the fallback executable win,
  // and the reason stays visible instead of being dropped silently.
  expect(host.textContent).toContain("non-.exe wrapper");
  await act(async () => externalButton().click());
  await act(async () => {});
  expect(run).toHaveBeenCalledWith({
    sessionId: "p4merge",
    result: "draft result\n",
  });
  expect(externalButton().textContent).toBe("Waiting for P4Merge…");
  expect(externalButton().disabled).toBe(true);

  await act(async () =>
    pending.resolve({
      status: "completed",
      result: "merged by p4merge\n",
      exitCode: 0,
      operationIds: [],
    }),
  );
  await act(async () => {});
  expect(
    (host.querySelector('[aria-label="Result"]') as HTMLTextAreaElement).value,
  ).toBe("merged by p4merge\n");
  expect(host.textContent).toContain(
    "Read back the P4Merge result; review it before validate/save",
  );
  expect(validate).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("disables the P4Merge button and shows the detection reason when unavailable", async () => {
  vi.spyOn(backend, "detectExternalMergeTool").mockResolvedValue({
    available: false,
    reason:
      "P4Merge was not found in P4MERGE, the common install locations, or PATH",
  });
  vi.spyOn(backend, "openManualMerge").mockResolvedValue(
    session("no-tool", "draft\n"),
  );
  vi.spyOn(backend, "cancelOperation").mockResolvedValue(undefined);
  const run = vi.spyOn(backend, "runExternalMerge");
  await renderEditor("no-tool");

  expect(externalButton().disabled).toBe(true);
  expect(host.textContent).toContain("P4Merge was not found");
  await act(async () => externalButton().click());
  expect(run).not.toHaveBeenCalled();
});

it("keeps Result intact and reports unchanged and failed P4Merge outcomes", async () => {
  vi.spyOn(backend, "detectExternalMergeTool").mockResolvedValue({
    available: true,
    executable: "p4merge",
    source: "path",
  });
  vi.spyOn(backend, "openManualMerge").mockResolvedValue(
    session("outcomes", "original\n"),
  );
  vi.spyOn(backend, "cancelOperation").mockResolvedValue(undefined);
  const run = vi
    .spyOn(backend, "runExternalMerge")
    .mockResolvedValueOnce({
      status: "unchanged",
      exitCode: 0,
      operationIds: [],
    })
    .mockResolvedValueOnce({
      status: "failed",
      exitCode: 2,
      reason: "P4Merge exited with code 2",
      operationIds: [],
    });
  await renderEditor("outcomes");

  await act(async () => externalButton().click());
  await act(async () => {});
  expect(run).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("P4Merge did not change the result");

  await act(async () => externalButton().click());
  await act(async () => {});
  expect(run).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("P4Merge exited with code 2");
  expect(
    (host.querySelector('[aria-label="Result"]') as HTMLTextAreaElement).value,
  ).toBe("original\n");
});
