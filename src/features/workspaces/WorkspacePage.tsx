import { t as translate, tFor, useIsZh } from "../../shared/i18n";
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
  const zh = useIsZh(); // subscribed: re-renders on language switch
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
        tFor(
          zh ? "zh-CN" : "en-US",
          "workspaces.workspace.switch.failed.and.existing.page",
          {
            p1: zh ? runtime.context.client : runtime.context.client,
            p2: zh ? switchFailure(cause, true) : switchFailure(cause, false),
          },
        ),
      );
      restoreSwitchFocus.current = true;
    } finally {
      setSwitching(false);
    }
  };
  return (
    <section className="workspaces-page">
      <FixedPageHeader
        description={translate("workspaces.workspaces.owned.by.the.current")}
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
            placeholder={translate("workspaces.search.workspace.host.path")}
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
              ? translate("workspaces.verifying.and.switching")
              : selected.name === runtime.context.client
                ? translate("workspaces.current.workspace")
                : translate("workspaces.switch.to.this.workspace")}
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
          {translate("workspaces.verify.and.activate.a.connection")}
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
                : translate("workspaces.p4vfs.setup.needed")
              : vfsStatus?.mode === "standard"
                ? translate("workspaces.standard")
                : translate("workspaces.checking")}
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
          {translate("workspaces.simulated.mock.workspace.switching.only")}
        </p>
      )}
      <div className="workspace-switch-status" role="status" aria-live="polite">
        {switchPhase === "verifying"
          ? translate("workspaces.verifying.target.workspace")
          : switchPhase === "committing"
            ? translate("workspaces.verified.committing.workspace")
            : switchPhase === "success"
              ? tFor(
                  zh ? "zh-CN" : "en-US",
                  "workspaces.switched.to.dependent.pages.were.refreshed",
                  { p1: zh ? runtime.context.client : runtime.context.client },
                )
              : switchPhase === "error"
                ? translate("workspaces.switch.failed.the.previous.workspace")
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
                          label: tFor(
                            zh ? "zh-CN" : "en-US",
                            "workspaces.switch.to.workspace",
                            { p1: zh ? item.name : item.name },
                          ),
                          ...action(
                            () => switchToSelected(item.name),
                            !ready ||
                              switching ||
                              item.name === runtime.context.client
                              ? translate("workspaces.switch.unavailable")
                              : undefined,
                          ),
                        },
                        "新建工作区…": {
                          label: translate("workspaces.new.workspace"),
                          ...action(
                            () => setCreateOpen(true),
                            !ready
                              ? translate("workspaces.connection.unavailable")
                              : undefined,
                          ),
                        },
                        "重命名工作区…": {
                          label: tFor(
                            zh ? "zh-CN" : "en-US",
                            "workspaces.rename.workspace",
                            { p1: zh ? item.name : item.name },
                          ),
                          ...action(
                            () =>
                              setMutation({
                                action: "rename",
                                workspace: item.name,
                                expectedGeneration: runtime.contextGeneration,
                              }),
                            !ready || item.name === runtime.context.client
                              ? translate(
                                  "workspaces.switch.to.another.workspace.first",
                                )
                              : undefined,
                          ),
                        },
                        "删除工作区…": {
                          label: tFor(
                            zh ? "zh-CN" : "en-US",
                            "workspaces.delete.workspace",
                            { p1: zh ? item.name : item.name },
                          ),
                          ...action(
                            () =>
                              setMutation({
                                action: "delete",
                                workspace: item.name,
                                expectedGeneration: runtime.contextGeneration,
                              }),
                            !ready || item.name === runtime.context.client
                              ? translate(
                                  "workspaces.switch.to.another.workspace.first",
                                )
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
                      {item.host || translate("workspaces.any.host")}
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
                  ? translate("workspaces.loading.workspaces")
                  : error
                    ? translate("workspaces.loading.failed.refresh.to.retry")
                    : search
                      ? translate("workspaces.no.matching.workspaces")
                      : translate("workspaces.no.workspaces.owned.by.the")}
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
