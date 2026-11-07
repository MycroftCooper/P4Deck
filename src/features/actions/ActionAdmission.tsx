import { t } from "../../shared/i18n";
import { useEffect, useState, useSyncExternalStore } from "react";
import { backend } from "../../infrastructure/backend";
import { admissionPort } from "./admissionPort";
import { createAdmissionView, type WriteFence } from "./admission";
type Controller = ReturnType<typeof createAdmissionView>;
function FenceRow({
  fence,
  controller,
  busy,
  zh: _zh,
}: {
  fence: WriteFence;
  controller: Controller;
  busy: boolean;
  zh: boolean;
}) {
  const [ack, setAck] = useState(false);
  return (
    <li style={{ padding: "6px 0" }}>
      <span>
        {fence.operationId} · {fence.scope.server} / {fence.scope.user} /{" "}
        {fence.scope.client} ·{" "}
        {fence.active
          ? t("actions.still.running")
          : t("actions.outcome.unknown")}
      </span>
      {!fence.active && fence.outcome === "unknown" && (
        <div>
          <label>
            <input
              type="checkbox"
              checked={ack}
              disabled={busy}
              onChange={(e) => setAck(e.target.checked)}
            />
            {t("actions.i.the.operation")}
          </label>
          <button
            className="settings-secondary"
            disabled={!ack || busy}
            onClick={() => void controller.release(fence, ack)}
          >
            {t("actions.release.this.write.block")}
          </button>
        </div>
      )}
    </li>
  );
}
export function AdmissionList({
  controller,
  zh,
}: {
  controller: Controller;
  zh: boolean;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  if (!state.fences.length) return null;
  return (
    <section aria-label={t("actions.unresolved.write.blocks")}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {state.fences.map((f) => (
          <FenceRow
            key={`${f.fenceId}:${f.revision}`}
            fence={f}
            controller={controller}
            busy={state.releasing.includes(f.fenceId)}
            zh={zh}
          />
        ))}
      </ul>
    </section>
  );
}
function AdmissionScope({ zh }: { zh: boolean }) {
  const [controller, setController] = useState<Controller>();
  useEffect(() => {
    let disposed = false;
    let owner: Controller | undefined;
    void backend
      .companySubmitConnectionSnapshot()
      .then((connection) => {
        if (disposed) return;
        owner = createAdmissionView(connection, admissionPort);
        setController(owner);
        void owner.start();
      })
      .catch(() => {
        if (!disposed) admissionPort.log(crypto.randomUUID(), "refresh");
      });
    return () => {
      disposed = true;
      owner?.dispose();
    };
  }, []);
  return controller ? <AdmissionList controller={controller} zh={zh} /> : null;
}
export function ActionAdmission({
  native,
  connectionKey,
  zh,
}: {
  native: boolean;
  connectionKey: string;
  zh: boolean;
}) {
  return native ? <AdmissionScope key={connectionKey} zh={zh} /> : null;
}
