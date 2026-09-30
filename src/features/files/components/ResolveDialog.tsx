import { useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { TargetList } from "../../../app/dialogs/TargetList";
import { PreflightStatus } from "../../../app/dialogs/PreflightStatus";
import type { WorkspaceNode } from "../../../shared/contracts/types";

export interface ResolveDetail {
  kind: "text" | "binary" | "other";
  base?: { label: string; content?: string };
  yours?: { label: string; content?: string };
  theirs?: { label: string; content?: string };
  result?: { state: "resolved" | "failed" | "skipped"; message: string };
}
type Method = "skip" | "merge" | "yours" | "theirs" | "external";
export function ResolveDialog({
  nodes,
  source,
  zh,
  onDismiss,
  details = {},
}: {
  nodes: WorkspaceNode[];
  source: HTMLElement | null;
  zh: boolean;
  onDismiss(): void;
  details?: Record<string, ResolveDetail>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() => [
    ...new Map(
      nodes.map((node) => [node.depotPath || node.absolutePath, { ...node }]),
    ).values(),
  ]);
  const [index, setIndex] = useState(0);
  const [plans, setPlans] = useState<Record<string, Method>>({});
  const [notice, setNotice] = useState("");
  const [discard, setDiscard] = useState(false);
  const current = snapshot[index];
  const key = current?.depotPath || current?.absolutePath || "";
  const detail = details[key];
  const method = plans[key] ?? "skip";
  const select = (next: number) => {
    setIndex(next);
    setNotice("");
  };
  const dismiss = () =>
    Object.keys(plans).length ? setDiscard(true) : onDismiss();
  return (
    <Dialog
      title={tr("解决冲突（Resolve）", "Resolve conflicts")}
      description={tr(
        "只展示目标和处理计划。未接通冲突检查与执行，不会更改文件或标记为已解决。",
        "Shows targets and a resolution plan only. Conflict inspection and execution are not connected; no files are changed or marked resolved.",
      )}
      source={source}
      zh={zh}
      onRequestClose={dismiss}
      footer={
        <>
          <button onClick={dismiss}>{tr("关闭", "Close")}</button>
          <button
            disabled={!current}
            onClick={() =>
              setNotice(
                tr(
                  "处理方式已检查，仅为界面计划，未解决任何冲突。",
                  "Plan checked for UI preview. No conflicts were resolved.",
                ),
              )
            }
          >
            {tr("检查计划（不执行）", "Check plan (no execution)")}
          </button>
          <button
            className="primary"
            disabled
            title={tr(
              "需要真实冲突数据和可用的处理工具",
              "Requires verified conflict data and an available resolution tool",
            )}
          >
            {tr("执行当前项", "Resolve current item")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {snapshot.length} {tr("个待检查目标", "targets to inspect")} ·{" "}
        {current ? index + 1 : 0}/{snapshot.length}
      </div>
      <TargetList
        paths={snapshot.map((node) => node.depotPath || node.absolutePath)}
        label={tr("待检查文件", "Files to inspect")}
        selectedIndex={index}
        onSelect={select}
      />
      <div className="workflow-navigation">
        <button disabled={index === 0} onClick={() => select(index - 1)}>
          {tr("上一项", "Previous")}
        </button>
        <button
          disabled={index >= snapshot.length - 1}
          onClick={() => select(index + 1)}
        >
          {tr("下一项", "Next")}
        </button>
      </div>
      {!current ? (
        <PreflightStatus state={{ kind: "empty" }} zh={zh} />
      ) : (
        <>
          <p className="workflow-summary-description">{key}</p>
          {!detail && (
            <DialogNotice>
              {current.state === "conflicted"
                ? tr(
                    "列表标记为冲突；实际冲突类型、基线、双方版本及可用工具仍未知。",
                    "List marks a conflict; actual conflict type, base, versions and available tools are still unknown.",
                  )
                : tr(
                    "尚未检查此文件是否需要 Resolve，不把未知状态当作没有冲突。",
                    "Resolve requirements have not been checked. Unknown does not mean conflict-free.",
                  )}
            </DialogNotice>
          )}
          <div className="workflow-version-grid">
            {(["base", "yours", "theirs"] as const).map((side, index) => {
              const version = detail?.[side];
              return (
                <section
                  key={side}
                  aria-label={
                    [
                      tr("共同基线", "Base"),
                      tr("工作区一侧", "Yours"),
                      tr("传入一侧", "Theirs"),
                    ][index]
                  }
                >
                  <h3>
                    {
                      [
                        tr("共同基线", "Base"),
                        tr("工作区一侧", "Yours"),
                        tr("传入一侧", "Theirs"),
                      ][index]
                    }
                  </h3>
                  <p>{version?.label ?? tr("版本未知", "Unknown revision")}</p>
                  {version?.content !== undefined ? (
                    <>
                      <pre>{version.content.slice(0, 100_000)}</pre>
                      {version.content.length > 100_000 && (
                        <p>
                          {tr(
                            "仅预览前 100,000 字符",
                            "Preview limited to first 100,000 characters",
                          )}
                        </p>
                      )}
                    </>
                  ) : (
                    <p>
                      {tr(
                        "内容未载入，不能推断差异。",
                        "Content not loaded; differences cannot be inferred.",
                      )}
                    </p>
                  )}
                </section>
              );
            })}
          </div>
          <label>
            {tr("当前文件的处理计划", "Plan for current file")}
            <select
              data-dialog-autofocus
              value={method}
              onChange={(event) => {
                setPlans((old) => ({
                  ...old,
                  [key]: event.target.value as Method,
                }));
                setNotice("");
              }}
            >
              <option value="skip">{tr("暂不处理", "Skip for now")}</option>
              <option value="merge">
                {tr(
                  "尝试合并（需验证类型）",
                  "Attempt merge (type must be verified)",
                )}
              </option>
              <option value="yours">
                {tr("保留工作区一侧", "Keep yours")}
              </option>
              <option value="theirs">
                {tr("接受传入一侧", "Accept theirs")}
              </option>
              <option value="external">
                {tr(
                  "使用外部合并工具（尚未连接）",
                  "External merge tool (not connected)",
                )}
              </option>
            </select>
          </label>
          {(method === "yours" || method === "theirs") && (
            <DialogNotice error>
              {tr(
                "选择一侧可能丢弃另一侧的修改。必须先确认双方来源和具体冲突类型。",
                "Choosing one side may discard changes from the other. Verify both sources and the conflict type first.",
              )}
            </DialogNotice>
          )}
          {detail?.kind === "binary" && (
            <DialogNotice>
              {tr(
                "二进制文件不能使用文本合并；需要适用的工具或明确选择一侧。",
                "Binary files cannot use text merging; an appropriate tool or explicit side selection is needed.",
              )}
            </DialogNotice>
          )}
          <PreflightStatus state={{ kind: "unavailable" }} zh={zh} />
          {detail?.result && (
            <DialogNotice error={detail.result.state === "failed"}>
              {tr("已提供的处理结果：", "Provided resolution result: ")}
              {detail.result.state} · {detail.result.message}
            </DialogNotice>
          )}
        </>
      )}
      {notice && <DialogNotice>{notice}</DialogNotice>}
      {discard && (
        <section className="workflow-discard" role="alert">
          <p>
            {tr(
              "关闭会丢弃尚未执行的处理计划。",
              "Closing discards the unexecuted plan.",
            )}
          </p>
          <button onClick={() => setDiscard(false)}>
            {tr("继续编辑", "Keep editing")}
          </button>
          <button onClick={onDismiss}>
            {tr("放弃计划并关闭", "Discard plan and close")}
          </button>
        </section>
      )}
    </Dialog>
  );
}
