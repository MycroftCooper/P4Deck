// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { dialogHarness, dialogButton } from "./testHarness";
import { useCommandDialogs } from "./useCommandDialogs";
import type { WorkspaceNode } from "../../shared/contracts/types";
const harness = dialogHarness();
const node: WorkspaceNode = {
  id: "a",
  name: "a",
  kind: "file",
  state: "controlled",
  absolutePath: "/a",
  relativePath: "a",
};
let api!: ReturnType<typeof useCommandDialogs>;
function Harness({ scope = "a" }: { scope?: string }) {
  api = useCommandDialogs(scope, "workspace", true);
  return api.element;
}
it("serializes command modals and ignores a second preview while one is open", async () => {
  await harness.render(<Harness />);
  await act(async () => {
    api.open({ kind: "rename", node, source: null });
    api.open({ kind: "resolve", nodes: [node], source: null });
  });
  expect(document.querySelectorAll("dialog")).toHaveLength(1);
  expect(document.body.textContent).toContain("重命名 / 移动");
  await act(async () => dialogButton("取消").click());
  expect(document.querySelector("dialog")).toBeNull();
});
it("cancels awaited revisions on connection change without leaking a later modal", async () => {
  await harness.render(<Harness />);
  let result!: Promise<string | null>;
  await act(async () => {
    result = api.getRevision({ nodes: [node], source: null });
  });
  await harness.render(<Harness scope="b" />);
  expect(await result).toBeNull();
  expect(document.querySelector("dialog")).toBeNull();
});
