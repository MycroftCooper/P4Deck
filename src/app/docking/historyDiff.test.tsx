// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DockviewApi } from "dockview-react";
import { useDockController } from "./useDockController";
import { pageLabels } from "../panels";
import { historyDiffTarget } from "../shell/commandPolicy";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emitTo: vi.fn() }));

it("opens a fresh locked Diff for each toolbar history pair and relabels existing tabs", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let controller!: ReturnType<typeof useDockController>;
  function Harness({
    zh,
    selectedPath,
  }: {
    zh: boolean;
    selectedPath?: string;
  }) {
    controller = useDockController({
      zh,
      selectedPath,
      pages: [],
      active: null,
      labels: pageLabels(zh),
      runtimeBinding: { connectionKey: "mock", contextGeneration: 1 },
      render: () => null,
      onActive() {},
      onPages() {},
    });
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const updateParameters = vi.fn(),
    setActive = vi.fn(),
    setTitle = vi.fn(),
    addPanel = vi.fn();
  try {
    await act(async () => root.render(<Harness zh={false} />));
    controller.api.current = {
      panels: [
        {
          id: "diff--existing",
          title: "Diff",
          params: { target: "//mock/config.toml", locked: false },
          api: { updateParameters, setActive, setTitle },
        },
        {
          id: "history--existing",
          title: "History",
          params: { target: "//mock/config.toml", locked: false },
          api: { setTitle },
        },
      ],
      addPanel,
    } as unknown as DockviewApi;
    const pair = historyDiffTarget({
      type: "history",
      path: "//mock/config.toml",
      revisions: [8, 7],
    })!;
    await act(async () => {
      controller.open("diff", pair.path, true, pair);
      controller.open("diff", pair.path, true, pair);
    });
    expect(addPanel).toHaveBeenCalledTimes(2);
    expect(addPanel.mock.calls[0][0].id).not.toBe(addPanel.mock.calls[1][0].id);
    expect(addPanel.mock.calls[0][0].params).toMatchObject({
      target: pair.path,
      locked: true,
      comparison: { left: 7, right: 8 },
    });
    expect(updateParameters).not.toHaveBeenCalled();
    expect(setActive).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness zh />));
    expect(setTitle).toHaveBeenCalledWith("历史记录 · config.toml");
    expect(setTitle).toHaveBeenCalledWith("差异 · config.toml");
    const pinnedUpdate = vi.fn();
    controller.api.current = {
      panels: [
        {
          ...addPanel.mock.calls[0][0],
          api: { updateParameters: pinnedUpdate, setTitle },
        },
      ],
      addPanel,
    } as unknown as DockviewApi;
    await act(async () =>
      root.render(<Harness zh selectedPath="//mock/unrelated.txt" />),
    );
    expect(pinnedUpdate).not.toHaveBeenCalled();
    expect(controller.api.current!.panels[0].params).toMatchObject({
      target: "//mock/config.toml",
      comparison: { left: 7, right: 8 },
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
