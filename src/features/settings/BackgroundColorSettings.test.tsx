// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackgroundColorSettings } from "./BackgroundColorSettings";
import { backgroundPresets } from "./background";

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = false;
});

function Harness({
  initial = "",
  save,
}: {
  initial?: string;
  save(next: string): void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <BackgroundColorSettings
      zh
      value={value}
      onChange={(next) => {
        setValue(next);
        save(next);
      }}
    />
  );
}

const setInput = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it("applies presets, keeps invalid hex out, and resets to the theme default", async () => {
  const save = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness save={save} />));
    const swatches = [
      ...host.querySelectorAll<HTMLButtonElement>(".background-swatch"),
    ];
    expect(swatches[0]!.getAttribute("aria-pressed")).toBe("true");
    const pine = swatches.find((button) =>
      button.textContent?.includes("松绿"),
    )!;
    expect(pine).toBeTruthy();
    await act(async () => pine.click());
    expect(save).toHaveBeenLastCalledWith(backgroundPresets[0].tone);
    expect(pine.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll(".background-preview")).toHaveLength(2);
    // Each theme preview shows the chrome layer next to the panel layer.
    expect(host.querySelectorAll(".background-preview-chrome")).toHaveLength(2);

    const hex = host.querySelector<HTMLInputElement>(".background-hex")!;
    await setInput(hex, "#zzzzzz");
    expect(save).toHaveBeenCalledTimes(1);
    expect(hex.getAttribute("aria-invalid")).toBe("true");
    await setInput(hex, "#ABCDEF");
    expect(save).toHaveBeenLastCalledWith("#abcdef");
    expect(hex.getAttribute("aria-invalid")).toBe("false");

    const color = host.querySelector<HTMLInputElement>('input[type="color"]')!;
    await setInput(color, "#123456");
    expect(save).toHaveBeenLastCalledWith("#123456");

    const reset = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "恢复默认背景",
    )!;
    expect(reset.disabled).toBe(false);
    await act(async () => reset.click());
    expect(save).toHaveBeenLastCalledWith("");
    expect(host.querySelectorAll(".background-preview")).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("keeps the reset disabled while the theme background applies", async () => {
  const save = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness save={save} />));
    const reset = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "恢复默认背景",
    )!;
    expect(reset.disabled).toBe(true);
    const themeDefault = host.querySelector(".background-swatch")!;
    await act(async () => (themeDefault as HTMLButtonElement).click());
    expect(save).toHaveBeenLastCalledWith("");
    expect(host.querySelectorAll(".background-preview")).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
