// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useRecordSelection } from "./useRecordSelection";

let host: HTMLDivElement, root: Root;
const rows = ["a", "b", "c"];
function Harness({ scope = "first" }: { scope?: string }) {
  const selection = useRecordSelection(rows, (row) => row, scope);
  return (
    <>
      <output>{selection.selected.join(",")}</output>
      {rows.map((row) => (
        <div
          key={row}
          data-row={row}
          tabIndex={0}
          onKeyDownCapture={(event) => selection.keyboard(row, event)}
          onContextMenu={(event) => {
            event.preventDefault();
            selection.context(row);
          }}
        >
          {row}
          <button>Nested action</button>
        </div>
      ))}
    </>
  );
}
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function key(row: string, options: KeyboardEventInit = {}) {
  await act(async () => {
    host.querySelector(`[data-row="${row}"]`)!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
        ...options,
      }),
    );
  });
}
const selected = () => host.querySelector("output")!.textContent;
it("supports keyboard single, additive and range selection", async () => {
  await key("a");
  expect(selected()).toBe("a");
  await key("c", { metaKey: true });
  expect(selected()).toBe("a,c");
  await key("c", { ctrlKey: true });
  expect(selected()).toBe("a");
  await key("a", { shiftKey: true });
  expect(selected()).toBe("a,b,c");
});
it("keeps a selected context target within the multi-selection and replaces it for an unselected row", async () => {
  await key("a");
  await key("b", { ctrlKey: true });
  const context = async (row: string) =>
    act(async () => {
      host
        .querySelector(`[data-row="${row}"]`)!
        .dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        );
    });
  await context("a");
  expect(selected()).toBe("a,b");
  await context("c");
  expect(selected()).toBe("c");
});
it("does not intercept selection keys on nested controls", async () => {
  await act(async () => {
    const event = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    host.querySelector("button")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  expect(selected()).toBe("");
});
it("clears selection when its object scope changes", async () => {
  await key("a");
  await act(async () => root.render(<Harness scope="second" />));
  expect(selected()).toBe("");
});
