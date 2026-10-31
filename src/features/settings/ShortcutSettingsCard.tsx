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
  app: { zh: "应用", en: "App" },
  connection: { zh: "连接", en: "Connection" },
  changes: { zh: "变更", en: "Changes" },
  navigation: { zh: "导航", en: "Navigation" },
  file: { zh: "文件", en: "File" },
  tools: { zh: "工具", en: "Tools" },
};

/** Browser/Windows keys that may be swallowed before the app sees them. */
const systemReserved: readonly [string, { zh: string; en: string }][] = [
  ["Mod+T", { zh: "浏览器新标签页", en: "browser new tab" }],
  ["Mod+Shift+T", { zh: "浏览器重新打开标签页", en: "browser reopen tab" }],
  ["Mod+W", { zh: "关闭窗口", en: "close window" }],
  ["Mod+Shift+W", { zh: "关闭窗口", en: "close window" }],
  ["Mod+N", { zh: "新窗口", en: "new window" }],
  ["Mod+Q", { zh: "退出应用", en: "quit app" }],
  ["Mod+P", { zh: "打印", en: "print" }],
  ["Mod+S", { zh: "保存网页", en: "save page" }],
  ["Mod+O", { zh: "打开文件", en: "open file" }],
  ["Mod+F", { zh: "浏览器查找", en: "browser find" }],
  ["Mod+Shift+Esc", { zh: "任务管理器", en: "task manager" }],
  ["Alt+F4", { zh: "关闭窗口", en: "close window" }],
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
  const tr = (a: string, b: string) => (zh ? a : b);
  if (command.risk === "mutation")
    return tr(
      "写操作：不分配快捷键，仍需工具栏/命令面板并确认",
      "Write action: no shortcut; use the toolbar or palette with confirmation",
    );
  switch (command.requires) {
    case "runtime":
      return tr("需连接运行时加载完成", "Requires the connection runtime");
    case "connected":
      return tr("需连接可用", "Requires an available connection");
    case "file":
      return tr("需先选择文件或目录", "Requires a selected file or folder");
    case "pending":
      return tr(
        "需选中非空、已编号的待提交 CL",
        "Requires a nonempty numbered pending changelist",
      );
    case "swarm":
      return tr("需已配置 Swarm", "Requires configured Swarm");
    case "mainWindow":
      return tr("仅主窗口可用", "Main window only");
    default:
      return tr("始终可用", "Always available");
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
  return zh
    ? `该组合可能被浏览器/系统占用（${reserved[1].zh}），桌面端通常仍可用`
    : `This combination may be reserved by the browser/system (${reserved[1].en}); the desktop app usually still receives it`;
}

type Message = { tone: "info" | "warn" | "error"; text: string };

interface Props {
  zh: boolean;
  /** Test/embedding override; production detects the current platform. */
  platform?: ShortcutPlatform;
}

export function ShortcutSettingsCard({ zh, platform }: Props) {
  const tr = (a: string, b: string) => (zh ? a : b);
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
          text: tr("已取消录制", "Recording cancelled"),
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
          text: tr("已清除该命令的绑定", "Binding cleared"),
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
          text: tr(
            "输入框内不录制快捷键",
            "Shortcuts are not recorded from editable fields",
          ),
        });
        return;
      }
      const candidate = shortcutFromEvent(event, activePlatform);
      if (!candidate) {
        event.preventDefault();
        event.stopPropagation();
        setMessage({
          tone: "error",
          text: tr(
            "该按键不可绑定：需要 Ctrl/Cmd、Alt 或功能键（Esc 取消，Backspace/Delete 清除）",
            "Unsupported key: use Ctrl/Cmd, Alt or a function key (Esc cancels, Backspace/Delete clears)",
          ),
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
          text: tr(
            `与「${conflict.zh}」(${conflict.id}) 冲突，请先清除或修改另一项`,
            `Conflicts with "${conflict.en}" (${conflict.id}); clear or change that command first`,
          ),
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
              text: tr(
                `已绑定 ${shortcutLabel(candidate, mac)}`,
                `Bound ${shortcutLabel(candidate, mac)}`,
              ),
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
          {tr("快捷键", "Keyboard shortcuts")}
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
                text: tr(
                  "已恢复 P4V 对齐的默认快捷键",
                  "Restored the P4V-aligned defaults",
                ),
              });
            }}
          >
            {tr("恢复默认快捷键", "Restore default shortcuts")}
          </button>
        </div>
      </div>
      <p>
        {tr(
          "默认键位与 P4V 对齐；写操作不分配快捷键，仍需工具栏/命令面板并确认。点击「录制」后按下新组合键，Esc 取消，Backspace/Delete 清除绑定。",
          "Defaults follow P4V. Write actions intentionally have no shortcut and still require confirmation. Click Record and press a combination; Esc cancels, Backspace/Delete clears the binding.",
        )}
      </p>
      {overriddenCount > 0 && (
        <p className="shortcut-overridden-count">
          {tr(
            `已自定义 ${overriddenCount} 项`,
            `${overriddenCount} customised`,
          )}
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
            <h3>{tr(groupLabels[group].zh, groupLabels[group].en)}</h3>
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
                      <span>{zh ? command.zh : command.en}</span>
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
                          {tr("未绑定", "Unbound")}
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
                                text: tr("已取消录制", "Recording cancelled"),
                              });
                            }}
                          >
                            {tr("取消 (Esc)", "Cancel (Esc)")}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="secondary"
                            aria-pressed={false}
                            aria-label={`${tr("录制", "Record")} ${
                              zh ? command.zh : command.en
                            }`}
                            onClick={() => {
                              setRecording(command.id);
                              setMessage({
                                tone: "info",
                                text: tr(
                                  "请按下新组合键…",
                                  "Press the new key combination…",
                                ),
                              });
                            }}
                          >
                            {tr("录制", "Record")}
                          </button>
                        ))}
                      {canBind && shortcuts.length > 0 && (
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`${tr("清除", "Clear")} ${
                            zh ? command.zh : command.en
                          }`}
                          onClick={() => {
                            setShortcutOverride(command.id, null);
                            setRecording(undefined);
                            setMessage({
                              tone: "info",
                              text: tr("已清除该命令的绑定", "Binding cleared"),
                            });
                          }}
                        >
                          {tr("清除", "Clear")}
                        </button>
                      )}
                      {canBind && overridden && (
                        <button
                          type="button"
                          className="secondary"
                          aria-label={`${tr("恢复默认", "Restore default")} ${
                            zh ? command.zh : command.en
                          }`}
                          onClick={() => {
                            clearShortcutOverride(command.id);
                            setMessage({
                              tone: "info",
                              text: tr(
                                "已恢复该项默认键",
                                "Default binding restored",
                              ),
                            });
                          }}
                        >
                          {tr("恢复默认", "Default")}
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
