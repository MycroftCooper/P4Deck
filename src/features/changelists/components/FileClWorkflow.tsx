import { useEffect, useState } from "react";
import type {
  PendingChange,
  WorkspaceNode,
} from "../../../shared/contracts/types";
import { backend } from "../../../infrastructure/backend";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { TargetList } from "../../../app/dialogs/TargetList";
import { MoveFilesDialog } from "./MoveFilesDialog";
import { ShelfDialog } from "./ShelfDialog";
import { fileClScope } from "../fileClScope";
import { workspaceCache } from "../../files/workspaceQueries";

/** Read once on explicit opening; no per-row queries and no write adapter. */
export function FileClWorkflow({
  nodes,
  mode,
  source,
  client,
  connectionKey,
  zh,
  onDismiss,
}: {
  nodes: WorkspaceNode[];
  mode: "moveFiles" | "shelve";
  source: HTMLElement | null;
  client: string;
  connectionKey: string;
  zh: boolean;
  onDismiss(): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() => nodes.map((node) => ({ ...node })));
  const [changes, setChanges] = useState<PendingChange[]>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [group, setGroup] = useState<number>();
  useEffect(() => {
    let live = true;
    setChanges(undefined);
    setError("");
    void backend
      .queryPendingChanges()
      .then((value) => {
        if (live) setChanges(value);
      })
      .catch((cause) => {
        if (live) setError(String(cause));
      });
    return () => {
      live = false;
    };
  }, [retry]);
  const scope = changes ? fileClScope(snapshot, changes) : undefined;
  if (changes && scope && scope.paths.length && !scope.unknown.length) {
    if (mode === "moveFiles")
      return (
        <MoveFilesDialog
          request={{
            from: scope.ids[0],
            origins: scope.origins,
            paths: scope.paths,
            source,
          }}
          changes={changes}
          client={client}
          connectionKey={connectionKey}
          zh={zh}
          onDismiss={onDismiss}
          onMove={async (targetChangeId, depotPaths) => {
            try {
              const result = await backend.mutatePendingChange({
                type: "moveFiles",
                targetChangeId,
                depotPaths,
                operationId: crypto.randomUUID(),
              });
              if (result.refreshError) {
                window.dispatchEvent(new Event("p4deck:pending-refresh"));
                throw new Error(
                  `${zh ? "移动可能已成功，但刷新失败；请关闭并刷新后确认，不要直接重试。" : "The move may have succeeded, but refresh failed. Close and refresh before retrying."} ${result.refreshError}`,
                );
              }
              window.dispatchEvent(
                new CustomEvent("p4deck:pending-mutation", { detail: result }),
              );
            } catch (cause) {
              window.dispatchEvent(new Event("p4deck:pending-refresh"));
              throw cause;
            } finally {
              await Promise.all([
                workspaceCache.invalidateQueries({
                  queryKey: ["workspace-files", connectionKey],
                }),
                workspaceCache.invalidateQueries({
                  queryKey: ["depot-files", connectionKey],
                }),
              ]);
            }
          }}
        />
      );
    const id = scope.ids.length === 1 ? scope.ids[0] : group;
    if (id !== undefined) {
      const change = changes.find((change) => change.id === id)!;
      return (
        <ShelfDialog
          request={{
            changeId: id,
            paths: scope.paths.filter((path) => scope.origins[path] === id),
            source,
            hasShelf: !!change.shelvedFiles.length,
            mode: "shelve",
          }}
          zh={zh}
          onDismiss={onDismiss}
          onBack={scope.ids.length > 1 ? () => setGroup(undefined) : undefined}
        />
      );
    }
  }
  return (
    <Dialog
      title={
        mode === "moveFiles"
          ? tr("移动文件到 CL", "Move files to changelist")
          : tr("搁置文件", "Shelve files")
      }
      zh={zh}
      source={source}
      onRequestClose={onDismiss}
      footer={
        <>
          <button onClick={onDismiss}>{tr("关闭", "Close")}</button>
          {error && (
            <button onClick={() => setRetry((value) => value + 1)}>
              {tr("重试", "Retry")}
            </button>
          )}
        </>
      }
    >
      {!changes && !error && (
        <DialogNotice>
          {tr(
            "正在读取已打开文件的 CL 归属…",
            "Loading CL membership for opened files…",
          )}
        </DialogNotice>
      )}
      {error && <DialogNotice error>{error}</DialogNotice>}
      {scope?.unknown.length ? (
        <>
          <DialogNotice error>
            {tr(
              "以下文件的唯一 CL 归属尚未确认。请刷新状态；不会忽略这些文件后操作其余文件。",
              "Unique CL membership is unknown for these files. Refresh their state; they will not be silently omitted from the operation.",
            )}
          </DialogNotice>
          <TargetList
            paths={scope.unknown}
            label={tr("归属未知的文件", "Files with unknown membership")}
          />
        </>
      ) : null}
      {scope && !scope.paths.length && (
        <DialogNotice>
          {tr("没有选择文件。", "No files selected.")}
        </DialogNotice>
      )}
      {scope &&
        !scope.unknown.length &&
        mode === "shelve" &&
        scope.ids.length > 1 && (
          <>
            <DialogNotice>
              {tr(
                "所选文件分属多个 CL。请选择本次搁置的来源组；其他 CL 文件不在此次范围内。",
                "Selected files belong to multiple CLs. Choose the source group for this shelf operation; other groups are out of scope.",
              )}
            </DialogNotice>
            {scope.ids.map((id) => (
              <button key={id} onClick={() => setGroup(id)}>
                {id ? `CL ${id}` : "Default"} ·{" "}
                {
                  scope.paths.filter((path) => scope.origins[path] === id)
                    .length
                }{" "}
                {tr("个文件", "files")}
              </button>
            ))}
          </>
        )}
    </Dialog>
  );
}
