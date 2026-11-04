import { t, tFor, type MsgKey } from "../../shared/i18n";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  appCommandReason,
  appCommands,
  commandShortcuts,
  shortcutLabel,
  type AppCommandEnvironment,
  type AppCommandId,
} from "./catalog";
import { useShortcutOverrides } from "./keymap";

interface Props {
  open: boolean;
  zh: boolean;
  environment: AppCommandEnvironment;
  onClose(): void;
  onExecute(id: AppCommandId): void;
}

export function CommandPalette({
  open,
  zh,
  environment,
  onClose,
  onExecute,
}: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const shortcutOverrides = useShortcutOverrides();
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const source = useRef<HTMLElement | null>(null);
  const listboxId = useId();
  useEffect(() => {
    if (open) {
      source.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setActiveIndex(0);
      queueMicrotask(() => input.current?.focus());
      return () => queueMicrotask(() => source.current?.focus());
    }
  }, [open]);
  const commands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return appCommands.filter((command) => {
      if (command.hiddenFromPalette) return false;
      return (
        !needle ||
        tFor(zh ? "zh-CN" : "en-US", command.zh as MsgKey)
          .toLowerCase()
          .includes(needle) ||
        command.id.toLowerCase().includes(needle)
      );
    });
  }, [query]);
  useEffect(() => {
    setActiveIndex((value) =>
      Math.min(value, Math.max(0, commands.length - 1)),
    );
  }, [commands.length]);
  useEffect(() => {
    document
      .getElementById(
        commands[activeIndex] ? `${listboxId}-${commands[activeIndex].id}` : "",
      )
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, commands, listboxId]);
  const execute = (index: number) => {
    const command = commands[index];
    if (!command || appCommandReason(command.id, environment, zh)) return;
    onExecute(command.id);
    onClose();
  };
  if (!open) return null;
  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("commands.command.palette")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((value) =>
              commands.length ? (value + 1) % commands.length : 0,
            );
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((value) =>
              commands.length
                ? (value - 1 + commands.length) % commands.length
                : 0,
            );
          } else if (event.key === "Home") {
            event.preventDefault();
            setActiveIndex(0);
          } else if (event.key === "End") {
            event.preventDefault();
            setActiveIndex(Math.max(0, commands.length - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            execute(activeIndex);
          } else if (event.key === "Tab") {
            const focusable = [
              ...(dialog.current?.querySelectorAll<HTMLElement>(
                'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
              ) ?? []),
            ];
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <input
          ref={input}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={
            commands[activeIndex]
              ? `${listboxId}-${commands[activeIndex].id}`
              : undefined
          }
          aria-label={t("commands.filter.commands")}
          placeholder={t("commands.type.a.command.or.id")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul id={listboxId} role="listbox">
          {commands.map((command, index) => {
            const reason = appCommandReason(command.id, environment, zh);
            const shortcuts = commandShortcuts(command, shortcutOverrides);
            return (
              <li
                id={`${listboxId}-${command.id}`}
                key={command.id}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={!!reason}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setActiveIndex(index);
                  execute(index);
                }}
              >
                <span>
                  {tFor(zh ? "zh-CN" : "en-US", command.zh as MsgKey)}
                </span>
                <small>
                  {command.group} · {command.id} · {command.risk}
                  {command.confirmation === "stateMachine"
                    ? t("commands.preflight.confirmation.required")
                    : ""}
                </small>
                {shortcuts.length > 0 && (
                  <kbd>
                    {shortcuts
                      .map((shortcut) =>
                        shortcutLabel(
                          shortcut,
                          navigator.platform.toLowerCase().includes("mac"),
                        ),
                      )
                      .join(" / ")}
                  </kbd>
                )}
                {reason && <em>{reason}</em>}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
