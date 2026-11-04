import { t, tFor, type MsgKey } from "../../shared/i18n";
import { Keyboard } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  appCommands,
  commandShortcuts,
  normalizedShortcut,
  shortcutFromEvent,
  shortcutLabel,
  type AppCommandDefinition,
  type AppCommandId,
  type AppCommandGroup,
  type ShortcutPlatform,
} from "../../app/commands/catalog";
import {
  clearShortcutOverride,
  resetShortcutOverrides,
  setShortcutOverride,
  useShortcutOverrides,
} from "../../app/commands/keymap";
import "./shortcutSettings.css";

const groupOrder: AppCommandGroup[] = [
  "app",
  "connection",
  "changes",
  "navigation",
  "file",
  "tools",
];

const groupLabels: Record<AppCommandGroup, { zh: string; en: string }> = {
  app: { zh: "settings.commandGroup.app", en: "settings.commandGroup.app" },
  connection: {
    zh: "settings.commandGroup.connection",
    en: "settings.commandGroup.connection",
  },
  changes: {
    zh: "settings.commandGroup.changes",
    en: "settings.commandGroup.changes",
  },
  navigation: {
    zh: "settings.commandGroup.navigation",
    en: "settings.commandGroup.navigation",
  },
  file: { zh: "settings.commandGroup.file", en: "settings.commandGroup.file" },
  tools: {
    zh: "settings.commandGroup.tools",
    en: "settings.commandGroup.tools",
  },
};

/** Browser/Windows keys that may be swallowed before the app sees them. */
const systemReserved: readonly [string, { zh: string; en: string }][] = [
  [
    "Mod+T",
    { zh: "settings.reservedKey.mod+t", en: "settings.reservedKey.mod+t" },
  ],
  [
    "Mod+Shift+T",
    {
      zh: "settings.reservedKey.mod+shift+t",
      en: "settings.reservedKey.mod+shift+t",
    },
  ],
  [
    "Mod+W",
    { zh: "settings.reservedKey.mod+w", en: "settings.reservedKey.mod+w" },
  ],
  [
    "Mod+Shift+W",
    {
      zh: "settings.reservedKey.mod+shift+w",
      en: "settings.reservedKey.mod+shift+w",
    },
  ],
  [
    "Mod+N",
    { zh: "settings.reservedKey.mod+n", en: "settings.reservedKey.mod+n" },
  ],
  [
    "Mod+Q",
    { zh: "settings.reservedKey.mod+q", en: "settings.reservedKey.mod+q" },
  ],
  [
    "Mod+P",
    { zh: "settings.reservedKey.mod+p", en: "settings.reservedKey.mod+p" },
  ],
  [
    "Mod+S",
    { zh: "settings.reservedKey.mod+s", en: "settings.reservedKey.mod+s" },
  ],
  [
    "Mod+O",
    { zh: "settings.reservedKey.mod+o", en: "settings.reservedKey.mod+o" },
  ],
  [
    "Mod+F",
    { zh: "settings.reservedKey.mod+f", en: "settings.reservedKey.mod+f" },
  ],
  [
    "Mod+Shift+Esc",
    {
      zh: "settings.reservedKey.mod+shift+esc",
      en: "settings.reservedKey.mod+shift+esc",
    },
  ],
  [
    "Alt+F4",
    { zh: "settings.reservedKey.alt+f4", en: "settings.reservedKey.alt+f4" },
  ],
];

function detectPlatform(): ShortcutPlatform {
  const platform = navigator.platform.toLowerCase();
  return platform.includes("mac")
    ? "mac"
    : platform.includes("linux")
      ? "linux"
      : "windows";
}

function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element))
    return false;
  return !!target.closest(
    "input, textarea, select, [contenteditable='true'], [role='textbox']",
  );
}

