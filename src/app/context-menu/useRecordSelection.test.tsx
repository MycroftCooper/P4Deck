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

let bounded: ReturnType<typeof useRecordSelection<string>>;
function Bounded({
  items = rows,
  scope = "bounded",
}: {
  items?: string[];
  scope?: string;
}) {
  bounded = useRecordSelection(items, (row) => row, scope, 2);
  return (
    <>
      {items.map((row) => (
        <div
          key={row}
          data-row={row}
          tabIndex={0}
          onKeyDown={(event) => bounded.keyboard(row, event)}
        />
      ))}
    </>
  );
}
it("keeps a FIFO pair in actual selection order, independent of sorted rows", async () => {
  await act(async () => root.render(<Bounded items={["d", "c", "b", "a"]} />));
  for (const row of ["a", "b", "c"]) await act(async () => bounded.select(row));
  expect(bounded.selected).toEqual(["b", "c"]);
  await act(async () => bounded.select("b"));
  await act(async () => bounded.select("d"));
  expect(bounded.selected).toEqual(["c", "d"]);
  await act(async () => bounded.context("d"));
  expect(bounded.selected).toEqual(["c", "d"]);
  await act(async () =>
    bounded.select("d", { ctrlKey: true, metaKey: false, shiftKey: false }),
  );
  expect(bounded.selected).toEqual(["c"]);
  await act(async () =>
    bounded.select("b", { ctrlKey: false, metaKey: true, shiftKey: false }),
  );
  expect(bounded.selected).toEqual(["c", "b"]);
  await key("a");
  expect(bounded.selected).toEqual(["b", "a"]);
  await act(async () => bounded.context("d"));
  expect(bounded.selected).toEqual(["a", "d"]);
});
it("handles ranges and select-all in deterministic insertion order with a two-item cap", async () => {
  await act(async () => root.render(<Bounded />));
  await act(async () => bounded.select("a"));
  await key("c", { shiftKey: true });
  expect(bounded.selected).toEqual(["b", "c"]);
  await act(async () => bounded.clear());
  await act(async () => bounded.all());
  expect(bounded.selected).toEqual(["b", "c"]);
  await act(async () => bounded.all());
  expect(new Set(bounded.selected).size).toBe(2);
});
it("prunes missing bounded records on refresh and clears selection on a new file", async () => {
  await act(async () => root.render(<Bounded />));
  await act(async () => bounded.all());
  await act(async () => root.render(<Bounded items={["c", "d"]} />));
  expect(bounded.selected).toEqual(["c"]);
  await act(async () => bounded.select("d"));
  expect(bounded.selected).toEqual(["c", "d"]);
  await act(async () => root.render(<Bounded scope="new-file" />));
  expect(bounded.selected).toEqual([]);
});
