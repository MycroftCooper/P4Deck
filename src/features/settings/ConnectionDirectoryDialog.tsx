import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../app/dialogs/Dialog";
import { backend } from "../../infrastructure/backend";
import type {
  ConnectionUserCandidate,
  ConnectionUserDirectoryResult,
  ConnectionWorkspaceCandidate,
  ConnectionWorkspaceDirectoryResult,
  P4Context,
} from "../../shared/contracts/types";
import { connectionPresentation } from "./connectionWizard";

type DirectoryKind = "user" | "workspace";
type DirectoryResult =
  ConnectionUserDirectoryResult | ConnectionWorkspaceDirectoryResult;

export function ConnectionDirectoryDialog({
  kind,
  context,
  requestGeneration,
  fallbackUser,
  source,
  zh,
  onDismiss,
  onSelect,
}: {
  kind: DirectoryKind;
  context: P4Context;
  requestGeneration: number;
  fallbackUser: string;
  source: HTMLElement | null;
  zh: boolean;
  onDismiss(): void;
  onSelect(value: ConnectionUserCandidate | ConnectionWorkspaceCandidate): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const snapshot = useMemo(() => ({ ...context }), []);
  const [prefix, setPrefix] = useState("");
  const [queryUser, setQueryUser] = useState(
    snapshot.user.trim() || fallbackUser.trim(),
  );
  const [result, setResult] = useState<DirectoryResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const operation = useRef<string | undefined>(undefined);

  useEffect(
    () => () => {
      sequence.current += 1;
      if (operation.current)
        void Promise.resolve(backend.cancelOperation(operation.current)).catch(
          () => undefined,
        );
    },
    [],
  );

  const identity = kind === "user" ? queryUser.trim() : snapshot.user.trim();
  const canQuery = !!snapshot.server.trim() && !!identity;

  async function browse() {
    if (busy || !canQuery) return;
    const seq = ++sequence.current;
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    setBusy(true);
    setError("");
    setResult(undefined);
    const requestContext = {
      ...snapshot,
      user: identity,
      client: "",
    };
    try {
      const next =
        kind === "user"
          ? await backend.browseConnectionUsers({
              context: requestContext,
              requestGeneration,
              operationId,
              prefix: prefix.trim() || undefined,
            })
          : await backend.browseConnectionWorkspaces({
              context: requestContext,
              requestGeneration,
              operationId,
              prefix: prefix.trim() || undefined,
            });
      if (seq !== sequence.current) return;
      if (next.requestGeneration !== requestGeneration) {
        setError(
          tr(
            "查询对应的连接设置已变化，请关闭后重试。",
            "The connection settings for this query changed. Close and retry.",
          ),
        );
        return;
      }
      setResult(next);
    } catch (cause) {
      if (seq === sequence.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === sequence.current) {
        operation.current = undefined;
        setBusy(false);
      }
    }
  }

  const status = result
    ? connectionPresentation(result.connection, zh)
    : undefined;
  const connectionReady = result?.connection.state === "connected";
  const items = connectionReady ? (result?.items ?? []) : [];
  return (
    <Dialog
      title={
        kind === "user"
          ? tr("浏览服务器用户", "Browse server users")
          : tr("浏览服务器 Workspace", "Browse server workspaces")
      }
      description={tr(
        `只查询当前未保存设置中的服务器 ${snapshot.server || "—"}；选择结果只会填入字段，不会保存或切换连接。`,
        `Queries only the server in the current unsaved settings (${snapshot.server || "—"}). Selecting a result only fills the field; it does not save or switch connections.`,
      )}
      source={source}
      zh={zh}
      busy={false}
      onRequestClose={onDismiss}
      footer={
        <>
          <button type="button" className="secondary" onClick={onDismiss}>
            {tr("取消", "Cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canQuery || busy}
            onClick={() => void browse()}
          >
            {busy ? tr("查询中…", "Searching…") : tr("查询", "Search")}
          </button>
        </>
      }
    >
      {kind === "user" && (
        <label>
          {tr("查询身份", "Query identity")}
          <input
            data-dialog-autofocus
            value={queryUser}
            disabled={busy}
            spellCheck={false}
            onChange={(event) => {
              setQueryUser(event.target.value);
              setResult(undefined);
              setError("");
            }}
          />
          <small>
            {tr(
              "这是本次查询明确使用的 P4 用户；不会从活动连接或环境中静默回退。如需 Trust 或登录恢复，请关闭窗口并先把该用户名填入主卡 User 字段。",
              "This is the explicit P4 user for this query; there is no silent fallback to the active connection or environment. For Trust or login recovery, close this dialog and first enter this username in the main User field.",
            )}
          </small>
        </label>
      )}
      <label>
        {tr("按名称前缀搜索", "Name prefix")}
        <input
          data-dialog-autofocus={kind === "workspace" ? true : undefined}
          value={prefix}
          disabled={busy}
          spellCheck={false}
          onChange={(event) => {
            setPrefix(event.target.value);
            setResult(undefined);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void browse();
            }
          }}
        />
      </label>
      {!snapshot.server.trim() && (
        <DialogNotice error>
          {tr("请先填写 Server。", "Enter Server first.")}
        </DialogNotice>
      )}
      {!identity && (
        <DialogNotice error>
          {kind === "user"
            ? tr(
                "请明确填写本次查询使用的用户名。",
                "Enter the username to use for this query.",
              )
            : tr(
                "请先在连接设置中填写 User。",
                "Enter User in Connection settings first.",
              )}
        </DialogNotice>
      )}
      {error && <DialogNotice error>{error}</DialogNotice>}
      {result && (
        <>
          <DialogNotice error={!connectionReady}>
            {result.simulated && "Browser Mock simulated · "}
            {connectionReady
              ? `${tr("查询成功", "Query succeeded")} · ${result.stats.matchedCount} / ${result.stats.scannedCount}`
              : `${status?.title} · ${status?.detail} ${tr("请在设置主区完成对应的 CLI、Trust 或登录恢复后重试。", "Complete the corresponding CLI, Trust, or login recovery in the main Settings card, then retry.")} ${status?.recovery}`}
            {connectionReady && (result.partial || result.truncated)
              ? tr(
                  " · 有界结果，可能不完整",
                  " · bounded result; may be incomplete",
                )
              : ""}
          </DialogNotice>
          {connectionReady && (
            <div
              className="connection-directory-list"
              role="listbox"
              aria-label={
                kind === "user"
                  ? tr("服务器用户", "Server users")
                  : tr("服务器 Workspace", "Server workspaces")
              }
            >
              {items.map((item) => (
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  key={item.name}
                  disabled={
                    kind === "workspace" &&
                    "selectable" in item &&
                    !item.selectable
                  }
                  onClick={() => onSelect(item)}
                >
                  <strong>{item.name}</strong>
                  <span>
                    {kind === "user"
                      ? [
                          "fullName" in item ? item.fullName : undefined,
                          "email" in item ? item.email : undefined,
                        ]
                          .filter(Boolean)
                          .join(" · ") ||
                        tr("无附加信息", "No additional details")
                      : [
                          "root" in item ? item.root : undefined,
                          "stream" in item ? item.stream : undefined,
                          "rootStatus" in item && item.rootStatus !== "usable"
                            ? tr(
                                `Root 不可用：${item.rootStatus}`,
                                `Root unavailable: ${item.rootStatus}`,
                              )
                            : undefined,
                        ]
                          .filter(Boolean)
                          .join(" · ") ||
                        tr("无附加信息", "No additional details")}
                  </span>
                </button>
              ))}
              {!items.length && (
                <p role="status">
                  {tr(
                    "没有匹配结果。服务器只返回有界的名称前缀搜索结果。",
                    "No matches. The server returns bounded name-prefix results only.",
                  )}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
