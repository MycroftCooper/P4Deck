import { Bell, Palette, RefreshCw } from "lucide-react";
import type {
  ConnectionStatus,
  Locale,
  P4Context,
  RuntimeInfo,
  ThemeMode,
} from "../../shared/contracts/types";
import { ConnectionProfilesCard } from "./ConnectionProfilesCard";
import { defaultUi, type UiPreferences } from "./preferences";
import { requestDesktopNotificationPermission } from "../../app/notifications/notifications";

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
    <section className="settings-page">
      <header className="section-title">
        <div>
          <span className="workspace-eyebrow">P4DECK / PREFERENCES</span>
          <h1>{tr("设置", "Settings")}</h1>
          <p>
            {tr(
              "全局设置 · 已保存连接经验证后切换，外观即时生效。",
              "Global preferences · Saved connections switch only after verification; appearance applies instantly.",
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
          <RefreshCw size={18} />
          {tr("刷新与通知", "Refresh & notifications")}
        </h2>
        <div className="settings-grid">
          <label>
            {tr("只读视图自动刷新", "Auto-refresh read-only views")}
            <select
              value={String(ui.autoRefresh)}
              onChange={(event) =>
                onUi({ ...ui, autoRefresh: event.target.value === "true" })
              }
            >
              <option value="true">{tr("开启", "On")}</option>
              <option value="false">{tr("暂停", "Paused")}</option>
            </select>
          </label>
          <label>
            <Bell size={14} /> {tr("桌面通知", "Desktop notifications")}
            <select
              value={String(ui.desktopNotifications)}
              onChange={(event) => {
                const enabled = event.target.value === "true";
                if (!enabled) {
                  onUi({ ...ui, desktopNotifications: false });
                  return;
                }
                void requestDesktopNotificationPermission().then((granted) =>
                  onUi({ ...ui, desktopNotifications: granted }),
                );
              }}
            >
              <option value="false">{tr("关闭", "Off")}</option>
              <option value="true">{tr("开启", "On")}</option>
            </select>
          </label>
          <label>
            {tr("通知范围", "Notification scope")}
            <select
              value={String(ui.notifyOnlyFailures)}
              disabled={!ui.desktopNotifications}
              onChange={(event) =>
                onUi({
                  ...ui,
                  notifyOnlyFailures: event.target.value === "true",
                })
              }
            >
              <option value="false">
                {tr("长操作结果与需处理事件", "Long operations and attention")}
              </option>
              <option value="true">
                {tr("仅失败与需处理事件", "Failures and attention only")}
              </option>
            </select>
          </label>
        </div>
        <p>
          {tr(
            "自动刷新仅重试幂等只读请求；Sync、Submit、Shelf 等修改操作必须由你明确重新发起。前台可见时系统通知会被抑制。",
            "Automatic refresh retries only idempotent reads. Sync, Submit, Shelf, and other mutations require an explicit retry. System notifications are suppressed while the app is visible.",
          )}
        </p>
      </section>
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
    </section>
  );
}