function availability(command: AppCommandDefinition, zh: boolean): string {
  if (command.risk === "mutation")
    return tFor(
      zh ? "zh-CN" : "en-US",
      "settings.write.action.no.shortcut.use.the",
    );
  switch (command.requires) {
    case "runtime":
      return tFor(
        zh ? "zh-CN" : "en-US",
        "settings.requires.the.connection.runtime",
      );
    case "connected":
      return tFor(
        zh ? "zh-CN" : "en-US",
        "settings.requires.an.available.connection",
      );
    case "file":
      return tFor(
        zh ? "zh-CN" : "en-US",
        "settings.requires.a.selected.file.or",
      );
    case "pending":
      return tFor(
        zh ? "zh-CN" : "en-US",
        "settings.requires.a.nonempty.numbered.pending.changelist",
      );
    case "swarm":
      return tFor(zh ? "zh-CN" : "en-US", "settings.requires.configured.swarm");
    case "mainWindow":
      return tFor(zh ? "zh-CN" : "en-US", "settings.main.window.only");
    default:
      return tFor(zh ? "zh-CN" : "en-US", "settings.always.available");
  }
}

function conflictFor(
  commandId: AppCommandId,
  candidate: string,
  platform: ShortcutPlatform,
  overrides: ReturnType<typeof useShortcutOverrides>,
): AppCommandDefinition | undefined {
  const normalized = normalizedShortcut(candidate, platform);
  return appCommands.find(
    (command) =>
      command.id !== commandId &&
      commandShortcuts(command, overrides).some(
        (shortcut) => normalizedShortcut(shortcut, platform) === normalized,
      ),
  );
}

function reservedWarning(
  candidate: string,
  platform: ShortcutPlatform,
  zh: boolean,
): string | undefined {
  const normalized = normalizedShortcut(candidate, platform);
  const reserved = systemReserved.find(
    ([key]) => normalizedShortcut(key, platform) === normalized,
  );
  if (!reserved) return undefined;
  return tFor(zh ? "zh-CN" : "en-US", "settings.shortcut.reserved.warning", {
    name: tFor(zh ? "zh-CN" : "en-US", reserved[1].zh as MsgKey),
  });
}

type Message = { tone: "info" | "warn" | "error"; text: string };

interface Props {
  zh: boolean;
  /** Test/embedding override; production detects the current platform. */
  platform?: ShortcutPlatform;
}

