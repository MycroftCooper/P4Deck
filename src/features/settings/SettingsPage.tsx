import { useEffect, useState } from "react";
import { Cable, Palette, Save, Radio } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import type {
  Locale,
  P4Context,
  RuntimeInfo,
  ThemeMode,
} from "../../shared/contracts/types";

import { defaultUi, type UiPreferences } from "./preferences";
interface Props {
  runtime: RuntimeInfo;
  onConnection(context: P4Context): void;
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
  theme,
  onTheme,
  locale,
  onLocale,
  ui,
  onUi,
}: Props) {
  const zh = locale === "zh-CN",
    tr = (a: string, b: string) => (zh ? a : b);
  const [draft, setDraft] = useState(runtime.context),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [error, setError] = useState("");
  useEffect(() => setDraft(runtime.context), [runtime.context]);
  const valid = !!(
    draft.server.trim() &&
    draft.user.trim() &&
    draft.client.trim()
  );
  const fields: [keyof P4Context, string, string][] = [
    ["server", "服务器 / P4PORT", "ssl:perforce:1666"],
    ["user", "用户 / P4USER", "username"],
    ["client", "工作区 / P4CLIENT", "workspace-name"],
    ["cwd", "工作目录", "/workspace/project / C:\\project"],
    ["charset", "字符集 / P4CHARSET", "utf8"],
    ["executable", "P4 可执行文件", "p4 / p4.exe"],
    ["trustPath", "Trust 文件路径", "P4TRUST"],
    ["ticketsPath", "Tickets 文件路径", "P4TICKETS"],
  ];
  const normalized = () =>
    Object.fromEntries(
      Object.entries(draft).map(([k, v]) => [
        k,
        typeof v === "string"
          ? v.trim() ||
            (["server", "user", "client"].includes(k) ? "" : undefined)
          : v,
      ]),
    ) as unknown as P4Context;
  async function save() {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const next = await backend.saveConnection(normalized());
      onConnection(next);
      setStatus(
        tr(
          "连接参数已保存并应用；保存不代表已连接成功。",
          "Connection saved and applied; this does not verify connectivity.",
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await backend.runP4({
        operationId: crypto.randomUUID(),
        source: "terminal",
        command: "info",
        args: [],
        context: normalized(),
        outputMode: "text",
        timeoutMs: 15000,
      });
      if (result.exitCode !== 0) throw new Error(`P4 exit ${result.exitCode}`);
      setStatus(
        runtime.mode === "mock"
          ? tr(
              "演示模式：模拟测试通过，未访问真实服务器。",
              "Demo mode: simulated success, no real server contacted.",
            )
          : tr("连接测试成功。", "Connection test succeeded."),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="settings-page">
      <header className="section-title">
        <div>
          <span className="workspace-eyebrow">P4DECK / PREFERENCES</span>
          <h1>{tr("设置", "Settings")}</h1>
          <p>
            {tr(
              "全局设置 · 外观即时生效，连接参数保存后应用。",
              "Global preferences · Appearance applies instantly; save connection changes to apply.",
            )}
          </p>
        </div>
      </header>
      <section className="settings-card">
        <h2>
          <Cable size={18} />
          {tr("连接", "Connection")}
        </h2>
        <p>
          {tr(
            "只保存连接参数和凭证文件路径，不保存密码或票据内容。已有任务继续使用原连接，新查询使用新连接。",
            "Only parameters and credential file paths are saved, never passwords or ticket contents. Running tasks retain their original connection.",
          )}
        </p>
        {runtime.mode === "mock" && (
          <p className="settings-note">
            {tr(
              "当前为浏览器演示模式。真实连接请使用桌面客户端。",
              "Browser demo mode. Use the desktop app for real connections.",
            )}
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy || runtime.p4Version === "loading"}>
            <div className="settings-grid">
              {fields.map(([key, label, placeholder]) => (
                <label key={key}>
                  {zh ? label : key}
                  <input
                    aria-label={label}
                    value={draft[key] ?? ""}
                    placeholder={placeholder}
                    required={["server", "user", "client"].includes(key)}
                    onChange={(e) => {
                      setDraft({ ...draft, [key]: e.target.value });
                      setStatus("");
                    }}
                    spellCheck={false}
                  />
                </label>
              ))}
            </div>
            <div className="settings-actions">
              <button
                type="button"
                className="secondary"
                disabled={!valid}
                onClick={() => void test()}
              >
                <Radio size={14} />
                {tr("测试连接", "Test connection")}
              </button>
              <button className="primary" type="submit" disabled={!valid}>
                <Save size={14} />
                {busy
                  ? tr("处理中…", "Working…")
                  : tr("保存并应用", "Save and apply")}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setDraft(runtime.context);
                  setStatus("");
                  setError("");
                }}
              >
                {tr("撤销修改", "Discard edits")}
              </button>
            </div>
          </fieldset>
        </form>
        {status && (
          <p role="status" className="settings-note">
            {status}
          </p>
        )}
        {error && (
          <p role="alert" className="workspace-load-error">
            {error}
          </p>
        )}
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
              onChange={(e) => onTheme(e.target.value as ThemeMode)}
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
              onChange={(e) => onLocale(e.target.value as Locale)}
            >
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </select>
          </label>
          <label>
            {tr("文件列表密度", "File list density")}
            <select
              value={String(ui.compact)}
              onChange={(e) =>
                onUi({ ...ui, compact: e.target.value === "true" })
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
              onChange={(e) =>
                onUi({ ...ui, sidebarWidth: Number(e.target.value) })
              }
            >
              {[200, 240, 280, 320].map((n) => (
                <option key={n} value={n}>
                  {n} px
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr("列表字号", "List font size")}
            <select
              value={ui.fontSize}
              onChange={(e) =>
                onUi({ ...ui, fontSize: Number(e.target.value) })
              }
            >
              {[11, 12, 13, 14].map((n) => (
                <option key={n} value={n}>
                  {n} px
                </option>
              ))}
            </select>
          </label>
          <label>
            {tr("减少动画", "Reduce motion")}
            <select
              value={String(ui.reducedMotion)}
              onChange={(e) =>
                onUi({ ...ui, reducedMotion: e.target.value === "true" })
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
              onChange={(e) =>
                onUi({ ...ui, activityBarText: e.target.value === "true" })
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
              onChange={(e) =>
                onUi({ ...ui, toolbarText: e.target.value === "true" })
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
