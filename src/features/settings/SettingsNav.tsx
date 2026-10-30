import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface SettingsNavItem {
  id: string;
  label: string;
  icon?: ReactNode;
}
export interface SettingsNavProps {
  items: readonly SettingsNavItem[];
  activeId: string;
  onSelect(id: string): void;
  label: string;
}

/** Sticky section list; horizontal chips on narrow containers via CSS. */
export function SettingsNav({
  items,
  activeId,
  onSelect,
  label,
}: SettingsNavProps) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const focusAndSelect = (index: number) => {
    const next = items[(index + items.length) % items.length];
    if (!next) return;
    buttons.current[(index + items.length) % items.length]?.focus();
    onSelect(next.id);
  };
  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      focusAndSelect(index + 1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      focusAndSelect(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAndSelect(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAndSelect(items.length - 1);
    }
  };
  return (
    <nav className="settings-nav" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          type="button"
          className="settings-nav-item"
          data-settings-nav={item.id}
          aria-current={item.id === activeId ? "location" : undefined}
          onClick={() => onSelect(item.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
