import { useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { TargetList } from "../../../app/dialogs/TargetList";
import type { PendingChange } from "../../../shared/contracts/types";

export interface MoveFilesRequest {
  from: number;
  origins?: Record<string, number>;
  paths: string[];
  source: HTMLElement | null;
}
export function MoveFilesDialog({
  request,
  changes,
  client,
  zh,
  onDismiss,
}: {
  request: MoveFilesRequest;
  changes: PendingChange[];
  client: string;
  zh: boolean;
  onDismiss(): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  // Freeze both the exact file subset and candidate snapshot when the workflow opens.
  const [snapshot] = useState(() => ({
    ...request,
    origins: request.origins ? { ...request.origins } : undefined,
    paths: [...new Set(request.paths)],
    changes: changes.map((change) => ({
      id: change.id,
      description: change.description,
    })),
  }));
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<number>();
  const [checked, setChecked] = useState(false);
  const originIds = [
    ...new Set(
      snapshot.paths.map((path) => snapshot.origins?.[path] ?? snapshot.from),
    ),
  ];
  const effectivePaths = snapshot.paths.filter(
    (path) =>
      target === undefined ||
      (snapshot.origins?.[path] ?? snapshot.from) !== target,
  );
  const available = snapshot.changes.filter(
    (change) => originIds.length > 1 || change.id !== snapshot.from,
  );
  const matches = available.filter((change) =>
    `${change.id === 0 ? "default" : change.id} ${change.description}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  const name = (id: number) => (id === 0 ? "Default" : `CL ${id}`);
  const fromLabel =
    originIds.length > 1 ? originIds.map(name).join(", ") : name(snapshot.from);
  return (
    <Dialog
      title={tr("移动文件到 CL", "Move files to changelist")}
      description={tr(
        "仅移动下面列出的已打开文件，不提交文件，也不移动磁盘目录。",
        "Reassign only the opened files listed below. This does not submit files or move disk folders.",
      )}
      source={snapshot.source}
      zh={zh}
      onRequestClose={onDismiss}
      footer={
        <>
          <button onClick={onDismiss}>{tr("关闭", "Close")}</button>
          <button
            className="primary"
            disabled={target === undefined || !effectivePaths.length}
            onClick={() => setChecked(true)}
          >
            {tr("检查选择（不执行）", "Check selection (no execution)")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {client} · {tr("来源", "From")} {fromLabel} · {snapshot.paths.length}{" "}
        {tr("个文件", "files")}
      </div>
      <DialogNotice>
        {tr(
          "界面预览：候选来自当前页面快照；尚未验证归属、锁或连接状态，不会执行移动。",
          "UI preview: candidates are from this page snapshot. Ownership, locks and connection have not been verified. No files will be moved.",
        )}
      </DialogNotice>
      <TargetList
        paths={effectivePaths}
        label={tr("将移动的文件", "Files to move")}
      />
      {effectivePaths.length < snapshot.paths.length && (
        <DialogNotice>
          {tr(
            "已跳过本来就在目标 CL 的文件：",
            "Files already in the target CL are skipped: ",
          )}
          {snapshot.paths.length - effectivePaths.length}
        </DialogNotice>
      )}
      {!snapshot.paths.length && (
        <DialogNotice error>
          {tr("没有选择文件。", "No files selected.")}
        </DialogNotice>
      )}
      <label>
        {tr("筛选目标 CL", "Filter target changelists")}
        <input
          autoFocus
          data-dialog-autofocus
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={tr("编号或描述", "Number or description")}
        />
      </label>
      <label>
        {originIds.length > 1
          ? tr("目标 CL", "Target changelist")
          : tr(
              "目标 CL（不包含当前 CL）",
              "Target changelist (current CL excluded)",
            )}
        <select
          value={target ?? ""}
          onChange={(event) => {
            setTarget(
              event.target.value === ""
                ? undefined
                : Number(event.target.value),
            );
            setChecked(false);
          }}
        >
          <option value="">{tr("请选择目标 CL", "Choose a target")}</option>
          {target !== undefined &&
            !matches.some((change) => change.id === target) && (
              <option value={target}>
                {name(target)} ·{" "}
                {tr("已选择，被筛选隐藏", "Selected, filtered out")}
              </option>
            )}
          {matches.map((change) => (
            <option key={change.id} value={change.id}>
              {name(change.id)} · {change.description}
            </option>
          ))}
        </select>
      </label>
      {!available.length && (
        <DialogNotice>
          {tr(
            "当前快照没有其他目标 CL。可以先新建 CL，待写入流程接通后刷新重试。",
            "No other target changelists in this snapshot. Create a CL and refresh once writing is connected.",
          )}
        </DialogNotice>
      )}
      {!!available.length && !matches.length && (
        <DialogNotice>
          {tr("没有匹配项，请修改筛选条件。", "No matches. Change the filter.")}
        </DialogNotice>
      )}
      {target !== undefined && (
        <p className="workflow-context">
          {fromLabel} → {name(target)} · {effectivePaths.length}{" "}
          {tr("个文件", "files")}
        </p>
      )}
      {checked && (
        <DialogNotice>
          {tr(
            "选择已检查，尚未移动任何文件。执行前仍需重新验证目标与文件状态。",
            "Selection checked. No files were moved. Target and file state must be revalidated before execution.",
          )}
        </DialogNotice>
      )}
    </Dialog>
  );
}
