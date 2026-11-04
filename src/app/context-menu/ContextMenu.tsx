import { t } from "../../shared/i18n";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import {
  buildMenu,
  clampMenu,
  isTextInput,
  type MenuBindings,
  type MenuItem,
  type MenuSpec,
} from "./model";
import { menuLabel } from "./labels";
import { menuCatalog, type MenuObjectId } from "./catalog";

export interface MenuTriggerEvent {
  target: EventTarget | null;
  currentTarget: HTMLElement | SVGElement;
  preventDefault(): void;
  stopPropagation(): void;
  clientX?: number;
  clientY?: number;
}
interface Request extends MenuSpec {
  x: number;
  y: number;
  source: HTMLElement | SVGElement;
  token: number;
}
const MenuLanguage = createContext(true);
const MenuContext = createContext<(request: Omit<Request, "token">) => void>(
  () => {},
);

export function ContextMenuProvider({
  children,
  scope,
  zh,
}: {
  children: ReactNode;
  scope: string;
  zh: boolean;
}) {
  const [request, setRequest] = useState<Request>();
  const [error, setError] = useState("");
  const errorDocument = useRef<Document>(document);
  const sequence = useRef(0);
  const current = useRef(request);
  current.current = request;
  const close = useCallback((restore = true) => {
    sequence.current++;
    const source = current.current?.source;
    setRequest(undefined);
    if (restore && source?.isConnected) source.focus({ preventScroll: true });
  }, []);
  const open = useCallback((value: Omit<Request, "token">) => {
    const token = ++sequence.current;
    errorDocument.current = value.source.ownerDocument;
    setError("");
    setRequest({ ...value, token });
    if (value.resolve)
      void value
        .resolve()
        .then((items) => {
          if (token === sequence.current)
            setRequest((previous) => previous && { ...previous, items });
        })
        .catch((cause) => {
          if (token === sequence.current) setError(String(cause));
        });
  }, []);
  useEffect(() => {
    close(false);
    return () => {
      sequence.current++;
    };
  }, [scope, close]);
  useEffect(() => {
    if (!request) return;
    const owner = request.source.ownerDocument;
    const view = owner.defaultView!;
    // Focusing an off-screen row for Shift+F10 can finish scrolling in this frame.
    let scrollArmed = false;
    const frame = view.requestAnimationFrame(() => {
      scrollArmed = true;
    });
    const outside = (event: Event) => {
      if (event.type === "scroll" && !scrollArmed) return;
      if (
        !(event.target && "closest" in event.target) ||
        !(event.target as Element).closest("[data-menu-layer]")
      )
        close(false);
    };
    const resize = () => close(false);
    const observer = new MutationObserver(() => {
      if (!request.source.isConnected) close(false);
    });
    observer.observe(owner.body, { childList: true, subtree: true });
    owner.addEventListener("pointerdown", outside, true);
    owner.addEventListener("scroll", outside, true);
    owner.addEventListener("dragstart", resize, true);
    view.addEventListener("resize", resize);
    view.addEventListener("blur", resize);
    return () => {
      view.cancelAnimationFrame(frame);
      observer.disconnect();
      owner.removeEventListener("pointerdown", outside, true);
      owner.removeEventListener("scroll", outside, true);
      owner.removeEventListener("dragstart", resize, true);
      view.removeEventListener("resize", resize);
      view.removeEventListener("blur", resize);
    };
  }, [request?.token, close]);
  const execute = (item: MenuItem) => {
    if (item.reason || !item.run) return;
    let origin: Element | null = current.current?.source ?? null;
    while (origin && origin.namespaceURI !== "http://www.w3.org/1999/xhtml")
      origin = origin.parentElement;
    const source = origin as HTMLElement | null;
    close();
    void Promise.resolve()
      .then(() => item.run?.(source ?? undefined))
      .catch((cause) => setError(String(cause)));
  };
  return (
    <MenuContext.Provider value={open}>
      <MenuLanguage.Provider value={zh}>
        {children}
        {request &&
          createPortal(
            <div
              role="region"
              aria-label={t("contextMenu.context.menu.layer")}
            >
              <MenuPanel
                key={request.token}
                title={request.title}
                items={request.items}
                x={request.x}
                y={request.y}
                onClose={() => close()}
                onRun={execute}
              />
            </div>,
            request.source.ownerDocument.body,
          )}
        {error &&
          createPortal(
            <div className="menu-error" role="alert">
              {error}
              <button
                onClick={() => setError("")}
                aria-label="关闭错误 / Dismiss error"
              >
                ×
              </button>
            </div>,
            errorDocument.current.body,
          )}
      </MenuLanguage.Provider>
    </MenuContext.Provider>
  );
}

