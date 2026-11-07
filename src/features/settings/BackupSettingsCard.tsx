import { t, tFor } from "../../shared/i18n";
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
/**
 * Composition helpers for the backup status lines.
 *
 * These lines concatenate optional fragments (an omitted-key suffix, a sha256
 * tail, a layout outcome), so each fragment is its own message and the join
 * stays here rather than inside the catalog.
 */
const settings = {
  omittedKeys(count: number, zh: boolean): string {
    return tFor(zh ? "zh-CN" : "en-US", "settings.backup.omittedKeys", {
      count,
    });
  },
  backupVerified(
    v: { file: string; size: string; sha: string; omitted: string },
    zh: boolean,
  ): string {
    return tFor(zh ? "zh-CN" : "en-US", "settings.backup.verified", v);
  },
  backupCreated(v: { file: string; omitted: string }, zh: boolean): string {
    return tFor(zh ? "zh-CN" : "en-US", "settings.backup.created", v);
  },
  restoreStaged(
    v: { file: string; rollback: string; layout: string },
    zh: boolean,
  ): string {
    return tFor(zh ? "zh-CN" : "en-US", "settings.backup.restoreStaged", v);
  },
  legacyRestoreStaged(
    v: { file: string; rollback: string },
    zh: boolean,
  ): string {
    return tFor(
      zh ? "zh-CN" : "en-US",
      "settings.backup.legacyRestoreStaged",
      v,
    );
  },
  restorePending(v: { file: string }, zh: boolean): string {
    return tFor(zh ? "zh-CN" : "en-US", "settings.backup.restorePending", v);
  },
  rollbackAvailable(v: { file: string }, zh: boolean): string {
    return tFor(zh ? "zh-CN" : "en-US", "settings.backup.rollbackAvailable", v);
  },
};

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
        <p>{t("settings.configuration.is.available")}</p>
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
        ? settings.omittedKeys(omittedCount, zh)
        : "";
      return settings.backupVerified(
        {
          file: artifact.fileName ?? "—",
          size: size(artifact.sizeBytes),
          sha: artifact.sha256
            ? ` · sha256 ${artifact.sha256.slice(0, 12)}…`
            : "",
          omitted,
        },
        zh,
      );
    }
    if (result.state === "legacy") {
      const legacy = controlPlaneLegacy<ConfigBackupCreateResult>(result);
      if (!legacy) return result.message;
      const omitted = legacy.omittedLocalStorageKeys.length
        ? settings.omittedKeys(legacy.omittedLocalStorageKeys.length, zh)
        : "";
      return settings.backupCreated(
        { file: legacy.backup.fileName, omitted },
        zh,
      );
    }
    return t("settings.outcome.uncertain.the.backup.may.exist");
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
          settings.restoreStaged(
            {
              file: details?.sourceFileName ?? fileName,
              rollback: details?.rollbackFileName ?? "—",
              layout: layoutApplied
                ? tFor(zh ? "zh-CN" : "en-US", "settings.backup.layoutWritten")
                : tFor(
                    zh ? "zh-CN" : "en-US",
                    "settings.backup.layoutNotWritten",
                  ),
            },
            zh,
          ),
        );
      } else if (result.state === "legacy") {
        const legacyPayload = result.legacy as ConfigBackupRestoreResult | null;
        const layoutApplied = legacyPayload
          ? applyBackupLocalStorage(legacyPayload.localStorage)
          : false;
        setMessage(
          legacyPayload
            ? settings.legacyRestoreStaged(
                {
                  file: legacyPayload.sourceFileName,
                  rollback: legacyPayload.rollbackFileName,
                },
                zh,
              )
            : result.message,
        );
        if (!layoutApplied)
          setError(t("settings.this.webview.could.not.write.layout"));
      } else {
        setError(t("settings.restore.staging.is.unconfirmed.the.rollback"));
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
      <p>{t("settings.back.up.connection.profiles.window.placement")}</p>
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
            {settings.restorePending({ file: pending.sourceFileName }, zh)}
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
              ? settings.rollbackAvailable(
                  { file: lastRestore.rollbackFileName },
                  zh,
                )
              : ""}
          </span>
        </div>
      )}
      {busy === "restore" && (
        <div className="settings-notice" role="status">
          {t("settings.staging.the.restore.not.completed.it")}
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
                  {t("settings.restore.current.configuration")}{" "}
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
