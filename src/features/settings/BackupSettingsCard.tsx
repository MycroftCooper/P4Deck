import { Archive, FolderOpen, History, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { backend } from "../../infrastructure/backend";
import type { ConfigBackupOverview } from "../../shared/contracts/types";
import {
  applyBackupLocalStorage,
  collectBackupLocalStorage,
} from "./backupState";

interface Props {
  zh: boolean;
  native: boolean;
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

export function BackupSettingsCard({ zh, native }: Props) {
  const [overview, setOverview] = useState<ConfigBackupOverview>();
  const [busy, setBusy] = useState<"create" | "restore" | "open" | "load">();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
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
          {tr("本地配置备份", "Local configuration backup")}
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

  const createBackup = async () => {
    setBusy("create");
    setMessage("");
    setError("");
    try {
      const result = await backend.createConfigBackup({
        localStorage: collectBackupLocalStorage(),
      });
      const omitted = result.omittedLocalStorageKeys.length
        ? tr(
            `；已排除 ${result.omittedLocalStorageKeys.length} 个临时/敏感键`,
            `; ${result.omittedLocalStorageKeys.length} transient or sensitive keys omitted`,
          )
        : "";
      setMessage(
        tr(
          `已创建 ${result.backup.fileName}${omitted}`,
          `Created ${result.backup.fileName}${omitted}`,
        ),
      );
      setOverview(await backend.listConfigBackups());
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const restoreBackup = async (fileName: string) => {
    setBusy("restore");
    setMessage("");
    setError("");
    try {
      const result = await backend.restoreConfigBackup({
        fileName,
        localStorage: collectBackupLocalStorage(),
      });
      const layoutApplied = applyBackupLocalStorage(result.localStorage);
      setMessage(
        layoutApplied
          ? tr(
              `已暂存 ${result.sourceFileName} 的恢复；布局已写入，请完全退出并重新打开 P4Deck，以显示恢复后的布局并加载连接配置。回滚包：${result.rollbackFileName}`,
              `Restore of ${result.sourceFileName} is staged; layout has been written. Fully quit and reopen P4Deck to show the restored layout and load connection settings. Rollback: ${result.rollbackFileName}`,
            )
          : tr(
              `已暂存 ${result.sourceFileName} 的连接与窗口配置恢复，但当前 WebView 无法写入布局。请先保留回滚包 ${result.rollbackFileName}，再完全退出并重新打开 P4Deck；若布局仍未恢复，请使用回滚包。`,
              `Connection and window restore for ${result.sourceFileName} is staged, but this WebView could not write layout state. Keep rollback ${result.rollbackFileName}, fully quit and reopen P4Deck, and use the rollback if layout is still not restored.`,
            ),
      );
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
        {tr("本地配置备份", "Local configuration backup")}
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
            ? tr("正在备份…", "Creating…")
            : tr("创建本地备份", "Create local backup")}
        </button>
        <button
          className="secondary"
          onClick={() => void openFolder()}
          disabled={Boolean(busy)}
        >
          <FolderOpen size={15} />
          {tr("打开备份文件夹", "Open backup folder")}
        </button>
        <button
          className="secondary"
          onClick={() => void refresh()}
          disabled={Boolean(busy)}
        >
          {tr("刷新", "Refresh")}
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
              ? tr("恢复失败：", "Restore failed: ")
              : lastRestore.state === "succeeded"
                ? tr("最近恢复成功：", "Last restore succeeded: ")
                : tr("恢复等待重启：", "Restore waiting for restart: ")}
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

      <div className="backup-list" aria-label={tr("本地备份", "Local backups")}>
        {!overview?.backups.length ? (
          <p className="backup-empty">
            {busy === "load"
              ? tr("正在读取备份…", "Loading backups…")
              : tr("还没有本地备份。", "No local backups yet.")}
          </p>
        ) : (
          overview.backups.map((backup) => (
            <article className="backup-row" key={backup.fileName}>
              <div>
                <strong>{backup.fileName}</strong>
                <span>
                  {backup.kind === "preRestore"
                    ? tr("恢复前回滚包", "Pre-restore rollback")
                    : tr("手动备份", "Manual backup")}
                  {" · "}
                  {time(backup.createdAt, zh)} · {size(backup.sizeBytes)}
                </span>
                <small>
                  {backup.includesConnection
                    ? tr("连接配置", "Connection profiles")
                    : tr("无连接文件", "No connection file")}
                  {" · "}
                  {backup.includesWindowPlacement
                    ? tr("窗口位置", "Window placement")
                    : tr("无窗口文件", "No placement file")}
                  {" · "}
                  {backup.localStorageKeys.length}{" "}
                  {tr("个布局键", "layout keys")}
                </small>
              </div>
              <button
                className="secondary"
                disabled={Boolean(busy) || Boolean(pending)}
                onClick={() => void restoreBackup(backup.fileName)}
              >
                <RotateCcw size={14} />
                {tr("恢复", "Restore")}
              </button>
            </article>
          ))
        )}
      </div>
      <small className="backup-directory">
        {tr("备份目录：", "Backup directory: ")}
        <code>{overview?.directory ?? "—"}</code>
      </small>
    </section>
  );
}
