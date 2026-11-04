import { t } from "../../shared/i18n";
import { Archive, FolderOpen, History, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { backend } from "../../infrastructure/backend";
import type {
  ConfigBackupCreateResult,
  ConfigBackupOverview,
  ConfigBackupRestoreResult,
  ControlPlaneActionResult,
} from "../../shared/contracts";
import type { ConnectionSnapshot } from "../companySubmit/model";
import {
  lookupControlPlaneAction,
  type ControlPlaneActionLookup,
} from "../actions/workflowReceipt";
import {
  controlPlaneCommitted,
  controlPlaneDetails,
  controlPlaneLegacy,
  controlPlaneRestorePending,
  runControlPlaneAction,
} from "./controlPlaneLifecycle";
import {
  applyBackupLocalStorage,
  collectBackupLocalStorage,
} from "./backupState";

interface Props {
  zh: boolean;
  native: boolean;
  /** Exact dispatching connection snapshot; captured once per operation. */
  connection?(): Promise<ConnectionSnapshot>;
  /** Durable receipt recovery by the SAME operationId. */
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<ControlPlaneActionLookup>;
}

function size(value: number) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function time(value: string, zh: boolean) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : parsed.toLocaleString(zh ? "zh-CN" : "en-US");
}

/**
 * S4j2: backup create/restore are local-file control-plane writes. Only
 * intent/progress is shown before the authoritative readback; restore is only
 * ever presented as pending (staged, applies on next start), never completed.
 */
