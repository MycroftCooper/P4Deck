import { FixedPageHeader } from "../../app/docking/chrome";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Monitor, RefreshCw, Search } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import type { P4VfsStatus, RuntimeInfo } from "../../shared/contracts/types";
import type { messages } from "../../shared/i18n";

import { useContextMenu } from "../../app/context-menu/ContextMenu";
import { TableHeader } from "../../app/context-menu/TableHeader";
import { action, copy } from "../../app/context-menu/bindings";
import { useRecordSelection } from "../../app/context-menu/useRecordSelection";
import { appCache } from "../../shared/cache/appCache";
import { useViewRefresh } from "../../shared/cache/useViewRefresh";
import { switchFailure } from "./workspaceSwitch";
import { useWorkspaceList, workspaceListKey } from "./workspaceList";

export function WorkspacePage({
  t,
  runtime,
  onRuntime,
}: {
  t: (typeof messages)[keyof typeof messages];
  runtime: RuntimeInfo;
  onRuntime(runtime: RuntimeInfo): void;
}) {
  const zh = t.files === "文件";
  const [search, setSearch] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const [switchError, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  const [vfsStatus, setVfsStatus] = useState<P4VfsStatus>();
  const [vfsError, setVfsError] = useState("");
  const [vfsRevision, setVfsRevision] = useState(0);
  const [switchPhase, setSwitchPhase] = useState<
    "idle" | "verifying" | "committing" | "success" | "error"
  >("idle");
  const scrollRef = useRef<HTMLDivElement>(null);
  const switchTarget = useRef("");
  const switchButton = useRef<HTMLButtonElement>(null);
  const restoreSwitchFocus = useRef(false);
  const previousGeneration = useRef(runtime.contextGeneration);
  const vfsSequence = useRef(0);
  const ready = runtime.connection.state === "connected";
  const key = workspaceListKey(runtime);
  // Cached rows stay visible while unverified; only a verified connection asks P4.
  const list = useWorkspaceList(
    runtime,
    ready && runtime.p4Version !== "loading",
  );
  const items = useMemo(() => list.data ?? [], [list.data]);
  const loading = list.initialLoading || list.refreshing;
  const error = switchError || list.error;
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) =>
      [
        item.name,
        item.owner,
        item.host,
        item.root,
        item.stream,
        item.description,
      ].some((value) => value.toLowerCase().includes(term)),
    );
  }, [items, search]);
  const menu = useContextMenu();
  const selection = useRecordSelection(
    filtered,
    (item) => item.name,
    JSON.stringify(key),
  );
  const selected = items.find((item) => item.name === selectedName);
  const currentWorkspace = items.find(
    (item) => item.name === runtime.context.client,
  );
  const virtual = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 8,
  });
  const date = (value: number | null) =>
    value == null
      ? "—"
      : new Date(value * 1000).toLocaleString(zh ? "zh-CN" : "en-US");
  const reload = () => {
    setError("");
    setVfsError("");
    setVfsRevision((value) => value + 1);
    return list.refresh();
  };
  useEffect(() => {
    const sequence = ++vfsSequence.current;
    if (!ready) {
      setVfsStatus(undefined);
      setVfsError("");
      return;
    }
    setVfsStatus(undefined);
    setVfsError("");
    void backend
      .inspectP4Vfs({
        expectedContextGeneration: runtime.contextGeneration,
        operationId: `workspace-vfs-${crypto.randomUUID()}`,
      })
      .then((status) => {
        if (sequence === vfsSequence.current) setVfsStatus(status);
      })
      .catch((cause) => {
        if (sequence !== vfsSequence.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!message.includes("contextChanged")) setVfsError(message);
      });
    return () => {
      vfsSequence.current += 1;
    };
  }, [ready, runtime.contextGeneration, vfsRevision]);
  useViewRefresh("workspaces", key, reload);
  useEffect(() => {
    if (previousGeneration.current === runtime.contextGeneration) return;
    previousGeneration.current = runtime.contextGeneration;
    // Stream or workspace switches can change rows; keep them visible meanwhile.
    void appCache.invalidateQueries({ queryKey: workspaceListKey(runtime) });
    setSearch("");
    setError("");
    if (switchTarget.current === runtime.context.client) {
      setSelectedName(runtime.context.client);
      setSwitchPhase("success");
      switchTarget.current = "";
    } else {
      setSelectedName("");
      setSwitchPhase("idle");
    }
  }, [runtime.context.client, runtime.contextGeneration]);
  useEffect(() => {
    if (!switching && restoreSwitchFocus.current) {
      switchButton.current?.focus();
      restoreSwitchFocus.current = false;
    }
  }, [switching]);
  const switchToSelected = async () => {
    if (!selected || selected.name === runtime.context.client) return;
    setSwitching(true);
    setSwitchPhase("verifying");
    setError("");
    switchTarget.current = selected.name;
    try {
      const next = await backend.switchWorkspace({
        expectedGeneration: runtime.contextGeneration,
        client: selected.name,
      });
      setSwitchPhase("committing");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      onRuntime(next);
    } catch (cause) {
      switchTarget.current = "";
      setSwitchPhase("error");
      setError(
        zh
          ? `Workspace 切换失败；仍保留 ${runtime.context.client} 与现有页面数据。${switchFailure(cause, true)}`
          : `Workspace switch failed. ${runtime.context.client} and existing page data were preserved. ${switchFailure(cause, false)}`,
      );
      restoreSwitchFocus.current = true;
    } finally {
      setSwitching(false);
    }
  };
  return (
    <section className="workspaces-page">
      <FixedPageHeader
        description={
          zh
            ? "当前用户拥有的工作区，跨主机集中查看。"
            : "Workspaces owned by the current user, across hosts."
        }
      >
        <span className="fixed-page-meta">{items.length}</span>
        <button disabled={loading || !ready} onClick={() => void reload()}>
          <RefreshCw size={15} className={loading ? "spin" : ""} />
          {t.refresh}
        </button>
      </FixedPageHeader>
      <div className="query-bar">
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label={zh ? "搜索工作区" : "Search workspaces"}
            placeholder={
              zh ? "搜索工作区、主机、路径…" : "Search workspace, host, path…"
            }
            value={search}
            disabled={!ready}
            onChange={(event) => {
              setSearch(event.target.value);
              scrollRef.current?.scrollTo(0, 0);
            }}
          />
        </label>
        <span className="owner-scope">
          {zh ? "归属：当前用户" : "Owner: current user"}
        </span>
        <span className="filter-count">
          {runtime.mode === "mock" ? t.mock : runtime.context.server}
        </span>
      </div>
      {!ready && (
        <p role="status" className="workspace-load-error">
          {zh
            ? "请先在设置中验证并激活连接；连接未验证时不会自动扫描 Workspace。"
            : "Verify and activate a connection in Settings first. Workspaces are not scanned automatically while the connection is unverified."}
        </p>
      )}
      <section
        className="workspace-runtime-summary"
        aria-label={zh ? "当前 Workspace" : "Current workspace"}
      >
        <div>
          <span>CLIENT</span>
          <strong>{runtime.context.client || "—"}</strong>
        </div>
        <div>
          <span>ROOT</span>
          <strong>
            {currentWorkspace?.root || runtime.context.cwd || "—"}
          </strong>
        </div>
        <div>
          <span>STREAM</span>
          <strong>{currentWorkspace?.stream || "—"}</strong>
        </div>
        <div title={vfsStatus?.reason}>
          <span>SYNC MODE</span>
          <strong>
            {vfsStatus?.mode === "virtual"
              ? vfsStatus.ready
                ? "P4VFS"
                : zh
                  ? "P4VFS · 待配置"
                  : "P4VFS · setup needed"
              : vfsStatus?.mode === "standard"
                ? zh
                  ? "标准同步"
                  : "Standard"
                : zh
                  ? "检查中…"
                  : "Checking…"}
          </strong>
        </div>
      </section>
      {vfsStatus?.mode === "virtual" && !vfsStatus.ready && (
        <p className="workspace-vfs-note" role="status">
          {zh ? "P4VFS 尚未就绪：" : "P4VFS is not ready: "}
          {vfsStatus.reason}
        </p>
      )}
      {vfsError && (
        <p className="workspace-vfs-note" role="status">
          {zh ? "无法检查 P4VFS 状态：" : "P4VFS status unavailable: "}
          {vfsError}
        </p>
      )}
      {runtime.mode === "mock" && (
        <p className="workspace-simulated-note">
          {zh
            ? "Simulated Mock：Workspace 切换只更新模拟 Context，不访问真实网络。"
            : "Simulated Mock: workspace switching only updates the simulated context and never accesses a real network."}
        </p>
      )}
      <div className="workspace-switch-status" role="status" aria-live="polite">
        {switchPhase === "verifying"
          ? zh
            ? "正在验证目标 Workspace…"
            : "Verifying target workspace…"
          : switchPhase === "committing"
            ? zh
              ? "验证通过，正在提交 Workspace…"
              : "Verified; committing workspace…"
            : switchPhase === "success"
              ? zh
                ? `已切换到 ${runtime.context.client}，依赖页面已刷新。`
                : `Switched to ${runtime.context.client}; dependent pages were refreshed.`
              : switchPhase === "error"
                ? zh
                  ? "切换失败，原 Workspace 保持不变。"
                  : "Switch failed; the previous workspace remains active."
                : ""}
      </div>
      {error && (
        <div role="alert" className="workspace-load-error">
          {error}
        </div>
      )}
      <div className={`workspace-layout ${selected ? "with-detail" : ""}`}>
        <section className="workspace-panel" aria-busy={loading}>
          <div
            className="workspace-table-scroll"
            ref={scrollRef}
            tabIndex={0}
            {...menu("W03", () => ({
              刷新: action(reload),
              全选结果: action(selection.all),
              清除选择: action(selection.clear),
            }))}
          >
            <TableHeader
              className="workspace-columns workspace-head"
              columns={[
                { id: "name", label: "Workspace" },
                { id: "owner", label: "Owner" },
                { id: "host", label: "Host" },
                { id: "root", label: zh ? "根目录" : "Root" },
                { id: "updated", label: zh ? "更新时间" : "Updated" },
              ]}
            />
            <div
              className="virtual-spacer"
              style={{ height: virtual.getTotalSize(), minWidth: 750 }}
            >
              {virtual.getVirtualItems().map((row) => {
                const item = filtered[row.index];
                return (
                  <button
                    key={item.name}
                    className={`workspace-columns workspace-row ${selection.isSelected(item) ? "selected" : ""}`}
                    style={{
                      height: row.size,
                      transform: `translateY(${row.start}px)`,
                    }}
                    aria-pressed={selection.isSelected(item)}
                    onClick={(event) => {
                      selection.select(item, event);
                      setSelectedName(item.name);
                    }}
                    {...menu(
                      selection.targets(item).length > 1 ? "W02" : "W01",
                      () => ({
                        查看详情: action(() => setSelectedName(item.name)),
                        复制名称: copy(item.name),
                        复制根路径: copy(item.root),
                        "复制 Stream 路径": copy(item.stream),
                        刷新: action(reload),
                        复制名称列表: copy(
                          selection
                            .targets(item)
                            .map((value) => value.name)
                            .join("\n"),
                        ),
                        复制根路径列表: copy(
                          selection
                            .targets(item)
                            .map((value) => value.root)
                            .join("\n"),
                        ),
                      }),
                      {
                        title: item.name,
                        onOpen: () => {
                          selection.context(item);
                          setSelectedName(item.name);
                        },
                      },
                    )}
                  >
                    <span>
                      <Monitor size={16} />
                      <strong>{item.name}</strong>
                      {item.name === runtime.context.client && (
                        <em>{zh ? "当前" : "Current"}</em>
                      )}
                    </span>
                    <span>{item.owner || "—"}</span>
                    <span>{item.host || (zh ? "不限主机" : "Any host")}</span>
                    <span title={item.root}>{item.root}</span>
                    <time>{date(item.updated)}</time>
                  </button>
                );
              })}
            </div>
            {!filtered.length && (
              <div className="workspace-empty" role="status">
                {loading
                  ? zh
                    ? "正在加载工作区…"
                    : "Loading workspaces…"
                  : error
                    ? zh
                      ? "加载失败，请刷新重试。"
                      : "Loading failed. Refresh to retry."
                    : search
                      ? zh
                        ? "没有匹配的工作区"
                        : "No matching workspaces"
                      : zh
                        ? "当前用户尚无工作区"
                        : "No workspaces owned by the current user"}
              </div>
            )}
          </div>
          <footer className="list-footer">
            {filtered.length} / {items.length} Workspace{" "}
            <span className="virtual-proof">
              {zh ? "仅显示当前用户所有" : "Owned by current user"}
            </span>
          </footer>
        </section>
        {selected && (
          <aside className="file-details workspace-details">
            <div className="detail-caption">
              {zh ? "工作区详情" : "Workspace details"}
              <button aria-label={t.close} onClick={() => setSelectedName("")}>
                ×
              </button>
            </div>
            <div className="file-preview-icon">
              <Monitor size={30} />
            </div>
            <h2>{selected.name}</h2>
            <dl>
              {[
                ["Owner", selected.owner],
                ["Host", selected.host || (zh ? "不限主机" : "Any host")],
                [
                  "Stream",
                  selected.stream || (zh ? "传统工作区" : "Classic workspace"),
                ],
                ...(selected.name === runtime.context.client
                  ? [
                      [
                        zh ? "同步方式" : "Sync mode",
                        vfsStatus?.mode === "virtual"
                          ? vfsStatus.ready
                            ? "P4VFS"
                            : zh
                              ? "P4VFS（未就绪）"
                              : "P4VFS (not ready)"
                          : vfsStatus?.mode === "standard"
                            ? zh
                              ? "标准同步"
                              : "Standard sync"
                            : zh
                              ? "未知"
                              : "Unknown",
                      ],
                    ]
                  : []),
                [zh ? "更新时间" : "Updated", date(selected.updated)],
                [zh ? "访问时间" : "Accessed", date(selected.accessed)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value || "—"}</dd>
                </div>
              ))}
            </dl>
            <div className="detail-path-label">ROOT</div>
            <p className="detail-path">{selected.root}</p>
            <div className="detail-path-label">
              {zh ? "描述" : "DESCRIPTION"}
            </div>
            <p className="workspace-description">
              {selected.description || "—"}
            </p>
            <button
              ref={switchButton}
              disabled={switching || selected.name === runtime.context.client}
              onClick={() => void switchToSelected()}
            >
              {switching
                ? zh
                  ? "正在验证并切换…"
                  : "Verifying and switching…"
                : selected.name === runtime.context.client
                  ? zh
                    ? "当前工作区"
                    : "Current workspace"
                  : zh
                    ? "切换到此工作区"
                    : "Switch to this workspace"}
            </button>
          </aside>
        )}
      </div>
    </section>
  );
}
