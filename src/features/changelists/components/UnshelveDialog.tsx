import { useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { TargetList } from "../../../app/dialogs/TargetList";
import {
  PreflightStatus,
  type PreflightState,
} from "../../../app/dialogs/PreflightStatus";
import type { PendingChange } from "../../../shared/contracts/types";
import type { ShelfRequest } from "./ShelfDialog";

export function UnshelveDialog({
  request,
  changes,
  zh,
  onDismiss,
}: {
  request: ShelfRequest;
  changes: PendingChange[];
  zh: boolean;
  onDismiss(): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() => ({
    ...request,
    paths: [...new Set(request.paths)],
    changes: changes.map((change) => ({
      id: change.id,
      description: change.description,
    })),
  }));
  const [target, setTarget] = useState<number>();
  const [filter, setFilter] = useState("");
  const [checked, setChecked] = useState(false);
  const matches = snapshot.changes.filter((change) =>
    `${change.id === 0 ? "default" : change.id} ${change.description}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  const name = (id: number) => (id === 0 ? "Default" : `CL ${id}`);
  const preflight: PreflightState = snapshot.paths.length
    ? { kind: "unavailable" }
    : { kind: "empty" };
  return (
    <Dialog
      title={tr("Unshelve 到工作区", "Unshelve to workspace")}
      description={tr(
        "将来源搁置内容应用到目标 CL；来源搁置仍保留。此预览不会修改文件。",
        "Apply source shelved content to a target CL, keeping the source shelf. This preview does not modify files.",
      )}
      zh={zh}
      source={snapshot.source}
      onRequestClose={onDismiss}
      footer={
        <>
          <button onClick={onDismiss}>{tr("关闭", "Close")}</button>
          <button
            disabled={target === undefined || !snapshot.paths.length}
            onClick={() => setChecked(true)}
          >
            {tr("检查选择（不执行）", "Check selection (no execution)")}
          </button>
          <button
            className="primary"
            disabled
            title={tr(
              "需要有效的后端预检结果",
              "Requires a valid backend preflight result",
            )}
          >
            {tr("确认 Unshelve", "Confirm unshelve")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {tr("来源搁置", "Source shelf")} CL {snapshot.changeId} ·{" "}
        {snapshot.paths.length} {tr("个文件", "files")}
      </div>
      <TargetList
        paths={snapshot.paths.map((path) => `${path}@=${snapshot.changeId}`)}
        label={tr("固定来源文件", "Fixed source files")}
      />
      <label>
        {tr("筛选目标 CL", "Filter target CL")}
        <input
          data-dialog-autofocus
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      <label>
        {tr("目标 CL", "Target CL")}
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
          <option value="">{tr("请选择目标 CL", "Choose a target CL")}</option>
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
      {!matches.length && (
        <DialogNotice>
          {snapshot.changes.length
            ? tr(
                "没有匹配的 CL，请修改筛选条件。",
                "No matching CL. Change the filter.",
              )
            : tr(
                "没有可用的目标 CL，请刷新列表。",
                "No target changelists available. Refresh the list.",
              )}
        </DialogNotice>
      )}
      {target !== undefined && (
        <div className="workflow-context">
          CL {snapshot.changeId} → {name(target)}
        </div>
      )}
      <DialogNotice>
        {tr(
          "尚未验证工作区映射、文件锁、已有本地修改及冲突。可能需要 Resolve；不会默认强制覆盖。",
          "Workspace mapping, locks, local modifications and conflicts have not been checked. Resolve may be required; force overwrite is not enabled by default.",
        )}
      </DialogNotice>
      <PreflightStatus state={preflight} zh={zh} />
      {checked && (
        <DialogNotice>
          {tr(
            "已检查来源与目标选择，尚未通过服务器预检，未执行 Unshelve。",
            "Source and target selection checked. Server preflight has not passed and unshelve was not executed.",
          )}
        </DialogNotice>
      )}
    </Dialog>
  );
}