function MenuPanel({
  title,
  items,
  x,
  y,
  onClose,
  onRun,
  nested = false,
}: {
  title: string;
  items: MenuItem[];
  x: number;
  y: number;
  onClose(): void;
  onRun(item: MenuItem): void;
  nested?: boolean;
}) {
  const zh = useContext(MenuLanguage);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [active, setActive] = useState(0);
  const [submenu, setSubmenu] = useState<{
    id: string;
    x: number;
    y: number;
  }>();
  useLayoutEffect(() => {
    const box = ref.current!.getBoundingClientRect();
    const view = ref.current!.ownerDocument.defaultView!;
    setPosition(
      clampMenu(x, y, box.width, box.height, view.innerWidth, view.innerHeight),
    );
    ref.current
      ?.querySelector<HTMLButtonElement>("[role^=menuitem]")
      ?.focus({ preventScroll: true });
  }, [x, y]);
  const focus = (index: number) => {
    const next = (index + items.length) % items.length;
    setActive(next);
    ref.current
      ?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]")
      [next]?.focus();
  };
  const expand = (item: MenuItem, element: HTMLElement) => {
    if (item.reason || !item.children?.length) return;
    const box = element.getBoundingClientRect();
    setSubmenu({
      id: item.id,
      x:
        box.right + 323 > element.ownerDocument.defaultView!.innerWidth
          ? box.left - 323
          : box.right + 3,
      y: box.top,
    });
  };
  const submenuItem = items.find((item) => item.id === submenu?.id);
  return (
    <>
      <div
        ref={ref}
        className="p4-context-menu"
        style={position}
        data-menu-layer
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            [
              "ArrowDown",
              "ArrowUp",
              "Home",
              "End",
              "Escape",
              "Tab",
              "ArrowLeft",
              "ArrowRight",
            ].includes(event.key)
          )
            event.preventDefault();
          if (event.key === "ArrowDown") focus(active + 1);
          if (event.key === "ArrowUp") focus(active - 1);
          if (event.key === "Home") focus(0);
          if (event.key === "End") focus(items.length - 1);
          if (
            event.key === "Escape" ||
            event.key === "Tab" ||
            (nested && event.key === "ArrowLeft")
          )
            onClose();
          if (
            event.key === "ArrowRight" &&
            event.target &&
            "getBoundingClientRect" in event.target
          )
            expand(items[active], event.target as HTMLElement);
        }}
      >
        <div className="menu-caption">{title}</div>
        <div className="menu-items" role="menu" aria-label={title}>
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role={
                item.checked === undefined ? "menuitem" : "menuitemcheckbox"
              }
              aria-checked={item.checked}
              aria-disabled={!!item.reason}
              aria-description={item.reason}
              aria-haspopup={item.children ? "menu" : undefined}
              aria-expanded={
                item.children ? submenu?.id === item.id : undefined
              }
              data-menu-item={item.id}
              tabIndex={index === active ? 0 : -1}
              className={
                [
                  item.danger ? "danger" : "",
                  item.emphasis === "primary" ? "menu-emphasis" : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              title={item.reason}
              onFocus={() => setActive(index)}
              onPointerEnter={(event) => {
                setActive(index);
                if (item.children) expand(item, event.currentTarget);
                else setSubmenu(undefined);
              }}
              onClick={(event) =>
                item.children ? expand(item, event.currentTarget) : onRun(item)
              }
            >
              <span className="menu-check">
                {item.checked && <Check size={13} />}
              </span>
              <span>{menuLabel(item.label, zh)}</span>
              {item.children && <ChevronRight size={14} />}
            </button>
          ))}
        </div>
        <div className="menu-hint" role="status">
          {items[active]?.reason ||
            (zh
              ? "↑ ↓ 选择 · Enter 执行 · Esc 关闭"
              : "↑ ↓ Navigate · Enter Run · Esc Close")}
        </div>
      </div>
      {submenu && submenuItem?.children && (
        <MenuPanel
          title={menuLabel(submenuItem.label, zh)}
          items={submenuItem.children}
          x={submenu.x}
          y={submenu.y}
          nested
          onClose={() => {
            setSubmenu(undefined);
            focus(active);
          }}
          onRun={onRun}
        />
      )}
    </>
  );
}

export function useContextMenu() {
  const open = useContext(MenuContext);
  return (
    object: MenuObjectId,
    getBindings: () => MenuBindings,
    options: {
      title?: string;
      onOpen?: () => void;
      resolve?: () => Promise<MenuBindings>;
    } = {},
  ) => {
    const trigger = (event: MenuTriggerEvent) => {
      if (isTextInput(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      const source = event.currentTarget;
      const box = source.getBoundingClientRect();
      // Capture bindings before selection updates; actions must not consult a later global target.
      const bindings = getBindings();
      options.onOpen?.();
      open({
        title: options.title ?? menuCatalog[object].title,
        items: buildMenu(object, bindings),
        x: "clientX" in event && event.clientX ? event.clientX : box.left + 12,
        y:
          "clientY" in event && event.clientY
            ? event.clientY
            : box.top + Math.min(box.height, 32),
        source,
        resolve: options.resolve
          ? async () =>
              buildMenu(object, { ...bindings, ...(await options.resolve!()) })
          : undefined,
      });
    };
    return {
      "data-menu-object": object,
      onContextMenu: trigger,
      onKeyDown: (
        event: MenuTriggerEvent & {
          key: string;
          shiftKey: boolean;
          ctrlKey?: boolean;
          metaKey?: boolean;
        },
      ) => {
        if (isTextInput(event.target)) return;
        if (
          ((event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "a") ||
          event.key === "Escape"
        ) {
          const bindings = getBindings();
          const item =
            event.key === "Escape"
              ? bindings["清除选择"]
              : (bindings["全选当前筛选结果"] ??
                bindings["全选结果"] ??
                bindings["全选当前可见结果"]);
          if (item?.run && !item.reason) {
            event.preventDefault();
            event.stopPropagation();
            void item.run();
            return;
          }
        }
        if (
          event.key === "ContextMenu" ||
          (event.shiftKey && event.key === "F10")
        )
          trigger(event);
      },
    };
  };
}
