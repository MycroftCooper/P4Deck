import { t as translate } from "../../shared/i18n";
import { isZh } from "../../shared/locale";
import { ConnectionSpecCreateDialog } from "../settings/ConnectionSpecCreateDialog";
import { WorkspaceMutationDialog } from "./WorkspaceMutationDialog";
import type { WorkspaceMutationRequest } from "../../shared/contracts";
import { useColumnWidths } from "../../app/context-menu/useColumnWidths";
import { FixedPageHeader } from "../../app/docking/chrome";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Monitor, RefreshCw, Search } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import type { P4VfsStatus, RuntimeInfo } from "../../shared/contracts";
import type { messages } from "../../shared/i18n";

import { useContextMenu } from "../../app/context-menu/ContextMenu";
import { TableHeader } from "../../app/context-menu/TableHeader";
import { action } from "../../app/context-menu/bindings";
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
  const zh = isZh();
  const columns = useColumnWidths(
    [260, 110, 140, 300, 190],
    [140, 80, 90, 140, 150],
    { id: "workspaces" },
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [mutation, setMutation] = useState<WorkspaceMutationRequest>();
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
    setCreateOpen(false);
    setMutation(undefined);
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
  const switchToSelected = async (name = selected?.name) => {
    if (!name || switching || name === runtime.context.client) return;
    setSwitching(true);
    setSwitchPhase("verifying");
    setError("");
    switchTarget.current = name;
    try {
      const next = await backend.switchWorkspace({
        expectedGeneration: runtime.contextGeneration,
        client: name,
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
            aria-label={translate("workspaces.search.workspaces")}
            placeholder={
              translate("workspaces.search.workspace.host.path")
            }
            value={search}
            disabled={!ready}
            onChange={(event) => {
              setSearch(event.target.value);
              scrollRef.current?.scrollTo(0, 0);
            }}
          />
        </label>
        {selected && (
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
        )}
        <span className="owner-scope">
          {translate("workspaces.owner.current.user")}
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
        aria-label={translate("workspaces.current.workspace")}
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
          {translate("workspaces.p4vfs.is.not.ready")}
          {vfsStatus.reason}
        </p>
      )}
      {vfsError && (
        <p className="workspace-vfs-note" role="status">
          {translate("workspaces.p4vfs.status.unavailable")}
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
      <div className="workspace-layout">
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
              resize={columns}
              columns={[
                { id: "name", label: "Workspace" },
                { id: "owner", label: "Owner" },
                { id: "host", label: "Host" },
                { id: "root", label: translate("workspaces.root") },
                { id: "updated", label: translate("workspaces.updated") },
              ]}
            />
            <div
              className="virtual-spacer"
              style={{
                height: virtual.getTotalSize(),
                minWidth: columns.style.minWidth,
              }}
            >
              {virtual.getVirtualItems().map((row) => {
                const item = filtered[row.index];
                return (
                  <button
                    key={item.name}
                    className={`workspace-columns workspace-row ${selection.isSelected(item) ? "selected" : ""}`}
                    style={{
                      ...columns.style,
                      height: row.size,
                      transform: `translateY(${row.start}px)`,
                    }}
                    aria-pressed={selection.isSelected(item)}
                    onClick={(event) => {
                      selection.select(item, event);
                      setSelectedName(item.name);
                    }}
                    {...menu(
                      "W01",
                      () => ({
                        "切换到此工作区…": {
                          label: zh
                            ? `切换到工作区 '${item.name}'`
                            : `Switch to Workspace '${item.name}'`,
                          ...action(
                            () => switchToSelected(item.name),
                            !ready ||
                              switching ||
                              item.name === runtime.context.client
                              ? zh
                                ? "当前不可切换"
                                : "Switch unavailable"
                              : undefined,
                          ),
                        },
                        "新建工作区…": {
                          label: translate("workspaces.new.workspace"),
                          ...action(
                            () => setCreateOpen(true),
                            !ready
                              ? zh
                                ? "连接不可用"
                                : "Connection unavailable"
                              : undefined,
                          ),
                        },
                        "重命名工作区…": {
                          label: zh
                            ? `重命名工作区 '${item.name}'`
                            : `Rename Workspace '${item.name}'`,
                          ...action(
                            () =>
                              setMutation({
                                action: "rename",
                                workspace: item.name,
                                expectedGeneration: runtime.contextGeneration,
                              }),
                            !ready || item.name === runtime.context.client
                              ? zh
                                ? "请先切换到其他工作区"
                                : "Switch to another workspace first"
                              : undefined,
                          ),
                        },
                        "删除工作区…": {
                          label: zh
                            ? `删除工作区 '${item.name}'`
                            : `Delete Workspace '${item.name}'`,
                          ...action(
                            () =>
                              setMutation({
                                action: "delete",
                                workspace: item.name,
                                expectedGeneration: runtime.contextGeneration,
                              }),
                            !ready || item.name === runtime.context.client
                              ? zh
                                ? "请先切换到其他工作区"
                                : "Switch to another workspace first"
                              : undefined,
                          ),
                        },
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
                    <span title={item.name}>
                      <Monitor size={16} />
                      <strong>{item.name}</strong>
                      {item.name === runtime.context.client && (
                        <em>{translate("workspaces.current")}</em>
                      )}
                    </span>
                    <span title={item.owner}>{item.owner || "—"}</span>
                    <span title={item.host}>
                      {item.host || (translate("workspaces.any.host"))}
                    </span>
                    <span title={item.root}>{item.root}</span>
                    <time title={date(item.updated)}>{date(item.updated)}</time>
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
              {translate("workspaces.owned.by.current.user")}
            </span>
          </footer>
        </section>
      </div>
      {createOpen && (
        <ConnectionSpecCreateDialog
          key={runtime.contextGeneration}
          kind="workspace"
          context={{ ...runtime.context, client: "" }}
          requestGeneration={runtime.contextGeneration}
          source={null}
          zh={zh}
          onDismiss={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void reload();
          }}
        />
      )}
      {mutation && (
        <WorkspaceMutationDialog
          key={`${runtime.contextGeneration}:${mutation.workspace}:${mutation.action}`}
          request={mutation}
          zh={zh}
          onClose={() => setMutation(undefined)}
          onDone={() => {
            setMutation(undefined);
            setSelectedName("");
            selection.clear();
            void reload();
          }}
        />
      )}
    </section>
  );
}
