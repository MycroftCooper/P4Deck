import { ResizableTable } from "../../../app/context-menu/ResizableTable";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import type {
  RevisionGraphNode,
  RuntimeInfo,
  BranchViewLine,
  SubmittedChangeFile,
} from "../../../shared/contracts";
import { appCache } from "../../../shared/cache/appCache";
import { makeReviewScope } from "../reviewModel";
import {
  graphReadKey,
  readGraph,
  readGraphChange,
  readGraphMapping,
} from "../graphReads";
import {
  investigateFiles,
  mapBranchFile,
  mapBranchRoots,
  newInvestigationBudget,
  takeInvestigationRead,
  type InvestigationReport,
} from "../graphInvestigation";

export function GraphInvestigationDialog({
  seed,
  runtime,
  zh,
  onClose,
}: {
  seed: RevisionGraphNode;
  runtime: RuntimeInfo;
  zh: boolean;
  onClose(): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [subject, setSubject] = useState("file");
  const [change, setChange] = useState(
    seed.changelistId > 0 ? String(seed.changelistId) : "",
  );
  const [mapping, setMapping] = useState("roots");
  const [sourceRoot, setSourceRoot] = useState("");
  const [targetRoot, setTargetRoot] = useState("");
  const [branch, setBranch] = useState("");
  const [reverse, setReverse] = useState(false);
  const [intermediates, setIntermediates] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<InvestigationReport>();
  const [resultPage, setResultPage] = useState(0);
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = undefined;
    },
    [],
  );
  const scope = makeReviewScope(runtime, seed.depotPath);
  async function run(refresh = false) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setReport(undefined);
    setResultPage(0);
    const budget = newInvestigationBudget();
    try {
      if (runtime.mode !== "mock" && runtime.connection.state !== "connected")
        throw new Error(tr("连接不可用", "Connection unavailable"));
      if (
        subject === "change" &&
        (!/^[1-9]\d*$/.test(change) || !Number.isSafeInteger(Number(change)))
      )
        throw new Error(tr("请输入有效 CL 号", "Enter a valid CL number"));
      let files: SubmittedChangeFile[] = [seed];
      let complete = true,
        changeId = seed.changelistId;
      if (subject === "change") {
        takeInvestigationRead(budget, controller.signal);
        const detail = await readGraphChange(
          scope,
          Number(change),
          runtime.mode,
          controller.signal,
          refresh,
        );
        files = detail.files;
        complete = detail.inspectionStatus === "complete";
        changeId = detail.changeId;
      }
      let view: BranchViewLine[] = [];
      if (mapping === "branch") {
        if (!branch.trim())
          throw new Error(
            tr("请输入 Branch Mapping 名称", "Enter a Branch Mapping name"),
          );
        takeInvestigationRead(budget, controller.signal);
        const result = await readGraphMapping(
          scope,
          branch.trim(),
          runtime.mode,
          controller.signal,
          refresh,
        );
        view = result.detail.view;
      }
      const value = await investigateFiles(
        files,
        changeId,
        (path) =>
          mapping === "branch"
            ? mapBranchFile(path, view, reverse)
            : mapBranchRoots(path, sourceRoot.trim(), targetRoot.trim()),
        async (path, cursor) => {
          const request = {
            scope: makeReviewScope(runtime, path),
            revisionLimit: 100,
            cursor,
            refresh,
          };
          const graph = await readGraph(
            request,
            runtime.mode,
            controller.signal,
          );
          return {
            graph,
            updatedAt:
              appCache.getQueryState(graphReadKey(request, runtime.mode))
                ?.dataUpdatedAt ?? 0,
          };
        },
        {
          signal: controller.signal,
          budget,
          fileListComplete: complete,
          intermediates,
          progress: (value) => {
            if (active.current === controller) setReport(value);
          },
        },
      );
      if (active.current === controller) setReport(value);
    } catch (cause) {
      if (active.current === controller) setError(String(cause));
    } finally {
      if (active.current === controller) {
        active.current = undefined;
        setBusy(false);
      }
    }
  }
  const known = report?.rows.filter((r) => r.status === "records").length ?? 0;
  const review = report?.rows.filter((r) => r.status === "review").length ?? 0;
  const visibleRows =
    report?.rows.slice(resultPage * 100, (resultPage + 1) * 100) ?? [];
  return (
    <Dialog
      title={tr("目标分支调查", "Target branch investigation")}
      zh={zh}
      onRequestClose={onClose}
      footer={
        <>
          {busy ? (
            <button onClick={() => active.current?.abort()}>
              {tr("取消读取", "Cancel read")}
            </button>
          ) : (
            <>
              <button onClick={() => void run()}>
                {tr("查询（优先缓存）", "Query (prefer cache)")}
              </button>
              <button onClick={() => void run(true)}>
                {tr("强制重新读取", "Force fresh reads")}
              </button>
            </>
          )}
        </>
      }
    >
      <fieldset className="graph-investigation-fields" disabled={busy}>
        <label>
          {tr("调查范围", "Scope")}
          <select
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setReport(undefined);
            }}
          >
            <option value="file">
              {tr("当前文件版本", "Current file revision")}
            </option>
            <option value="change">
              {tr("整个已提交 CL（逐文件）", "Submitted CL (file by file)")}
            </option>
          </select>
        </label>
        {subject === "change" ? (
          <label>
            CL
            <input
              inputMode="numeric"
              value={change}
              onChange={(e) => {
                setChange(e.target.value);
                setReport(undefined);
              }}
            />
          </label>
        ) : (
          <p>
            {seed.depotPath}#{seed.revision}
          </p>
        )}
        <label>
          {tr("文件映射", "File mapping")}
          <select
            value={mapping}
            onChange={(e) => {
              setMapping(e.target.value);
              setReport(undefined);
            }}
          >
            <option value="roots">
              {tr(
                "指定根目录，保留相对路径",
                "Explicit roots, same relative path",
              )}
            </option>
            <option value="branch">Branch Mapping</option>
          </select>
        </label>
        {mapping === "roots" ? (
          <>
            <label>
              {tr("源分支根目录", "Source branch root")}
              <input
                placeholder="//depot/source"
                value={sourceRoot}
                onChange={(e) => {
                  setSourceRoot(e.target.value);
                  setReport(undefined);
                }}
              />
            </label>
            <label>
              {tr("目标分支根目录", "Target branch root")}
              <input
                placeholder="//depot/target"
                value={targetRoot}
                onChange={(e) => {
                  setTargetRoot(e.target.value);
                  setReport(undefined);
                }}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              {tr("已有映射名称", "Existing mapping name")}
              <input
                value={branch}
                onChange={(e) => {
                  setBranch(e.target.value);
                  setReport(undefined);
                }}
              />
            </label>
            <label className="graph-investigation-check">
              <input
                type="checkbox"
                checked={reverse}
                onChange={(e) => {
                  setReverse(e.target.checked);
                  setReport(undefined);
                }}
              />
              {tr("反向映射", "Reverse mapping")}
            </label>
          </>
        )}
        <label className="graph-investigation-check">
          <input
            type="checkbox"
            checked={intermediates}
            onChange={(e) => {
              setIntermediates(e.target.checked);
              setReport(undefined);
            }}
          />
          {tr(
            "检查来源/目标共同引用的中转（每文件最多2个）",
            "Inspect shared intermediate references (up to 2 per file)",
          )}
        </label>
      </fieldset>
      <p>
        {tr(
          "最多20次API读取尝试（含CL/映射），100个文件，每路径最多2页；缓存命中不请求服务器。仅支持直接目录映射或简单Branch Mapping，复杂Stream导入/重映射不会猜测。",
          "At most 20 API read attempts including CL/mapping, 100 files, 2 pages per path. Cache hits make no server request. Complex Stream imports/remaps are not inferred.",
        )}
      </p>
      {error && <DialogNotice error>{error}</DialogNotice>}
      {busy && (
        <DialogNotice>
          {tr("正在收集有界证据…", "Collecting bounded evidence…")}
        </DialogNotice>
      )}
      {report && (
        <>
          <DialogNotice>
            {tr("记录路径", "Record paths")} {known} ·{" "}
            {tr("需复核", "Needs review")} {review} ·{" "}
            {tr("未知/未查询", "Unknown / not queried")}{" "}
            {report.total - known - review} / {report.total} ·{" "}
            {tr("读取尝试", "Read attempts")} {report.reads}/20
          </DialogNotice>
          <p>
            {tr(
              "整个CL的内容包含性：未知。单文件记录路径不代表整个CL已合入；未查到不代表未合入。",
              "Whole-CL content inclusion: unknown. Individual record paths do not prove the whole CL was integrated; no path does not prove absence.",
            )}
          </p>
          {(!report.fileListComplete ||
            report.interrupted ||
            report.limited) && (
            <DialogNotice error>
              {tr(
                "调查不完整：文件列表、取消或预算限制。",
                "Investigation incomplete: file visibility, cancellation or budget limit.",
              )}
            </DialogNotice>
          )}
          {!report.total && (
            <p>
              {tr(
                "没有可见文件，无法得出CL结论。",
                "No visible files; no CL conclusion can be drawn.",
              )}
            </p>
          )}
          <div className="graph-investigation-results">
            <ResizableTable
              tableId="graph-investigation"
              defaults={[340, 340]}
              minimums={[180, 180]}
            >
              <thead>
                <tr>
                  <th>
                    {tr("来源版本 → 目标文件", "Source revision → target file")}
                  </th>
                  <th>
                    {tr(
                      "记录证据（不证明内容包含）",
                      "Evidence (not content inclusion)",
                    )}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, i) => (
                  <tr key={`${row.file.depotPath}:${row.file.revision}:${i}`}>
                    <td>
                      {row.file.depotPath}#{row.file.revision ?? "?"}
                      <br />→ {row.target ?? "—"}
                      <br />
                      {row.file.action}
                    </td>
                    <td>
                      {row.reason}
                      {row.updatedAt !== undefined && (
                        <small>
                          {tr("快照时间", "Snapshot time")}:{" "}
                          {row.updatedAt
                            ? new Date(row.updatedAt).toLocaleString(
                                zh ? "zh-CN" : "en-US",
                              )
                            : "?"}
                        </small>
                      )}
                      {row.evidence?.incomplete && (
                        <small>
                          {tr(
                            "分页/引用证据不完整",
                            "Pages / reference evidence incomplete",
                          )}
                        </small>
                      )}
                      {!!row.evidence?.edges.length && (
                        <details>
                          <summary>
                            {tr("查看路径及范围", "Inspect path and ranges")}
                          </summary>
                          <ul>
                            {row.evidence.edges.map((e) => {
                              const a = row.graph?.nodes.find(
                                  (n) => n.id === e.source,
                                ),
                                b = row.graph?.nodes.find(
                                  (n) => n.id === e.target,
                                );
                              return (
                                <li key={e.id}>
                                  {a?.depotPath}#{a?.revision} → {b?.depotPath}#
                                  {b?.revision} · CL {b?.changelistId || "?"} ·{" "}
                                  {e.relationship} · ({e.startRevision ?? "?"},{" "}
                                  {e.endRevision ?? "?"}]
                                </li>
                              );
                            })}
                          </ul>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResizableTable>
          </div>
          {report.rows.length > 100 && (
            <div>
              <button
                disabled={!resultPage}
                onClick={() => setResultPage((p) => p - 1)}
              >
                {tr("上一组", "Previous")}
              </button>
              <span>
                {resultPage + 1}/{Math.ceil(report.rows.length / 100)}
              </span>
              <button
                disabled={(resultPage + 1) * 100 >= report.rows.length}
                onClick={() => setResultPage((p) => p + 1)}
              >
                {tr("下一组", "Next")}
              </button>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
