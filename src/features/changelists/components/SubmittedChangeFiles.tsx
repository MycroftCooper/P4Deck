import { t, tFor } from "../../../shared/i18n";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ArrowDownToLine } from "lucide-react";
import { backend } from "../../../infrastructure/backend";
import type {
  RuntimeInfo,
  SubmittedChangeDetail,
} from "../../../shared/contracts";
import { invalidateData } from "../../../shared/cache/dataEffects";
import { commandActions } from "../../../app/commands/actionCatalog";
import { SyncDialog } from "../../files/components/SyncDialog";
import { RevisionFileList } from "./RevisionFileList";

export function SubmittedChangeFiles({
  changeId,
  scope,
  connectionKey,
  cache,
  runtime,
  zh,
  outerScroll,
  onHeight,
}: {
  changeId: number;
  scope: string;
  connectionKey: string;
  cache: Map<number, SubmittedChangeDetail>;
  runtime: RuntimeInfo;
  zh: boolean;
  outerScroll?: RefObject<HTMLDivElement | null>;
  onHeight?(height: number): void;
}) {
  const element = useRef<HTMLElement>(null);
  const reportHeight = useRef(onHeight);
  reportHeight.current = onHeight;
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      const height = node.getBoundingClientRect().height;
      if (height > 0 && Number.isFinite(height))
        reportHeight.current?.(Math.ceil(height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [scope, changeId]);
  const [detail, setDetail] = useState(() => cache.get(changeId));
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [syncRequest, setSyncRequest] = useState<{
    paths: string[];
    source: HTMLElement;
  }>();
  useEffect(() => {
    let live = true;
    const cached = cache.get(changeId);
    setDetail(cached);
    setError("");
    if (cached) return;
    const operationId = crypto.randomUUID();
    const load = async () => {
      if (runtime.mode !== "mock" && runtime.connection.state !== "connected")
        throw new Error(t("pending.connection.unavailable"));
      const result = await backend.getSubmittedChangeDetail({
        changeId,
        operationId,
      });
      if (!live) return;
      if (result.changeId !== changeId)
        throw new Error(t("pending.returned.cl.does.not.match"));
      if (result.inspectionStatus === "unavailable")
        throw new Error(result.message || t("pending.details.unavailable"));
      cache.set(changeId, result);
      setDetail(result);
    };
    void load().catch((cause) => {
      if (live) setError(String(cause));
    });
    return () => {
      live = false;
      void backend.cancelOperation(operationId).catch(() => undefined);
    };
  }, [
    changeId,
    scope,
    cache,
    attempt,
    runtime.mode,
    runtime.connection.state,
    zh,
  ]);
  return (
    <section
      ref={element}
      className="submitted-change-files"
      aria-label={`${t("pending.changed.files")} · CL ${changeId}`}
    >
      {!detail && !error && <p role="status">{t("pending.loading.files")}</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            className="secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t("pending.retry")}
          </button>
        </p>
      )}
      {detail && (
        <>
          <p className="submitted-files-count" role="status">
            {detail.inspectionStatus === "complete"
              ? tFor(zh ? "zh-CN" : "en-US", "pending.fileCount", {
                  count: detail.files.length,
                })
              : tFor(
                  zh ? "zh-CN" : "en-US",
                  "pending.files.loaded.total.unknown",
                  { p1: zh ? detail.files.length : detail.files.length },
                )}
          </p>
          {detail.inspectionStatus !== "complete" && (
            <p role="status">
              {detail.message || t("pending.file.list.may.be.incomplete")}
            </p>
          )}
          {detail.files.length > 0 && (
            <div className="submitted-files-actions">
              <button
                className="secondary"
                onClick={(event) =>
                  setSyncRequest({
                    paths: [
                      ...new Set(detail.files.map((file) => file.depotPath)),
                    ],
                    source: event.currentTarget,
                  })
                }
              >
                <ArrowDownToLine size={15} aria-hidden="true" />
                <span>
                  {tFor(zh ? "zh-CN" : "en-US", "pending.sync.to.cl.revision")}
                </span>
              </button>
            </div>
          )}
          {detail.files.length ? (
            <RevisionFileList
              files={detail.files.map((file) => ({ ...file, changeId }))}
              scope={`${scope}:${changeId}`}
              demo={runtime.mode === "mock"}
              outerScroll={outerScroll}
            />
          ) : (
            <p>
              {detail.inspectionStatus === "complete"
                ? t("pending.no.files.to.display")
                : t("pending.no.files.loaded.yet.listing")}
            </p>
          )}
        </>
      )}
      {syncRequest && (
        <SyncDialog
          request={{
            nodes: [],
            revisionMode: "change",
            fixedChange: changeId,
            paths: syncRequest.paths,
            scopeLabel: `CL ${changeId}`,
            source: syncRequest.source,
          }}
          connectionKey={connectionKey}
          demo={runtime.mode === "mock"}
          zh={zh}
          onDismiss={() => setSyncRequest(undefined)}
          onRefresh={() =>
            void invalidateData(commandActions.getLatest.effects, {
              connectionKey,
            }).catch(() => undefined)
          }
        />
      )}
    </section>
  );
}
