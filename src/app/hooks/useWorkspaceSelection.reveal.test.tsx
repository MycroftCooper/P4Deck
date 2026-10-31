// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import { useWorkspaceSelection } from "./useWorkspaceSelection";
import type { WorkspaceNode } from "../../shared/contracts";
const d = vi.hoisted(() => ({ focus: vi.fn(), target: { type: "none" } }));
vi.mock("../shell/useCommandTarget", () => ({ useCommandTarget: () => d }));
const h = dialogHarness();
let state: ReturnType<typeof useWorkspaceSelection>;
const open = vi.fn();
function Observe({ scope }: { scope: string }) {
  state = useWorkspaceSelection(scope, "C:/fixture", open);
  return null;
}
const file: WorkspaceNode = {
  id: "a",
  name: "a",
  absolutePath: "C:/fixture/a",
  relativePath: "a",
  kind: "file",
  state: "controlled",
};
it("explicit navigation creates new same-path requests; old consumption cannot erase a newer request", async () => {
  await h.render(<Observe scope="one" />);
  await act(async () => state.navigate(file));
  const first = state.reveal!;
  await act(async () => state.navigate(file));
  expect(state.reveal!.id).toBeGreaterThan(first.id);
  expect(state.directory).toBeUndefined();
  expect(open).toHaveBeenCalled();
  await act(async () => state.consumeReveal(first.id));
  expect(state.reveal).toBeDefined();
  await act(async () => state.consumeReveal(state.reveal!.id));
  expect(state.reveal).toBeUndefined();
});
it("connection change clears requests and depot-only navigation never guesses local mapping", async () => {
  await h.render(<Observe scope="one" />);
  await act(async () => state.navigate(file));
  await h.render(<Observe scope="two" />);
  expect(state.reveal).toBeUndefined();
  await act(async () =>
    state.navigate({ ...file, absolutePath: "", depotPath: "//synthetic/a" }),
  );
  expect(state.reveal).toBeUndefined();
});
