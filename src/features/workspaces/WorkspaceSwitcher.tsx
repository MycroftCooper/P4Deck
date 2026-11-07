import { t } from "../../shared/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw, Search } from "lucide-react";
import type { RuntimeInfo } from "../../shared/contracts";
import { switchFailure, switchWorkspaceWithResync } from "./workspaceSwitch";
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
      ? t("workspaces.unable.workspaces.retry")
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
      const attempt = await switchWorkspaceWithResync(
        { expectedGeneration: runtime.contextGeneration, client },
        runtime,
      );
      if (!live.current) return;
      if (attempt.runtime) onRuntime(attempt.runtime);
      if (attempt.error) throw attempt.error;
      close();
    } catch (cause) {
      if (!live.current) return;
      setError(
        `${t("workspaces.switch.failed.the.current.workspace")} ${switchFailure(cause, zh)}`,
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
            ? `${t("workspaces.switch.workspace")}: ${runtime.context.client}`
            : t("workspaces.connection.settings.not.connected")
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
        title={`${runtime.context.user}@${runtime.context.client} · ${runtime.context.server}\n${runtime.mode === "mock" ? "Demo / 演示连接" : runtime.connection.message}\n${t("workspaces.switch.workspace")}`}
      >
        <span
          className={`status-dot connection-${runtime.mode === "mock" && configured ? "demo" : runtime.connection.state}`}
        />
        <span className="connection-client">
          {configured ? runtime.context.client : t("workspaces.not.connected")}
        </span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div
          id={id}
          className="workspace-switcher-menu"
          role="dialog"
          aria-label={t("workspaces.switch.workspace")}
        >
          <div className="workspace-switcher-heading">
            <strong>{t("workspaces.switch.workspace")}</strong>
            <button
              className="icon-button"
              aria-label={t("workspaces.refresh.workspaces")}
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
              aria-label={t("workspaces.search.workspaces.2")}
              placeholder={t("workspaces.search.name.path.or.stream")}
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
                      <small>{t("workspaces.current.workspace")}</small>
                    )}
                  </span>
                </button>
              );
            })}
            {loading && (
              <p role="status">{t("workspaces.loading.workspaces")}</p>
            )}
            {!loading && !error && !filtered.length && (
              <p role="status">
                {search
                  ? t("workspaces.no.matching.workspaces")
                  : t("workspaces.no.workspaces.owned.by.the.current")}
              </p>
            )}
          </div>
          {switching && (
            <p role="status">
              {t("workspaces.verifyingSwitch")} {switching}…
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
            {t("workspaces.connection.settings")}
          </button>
        </div>
      )}
    </div>
  );
}
