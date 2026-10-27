import { useRef, useState } from "react";
import { FolderOpen, ScrollText, Trash2 } from "lucide-react";
import { backend } from "../../infrastructure/backend";
import { Dialog } from "../../app/dialogs/Dialog";

export function LogSettingsCard({
  zh,
  native,
}: {
  zh: boolean;
  native: boolean;
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
      if (action === "open") await backend.openLogsFolder();
      else {
        await backend.deleteAllLogs();
        setConfirm(false);
        setMessage(
          native
            ? tr(
                "已删除全部日志，后续日志将继续写入。",
                "All logs deleted. New logs will continue to be recorded.",
              )
            : tr("已清空模拟日志。", "Simulated logs cleared."),
        );
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
        {tr("日志", "Logs")}
      </h2>
      <p>
        {tr(
          "每次启动创建新日志文件，日志面板只显示本次运行的记录。历史日志保留在磁盘上，启动时不会读取。",
          "Each launch creates a new log file. The log panel shows only this session; previous files remain on disk and are never loaded at startup.",
        )}
      </p>
      <div className="settings-actions">
        <button
          className="secondary"
          disabled={!native || !!busy}
          onClick={() => void run("open")}
        >
          <FolderOpen size={16} />
          {tr("打开日志文件夹", "Open log folder")}
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
          {tr("删除全部日志", "Delete all logs")}
        </button>
      </div>
      {!native && (
        <p className="muted">
          {tr(
            "浏览器演示仅清理模拟日志；打开日志文件夹需使用桌面端。",
            "Browser demo clears simulated logs only. Opening the log folder requires the desktop app.",
          )}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && !confirm && <p role="alert">{error}</p>}
      {confirm && (
        <Dialog
          zh={zh}
          danger
          title={tr("删除全部日志？", "Delete all logs?")}
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
                {tr("取消", "Cancel")}
              </button>
              <button
                className="danger"
                disabled={!!busy}
                onClick={() => void run("delete")}
              >
                {busy === "delete"
                  ? tr("正在删除…", "Deleting…")
                  : tr("确认删除", "Confirm deletion")}
              </button>
            </>
          }
        >
          <p>
            {tr(
              "将删除当前及历史日志，包括旧版日志数据库。连接设置会保留，后续新日志将继续写入。",
              "Deletes current and historical logs, including the legacy log database. Connection settings are preserved, and new logs will continue to be recorded.",
            )}
          </p>
          {error && <p role="alert">{error}</p>}
        </Dialog>
      )}
    </section>
  );
}