export function BackupSettingsCard({
  zh,
  native,
  connection: connectionProvider,
  lookup: lookupReceipt,
}: Props) {
  const [overview, setOverview] = useState<ConfigBackupOverview>();
  const [busy, setBusy] = useState<"create" | "restore" | "open" | "load">();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmRestore, setConfirmRestore] = useState<string>();
  const tr = (a: string, b: string) => (zh ? a : b);

  const refresh = useCallback(async () => {
    if (!native) return;
    setBusy("load");
    setError("");
    try {
      setOverview(await backend.listConfigBackups());
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(undefined);
    }
  }, [native]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!native) {
    return (
      <section className="settings-card backup-settings-card">
        <h2>
          <Archive size={18} />
          {t("settings.local.configuration.backup")}
        </h2>
        <p>
          {tr(
            "配置备份只在 P4Deck 桌面版中可用。",
            "Configuration backup is available in the P4Deck desktop app.",
          )}
        </p>
      </section>
    );
  }

  async function captureConnection(): Promise<ConnectionSnapshot> {
    return (
      connectionProvider ?? (() => backend.companySubmitConnectionSnapshot())
    )();
  }

  function describeCreate(result: ControlPlaneActionResult) {
    if (controlPlaneCommitted(result)) {
      const artifact = result.artifact;
      const legacyPayload = result.legacy as ConfigBackupCreateResult | null;
      const omittedCount = legacyPayload?.omittedLocalStorageKeys?.length ?? 0;
      const omitted = omittedCount
        ? tr(
            `；已排除 ${omittedCount} 个临时/敏感键`,
            `; ${omittedCount} transient or sensitive keys omitted`,
          )
        : "";
      return tr(
        `备份文件已回读验证：${artifact.fileName ?? "—"} · ${size(artifact.sizeBytes)}${artifact.sha256 ? ` · sha256 ${artifact.sha256.slice(0, 12)}…` : ""}${omitted}`,
        `Backup artifact verified by readback: ${artifact.fileName ?? "—"} · ${size(artifact.sizeBytes)}${artifact.sha256 ? ` · sha256 ${artifact.sha256.slice(0, 12)}…` : ""}${omitted}`,
      );
    }
    if (result.state === "legacy") {
      const legacy = controlPlaneLegacy<ConfigBackupCreateResult>(result);
      if (!legacy) return result.message;
      const omitted = legacy.omittedLocalStorageKeys.length
        ? tr(
            `；已排除 ${legacy.omittedLocalStorageKeys.length} 个临时/敏感键`,
            `; ${legacy.omittedLocalStorageKeys.length} transient or sensitive keys omitted`,
          )
        : "";
      return tr(
        `已创建 ${legacy.backup.fileName}${omitted}`,
        `Created ${legacy.backup.fileName}${omitted}`,
      );
    }
    return tr(
      "结果不确定：备份可能已写入但回读未确认。已用同一操作号查询持久回执并刷新列表；请先核对备份文件，不要换新操作号重试。",
      "Outcome uncertain: the backup may exist but the readback did not confirm it. The durable receipt was queried with the same operation id and the list was refreshed; inspect the backup file before any retry with a new id.",
    );
  }

  const createBackup = async () => {
    setBusy("create");
    setMessage("");
    setError("");
    const operationId = crypto.randomUUID();
    try {
      const dispatching = await captureConnection();
      const run = await runControlPlaneAction({
        kind: "backupCreate",
        operationId,
        connection: dispatching,
        execute: () =>
          backend.createConfigBackup({
            request: { localStorage: collectBackupLocalStorage() },
            operationId,
          }),
        lookup: lookupReceipt ?? lookupControlPlaneAction,
      });
      setMessage(describeCreate(run.result));
      // Single bounded refresh of the local list (readback is the authority).
      setOverview(await backend.listConfigBackups());
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const confirmRestoreRun = async (fileName: string) => {
    setBusy("restore");
    setMessage("");
    setError("");
    setConfirmRestore(undefined);
    const operationId = crypto.randomUUID();
    try {
      const dispatching = await captureConnection();
      const run = await runControlPlaneAction({
        kind: "backupRestore",
        operationId,
        connection: dispatching,
        execute: () =>
          backend.restoreConfigBackup({
            request: { fileName, localStorage: collectBackupLocalStorage() },
            operationId,
          }),
        lookup: lookupReceipt ?? lookupControlPlaneAction,
      });
      const result = run.result;
      if (controlPlaneRestorePending(result)) {
        const details = controlPlaneDetails<{
          sourceFileName?: string;
          rollbackFileName?: string;
          restartRequired?: boolean;
        }>(result);
        const legacyPayload = result.legacy as ConfigBackupRestoreResult | null;
        const layoutApplied = legacyPayload
          ? applyBackupLocalStorage(legacyPayload.localStorage)
          : false;
        setMessage(
          tr(
            `已暂存恢复（重启后应用，而非已完成）：${details?.sourceFileName ?? fileName}；回滚包 ${details?.rollbackFileName ?? "—"}。${layoutApplied ? "布局已写入，请完全退出并重新打开 P4Deck。" : "当前 WebView 无法写入布局；请保留回滚包，完全退出并重新打开后核对。"}`,
            `Restore staged (applies on next start, not completed): ${details?.sourceFileName ?? fileName}; rollback ${details?.rollbackFileName ?? "—"}. ${layoutApplied ? "Layout was written; fully quit and reopen P4Deck." : "This WebView could not write layout state; keep the rollback bundle, fully quit and reopen, then verify."}`,
          ),
        );
      } else if (result.state === "legacy") {
        const legacyPayload = result.legacy as ConfigBackupRestoreResult | null;
        const layoutApplied = legacyPayload
          ? applyBackupLocalStorage(legacyPayload.localStorage)
          : false;
        setMessage(
          legacyPayload
            ? tr(
                `已暂存 ${legacyPayload.sourceFileName} 的恢复；回滚包：${legacyPayload.rollbackFileName}。若布局未恢复请使用回滚包。`,
                `Restore of ${legacyPayload.sourceFileName} is staged; rollback: ${legacyPayload.rollbackFileName}. Use the rollback if layout is not restored.`,
              )
            : result.message,
        );
        if (!layoutApplied)
          setError(
            tr(
              "当前 WebView 无法写入布局；请保留回滚包并在重启后核对。",
              "This WebView could not write layout state; keep the rollback bundle and verify after restart.",
            ),
          );
      } else {
        setError(
          tr(
            "恢复暂存结果不确定：回滚包/pending 清单未得到回读确认。已用同一操作号查询持久回执；请先核对 pending/回滚状态，不要换新操作号重试。",
            "Restore staging is unconfirmed: the rollback bundle/pending manifest readback failed. The durable receipt was queried with the same operation id; inspect pending/rollback state before any retry with a new id.",
          ),
        );
      }
      setOverview(await backend.listConfigBackups());
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const openFolder = async () => {
    setBusy("open");
    setError("");
    try {
      await backend.openConfigBackupsFolder();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const pending = overview?.pendingRestore;
  const lastRestore = overview?.lastRestore;
  return (
    <section className="settings-card backup-settings-card">
      <h2>
        <Archive size={18} />
        {t("settings.local.configuration.backup")}
      </h2>
      <p>
        {tr(
          "备份连接 Profile、窗口位置和布局。ticket、trust、密码、日志、操作 Journal、终端历史和可重建缓存不会进入备份。",
          "Back up connection profiles, window placement, and layout. Tickets, trust, passwords, logs, operation journal, terminal history, and rebuildable caches are excluded.",
        )}
      </p>
      <div className="settings-actions backup-actions">
        <button
          onClick={() => void createBackup()}
          disabled={Boolean(busy) || Boolean(pending)}
        >
          <Archive size={15} />
          {busy === "create"
            ? t("settings.creating")
            : t("settings.create.local.backup")}
        </button>
        <button
          className="secondary"
          onClick={() => void openFolder()}
          disabled={Boolean(busy)}
        >
          <FolderOpen size={15} />
          {t("settings.open.backup.folder")}
        </button>
        <button
          className="secondary"
          onClick={() => void refresh()}
          disabled={Boolean(busy)}
        >
          {t("settings.refresh")}
        </button>
      </div>

      {pending && (
        <div className="settings-notice backup-pending" role="status">
          <History size={16} />
          <span>
            {tr(
              `待应用恢复：${pending.sourceFileName}。完全退出并重新打开 P4Deck 后生效；回滚包已生成。`,
              `Restore pending: ${pending.sourceFileName}. Fully quit and reopen P4Deck to apply it; a rollback backup already exists.`,
            )}
          </span>
        </div>
      )}
      {lastRestore && (
        <div
          className={`settings-notice backup-status ${lastRestore.state}`}
          role={lastRestore.state === "failed" ? "alert" : "status"}
        >
          <span>
            {lastRestore.state === "failed"
              ? t("settings.restore.failed")
              : lastRestore.state === "succeeded"
                ? t("settings.last.restore.succeeded")
                : t("settings.restore.waiting.for.restart")}
            {lastRestore.sourceFileName}
            {lastRestore.message
              ? ` · ${lastRestore.message}`
              : lastRestore.completedAt
                ? ` · ${time(lastRestore.completedAt, zh)}`
                : ""}
            {lastRestore.rollbackFileName
              ? tr(
                  ` · 可回滚到 ${lastRestore.rollbackFileName}`,
                  ` · Roll back with ${lastRestore.rollbackFileName}`,
                )
              : ""}
          </span>
        </div>
      )}
      {busy === "restore" && (
        <div className="settings-notice" role="status">
          {tr(
            "正在暂存恢复（尚未完成，重启后才会应用）…",
            "Staging the restore (not completed; it applies on the next start)…",
          )}
        </div>
      )}
      {message && (
        <div className="settings-notice backup-success" role="status">
          {message}
        </div>
      )}
      {error && (
        <div className="settings-notice backup-error" role="alert">
          {error}
        </div>
      )}

      <div className="backup-list" aria-label={t("settings.local.backups")}>
        {!overview?.backups.length ? (
          <p className="backup-empty">
            {busy === "load"
              ? t("settings.loading.backups")
              : t("settings.no.local.backups.yet")}
          </p>
        ) : (
          overview.backups.map((backup) => (
            <article className="backup-row" key={backup.fileName}>
              <div>
                <strong>{backup.fileName}</strong>
                <span>
                  {backup.kind === "preRestore"
                    ? t("settings.pre.restore.rollback")
                    : t("settings.manual.backup")}
                  {" · "}
                  {time(backup.createdAt, zh)} · {size(backup.sizeBytes)}
                </span>
                <small>
                  {backup.includesConnection
                    ? t("settings.connection.profiles")
                    : t("settings.no.connection.file")}
                  {" · "}
                  {backup.includesWindowPlacement
                    ? t("settings.window.placement")
                    : t("settings.no.placement.file")}
                  {" · "}
                  {backup.localStorageKeys.length} {t("settings.layout.keys")}
                </small>
              </div>
              {confirmRestore === backup.fileName ? (
                <span className="backup-restore-confirm">
                  {tr(
                    "恢复会覆盖当前配置并在下次启动应用；将先自动生成回滚包。确认继续？",
                    "Restore overwrites the current configuration and applies on the next start; a rollback bundle is created first. Continue?",
                  )}{" "}
                  <button
                    className="danger"
                    disabled={Boolean(busy)}
                    onClick={() => void confirmRestoreRun(backup.fileName)}
                  >
                    {t("settings.confirm.staged.restore")}
                  </button>
                  <button
                    disabled={Boolean(busy)}
                    onClick={() => setConfirmRestore(undefined)}
                  >
                    {t("settings.cancel")}
                  </button>
                </span>
              ) : (
                <button
                  className="secondary"
                  disabled={Boolean(busy) || Boolean(pending)}
                  onClick={() => setConfirmRestore(backup.fileName)}
                >
                  <RotateCcw size={14} />
                  {t("settings.restore")}
                </button>
              )}
            </article>
          ))
        )}
      </div>
      <small className="backup-directory">
        {t("settings.backup.directory")}
        <code>{overview?.directory ?? "—"}</code>
      </small>
    </section>
  );
}
