// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { useFullTextSelection } from "./FullTextSelection";

it("selects complete text in the source document and restores its focus", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const owner = frame.contentDocument!;
  const host = owner.createElement("div");
  owner.body.append(host);
  const original = Object.getOwnPropertyDescriptor(
    owner.defaultView!.HTMLDialogElement.prototype,
    "showModal",
  );
  Object.defineProperty(
    owner.defaultView!.HTMLDialogElement.prototype,
    "showModal",
    {
      configurable: true,
      value() {
        this.setAttribute("open", "");
      },
    },
  );
  function Fixture() {
    const text = useFullTextSelection();
    return (
      <section ref={text.surfaceRef}>
        <button onClick={() => text.selectAll("line 1\nline 2\nline 3")}>
          Select
        </button>
        {text.dialog}
      </section>
    );
  }
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Fixture />));
    const source = owner.querySelector("button")!;
    source.focus();
    await act(async () => source.click());
    expect(document.querySelector("dialog")).toBeNull();
    const dialog = owner.querySelector("dialog")!;
    const input = dialog.querySelector("textarea")!;
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    await act(async () => dialog.querySelector("button")!.click());
    expect(owner.querySelector("dialog")).toBeNull();
    expect(owner.activeElement).toBe(source);
  } finally {
    await act(async () => root.unmount());
    if (original)
      Object.defineProperty(
        owner.defaultView!.HTMLDialogElement.prototype,
        "showModal",
        original,
      );
    frame.remove();
  }
});
