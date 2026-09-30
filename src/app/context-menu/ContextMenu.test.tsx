// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextMenuProvider, useContextMenu } from "./ContextMenu";
import type { MenuBindings } from "./model";
import { Dialog } from "../dialogs/Dialog";

let host: HTMLDivElement, root: Root;
const run = vi.fn();
function Targets({ resolve }: { resolve?: () => Promise<MenuBindings> }) {
  const menu = useContextMenu();
  return (
    <section {...menu("F09", () => ({}), { title: "background" })}>
      <button
        data-testid="file"
        {...menu(
          "F01",
          () => ({ 文件预览: { run }, "复制 › 文件名": { run } }),
          { title: "file", resolve },
        )}
      >
        File
      </button>
      <button
        data-testid="folder"
        {...menu("F03", () => ({}), { title: "folder" })}
      >
        Folder
      </button>
      <input aria-label="native input" />
    </section>
  );
}
const query = (selector: string) =>
  document.querySelector<HTMLElement>(selector)!;
async function rightClick(selector: string) {
  await act(async () => {
    query(selector).dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 400,
        clientY: 200,
      }),
    );
  });
}
async function key(selector: string, key: string) {
  await act(async () => {
    query(selector).focus();
  });
  await act(async () => {
    query(selector).dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        shiftKey: key === "F10",
      }),
    );
  });
}
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  run.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <ContextMenuProvider scope="a" zh>
        <Targets />
      </ContextMenuProvider>,
    );
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("mouse right-click on a row stops the ancestor blank-area menu", async () => {
  await rightClick('[data-testid="file"]');
  expect(query('[role="menu"]').getAttribute("aria-label")).toBe("file");
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
  expect(document.activeElement?.getAttribute("data-menu-item")).toBe("F01-01");
});
it("leaves text fields to the native context menu", async () => {
  let prevented = false;
  await act(async () => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    query("input").dispatchEvent(event);
    prevented = event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
it("supports Shift+F10, arrows, submenu return, and restores source focus", async () => {
  await key('[data-testid="file"]', "F10");
  await key('[data-menu-item="F01-01"]', "ArrowDown");
  expect(document.activeElement?.getAttribute("data-menu-item")).toBe("F01-02");
  await key('[data-menu-item="F01:group:复制"]', "ArrowRight");
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(2);
  await key('[data-menu-item="F01-16"]', "ArrowLeft");
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
  await key('[data-menu-item="F01:group:复制"]', "Escape");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(query('[data-testid="file"]'));
});
it("never runs disabled entries; available actions execute once and close", async () => {
  await rightClick('[data-testid="file"]');
  await act(async () => {
    query('[data-menu-item="F01-08"]').click();
  });
  expect(run).not.toHaveBeenCalled();
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => {
    query('[data-menu-item="F01-01"]').click();
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
it("ignores capability responses for an already-replaced menu", async () => {
  let resolve!: (bindings: MenuBindings) => void;
  const pending = new Promise<MenuBindings>((done) => {
    resolve = done;
  });
  await act(async () => {
    root.render(
      <ContextMenuProvider scope="a" zh>
        <Targets resolve={() => pending} />
      </ContextMenuProvider>,
    );
  });
  await rightClick('[data-testid="file"]');
  await rightClick('[data-testid="folder"]');
  await act(async () => {
    resolve({ 文件预览: { reason: "late response" } });
  });
  expect(query('[role="menu"]').getAttribute("aria-label")).toBe("folder");
  expect(query('[role="menu"]').textContent).not.toContain("late response");
});
it("updates an already-open submenu when async capabilities arrive", async () => {
  let resolve!: (bindings: MenuBindings) => void;
  const pending = new Promise<MenuBindings>((done) => {
    resolve = done;
  });
  await act(async () => {
    root.render(
      <ContextMenuProvider scope="a" zh>
        <Targets resolve={() => pending} />
      </ContextMenuProvider>,
    );
  });
  await rightClick('[data-testid="file"]');
  await key('[data-menu-item="F01:group:复制"]', "ArrowRight");
  expect(query('[data-menu-item="F01-17"]').getAttribute("aria-disabled")).toBe(
    "true",
  );
  await act(async () => {
    resolve({ "复制 › 本地绝对路径": { run } });
  });
  expect(
    query('[data-menu-item="F01-17"]').getAttribute("aria-disabled"),
  ).not.toBe("true");
  await act(async () => {
    query('[data-menu-item="F01-17"]').click();
  });
  expect(run).toHaveBeenCalledTimes(1);
});
it("closes on outside pointer, connection scope changes and row removal", async () => {
  await rightClick('[data-testid="file"]');
  await act(async () => {
    query("input").dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true }),
    );
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await rightClick('[data-testid="file"]');
  await act(async () => {
    root.render(
      <ContextMenuProvider scope="b" zh>
        <Targets />
      </ContextMenuProvider>,
    );
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await rightClick('[data-testid="file"]');
  await act(async () => {
    root.render(
      <ContextMenuProvider scope="b" zh>
        <p>Row removed</p>
      </ContextMenuProvider>,
    );
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
it("shows an asynchronous action error instead of silently failing", async () => {
  run.mockRejectedValueOnce(new Error("failure"));
  await rightClick('[data-testid="file"]');
  await act(async () => {
    query('[data-menu-item="F01-01"]').click();
  });
  expect(query('[role="alert"]').textContent).toContain("failure");
});
it("opens menus and keyboard submenus in the source window document", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const owner = frame.contentDocument!;
  try {
    await act(async () =>
      root.render(
        <ContextMenuProvider scope="popout" zh>
          {createPortal(<Targets />, owner.body)}
        </ContextMenuProvider>,
      ),
    );
    await act(async () =>
      owner
        .querySelector('[data-testid="file"]')!
        .dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        ),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const copyMenu = owner.querySelector<HTMLButtonElement>(
      '[data-menu-item="F01:group:复制"]',
    )!;
    await act(async () => copyMenu.focus());
    await act(async () =>
      copyMenu.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(owner.querySelectorAll('[role="menu"]')).toHaveLength(2);
    await act(async () =>
      owner.querySelector('[data-menu-item="F01-16"]')!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(owner.querySelectorAll('[role="menu"]')).toHaveLength(1);
    await act(async () =>
      owner
        .querySelector<HTMLButtonElement>('[data-menu-item="F01-01"]')!
        .click(),
    );
    expect(run).toHaveBeenCalledWith(
      owner.querySelector('[data-testid="file"]'),
    );
  } finally {
    await act(async () =>
      root.render(
        <ContextMenuProvider scope="a" zh>
          <Targets />
        </ContextMenuProvider>,
      ),
    );
    frame.remove();
  }
});
it("carries a popout menu origin into a modal and restores focus there", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const owner = frame.contentDocument!;
  const prototype = Object.getPrototypeOf(owner.createElement("dialog"));
  const originals = ["showModal", "close"].map((name) =>
    Object.getOwnPropertyDescriptor(prototype, name),
  );
  for (const name of ["showModal", "close"])
    Object.defineProperty(prototype, name, {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.toggleAttribute("open", name === "showModal");
      },
    });
  function Surface() {
    const menu = useContextMenu();
    const [source, setSource] = useState<HTMLElement>();
    return (
      <>
        <button
          {...menu("F01", () => ({
            文件预览: { run: (origin) => setSource(origin) },
          }))}
        >
          Origin
        </button>
        {source && (
          <Dialog
            source={source}
            title="Modal"
            footer={null}
            zh
            onRequestClose={() => setSource(undefined)}
          >
            <input data-dialog-autofocus />
          </Dialog>
        )}
      </>
    );
  }
  try {
    await act(async () =>
      root.render(
        <ContextMenuProvider scope="modal-popout" zh>
          {createPortal(<Surface />, owner.body)}
        </ContextMenuProvider>,
      ),
    );
    const trigger = owner.querySelector("button")!;
    await act(async () =>
      trigger.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      ),
    );
    await act(async () =>
      owner
        .querySelector<HTMLButtonElement>('[data-menu-item="F01-01"]')!
        .click(),
    );
    expect(document.querySelector("dialog")).toBeNull();
    expect(owner.querySelector("dialog")!.open).toBe(true);
    expect(owner.activeElement).toBe(owner.querySelector("input"));
    await act(async () =>
      owner
        .querySelector("dialog")!
        .dispatchEvent(new Event("cancel", { cancelable: true })),
    );
    expect(owner.querySelector("dialog")).toBeNull();
    expect(owner.activeElement).toBe(trigger);
  } finally {
    await act(async () => root.render(null));
    ["showModal", "close"].forEach((name, index) => {
      if (originals[index])
        Object.defineProperty(prototype, name, originals[index]!);
      else Reflect.deleteProperty(prototype, name);
    });
    frame.remove();
  }
});
