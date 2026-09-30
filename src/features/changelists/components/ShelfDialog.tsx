import { useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { TargetList } from "../../../app/dialogs/TargetList";

export interface ShelfRequest {
  changeId: number;
  paths: string[];
  mode: "shelve" | "delete";
  hasShelf: boolean;
  source: HTMLElement | null;
}
export function ShelfDialog({
  request,
  zh,
  onDismiss,
  onBack,
}: {
  request: ShelfRequest;
  zh: boolean;
  onDismiss(): void;
  onBack?(): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() => ({
    ...request,
    paths: [...new Set(request.paths)],
  }));
  const [replace, setReplace] = useState(false);
  const [ack, setAck] = useState(false);
  const [checked, setChecked] = useState(false);
  const deleting = snapshot.mode === "delete";
  const risky = deleting || replace;
  const valid =
    snapshot.changeId > 0 && snapshot.paths.length > 0 && (!risky || ack);
  return (
    <Dialog
      title={
        deleting
          ? tr("删除搁置内容", "Delete shelved files")
          : tr("搁置文件", "Shelve files")
      }
      description={tr(
        "范围固定为下方文件，不会自动扩大为整个 CL。",
        "The scope is exactly the files below, never implicitly the entire CL.",
      )}
      source={snapshot.source}
      zh={zh}
      danger={risky}
      onRequestClose={onDismiss}
      footer={
        <>
          {onBack && (
            <button onClick={onBack}>
              {tr("返回 CL 分组", "Back to CL groups")}
            </button>
          )}
          <button data-dialog-autofocus onClick={onDismiss}>
            {tr("关闭", "Close")}
          </button>
          <button
            className={risky ? "danger" : "primary"}
            disabled={!valid}
            onClick={() => setChecked(true)}
          >
            {tr("检查选择（不执行）", "Check selection (no execution)")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {snapshot.changeId ? `CL ${snapshot.changeId}` : "Default"} ·{" "}
        {snapshot.paths.length} {tr("个文件", "files")}
      </div>
      <DialogNotice>
        {tr(
          "界面预览：不会创建、替换或删除服务器上的搁置内容。搁置是服务器上的快照，不是本地文件副本。",
          "UI preview: no server shelf is created, replaced or deleted. A shelf is a server snapshot, not a local file copy.",
        )}
      </DialogNotice>
      <TargetList
        paths={snapshot.paths}
        label={tr("明确的文件范围", "Explicit file scope")}
      />
      {snapshot.changeId <= 0 && (
        <DialogNotice error>
          {tr(
            "需要先创建编号 CL，再选择文件搁置；此预览不会自动创建或移动 CL。",
            "Create a numbered CL before shelving. This preview does not automatically create a CL or reassign files.",
          )}
        </DialogNotice>
      )}
      {!snapshot.paths.length && (
        <DialogNotice error>
          {tr("此范围没有可操作的文件。", "There are no files in this scope.")}
        </DialogNotice>
      )}
      {!deleting && snapshot.hasShelf && (
        <label>
          {tr("已有搁置内容的处理方式", "Existing shelf handling")}
          <select
            value={replace ? "replace" : "preserve"}
            onChange={(event) => {
              setReplace(event.target.value === "replace");
              setAck(false);
              setChecked(false);
            }}
          >
            <option value="preserve">
              {tr(
                "保留已有内容（冲突需预检）",
                "Preserve existing content (conflicts require preflight)",
              )}
            </option>
            <option value="replace">
              {tr(
                "替换所选文件的搁置版本",
                "Replace shelved versions of selected files",
              )}
            </option>
          </select>
        </label>
      )}
      {risky && (
        <>
          <DialogNotice error>
            {deleting
              ? tr(
                  "删除后这些服务器搁置版本将不可再用于 Unshelve。不会同时删除工作区文件或整个 CL。",
                  "Deleted shelf versions will no longer be available for unshelve. Workspace files and the CL itself are not deleted.",
                )
              : tr(
                  "替换会覆盖所选文件已有的搁置版本；未选文件不在本次范围内。",
                  "Replacement overwrites existing shelved versions of selected files. Unselected files remain out of scope.",
                )}
          </DialogNotice>
          <label className="workflow-checkbox">
            <input
              type="checkbox"
              checked={ack}
              onChange={(event) => {
                setAck(event.target.checked);
                setChecked(false);
              }}
            />
            {tr(
              "我已核对文件范围并了解风险。",
              "I have reviewed the file scope and risks.",
            )}
          </label>
        </>
      )}
      <DialogNotice>
        {tr(
          "执行前仍需验证 CL 归属、锁定状态、文件当前内容与服务器搁置是否变化。",
          "Execution still requires checking CL ownership, locks, current file contents and server shelf changes.",
        )}
      </DialogNotice>
      {checked && (
        <DialogNotice>
          {tr(
            "选择已检查，尚未更改任何搁置内容。",
            "Selection checked. No shelved content was changed.",
          )}
        </DialogNotice>
      )}
    </Dialog>
  );
}
