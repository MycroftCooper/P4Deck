import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw, Search } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import type { RuntimeInfo } from "../../shared/contracts";
import { switchFailure } from "./workspaceSwitch";
import { useWorkspaceList } from "./workspaceList";

export function WorkspaceSwitcher({
  runtime,
  zh,
  onRuntime,
  onSettings,
}: {
  runtime: RuntimeInfo;
  zh: boolean;
  onRuntime(runtime: RuntimeInfo): void;
  onSettings(): void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [switchError, setError] = useState("");
  const [switching, setSwitching] = useState("");
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  const pending = useRef(false);
  const id = useId();
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const configured =
    !!runtime.context.server.trim() && !!runtime.context.user.trim();
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // Opening shows the cached list at once; P4 is asked only for stale data.
  const list = useWorkspaceList(runtime, open && configured);
  const items = list.data ?? [];
  const loading = list.initialLoading;
  const busy = list.initialLoading || list.refreshing;
  const error =
    switchError ||
    (list.error && !items.length
      ? tr(
          "无法加载 Workspace，请刷新重试或在连接设置中检查登录状态。",
          "Unable to load workspaces. Retry or check your login in Connection settings.",
        )
      : "");
  useEffect(() => {
    if (!open) return;
    searchInput.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!picker.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const switchTo = async (client: string) => {
    if (pending.current || client === runtime.context.client) return;
    pending.current = true;
    searchInput.current?.focus();
    setSwitching(client);
    setError("");
    try {
      const next = await backend.switchWorkspace({
        expectedGeneration: runtime.contextGeneration,
        client,
      });
      if (!live.current) return;
      close();
      onRuntime(next);
    } catch (cause) {
      if (!live.current) return;
      setError(
        `${tr("切换失败，当前 Workspace 保持不变。", "Switch failed; the current workspace remains active.")} ${switchFailure(cause, zh)}`,
      );
      searchInput.current?.focus();
    } finally {
      pending.current = false;
      if (live.current) setSwitching("");
    }
  };
  const term = search.trim().toLowerCase();
  const filtered = items.filter((item) =>
    [item.name, item.root, item.host, item.stream].some((value) =>
      value.toLowerCase().includes(term),
    ),
  );
  return (
    <div
      className="connection-picker"
      data-tauri-drag-region="false"
      ref={picker}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        const buttons = [
          ...(picker.current?.querySelectorAll<HTMLButtonElement>(
            ".workspace-switcher-item:not(:disabled)",
          ) ?? []),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          index < 0
            ? event.key === "ArrowDown"
              ? 0
              : buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length;
        buttons[next]?.focus();
      }}
    >
      <button
        ref={trigger}
        className="connection"
        aria-label={
          configured
            ? `${tr("切换 Workspace", "Switch workspace")}: ${runtime.context.client}`
            : tr("连接设置：未连接", "Connection settings: Not connected")
        }
        aria-haspopup={configured ? "dialog" : undefined}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={runtime.p4Version === "loading"}
        onClick={() => {
          if (!configured) {
            onSettings();
            return;
          }
          setSearch("");
          setOpen((value) => !value);
        }}
        title={`${runtime.context.user}@${runtime.context.client} · ${runtime.context.server}\n${runtime.mode === "mock" ? "Demo / 演示连接" : runtime.connection.message}\n${tr("切换 Workspace", "Switch workspace")}`}
      >
        <span
          className={`status-dot connection-${runtime.mode === "mock" && configured ? "demo" : runtime.connection.state}`}
        />
        <span className="connection-client">
          {configured ? runtime.context.client : tr("未连接", "Not connected")}
        </span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div
          id={id}
          className="workspace-switcher-menu"
          role="dialog"
          aria-label={tr("切换 Workspace", "Switch workspace")}
        >
          <div className="workspace-switcher-heading">
            <strong>{tr("切换 Workspace", "Switch workspace")}</strong>
            <button
              className="icon-button"
              aria-label={tr("刷新 Workspace", "Refresh workspaces")}
              disabled={busy || !!switching}
              onClick={() => {
                searchInput.current?.focus();
                setError("");
                void list.refresh();
              }}
            >
              <RefreshCw size={14} className={busy ? "spin" : ""} />
            </button>
          </div>
          <p className="workspace-switcher-context">
            {runtime.context.user} · {runtime.context.server}
            {runtime.mode === "mock" ? " · Demo" : ""}
          </p>
          <label className="workspace-switcher-search">
            <Search size={14} />
            <input
              ref={searchInput}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label={tr("搜索 Workspace", "Search workspaces")}
              placeholder={tr(
                "搜索名称、路径或 Stream…",
                "Search name, path or stream…",
              )}
            />
          </label>
          <div
            className="workspace-switcher-list"
            aria-busy={loading || !!switching}
          >
            {filtered.map((item) => {
              const current = item.name === runtime.context.client;
              return (
                <button
                  key={item.name}
                  className="workspace-switcher-item"
                  aria-current={current ? "true" : undefined}
                  disabled={!!switching}
                  onClick={() => (current ? close() : void switchTo(item.name))}
                >
                  <span className="workspace-switcher-check">
                    {current && <Check size={15} />}
                  </span>
                  <span className="workspace-switcher-details">
                    <strong>{item.name}</strong>
                    <small>
                      {item.root}
                      {item.host ? ` · ${item.host}` : ""}
                    </small>
                    {current && (
                      <small>{tr("当前 Workspace", "Current workspace")}</small>
                    )}
                  </span>
                </button>
              );
            })}
            {loading && (
              <p role="status">
                {tr("正在加载 Workspace…", "Loading workspaces…")}
              </p>
            )}
            {!loading && !error && !filtered.length && (
              <p role="status">
                {search
                  ? tr("没有匹配的 Workspace", "No matching workspaces")
                  : tr(
                      "当前用户尚无 Workspace",
                      "No workspaces owned by the current user",
                    )}
              </p>
            )}
          </div>
          {switching && (
            <p role="status">
              {tr("正在验证并切换到", "Verifying and switching to")} {switching}
              …
            </p>
          )}
          {error && (
            <p className="workspace-switcher-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="workspace-switcher-settings"
            disabled={!!switching}
            onClick={() => {
              close();
              onSettings();
            }}
          >
            {tr("连接设置…", "Connection settings…")}
          </button>
        </div>
      )}
    </div>
  );
}
