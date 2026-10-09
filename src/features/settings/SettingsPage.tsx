import { useEffect, useRef, useState } from "react";
import {
  Cable,
  KeyRound,
  LogIn,
  LogOut,
  Palette,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { backend } from "../../infrastructure/backend";
import type {
  ConnectionStatus,
  Locale,
  P4Context,
  RuntimeInfo,
  ThemeMode,
} from "../../shared/contracts/types";

import { defaultUi, type UiPreferences } from "./preferences";
import {
  connectionPresentation,
  contextIdentity,
  notTestedStatus,
  probeConnection,
} from "./connectionWizard";
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

function normalizeContext(draft: P4Context): P4Context {
  return Object.fromEntries(
    Object.entries(draft).map(([key, value]) => [
      key,
      typeof value === "string"
        ? value.trim() ||
          (["server", "user", "client"].includes(key) ? "" : undefined)
        : value,
    ]),
  ) as unknown as P4Context;
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
  const zh = locale === "zh-CN",
    tr = (a: string, b: string) => (zh ? a : b);
  const [draft, setDraft] = useState(runtime.context),
    [busy, setBusy] = useState(false),
    [operation, setOperation] = useState(""),
    [connection, setConnection] = useState(runtime.connection),
    [cliVersion, setCliVersion] = useState(runtime.p4Version),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [password, setPassword] = useState(""),
    [trustConfirmed, setTrustConfirmed] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const expectedContext = useRef<string | undefined>(undefined);
  const activeContext = contextIdentity(runtime.context);
  useEffect(() => {
    const ownSave = expectedContext.current === activeContext;
    expectedContext.current = undefined;
    generation.current += 1;
    inFlight.current = false;
    setBusy(false);
    setOperation("");
    setDraft(runtime.context);
    setConnection(runtime.connection);
    setCliVersion(runtime.p4Version);
    if (!ownSave) setNotice("");
    setError("");
    setPassword("");
    setTrustConfirmed(false);
  }, [activeContext]);
  useEffect(() => setConnection(runtime.connection), [runtime.connection]);
  const valid = !!(
    draft.server.trim() &&
    draft.user.trim() &&
    draft.client.trim()
  );
  const current = normalizeContext(draft);
  const dirty = contextIdentity(current) !== activeContext;
  const presentation = connectionPresentation(connection, zh);
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
  function begin(nextOperation: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    const token = ++generation.current;
    setBusy(true);
    setOperation(nextOperation);
    setError("");
    setNotice("");
    return token;
  }
  function isCurrent(token: number) {
    return token === generation.current;
  }
  function finish(token: number) {
    if (!isCurrent(token)) return;
    inFlight.current = false;
    setBusy(false);
    setOperation("");
  }
  function publish(
    context: P4Context,
    status: ConnectionStatus,
    version = cliVersion,
  ) {
    setConnection(status);
    setTrustConfirmed(false);
    setCliVersion(version);
    onConnection(context, status, version);
  }
  async function save() {
    const token = begin("save");
    if (token == null) return;
    try {
      const next = await backend.saveConnection(current);
      if (!isCurrent(token)) return;
      const status = notTestedStatus(next.server);
      const version =
        next.executable === runtime.context.executable
          ? cliVersion
          : "P4 CLI not tested";
      setConnection(status);
      setCliVersion(version);
      setNotice(
        tr(
          "连接参数已保存并应用；保存不代表已连接成功。",
          "Connection saved and applied; this does not verify connectivity.",
        ),
      );
      finish(token);
      expectedContext.current = contextIdentity(next);
      const refreshed = await backend.runtimeInfo();
      if (!isCurrent(token)) return;
      onRuntime({ ...refreshed, connection: status, p4Version: version });
    } catch {
      if (isCurrent(token))
        setError(
          tr(
            "无法保存连接参数；请检查字段和本地路径。",
            "Could not save the connection. Check the fields and local paths.",
          ),
        );
    } finally {
      finish(token);
    }
  }
  async function test() {
    const token = begin("test");
    if (token == null) return;
    try {
      const result = await probeConnection(backend, current, () =>
        isCurrent(token),
      );
      if (result.stale || !isCurrent(token)) return;
      const version =
        result.discovery.version ??
        (result.discovery.state === "notTested"
          ? cliVersion
          : "P4 CLI unavailable");
      publish(current, result.status, version);
      if (result.status.state === "connected")
        setNotice(
          runtime.mode === "mock"
            ? tr(
                "浏览器 Mock：模拟验证完成，未发起任何真实网络连接。",
                "Browser Mock: validation was simulated; no real network connection was made.",
              )
            : tr(
                "连接和登录状态已验证；相关工作区视图正在使用新的连接代次刷新。",
                "Connection and login are verified. Dependent workspace views are refreshing with a new connection generation.",
              ),
        );
    } catch {
      if (isCurrent(token))
        setError(
          tr(
            "连接验证请求未完成；未将该结果视为成功，请重试。",
            "The connection check did not complete and was not treated as success. Retry.",
          ),
        );
    } finally {
      finish(token);
    }
  }
  async function trust() {
    const snapshot = connection;
    if (
      dirty ||
      snapshot.state !== "sslUntrusted" ||
      !snapshot.fingerprint ||
      snapshot.server !== current.server ||
      !trustConfirmed
    )
      return;
    const token = begin("trust");
    if (token == null) return;
    try {
      const trusted = await backend.trustServer({
        context: current,
        fingerprint: snapshot.fingerprint,
        confirmed: true,
      });
      if (!isCurrent(token)) return;
      if (trusted.state === "notTested") {
        const result = await probeConnection(backend, current, () =>
          isCurrent(token),
        );
        if (result.stale || !isCurrent(token)) return;
        publish(current, result.status, result.discovery.version ?? cliVersion);
      } else publish(current, trusted);
    } catch {
      if (isCurrent(token))
        setError(
          tr(
            "Trust 请求未完成；未信任任何其他指纹。",
            "The trust request did not complete. No other fingerprint was trusted.",
          ),
        );
    } finally {
      finish(token);
    }
  }
  async function login() {
    if (
      dirty ||
      !password ||
      !["authRequired", "ticketExpired"].includes(connection.state)
    )
      return;
    const token = begin("login");
    if (token == null) return;
    const singleUsePassword = password;
    setPassword("");
    try {
      const authenticated = await backend.login({
        context: current,
        password: singleUsePassword,
        confirmed: true,
      });
      if (!isCurrent(token)) return;
      const status =
        authenticated.state === "connected"
          ? await backend.queryLoginStatus(current)
          : authenticated;
      if (!isCurrent(token)) return;
      publish(current, status);
      if (status.state === "connected")
        setNotice(
          runtime.mode === "mock"
            ? tr(
                "浏览器 Mock：模拟登录完成，未发送到真实服务器。",
                "Browser Mock: login was simulated and was not sent to a real server.",
              )
            : tr(
                "登录成功；密码已清空。",
                "Login succeeded; the password has been cleared.",
              ),
        );
    } catch {
      if (isCurrent(token))
        setError(
          tr(
            "登录请求未完成；密码已清空，请确认状态后再试。",
            "The login request did not complete. The password was cleared; check status before retrying.",
          ),
        );
    } finally {
      finish(token);
    }
  }
  async function logout() {
    if (dirty || connection.state !== "connected") return;
    const token = begin("logout");
    if (token == null) return;
    setPassword("");
    try {
      const status = await backend.logout({
        context: current,
        confirmed: true,
      });
      if (!isCurrent(token)) return;
      publish(current, status);
      setNotice(
        runtime.mode === "mock"
          ? tr(
              "浏览器 Mock：模拟退出登录，未访问真实服务器。",
              "Browser Mock: logout was simulated; no real server was accessed.",
            )
          : tr("已退出当前用户。", "The current user has been logged out."),
      );
    } catch {
      if (isCurrent(token))
        setError(
          tr(
            "退出登录请求未完成；请检查登录状态后再试。",
            "The logout request did not complete. Check login status before retrying.",
          ),
        );
    } finally {
      finish(token);
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
          <p className="settings-note settings-mock-disclosure">
            {tr(
              "浏览器 Mock 只模拟状态，不会发起真实网络连接、写入 Trust 或创建登录票据。真实连接请使用桌面客户端。",
              "Browser Mock simulates state only. It makes no real network connection, writes no trust entry, and creates no login ticket. Use the desktop app for real connections.",
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
                      const next = { ...draft, [key]: e.target.value };
                      generation.current += 1;
                      setDraft(next);
                      setConnection(
                        notTestedStatus(
                          key === "server"
                            ? e.target.value.trim()
                            : next.server.trim(),
                        ),
                      );
                      setNotice("");
                      setError("");
                      setPassword("");
                      setTrustConfirmed(false);
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
                disabled={!valid || dirty}
                onClick={() => void test()}
              >
                <RefreshCw
                  size={14}
                  className={operation === "test" ? "spin" : ""}
                />
                {operation === "test"
                  ? tr("正在验证…", "Checking…")
                  : tr("验证连接与登录", "Check connection and login")}
              </button>
              <button
                className="primary"
                type="submit"
                disabled={!valid || !dirty}
              >
                <Save size={14} />
                {operation === "save"
                  ? tr("正在保存…", "Saving…")
                  : tr("保存并应用", "Save and apply")}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!dirty}
                onClick={() => {
                  setDraft(runtime.context);
                  setConnection(runtime.connection);
                  setNotice("");
                  setError("");
                  setPassword("");
                  setTrustConfirmed(false);
                }}
              >
                {tr("撤销修改", "Discard edits")}
              </button>
            </div>
          </fieldset>
        </form>
        {dirty && (
          <p role="status" className="settings-unsaved-note">
            {tr(
              "连接参数有未保存修改。先保存，再验证、Trust 或登录；保存本身不会显示为已连接。",
              "Connection settings have unsaved changes. Save before testing, trusting, or logging in. Saving alone never reports a successful connection.",
            )}
          </p>
        )}
        <section
          className={`connection-status-card connection-status-${presentation.tone}`}
          aria-live="polite"
          aria-busy={busy}
        >
          <div className="connection-status-heading">
            <span className="connection-status-indicator" aria-hidden="true" />
            <div>
              <strong>{presentation.title}</strong>
              <span>{connection.state}</span>
            </div>
          </div>
          <p>{presentation.detail}</p>
          <dl className="connection-facts">
            <div>
              <dt>{tr("服务器", "Server")}</dt>
              <dd>{connection.server || current.server || "—"}</dd>
            </div>
            <div>
              <dt>P4 CLI</dt>
              <dd>{cliVersion || tr("未知", "Unknown")}</dd>
            </div>
          </dl>
          <p className="connection-recovery">
            <strong>{tr("下一步：", "Next: ")}</strong>
            {presentation.recovery}
          </p>

          {connection.state === "sslUntrusted" && (
            <div className="connection-recovery-panel">
              {connection.fingerprint ? (
                <>
                  <div className="connection-fingerprint">
                    <span>{tr("服务器指纹", "Server fingerprint")}</span>
                    <code>{connection.fingerprint}</code>
                  </div>
                  <label className="connection-confirmation">
                    <input
                      type="checkbox"
                      checked={trustConfirmed}
                      disabled={busy || dirty}
                      onChange={(event) =>
                        setTrustConfirmed(event.target.checked)
                      }
                    />
                    <span>
                      {tr(
                        `我已通过可信渠道核对 ${connection.server} 的上述完整指纹。`,
                        `I verified the full fingerprint above for ${connection.server} through a trusted channel.`,
                      )}
                    </span>
                  </label>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!trustConfirmed || busy || dirty}
                    onClick={() => void trust()}
                  >
                    <ShieldCheck size={14} />
                    {operation === "trust"
                      ? tr("正在写入 Trust…", "Trusting…")
                      : tr("信任此精确指纹", "Trust this exact fingerprint")}
                  </button>
                </>
              ) : (
                <p role="alert">
                  {tr(
                    "服务器没有返回可核对的指纹，因此不能执行 Trust。请重试或联系管理员。",
                    "The server did not return a fingerprint that can be verified, so trust is blocked. Retry or contact an administrator.",
                  )}
                </p>
              )}
            </div>
          )}

          {["authRequired", "ticketExpired"].includes(connection.state) && (
            <form
              className="connection-recovery-panel connection-login"
              onSubmit={(event) => {
                event.preventDefault();
                void login();
              }}
            >
              <label>
                <span>
                  {tr(
                    "P4 密码（仅用于本次请求）",
                    "P4 password (this request only)",
                  )}
                </span>
                <span className="connection-password-field">
                  <KeyRound size={15} aria-hidden="true" />
                  <input
                    type="password"
                    aria-label={tr("P4 密码", "P4 password")}
                    value={password}
                    autoComplete="off"
                    disabled={busy || dirty}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </span>
              </label>
              <p>
                {tr(
                  "密码不写入连接草稿、Storage、URL、历史或日志；点击登录后立即清空输入。",
                  "The password is never written to connection drafts, storage, URLs, history, or logs, and the input is cleared immediately on submit.",
                )}
              </p>
              <button
                type="submit"
                className="primary"
                disabled={!password || busy || dirty}
              >
                <LogIn size={14} />
                {operation === "login"
                  ? tr("正在登录…", "Logging in…")
                  : connection.state === "ticketExpired"
                    ? tr("重新登录", "Log in again")
                    : tr("登录", "Log in")}
              </button>
            </form>
          )}

          {connection.state === "externalAuthRequired" && (
            <div className="connection-recovery-panel">
              <p>
                {tr(
                  "P4Deck 不会用普通密码框伪装完成外部认证。打开组织指定的 SSO/MFA 流程并完成后，再检查状态。",
                  "P4Deck will not pretend a normal password form can complete external authentication. Finish your organization's SSO/MFA flow, then check again.",
                )}
              </p>
              <button
                type="button"
                className="secondary"
                disabled={busy || dirty}
                onClick={() => void test()}
              >
                <RefreshCw size={14} />
                {tr(
                  "我已完成外部认证，检查状态",
                  "I completed external authentication; check status",
                )}
              </button>
            </div>
          )}

          {connection.state === "connected" && (
            <button
              type="button"
              className="secondary"
              disabled={busy || dirty}
              onClick={() => void logout()}
            >
              <LogOut size={14} />
              {operation === "logout"
                ? tr("正在退出…", "Logging out…")
                : tr("退出登录", "Log out")}
            </button>
          )}
        </section>
        {notice && (
          <p role="status" className="settings-note">
            {notice}
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
