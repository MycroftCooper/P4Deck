import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach } from "vitest";

/** jsdom lacks native dialog methods; behavior is separately checked in a real browser. */
export function dialogHarness() {
  let host: HTMLDivElement, root: Root;
  const methods = ["showModal", "close"];
  const originals = methods.map((name) =>
    Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
  );
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    for (const name of methods)
      Object.defineProperty(HTMLDialogElement.prototype, name, {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.toggleAttribute("open", name === "showModal");
        },
      });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    methods.forEach((name, index) => {
      if (originals[index])
        Object.defineProperty(
          HTMLDialogElement.prototype,
          name,
          originals[index]!,
        );
      else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    });
  });
  return {
    render: async (node: ReactNode) => {
      await act(async () => root.render(node));
    },
  };
}
export function dialogButton(text: string) {
  return [
    ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
  ].find((button) => button.textContent === text)!;
}
export async function chooseSelect(value: string) {
  await act(async () => {
    const select = document.querySelector<HTMLSelectElement>("dialog select")!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
