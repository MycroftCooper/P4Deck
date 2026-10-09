import { Palette } from "lucide-react";
import type {
  ConnectionStatus,
  Locale,
  P4Context,
  RuntimeInfo,
  ThemeMode,
} from "../../shared/contracts/types";
import { ConnectionProfilesCard } from "./ConnectionProfilesCard";
import { defaultUi, type UiPreferences } from "./preferences";

interface Props {
  runtime: RuntimeInfo;
  onConnection(
    context: P4Context,
    connection?: ConnectionStatus,
    p4Version?: string,
  ): void;
  onRuntime(runtime: RuntimeInfo): void;
  theme: ThemeMode;
  onTheme(theme: ThemeMode): void;
  locale: Locale;
  onLocale(locale: Locale): void;
  ui: UiPreferences;
  onUi(ui: UiPreferences): void;
}

export function SettingsPage({
  runtime,
  onConnection,
  onRuntime,
  theme,
  onTheme,
  locale,
  onLocale,
  ui,
  onUi,
}: Props) {
  const zh = locale === "zh-CN";
  const tr = (a: string, b: string) => (zh ? a : b);
  return (
    <main className="settings-page">
      <header className="section-title">
        <div>
          <span className="workspace-eyebrow">P4DECK / PREFERENCES</span>
          <h1>{tr("设置", "Settings")}</h1>
          <p>
            {tr(
              "全局设置 · 连接 Profile 经验证后切换，外观即时生效。",
              "Global preferences · Connection profiles switch only after verification; appearance applies instantly.",
            )}
          </p>
        </div>
      </header>
      <ConnectionProfilesCard
        runtime={runtime}
        onConnection={onConnection}
        onRuntime={onRuntime}
        locale={locale}
      />
      <section className="settings-card">
        <h2>
          <Palette size={18} />
          {tr("外观与交互", "Appearance & interaction")}
        </h2>
        <div className="settings-grid">
          <label>
            {tr("主题", "Theme")}
            <select
              value={theme}
              onChange={(event) => onTheme(event.target.value as ThemeMode)}
            >
              <option value="system">{tr("跟随系统", "System")}</option>
              <option value="light">{tr("亮色", "Light")}</option>
              <option value="dark">{tr("暗色", "Dark")}</option>
            </select>
          </label>
          <label>
            {tr("语言", "Language")}
            <select
              value={locale}
              onChange={(event) => onLocale(event.target.value as Locale)}
            >
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </select>
          </label>
          <label>
            {tr("文件列表密度", "File list density")}
            <select
              value={String(ui.compact)}
              onChange={(event) =>
                onUi({ ...ui, compact: event.target.value === "true" })
              }
            >
              <option value="false">{tr("舒适", "Comfortable")}</option>
              <option value="true">{tr("紧凑", "Compact")}</option>
            </select>
          </label>
          <label>
            {tr("左侧栏宽度", "Sidebar width")}
            <select
              value={ui.sidebarWidth}
              onChange={(event) =>
                onUi({ ...ui, sidebarWidth: Number(event.target.value) })
              }
            >
              {[200, 240, 280, 320].map((value) => (
                <option key={value} value={value}>
                  {value} px
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr("列表字号", "List font size")}
            <select
              value={ui.fontSize}
              onChange={(event) =>
                onUi({ ...ui, fontSize: Number(event.target.value) })
              }
            >
              {[11, 12, 13, 14].map((value) => (
                <option key={value} value={value}>
                  {value} px
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr("减少动画", "Reduce motion")}
            <select
              value={String(ui.reducedMotion)}
              onChange={(event) =>
                onUi({ ...ui, reducedMotion: event.target.value === "true" })
              }
            >
              <option value="false">{tr("关闭", "Off")}</option>
              <option value="true">{tr("开启", "On")}</option>
            </select>
          </label>
          <label>
            {tr("左侧固定栏显示文本", "Show activity bar labels")}
            <select
              value={String(ui.activityBarText)}
              onChange={(event) =>
                onUi({ ...ui, activityBarText: event.target.value === "true" })
              }
            >
              <option value="true">{tr("开启", "On")}</option>
              <option value="false">{tr("关闭", "Off")}</option>
            </select>
          </label>
          <label>
            {tr("工具栏显示文本", "Show toolbar labels")}
            <select
              value={String(ui.toolbarText)}
              onChange={(event) =>
                onUi({ ...ui, toolbarText: event.target.value === "true" })
              }
            >
              <option value="true">{tr("开启", "On")}</option>
              <option value="false">{tr("关闭", "Off")}</option>
            </select>
          </label>
        </div>
        <div className="settings-actions">
          <button
            className="secondary"
            onClick={() => {
              onUi(defaultUi);
              onTheme("system");
            }}
          >
            {tr("恢复外观默认值", "Reset appearance")}
          </button>
        </div>
      </section>
      <section className="settings-card">
        <h2>{tr("页签行为", "Tab behavior")}</h2>
        <p>
          {tr(
            "全局页签（搜索、设置、Files、Pending、Submitted、Workspace、Streams）不可重复打开。文件预览、History、Diff、Rev Graph 可以多开，使用页内“新页签”按钮。",
            "Global tabs are single-instance. Preview, History, Diff and Rev Graph support multiple instances via New tab.",
          )}
        </p>
        <p>
          {tr(
            "文件页签默认跟随所选文件；锁定目标后不再切换。解锁后，下次选择文件时恢复跟随。锁定状态与布局一起保存。",
            "File tabs follow selection until locked. Unlock to follow subsequent selections. Targets and locks are saved with the layout.",
          )}
        </p>
      </section>
    </main>
  );
}
