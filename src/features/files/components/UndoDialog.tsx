import { tFor } from "../../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "../../../app/dialogs/Dialog";
import { backend } from "../../../infrastructure/backend";
import type { UndoTarget, UndoPreview } from "../../../shared/contracts";
import {
  beginLocalIoProjection,
  lifecycleOf,
  settleLocalIoProjection,
  unwrapLocalIoLegacy,
  withdrawLocalIoProjection,
} from "../../actions/localIoLifecycle";

export interface UndoDialogRequest extends UndoTarget {
  source: HTMLElement | null;
}
export function UndoDialog({
  request,
  zh,
  onDismiss,
  onRefresh,
}: {
  request: UndoDialogRequest;
  zh: boolean;
  onDismiss(): void;
  onRefresh(): void;
}) {
  const [target] = useState<UndoTarget>(() => ({
    depotPath: request.depotPath,
    revision: request.revision,
    changelistId: request.changelistId,
  }));
  const [plan, setPlan] = useState<UndoPreview>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [finished, setFinished] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (confirm: boolean) => {
    if (inFlight.current || (confirm && !plan)) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    const reviewed = plan;
    setPlan(undefined);
    try {
      if (!confirm) {
        const next = await backend.previewUndo(target);
        if (
          next.target.depotPath !== target.depotPath ||
          next.target.revision !== target.revision ||
          next.target.changelistId !== target.changelistId ||
          !next.token ||
          next.expiresAt <= Date.now()
        )
          throw new Error(
            tFor(
              zh ? "zh-CN" : "en-US",
              "files.preview.target.differs.or.expired",
            ),
          );
        if (mounted.current) setPlan(next);
      } else {
        const operationId = crypto.randomUUID();
        beginLocalIoProjection({
          operationId,
          kind: "undoChange",
          paths: [target.depotPath],
          targetState: "openedEdit",
          changelistId: target.changelistId,
        });
        const raw: unknown = await backend.confirmUndo({
          target,
          token: reviewed!.token,
          operationId,
        } as never);
        const lifecycle = lifecycleOf(raw);
        const legacy =
          unwrapLocalIoLegacy<
            import("../../../shared/contracts").OperationResult
          >(raw);
        if (!lifecycle || !legacy) {
          withdrawLocalIoProjection(operationId);
          onRefresh();
          if (mounted.current) {
            setFinished(true);
            setMessage(
              tFor(zh ? "zh-CN" : "en-US", "files.undo.result.inspect"),
            );
          }
          return;
        }
        if (
          lifecycle.state === "unknown" ||
          lifecycle.state === "rejected" ||
          lifecycle.state === "legacy"
        ) {
          settleLocalIoProjection(operationId, lifecycle, false);
          onRefresh();
          if (mounted.current) {
            setFinished(true);
            setMessage(
              tFor(
                zh ? "zh-CN" : "en-US",
                "files.undo.outcome.is.unconfirmed.rows.were",
              ),
            );
          }
          return;
        }
        settleLocalIoProjection(operationId, lifecycle, false);
        void Promise.resolve(onRefresh())
          .then(() => settleLocalIoProjection(operationId, lifecycle, true))
          .catch(() => undefined);
        if (mounted.current) {
          setFinished(true);
          setMessage(
            lifecycle.outcome === "succeeded"
              ? tFor(
                  zh ? "zh-CN" : "en-US",
                  "files.undo.saved.to.the.default.pending",
                )
              : tFor(
                  zh ? "zh-CN" : "en-US",
                  "files.undo.did.not.complete.cleanly.partial",
                ),
          );
        }
      }
    } catch (error) {
      if (confirm) onRefresh();
      if (mounted.current) {
        setMessage(String(error));
        if (confirm) setFinished(true);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Dialog
      title={tFor(zh ? "zh-CN" : "en-US", "files.undo.this.revision")}
      zh={zh}
      danger
      busy={busy}
      source={request.source}
      onRequestClose={onDismiss}
      description={tFor(
        zh ? "zh-CN" : "en-US",
        "files.undo.changes.introduced",
      )}
      footer={
        <>
          <button disabled={busy} onClick={onDismiss}>
            {tFor(zh ? "zh-CN" : "en-US", "files.close")}
          </button>
          {!finished && (
            <button disabled={busy} onClick={() => void run(false)}>
              {tFor(zh ? "zh-CN" : "en-US", "files.preview")}
            </button>
          )}
          {plan && !finished && (
            <button disabled={busy} onClick={() => void run(true)}>
              {tFor(zh ? "zh-CN" : "en-US", "files.confirm.undo")}
            </button>
          )}
        </>
      }
    >
      <p style={{ overflowWrap: "anywhere" }}>
        {target.depotPath}#{target.revision} · CL {target.changelistId}
      </p>
      <p>
        {tFor(
          zh ? "zh-CN" : "en-US",
          "files.destination.default.pending.changelist.no.automatic",
        )}
      </p>
      {plan && (
        <div>
          <p>
            {tFor(
              zh ? "zh-CN" : "en-US",
              "files.single.file.preview.verified.confirmation.rechecks",
            )}
          </p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {plan.messages.join("\n")}
          </pre>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </Dialog>
  );
}
