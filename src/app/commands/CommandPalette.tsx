import { useEffect, useMemo, useRef, useState } from "react";
import {
  appCommandReason,
  appCommands,
  shortcutLabel,
  type AppCommandEnvironment,
  type AppCommandId,
} from "./catalog";

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
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQuery("");
      queueMicrotask(() => input.current?.focus());
    }
  }, [open]);
  const commands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return appCommands.filter((command) => {
      if (command.hiddenFromPalette) return false;
      return (
        !needle ||
        command.zh.toLowerCase().includes(needle) ||
        command.en.toLowerCase().includes(needle) ||
        command.id.toLowerCase().includes(needle)
      );
    });
  }, [query]);
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
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={zh ? "命令面板" : "Command palette"}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <input
          ref={input}
          aria-label={zh ? "筛选命令" : "Filter commands"}
          placeholder={zh ? "输入命令名称或 ID" : "Type a command or ID"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul role="listbox">
          {commands.map((command) => {
            const reason = appCommandReason(command.id, environment, zh);
            return (
              <li key={command.id}>
                <button
                  disabled={!!reason}
                  title={reason}
                  onClick={() => {
                    onExecute(command.id);
                    onClose();
                  }}
                >
                  <span>{zh ? command.zh : command.en}</span>
                  <small>
                    {command.group} · {command.id} · {command.risk}
                    {command.confirmation === "stateMachine"
                      ? zh
                        ? " · 需要预检/确认"
                        : " · preflight/confirmation required"
                      : ""}
                  </small>
                  {command.shortcut && (
                    <kbd>
                      {shortcutLabel(
                        command.shortcut,
                        navigator.platform.toLowerCase().includes("mac"),
                      )}
                    </kbd>
                  )}
                  {reason && <em>{reason}</em>}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
