import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { backend } from "../../../infrastructure/backend";
import type {
  PendingChange,
  RuntimeInfo,
  SubmittedChangeDetail,
} from "../../../shared/contracts/types";
import { RevisionFileList } from "./RevisionFileList";
export type ChangeDetailsTarget =
  | {
      kind: "submitted";
      changeId: number;
      onLoaded?(value: SubmittedChangeDetail): void;
    }
  | { kind: "pending"; changeId: number; snapshot?: PendingChange };
export type OpenChangeDetails = (
  target: ChangeDetailsTarget,
  source?: HTMLElement | null,
) => void;
export const ChangeDetailsContext = createContext<OpenChangeDetails | null>(
  null,
);
export const useChangeDetails = () => useContext(ChangeDetailsContext);
export function useChangeDetailsDialog(
  runtime: RuntimeInfo,
  connectionKey: string,
  zh: boolean,
) {
  const [request, setRequest] = useState<{
    target: ChangeDetailsTarget;
    source: HTMLElement | null;
    owner: string;
    nonce: number;
  }>();
  const nonce = useRef(0);
  const owner = `${connectionKey}:${runtime.activeProfileId}:${runtime.contextGeneration}`;
  const open = useCallback<OpenChangeDetails>(
    (target, source) => {
      if (
        !Number.isSafeInteger(target.changeId) ||
        target.changeId < (target.kind === "pending" ? 0 : 1)
      )
        return;
      const fallback =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const nextNonce = ++nonce.current;
      setRequest((previous) => ({
        target,
        source:
          source ?? (previous?.owner === owner ? previous.source : fallback),
        owner,
        nonce: nextNonce,
      }));
    },
    [owner],
  );
  useEffect(() => setRequest(undefined), [owner]);
  return {
    open,
    dialog:
      request?.owner === owner ? (
        <ChangeDetailsDialog
          key={`${owner}:${request.nonce}`}
          target={request.target}
          source={request.source}
          runtime={runtime}
          zh={zh}
          onClose={() => setRequest(undefined)}
        />
      ) : null,
  };
}
function ChangeDetailsDialog({
  target,
  source,
  runtime,
  zh,
  onClose,
}: {
  target: ChangeDetailsTarget;
  source: HTMLElement | null;
  runtime: RuntimeInfo;
  zh: boolean;
  onClose(): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [value, setValue] = useState<SubmittedChangeDetail>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    const operationId = crypto.randomUUID();
    setValue(undefined);
    setError("");
    const load = async () => {
      if (target.kind === "pending" && target.snapshot)
        return pendingDetail(target.snapshot);
      if (runtime.mode !== "mock" && runtime.connection.state !== "connected")
        throw new Error(tr("连接不可用", "Connection unavailable"));
      if (target.kind === "submitted")
        return backend.getSubmittedChangeDetail({
          changeId: target.changeId,
          operationId,
        });
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
        const page = await backend.queryPendingChanges({
          operationId,
          requestGeneration: retry,
          keyword: "",
          sort: "newest",
          pageSize: 100,
          cursor,
        });
        if (!live) throw new Error("Cancelled");
        const found = [
          ...(page.defaultChange ? [page.defaultChange] : []),
          ...page.items,
        ].find((c) => c.id === target.changeId);
        if (found) return pendingDetail(found);
        if (!page.hasMore || !page.nextCursor || seen.has(page.nextCursor))
          break;
        cursor = page.nextCursor;
        seen.add(cursor);
      }
      throw new Error(
        tr(
          "未找到此待提交 CL，或结果不完整。",
          "Pending changelist not found, or results are incomplete.",
        ),
      );
    };
    void load()
      .then((detail) => {
        if (!live) return;
        if (detail.changeId !== target.changeId)
          throw new Error(
            tr(
              "返回的 CL 与目标不符",
              "Returned changelist does not match the target",
            ),
          );
        if (detail.inspectionStatus === "unavailable")
          throw new Error(
            detail.message || tr("详情不可用", "Details unavailable"),
          );
        setValue(detail);
        if (target.kind === "submitted") target.onLoaded?.(detail);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
      void backend.cancelOperation(operationId).catch(() => undefined);
    };
  }, [target, runtime, retry]);
  const time =
    value?.time && Number.isFinite(Date.parse(value.time))
      ? new Intl.DateTimeFormat(zh ? "zh-CN" : "en", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value.time))
      : "—";
  return (
    <Dialog
      title={`${tr("CL 详情", "Changelist details")} · ${target.changeId || "default"}`}
      source={source}
      zh={zh}
      onRequestClose={onClose}
      footer={
        <button data-dialog-autofocus onClick={onClose}>
          {tr("关闭", "Close")}
        </button>
      }
    >
      <div className="change-details-dialog">
        {runtime.mode === "mock" && (
          <DialogNotice>
            {tr(
              "模拟数据 · 未访问真实 P4 Server 或网络",
              "Simulated data · no real P4 server or network",
            )}
          </DialogNotice>
        )}
        {!value && !error && (
          <DialogNotice>{tr("正在加载…", "Loading…")}</DialogNotice>
        )}
        {error && (
          <>
            <DialogNotice error>{error}</DialogNotice>
            <button onClick={() => setRetry((v) => v + 1)}>
              {tr("重试", "Retry")}
            </button>
          </>
        )}
        {target.kind === "pending" && target.snapshot && (
          <DialogNotice>
            {tr("当前列表快照", "Current list snapshot")}
          </DialogNotice>
        )}
        {value && (
          <>
            <dl className="change-details-meta">
              <div>
                <dt>CL</dt>
                <dd>{value.changeId || "default"}</dd>
              </div>
              <div>
                <dt>{tr("提交人", "User")}</dt>
                <dd>{value.user || "—"}</dd>
              </div>
              <div>
                <dt>{tr("时间", "Time")}</dt>
                <dd>{time}</dd>
              </div>
              <div>
                <dt>{tr("工作区", "Workspace")}</dt>
                <dd>{value.client || "—"}</dd>
              </div>
              <div>
                <dt>{tr("状态", "Status")}</dt>
                <dd>
                  {target.kind === "submitted"
                    ? tr("已提交", "Submitted")
                    : tr("待提交", "Pending")}
                </dd>
              </div>
            </dl>
            <h3>{tr("描述", "Description")}</h3>
            <p className="change-details-description">
              {value.description || tr("无描述", "No description")}
            </p>
            {value.inspectionStatus === "partial" && (
              <DialogNotice>
                {value.message ||
                  tr("文件列表可能不完整", "File list may be incomplete")}
              </DialogNotice>
            )}
            <h3>
              {tr("文件", "Files")} · {value.files.length}
            </h3>
            {value.files.length ? (
              <RevisionFileList
                showFileType
                files={value.files.map((f) => ({
                  ...f,
                  changeId: value.changeId,
                }))}
                scope={`${runtime.contextGeneration}:${target.kind}:${target.changeId}`}
                demo={runtime.mode === "mock"}
              />
            ) : (
              <p>{tr("无文件", "No files")}</p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
function pendingDetail(change: PendingChange): SubmittedChangeDetail {
  return {
    changeId: change.id,
    description: change.description,
    user: change.user,
    client: change.client,
    time: change.updatedAt || "",
    jobs: change.jobs,
    files: change.files,
    integrationEvidence: [],
    mergeClassification: "unknown",
    inspectionStatus: "complete",
  };
}