export function ShortcutSettingsCard({ zh, platform }: Props) {
  const detected = useMemo(detectPlatform, []);
  const activePlatform = platform ?? detected;
  const overrides = useShortcutOverrides();
  const [recording, setRecording] = useState<AppCommandId>();
  const [message, setMessage] = useState<Message>();
  const mac = activePlatform === "mac";

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setRecording(undefined);
        setMessage({
          tone: "info",
          text: t("settings.recording.cancelled"),
        });
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        event.stopPropagation();
        setShortcutOverride(recording, null);
        setRecording(undefined);
        setMessage({
          tone: "info",
          text: t("settings.binding.cleared"),
        });
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        setRecording(undefined);
        return;
      }
      if (isEditableTarget(event.target)) {
        setRecording(undefined);
        setMessage({
          tone: "warn",
          text: t("settings.shortcuts.are.not.recorded.from.editable"),
        });
        return;
      }
      const candidate = shortcutFromEvent(event, activePlatform);
      if (!candidate) {
        event.preventDefault();
        event.stopPropagation();
        setMessage({
          tone: "error",
          text: t("settings.unsupported.key.use.ctrl.cmd.alt"),
        });
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const conflict = conflictFor(
        recording,
        candidate,
        activePlatform,
        overrides,
      );
      if (conflict) {
        setMessage({
          tone: "error",
          text: tFor(zh ? "zh-CN" : "en-US", "settings.shortcut.conflict", {
            name: tFor(zh ? "zh-CN" : "en-US", conflict.zh as MsgKey),
            id: conflict.id,
          }),
        });
        return;
      }
      setShortcutOverride(recording, candidate);
      setRecording(undefined);
      const warning = reservedWarning(candidate, activePlatform, zh);
      setMessage(
        warning
          ? { tone: "warn", text: warning }
          : {
              tone: "info",
              text: tFor(zh ? "zh-CN" : "en-US", "settings.shortcut.bound", {
                shortcut: shortcutLabel(candidate, mac),
              }),
            },
      );
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, activePlatform, overrides, zh, mac]);

  const overriddenCount = Object.keys(overrides).length;

  return (
    <section className="settings-card shortcut-settings">
      <div className="shortcut-settings-header">
        <h2>
          <Keyboard size={18} />
          {t("settings.keyboard.shortcuts")}
        </h2>
        <div className="shortcut-settings-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              resetShortcutOverrides();
              setRecording(undefined);
              setMessage({
                tone: "info",
                text: t("settings.restored.the.p4v.aligned.defaults"),
              });
            }}
          >
            {t("settings.restore.default.shortcuts")}
          </button>
        </div>
      </div>
      <p>{t("settings.defaults.follow.p4v.write.actions.intentionally")}</p>
      {overriddenCount > 0 && (
        <p className="shortcut-overridden-count">
          {tFor(zh ? "zh-CN" : "en-US", "settings.shortcut.overridden", {
            count: overriddenCount,
          })}
        </p>
      )}
      {message && (
        <p
          className={`shortcut-message ${message.tone}`}
          role="status"
          aria-live="polite"
        >
          {message.text}
        </p>
      )}
      {groupOrder.map((group) => {
        const commands = appCommands.filter(
          (command) => command.group === group,
        );
        if (!commands.length) return null;
        return (
          <div className="shortcut-group" key={group}>
            <h3>
              {tFor(zh ? "zh-CN" : "en-US", groupLabels[group].zh as MsgKey)}
            </h3>
            <ul className="shortcut-list">
              {commands.map((command) => {
                const shortcuts = commandShortcuts(command, overrides);
                const overridden = Object.prototype.hasOwnProperty.call(
                  overrides,
                  command.id,
                );
                const isRecording = recording === command.id;
                const canBind = command.risk !== "mutation";
                return (
                  <li
                    key={command.id}
                    className={isRecording ? "recording" : undefined}
                  >
                    <div className="shortcut-identity">
                      <span>
                        {tFor(zh ? "zh-CN" : "en-US", command.zh as MsgKey)}
                      </span>
                      <small>
                        {command.id} · {availability(command, zh)}
                      </small>
                    </div>
                    <div className="shortcut-keys">
                      {shortcuts.length ? (
                        shortcuts.map((shortcut) => (
                          <kbd key={shortcut}>
                            {shortcutLabel(shortcut, mac)}
                          </kbd>
                        ))
                      ) : (
                        <span className="shortcut-unbound">
                          {t("settings.unbound")}
                        </span>
                      )}
                    </div>
                    <div className="shortcut-buttons">
                      {canBind &&
                        (isRecording ? (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              setRecording(undefined);
                              setMessage({
                                tone: "info",
                                text: t("settings.recording.cancelled"),
                              });
                            }}
                          >
                            {t("settings.cancel.esc")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="secondary"
                            aria-pressed={false}
                            aria-label={`${t("settings.record")} ${tFor(
                              zh ? "zh-CN" : "en-US",
                              command.zh as MsgKey,
                            )}`}
                            onClick={() => {
                              setRecording(command.id);
                              setMessage({
                                tone: "info",
                                text: t(
                                  "settings.press.the.new.key.combination",
                                ),
                              });
                            }}
                          >
                            {t("settings.record")}
                          </button>
                        ))}
                      {canBind && shortcuts.length > 0 && (
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`${t("settings.clear")} ${tFor(
                            zh ? "zh-CN" : "en-US",
                            command.zh as MsgKey,
                          )}`}
                          onClick={() => {
                            setShortcutOverride(command.id, null);
                            setRecording(undefined);
                            setMessage({
                              tone: "info",
                              text: t("settings.binding.cleared"),
                            });
                          }}
                        >
                          {t("settings.clear")}
                        </button>
                      )}
                      {canBind && overridden && (
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`${t("settings.restore.default")} ${tFor(
                            zh ? "zh-CN" : "en-US",
                            command.zh as MsgKey,
                          )}`}
                          onClick={() => {
                            clearShortcutOverride(command.id);
                            setMessage({
                              tone: "info",
                              text: t("settings.default.binding.restored"),
                            });
                          }}
                        >
                          {t("settings.default")}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
