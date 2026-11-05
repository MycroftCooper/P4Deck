import { tFor, t } from "../../shared/i18n";
import { useRef, useState } from "react";
import { FolderOpen, ScrollText, Trash2 } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import { Dialog } from "../../app/dialogs/Dialog";
import type { ConnectionSnapshot } from "../companySubmit/model";
import {
  lookupControlPlaneAction,
  type ControlPlaneActionLookup,
} from "../actions/workflowReceipt";
import {
  controlPlaneCommitted,
  controlPlaneDetails,
  runControlPlaneAction,
} from "./controlPlaneLifecycle";

export function LogSettingsCard({
  zh,
  native,
  connection: connectionProvider,
  lookup: lookupReceipt,
}: {
  zh: boolean;
  native: boolean;
  /** Exact dispatching connection snapshot; captured once per clear. */
  connection?(): Promise<ConnectionSnapshot>;
  /** Durable receipt recovery by the SAME operationId. */
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<ControlPlaneActionLookup>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<"open" | "delete">();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const source = useRef<HTMLButtonElement>(null);
  async function run(action: "open" | "delete") {
    if (busy) return;
    setBusy(action);
    setError("");
    setMessage("");
    try {
      if (action === "open") {
        await backend.openLogsFolder();
      } else {
        const operationId = crypto.randomUUID();
        const dispatching = await (
          connectionProvider ??
          (() => backend.companySubmitConnectionSnapshot())
        )();
        const runResult = await runControlPlaneAction({
          kind: "logClear",
          operationId,
          connection: dispatching,
          execute: () => backend.deleteAllLogs({ operationId }),
          lookup: lookupReceipt ?? lookupControlPlaneAction,
        });
        setConfirm(false);
        if (controlPlaneCommitted(runResult.result)) {
          const remaining =
            controlPlaneDetails<{ remainingEntries?: number }>(runResult.result)
              ?.remainingEntries ?? 0;
          setMessage(
            native
              ? tr(
                  `日志已清空（回读确认剩余 ${remaining} 条）；后续日志将继续写入。`,
                  `Logs cleared (readback confirms ${remaining} remaining); new logs will continue to be recorded.`,
                )
              : tFor(zh ? "zh-CN" : "en-US", "settings.simulated.logs.cleared"),
          );
        } else {
          setError(t("settings.clear.outcome.uncertain.the.readback.still"));
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <section className="settings-card log-settings-card">
      <h2>
        <ScrollText size={18} />
        {tFor(zh ? "zh-CN" : "en-US", "settings.logs")}
      </h2>
      <p>{t("settings.each.launch.creates.a.new.log")}</p>
      <div className="settings-actions">
        <button
          className="secondary"
          disabled={!native || !!busy}
          onClick={() => void run("open")}
        >
          <FolderOpen size={16} />
          {tFor(zh ? "zh-CN" : "en-US", "settings.open.log.folder")}
        </button>
        <button
          className="danger"
          ref={source}
          disabled={!!busy}
          onClick={() => {
            setError("");
            setMessage("");
            setConfirm(true);
          }}
        >
          <Trash2 size={16} />
          {tFor(zh ? "zh-CN" : "en-US", "settings.delete.all.logs")}
        </button>
      </div>
      {!native && (
        <p className="muted">
          {t("settings.browser.demo.clears.simulated.logs.only")}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && !confirm && <p role="alert">{error}</p>}
      {confirm && (
        <Dialog
          zh={zh}
          danger
          title={tFor(zh ? "zh-CN" : "en-US", "settings.delete.all.logs.2")}
          source={source.current}
          busy={!!busy}
          onRequestClose={() => {
            if (!busy) setConfirm(false);
          }}
          footer={
            <>
              <button
                className="secondary"
                data-dialog-autofocus
                disabled={!!busy}
                onClick={() => setConfirm(false)}
              >
                {tFor(zh ? "zh-CN" : "en-US", "settings.cancel")}
              </button>
              <button
                className="danger"
                disabled={!!busy}
                onClick={() => void run("delete")}
              >
                {busy === "delete"
                  ? tFor(zh ? "zh-CN" : "en-US", "settings.deleting")
                  : tFor(zh ? "zh-CN" : "en-US", "settings.confirm.deletion")}
              </button>
            </>
          }
        >
          <p>{t("settings.deletes.current.and.historical.logs.including")}</p>
          {error && <p role="alert">{error}</p>}
        </Dialog>
      )}
    </section>
  );
}
