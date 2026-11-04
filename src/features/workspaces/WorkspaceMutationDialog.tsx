import { tFor } from "../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import { useUnsavedEditor } from "../../app/closeGuard";
import { Dialog, DialogNotice } from "../../app/dialogs/Dialog";
import { backend } from "../../infrastructure/backend";
import type { ConnectionSnapshot } from "../companySubmit/model";
import {
  lookupWorkspaceMutationAction,
  validWorkspaceMutationReceipt,
  type WorkspaceMutationActionLookup,
} from "../actions/workflowReceipt";
import type {
  WorkspaceMutationPreview,
  WorkspaceMutationRequest,
  WorkspaceMutationResult,
} from "../../shared/contracts";

/**
 * S4i2 workspace rename/delete. Server-side spec write with no client rollback:
 * the UI shows intent/progress only and treats the post-write existence readback
 * (`verified` + `observedExists`) as the sole authority. Unknown outcomes keep the
 * state visibly uncertain, are looked up once by the SAME operationId and are
 * never retried with a new id.
 */
export function WorkspaceMutationDialog({
  request,
  zh,
  onClose: closeCallback,
  onDone,
  onRefresh,
  connection: connectionProvider,
  lookup: lookupReceipt,
}: {
  request: WorkspaceMutationRequest;
  zh: boolean;
  onClose(): void;
  onDone(): void;
  /** Bounded list/context refresh for non-success outcomes (never closes). */
  onRefresh?(): void;
  /** Exact dispatching connection snapshot; captured once per confirm. */
  connection?(): Promise<ConnectionSnapshot>;
  /** Durable receipt recovery by the SAME operationId. */
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<WorkspaceMutationActionLookup>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [name, setName] = useState(request.workspace);
  const clearUnsaved = useUnsavedEditor(
    name !== request.workspace ? "dirty" : "clean",
  );
  const onClose = () => {
    clearUnsaved();
    closeCallback();
  };
  const [preview, setPreview] = useState<WorkspaceMutationPreview>();
  const [result, setResult] = useState<WorkspaceMutationResult>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const operationId = useRef<string | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (operationId.current)
        void backend
          .cancelOperation(operationId.current)
          .catch(() => undefined);
    };
  }, []);
  async function inspect() {
    if (busy) return;
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const value = await backend.preflightWorkspaceMutation({
        ...request,
        newName: request.action === "rename" ? name.trim() : undefined,
      });
      if (alive.current) setPreview(value);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function recover(
    id: string,
    dispatching: ConnectionSnapshot,
  ): Promise<WorkspaceMutationResult | undefined> {
    try {
      const lookupRequest = { operationId: id, connection: dispatching };
      const lookup = await (lookupReceipt ?? lookupWorkspaceMutationAction)(
        lookupRequest,
      );
      if (
        lookup.kind === "found" &&
        validWorkspaceMutationReceipt(lookupRequest, lookup.receipt) &&
        lookup.receipt.state === "settled" &&
        lookup.receipt.result
      )
        return lookup.receipt.result;
    } catch {
      /* Receipt lookup never retries the write. */
    }
    return undefined;
  }
  function apply(value: WorkspaceMutationResult) {
    setResult(value);
    if (value.outcome === "succeeded" && value.verified) {
      clearUnsaved();
      onDone();
      return;
    }
    // Not verified: refresh once but keep the uncertainty visible.
    if (onRefresh) onRefresh();
    else onDone();
  }
  async function confirm() {
    if (!preview || busy) return;
    if (request.action === "delete" && !acknowledged) return;
    const id = crypto.randomUUID();
    operationId.current = id;
    setBusy(true);
    setPreview(undefined);
    setError("");
    let dispatching: ConnectionSnapshot | undefined;
    try {
      dispatching = await (
        connectionProvider ?? (() => backend.companySubmitConnectionSnapshot())
      )();
      if (!alive.current) return;
      if (String(preview.request.expectedGeneration) !== dispatching.generation)
        throw new Error(
          tr(
            "连接代际与预检目标不一致，未执行工作区变更。",
            "Connection generation changed; no workspace mutation was dispatched.",
          ),
        );
      let value = await backend.confirmWorkspaceMutation(preview.token, id);
      if (!alive.current) return;
      if (value.outcome === "unknown") {
        const recovered = await recover(id, dispatching);
        if (recovered) value = recovered;
      }
      if (!alive.current) return;
      apply(value);
    } catch (cause) {
      if (!alive.current) return;
      const recovered = dispatching
        ? await recover(id, dispatching)
        : undefined;
      if (!alive.current) return;
      if (recovered) {
        apply(recovered);
        return;
      }
      const message = String(cause);
      setError(message);
      apply({
        outcome: "unknown",
        failure: message,
        message: tr(
          "结果不确定：操作可能已应用。已用同一操作号查询持久回执并刷新；请核对工作区列表，不要用新操作号重试。",
          "Outcome uncertain: the operation may have applied. The durable receipt was queried with the same operation id and the list was refreshed; inspect the workspace list before any retry with a new id.",
        ),
        workspace: preview.request.workspace,
        action: preview.request.action,
        verified: false,
      });
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const resultVerified =
    result?.outcome === "succeeded" && result.verified === true;
  return (
    <Dialog
      title={`${request.action === "rename" ? tFor(zh ? "zh-CN" : "en-US", "workspaces.rename.workspace") : tFor(zh ? "zh-CN" : "en-US", "workspaces.delete.workspace")} '${request.workspace}'`}
      zh={zh}
      busy={busy}
      onRequestClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <button disabled={busy} onClick={onClose}>
            {tFor(zh ? "zh-CN" : "en-US", "workspaces.cancel")}
          </button>
          {busy && (
            <button
              onClick={() =>
                void backend.cancelOperation(operationId.current ?? "")
              }
            >
              {tFor(zh ? "zh-CN" : "en-US", "workspaces.cancel.operation")}
            </button>
          )}
          {!result && (
            <button
              disabled={
                busy ||
                (!!preview && request.action === "delete" && !acknowledged)
              }
              onClick={() => void (preview ? confirm() : inspect())}
            >
              {busy
                ? tFor(zh ? "zh-CN" : "en-US", "workspaces.working")
                : preview
                  ? tFor(zh ? "zh-CN" : "en-US", "workspaces.confirm")
                  : tFor(zh ? "zh-CN" : "en-US", "workspaces.review")}
            </button>
          )}
          {result && (
            <button className="primary" onClick={onClose}>
              {tFor(zh ? "zh-CN" : "en-US", "workspaces.close")}
            </button>
          )}
        </>
      }
    >
      <p>
        {request.action === "delete"
          ? tr(
              "仅删除服务器上的工作区定义，不删除本机或 Depot 文件。存在待提交/搁置记录或打开文件时不能删除。",
              "Delete only the workspace definition; local and depot files remain. Pending/shelved changes or open files block deletion.",
            )
          : tr(
              "使用服务器原生重命名，保留工作进度；不采用复制后删除。要求服务器 2022.2+ 且允许此操作。",
              "Use native server rename preserving work in progress; no copy/delete fallback. Requires Server 2022.2+ and permission.",
            )}
      </p>
      {request.action === "rename" && !result && (
        <label>
          {tFor(zh ? "zh-CN" : "en-US", "workspaces.new.name")}
          <input
            disabled={busy}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setPreview(undefined);
            }}
          />
        </label>
      )}
      {preview && !result && (
        <>
          <DialogNotice>
            {preview.request.workspace}
            {preview.request.newName ? ` → ${preview.request.newName}` : ""}
            <br />
            Root: {preview.root}
            <br />
            Stream: {preview.stream || "—"}
            <br />
            {tr(
              "请确认以上目标。执行前会再次检查。",
              "Confirm this target. It will be revalidated before execution.",
            )}
          </DialogNotice>
          {request.action === "delete" && (
            <DialogNotice error>
              {tr(
                "删除工作区定义不可本地撤销；本机与 Depot 文件不受影响。",
                "Deleting the workspace definition cannot be undone locally; local and depot files are untouched.",
              )}
            </DialogNotice>
          )}
          {request.action === "delete" && (
            <label className="workflow-checkbox">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              {tr(
                "我确认永久删除该工作区定义",
                "I understand this permanently deletes the workspace definition",
              )}
            </label>
          )}
        </>
      )}
      {busy && !result && (
        <DialogNotice>
          {tr(
            "正在执行；关闭保护已启用，取消不会回滚已应用的服务器变更。",
            "Operation in progress; closing is protected and cancelling does not roll back changes already applied on the server.",
          )}
        </DialogNotice>
      )}
      {result && (
        <DialogNotice error={!resultVerified}>
          <strong>
            {resultVerified
              ? tFor(
                  zh ? "zh-CN" : "en-US",
                  "workspaces.verified.by.server.readback",
                )
              : result.outcome === "unknown"
                ? tFor(zh ? "zh-CN" : "en-US", "workspaces.outcome.uncertain")
                : tFor(
                    zh ? "zh-CN" : "en-US",
                    "workspaces.operation.did.not.succeed",
                  )}
          </strong>
          <br />
          {result.message}
          {result.failure && (
            <>
              <br />
              <code>{result.failure}</code>
            </>
          )}
          {request.action === "delete" &&
            result.observedExists !== undefined && (
              <>
                <br />
                {tFor(zh ? "zh-CN" : "en-US", "workspaces.workspace.readback")}
                {result.observedExists
                  ? tFor(zh ? "zh-CN" : "en-US", "workspaces.still.exists")
                  : tFor(zh ? "zh-CN" : "en-US", "workspaces.no.longer.exists")}
              </>
            )}
          {request.action === "rename" &&
            result.observedExists !== undefined && (
              <>
                <br />
                {tFor(zh ? "zh-CN" : "en-US", "workspaces.old.name.readback")}
                {result.observedExists
                  ? tFor(zh ? "zh-CN" : "en-US", "workspaces.still.exists")
                  : tFor(zh ? "zh-CN" : "en-US", "workspaces.no.longer.exists")}
              </>
            )}
        </DialogNotice>
      )}
      {(result?.outcome === "unknown" || error) && !resultVerified && (
        <DialogNotice error>
          {tr(
            "结果不确定时不自动重试、不更换操作号；请先刷新并核对工作区列表。",
            "Uncertain outcomes are never retried or re-dispatched with a new operation id; refresh and inspect the workspace list first.",
          )}
        </DialogNotice>
      )}
      {operationId.current && (
        <p className="workflow-context">
          {tFor(zh ? "zh-CN" : "en-US", "workspaces.operation")}{" "}
          {operationId.current}
        </p>
      )}
      {error && !result && <DialogNotice error>{error}</DialogNotice>}
    </Dialog>
  );
}
