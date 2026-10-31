import { useEffect, useRef, useState } from "react";
import { Dialog } from "../../../app/dialogs/Dialog";
import { backend } from "../../../infrastructure/backend";
import type {
  IntegrationTraceRequest,
  IntegrationTraceBatch,
  IntegrationTraceRecord,
  RuntimeInfo,
  SubmittedChangeDetail,
} from "../../../shared/contracts";
import {
  createSharedGraphReader,
  readGraphChange,
} from "../../browsers/graphReads";
import { makeReviewScope } from "../../browsers/reviewModel";
import {
  acceptedIntegration,
  checkedTraceBatch,
  traceGroups,
  tracePathKey,
} from "../integrationTrace";

export const readIntegrationBatch = createSharedGraphReader<
  IntegrationTraceRequest,
  IntegrationTraceBatch
>(
  async (request) =>
    checkedTraceBatch(await backend.getIntegrationTrace(request)),
  (id) => backend.cancelOperation(id).then(() => undefined),
  (request, mode) => [
    "target",
    "integration-trace",
    mode,
    request.scope,
    [...new Set(request.paths)].sort(),
  ],
);
/** CL-level investigation: no graph entry point, no description matching, no implicit recursion. */
export function IntegrationTraceDialog(
  props: Parameters<typeof IntegrationTraceDialogInner>[0],
) {
  const owner = JSON.stringify([
    props.runtime.mode,
    makeReviewScope(props.runtime, `//change/${props.changeId}`),
  ]);
  return <IntegrationTraceDialogInner key={owner} {...props} />;
}
function IntegrationTraceDialogInner({
  changeId,
  runtime,
  zh,
  onClose,
  source,
}: {
  changeId: number;
  runtime: RuntimeInfo;
  zh: boolean;
  onClose(): void;
  source?: HTMLElement;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [detail, setDetail] = useState<SubmittedChangeDetail>();
  const [records, setRecords] = useState<IntegrationTraceRecord[]>([]);
  const [next, setNext] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [readAt, setReadAt] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [incomplete, setIncomplete] = useState(true);
  const [requests, setRequests] = useState(0);
  const [metadata, setMetadata] = useState<
    Record<number, SubmittedChangeDetail>
  >({});
  const [hops, setHops] = useState<
    { via: IntegrationTraceRecord; batch: IntegrationTraceBatch }[]
  >([]);
  const active = useRef<AbortController | undefined>(undefined);
  const budget = useRef(0);
  useEffect(() => () => active.current?.abort(), []);
  const scope = makeReviewScope(runtime, `//change/${changeId}`);
  function begin() {
    if (active.current) return;
    if (runtime.mode !== "mock" && runtime.connection.state !== "connected") {
      setWarnings([tr("连接不可用", "Connection unavailable")]);
      return;
    }
    if (budget.current >= 12) {
      setWarnings((previous) => [
        ...previous,
        tr(
          "达到12次读取预算；请显式刷新以重新调查",
          "12-read budget reached; explicitly refresh to start another investigation",
        ),
      ]);
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    return controller;
  }
  function take() {
    if (budget.current >= 12)
      throw new Error(tr("达到12次读取预算", "12-read budget reached"));
    budget.current++;
    setRequests(budget.current);
  }
  function finish(controller: AbortController) {
    if (active.current === controller) {
      active.current = undefined;
      setBusy(false);
    }
  }
  function fail(error: unknown, controller: AbortController) {
    setIncomplete(true);
    if (!controller.signal.aborted)
      setWarnings((previous) => [...previous, String(error)]);
  }
  async function run(refresh = false) {
    if (active.current) return;
    if (refresh) {
      budget.current = 0;
    }
    const controller = begin();
    if (!controller) return;
    try {
      let value = refresh ? undefined : detail;
      if (!value) {
        take();
        value = await readGraphChange(
          scope,
          changeId,
          runtime.mode,
          controller.signal,
          refresh,
        );
        if (controller.signal.aborted) return;
      }
      const start = refresh ? 0 : next;
      const files = [
        ...new Map(value.files.map((file) => [file.depotPath, file])).values(),
      ];
      const end = Math.min(files.length, start + 100);
      const collected = refresh ? [] : [...records];
      const notices = refresh ? [] : [...warnings];
      let partial = refresh || !detail ? false : incomplete;
      let timestamp = refresh ? undefined : readAt;
      const publish = (progress: number) => {
        setDetail(value);
        setRecords([...collected]);
        setReadAt(timestamp);
        setWarnings([...new Set(notices)]);
        setNext(progress);
        setIncomplete(partial);
        if (refresh) {
          setHops([]);
          setMetadata({});
        }
      };
      for (let index = start; index < end; index += 20) {
        take();
        const batch = await readIntegrationBatch(
          {
            scope,
            paths: files
              .slice(index, Math.min(index + 20, end))
              .map((file) => file.depotPath),
            refresh,
          },
          runtime.mode,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        collected.push(...batch.records);
        timestamp = Math.min(timestamp ?? batch.readAt, batch.readAt);
        partial ||= batch.incomplete;
        notices.push(...batch.warnings);
        // A later failed batch must not discard destinations already returned.
        publish(Math.min(index + 20, end));
      }
      if (start === end) publish(end);
    } catch (error) {
      fail(error, controller);
    } finally {
      finish(controller);
    }
  }
  async function inspect(change: number) {
    const controller = begin();
    if (!controller) return;
    try {
      take();
      const value = await readGraphChange(
        scope,
        change,
        runtime.mode,
        controller.signal,
      );
      if (!controller.signal.aborted)
        setMetadata((previous) => ({ ...previous, [change]: value }));
    } catch (error) {
      fail(error, controller);
    } finally {
      finish(controller);
    }
  }
  async function follow(via: IntegrationTraceRecord) {
    if (!acceptedIntegration(via)) return;
    const controller = begin();
    if (!controller) return;
    try {
      take();
      const batch = await readIntegrationBatch(
        { scope, paths: [via.targetPath] },
        runtime.mode,
        controller.signal,
      );
      if (!controller.signal.aborted)
        setHops((previous) => [...previous, { via, batch }]);
    } catch (error) {
      fail(error, controller);
    } finally {
      finish(controller);
    }
  }
  const files = detail?.files ?? [];
  const uniqueFiles = new Set(files.map((file) => file.depotPath)).size;
  const groups = traceGroups(
    files,
    records,
    detail?.inspectionStatus === "complete" &&
      !incomplete &&
      !busy &&
      next >= uniqueFiles,
  );
  const evidence = (record: IntegrationTraceRecord) =>
    `${record.sourcePath}#(${record.sourceStart},${record.sourceEnd}] → ${record.targetPath}#(${record.targetStart},${record.targetEnd}] · ${record.how} · CL ${record.recordChange}`;
  return (
    <Dialog
      title={`${tr("追踪合并去向", "Trace integration destinations")} · CL ${changeId}`}
      zh={zh}
      source={source}
      onRequestClose={() => {
        active.current?.abort();
        onClose();
      }}
      footer={
        <>
          <button
            disabled={
              busy || (!!detail && next >= uniqueFiles) || requests >= 12
            }
            onClick={() => void run()}
          >
            {detail
              ? tr("继续查询下一批文件", "Read next file batch")
              : tr("查询集成记录", "Query integration records")}
          </button>
          <button disabled={busy} onClick={() => void run(true)}>
            {tr("刷新调查", "Refresh investigation")}
          </button>
          {busy && (
            <button
              onClick={() => {
                active.current?.abort();
                setIncomplete(true);
                setWarnings((previous) => [
                  ...previous,
                  tr(
                    "已取消，当前结果不完整",
                    "Cancelled; current results incomplete",
                  ),
                ]);
              }}
            >
              {tr("取消读取", "Cancel reads")}
            </button>
          )}
        </>
      }
    >
      <p>
        {tr(
          "只验证已读取的集成记录覆盖，不证明已穷尽所有去向，也不保证目标当前内容仍包含修改。未发现记录不等于未合入；目标分支无法可靠映射时显示 depot 路径。",
          "Coverage of retrieved integration records only; neither exhaustive destinations nor current content inclusion. No records does not mean not integrated; unmapped destinations retain their depot paths.",
        )}
      </p>
      <p role="status">
        {tr("已查询文件", "Files queried")}: {next}/{uniqueFiles} ·{" "}
        {tr("读取预算", "Read budget")}: {requests}/12 ·{" "}
        {readAt
          ? new Date(readAt).toLocaleString()
          : tr("尚未读取", "Not read")}
      </p>
      {detail &&
        (detail.inspectionStatus !== "complete" ||
          incomplete ||
          next < uniqueFiles) && (
          <p>
            {tr(
              "源CL文件集或调查尚不完整，未查询项为未知。",
              "Source file set or investigation is incomplete; unqueried files are unknown.",
            )}
          </p>
        )}
      {warnings.map((warning, index) => (
        <p role="alert" key={index}>
          {warning}
        </p>
      ))}
      {detail && !groups.length && (
        <p>
          {tr(
            "当前未发现匹配记录，去向未知。",
            "No matching records in current results; destinations unknown.",
          )}
          {records.length > 0
            ? tr(
                ` 返回了 ${records.length} 条记录，但源路径或源修订范围与此CL未匹配。`,
                ` ${records.length} records returned, but their source paths or revision ranges do not match this CL.`,
              )
            : tr(
                " 后端返回0条记录；这不能证明未合入，可刷新重新核对。",
                " Backend returned 0 records; this does not prove no integration. Refresh to recheck.",
              )}
        </p>
      )}
      {groups.map((group) => (
        <details key={group.change}>
          <summary>
            {tr("记录 CL", "Record CL")} {group.change} · {group.covered.size}/
            {group.total} ·{" "}
            {group.full
              ? tr("完整文件记录覆盖", "Full file record coverage")
              : tr("部分记录 / 未知", "Partial records / unknown")}
          </summary>
          <button
            disabled={busy || !!metadata[group.change]}
            onClick={() => void inspect(group.change)}
          >
            {tr("核对目标CL与时间", "Verify destination CL and time")}
          </button>
          {metadata[group.change] && (
            <p>
              {metadata[group.change].inspectionStatus === "complete" &&
              group.records.every((record) =>
                metadata[group.change].files.some(
                  (file) =>
                    tracePathKey(file.depotPath) ===
                      tracePathKey(record.targetPath) &&
                    file.revision === record.targetEnd,
                ),
              )
                ? `${tr("目标 CL", "Destination CL")} ${group.change} · ${metadata[group.change].time}`
                : tr(
                    "记录CL未能与全部目标修订核对，目标CL/时间未知",
                    "Record CL could not be verified against all destination revisions; destination CL/time unknown",
                  )}
            </p>
          )}
          {group.records.map((record, index) => (
            <div key={index}>
              <p style={{ overflowWrap: "anywhere" }}>{evidence(record)}</p>
              <button
                disabled={
                  busy ||
                  !acceptedIntegration(record) ||
                  requests >= 12 ||
                  hops.some(
                    (hop) => JSON.stringify(hop.via) === JSON.stringify(record),
                  )
                }
                onClick={() => void follow(record)}
              >
                {tr(
                  "按需查询此去向的下一跳",
                  "Read this destination's next hop",
                )}
              </button>
            </div>
          ))}
        </details>
      ))}
      {hops.map((hop, index) => (
        <details key={index} open>
          <summary>
            {tr(
              "中转线索（不计为完整覆盖）",
              "Intermediate evidence (not full coverage)",
            )}
          </summary>
          <p style={{ overflowWrap: "anywhere" }}>{evidence(hop.via)}</p>
          {hop.batch.records
            .filter(
              (record) =>
                acceptedIntegration(record) &&
                tracePathKey(record.sourcePath) ===
                  tracePathKey(hop.via.targetPath) &&
                record.sourceStart < hop.via.targetEnd &&
                record.sourceEnd >= hop.via.targetEnd,
            )
            .map((record, i) => (
              <p key={i} style={{ overflowWrap: "anywhere" }}>
                {evidence(record)}
              </p>
            ))}
          <p>
            {tr(
              "仅下一跳记录；忽略/撤销/编辑动作和缺失范围需独立核对。",
              "Next-hop records only; ignored/undo/edit actions and missing ranges require separate verification.",
            )}
            {hop.batch.incomplete
              ? tr("结果不完整。", "Incomplete results.")
              : ""}
          </p>
        </details>
      ))}
    </Dialog>
  );
}
