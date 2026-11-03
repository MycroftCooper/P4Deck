// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ResizableTable } from "./ResizableTable";

it("isolates tables, preserves native spacer rows, and prevents resize gestures triggering header actions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const click = vi.fn();
  try {
    await act(async () =>
      root.render(
        <>
          {["first", "second"].map((id) => (
            <ResizableTable
              key={id}
              tableId={id}
              defaults={[200, 150]}
              minimums={[100, 80]}
            >
              <thead>
                <tr>
                  <th onClick={click}>Path</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                <tr aria-hidden="true">
                  <td colSpan={2} style={{ height: 1000 }} />
                </tr>
                <tr>
                  <td>long path</td>
                  <td>ready</td>
                </tr>
              </tbody>
            </ResizableTable>
          ))}
        </>,
      ),
    );
    const grip = host.querySelector<HTMLElement>('[role="separator"]')!;
    Object.defineProperties(grip, {
      setPointerCapture: { value: vi.fn() },
      releasePointerCapture: { value: vi.fn() },
    });
    const pointer = async (type: string, x: number) => {
      const event = new MouseEvent(type, {
        button: 0,
        bubbles: true,
        clientX: x,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      await act(async () => grip.dispatchEvent(event));
    };
    await pointer("pointerdown", 100);
    await pointer("pointermove", 160);
    await pointer("pointerup", 160);
    expect(grip.getAttribute("aria-valuenow")).toBe("260");
    expect(host.querySelectorAll("col")[0].style.width).toBe("260px");
    expect(host.querySelectorAll("col")[2].style.width).toBe("200px");
    await act(async () => grip.click());
    expect(click).not.toHaveBeenCalled();
    await act(async () =>
      grip.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      ),
    );
    expect(grip.getAttribute("aria-valuenow")).toBe("100");
    await act(async () =>
      grip.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    expect(grip.getAttribute("aria-valuenow")).toBe("200");
    await pointer("pointerdown", 0);
    await pointer("pointercancel", 0);
    await pointer("pointermove", 300);
    expect(grip.getAttribute("aria-valuenow")).toBe("200");
    expect(host.querySelectorAll('td[colspan="2"]')).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps the default relative header positioning and opts into sticky headers", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <>
          <ResizableTable
            tableId="default-header"
            defaults={[120]}
            minimums={[60]}
          >
            <thead>
              <tr>
                <th>A</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>a</td>
              </tr>
            </tbody>
          </ResizableTable>
          <ResizableTable
            tableId="sticky-header"
            defaults={[120]}
            minimums={[60]}
            headerSticky
          >
            <thead>
              <tr>
                <th>A</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>a</td>
              </tr>
            </tbody>
          </ResizableTable>
        </>,
      ),
    );
    const header = (id: string) =>
      host.querySelector<HTMLElement>(`[data-table-id="${id}"] thead th`)!;
    expect(header("default-header").style.position).toBe("relative");
    expect(header("sticky-header").style.position).toBe("sticky");
    // The grip still anchors inside the sticky header cell.
    expect(
      header("sticky-header").querySelector('[role="separator"]'),
    ).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("only instruments the first header row of a multi-row header", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ResizableTable
          tableId="multi-row"
          defaults={[120, 120]}
          minimums={[60, 60]}
          headerSticky
        >
          <thead>
            <tr>
              <th>Letters</th>
              <th>Second</th>
            </tr>
            <tr>
              <th>Frozen</th>
              <th>Labels</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>a</td>
              <td>b</td>
            </tr>
          </tbody>
        </ResizableTable>,
      ),
    );
    const rows = host.querySelectorAll<HTMLElement>("thead tr");
    expect(host.querySelectorAll('thead [role="separator"]')).toHaveLength(2);
    expect(rows[0].querySelectorAll('[role="separator"]')).toHaveLength(2);
    expect(rows[1].querySelectorAll('[role="separator"]')).toHaveLength(0);
    expect(rows[0].querySelector("th")?.style.position).toBe("sticky");
    expect(rows[1].querySelector("th")?.style.position).toBe("");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
