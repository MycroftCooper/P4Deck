// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AccentSettings } from "./AccentSettings";
import { defaultAccent } from "./accent";
it("applies presets and valid custom colors immediately, keeping invalid drafts out of preferences", async () => {
  const save = vi.fn();
  function Harness() {
    const [value, setValue] = useState(defaultAccent);
    return (
      <AccentSettings
        zh={false}
        value={value}
        onChange={(color) => {
          setValue(color);
          save(color);
        }}
      />
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    const select = host.querySelector("select")!;
    await act(async () => {
      select.value = "#2563eb";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(save).toHaveBeenLastCalledWith("#2563eb");
    const input = host.querySelector<HTMLInputElement>(
      'input:not([type="color"])',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(input, "#zzzzzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await act(async () => {
      setter.call(input, "#ABCDEF");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save).toHaveBeenLastCalledWith("#abcdef");
    expect(select.value).toBe("custom");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
