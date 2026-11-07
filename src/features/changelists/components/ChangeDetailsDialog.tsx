import { tFor, t } from "../../../shared/i18n";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { backend } from "../../../infrastructure/backend";
import type {
  PendingChange,
  RuntimeInfo,
  SubmittedChangeDetail,
} from "../../../shared/contracts";
import { ResizableTable } from "../../../app/context-menu/ResizableTable";
import { FileStatusIcon } from "../../files/components/FileStatusIcon";
import { UnshelveDialog } from "./UnshelveDialog";
export type ChangeDetailsTarget =
  | {
      kind: "submitted";
      changeId: number;
      onLoaded?(value: SubmittedChangeDetail): void;
    }
  | { kind: "pending"; changeId: number; snapshot?: PendingChange };
export type OpenChangeDetails = (
  target: ChangeDetailsTarget,
  source?: HTMLElement | null,
) => void;
export const ChangeDetailsContext = createContext<OpenChangeDetails | null>(
  null,
);
export const useChangeDetails = () => useContext(ChangeDetailsContext);
export function useChangeDetailsDialog(
  runtime: RuntimeInfo,
  connectionKey: string,
  zh: boolean,
) {
  const [request, setRequest] = useState<{
    target: ChangeDetailsTarget;
    source: HTMLElement | null;
    owner: string;
    nonce: number;
  }>();
  /** Pending "unshelve this CL's shelved files into a new CL" workflow. */
  const [unshelve, setUnshelve] = useState<{
    changeId: number;
    paths: string[];
  }>();
  const nonce = useRef(0);
  const owner = `${connectionKey}:${runtime.activeProfileId}:${runtime.contextGeneration}`;
  const open = useCallback<OpenChangeDetails>(
    (target, source) => {
      if (
        !Number.isSafeInteger(target.changeId) ||
        target.changeId < (target.kind === "pending" ? 0 : 1)
      )
        return;
      const fallback =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const nextNonce = ++nonce.current;
      setUnshelve(undefined);
      setRequest((previous) => ({
        target,
        source:
          source ?? (previous?.owner === owner ? previous.source : fallback),
        owner,
        nonce: nextNonce,
      }));
    },
    [owner],
  );
  const openUnshelve = useCallback((detail: SubmittedChangeDetail) => {
    const paths = [
      ...new Set(
        detail.files
          .map((file) => file.depotPath)
          .filter((path) => path.length > 0),
      ),
    ];
    if (!paths.length) return;
    setRequest(undefined);
    setUnshelve({ changeId: detail.changeId, paths });
  }, []);
  useEffect(() => {
    setRequest(undefined);
    setUnshelve(undefined);
  }, [owner]);
  return {
    open,
    dialog: (
      <>
        {request?.owner === owner ? (
          <ChangeDetailsDialog
            key={`${owner}:${request.nonce}`}
            target={request.target}
            source={request.source}
            runtime={runtime}
            zh={zh}
            onUnshelveIntoNewChange={openUnshelve}
            onClose={() => setRequest(undefined)}
          />
        ) : null}
        {unshelve ? (
          <UnshelveDialog
            request={{
              changeId: unshelve.changeId,
              paths: unshelve.paths,
              mode: "shelve",
              hasShelf: true,
              source: null,
            }}
            changes={[]}
            currentWorkspace={runtime.context.client}
            connectionKey={connectionKey}
            demo={runtime.mode === "mock"}
            zh={zh}
            newChangeDescription={`Unshelved from CL${unshelve.changeId}`}
            onDismiss={() => setUnshelve(undefined)}
          />
        ) : null}
      </>
    ),
  };
}
function ChangeDetailsDialog({
  target,
  source,
  runtime,
  zh,
  onClose,
  onUnshelveIntoNewChange,
}: {
  target: ChangeDetailsTarget;
  source: HTMLElement | null;
  runtime: RuntimeInfo;
  zh: boolean;
  onClose(): void;
  /** Only offered for a non-submitted CL whose shelved files are listed. */
  onUnshelveIntoNewChange?(detail: SubmittedChangeDetail): void;
}) {
  const [value, setValue] = useState<SubmittedChangeDetail>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    const operationId = crypto.randomUUID();
    setValue(undefined);
    setError("");
    const load = async () => {
      if (target.kind === "pending" && target.snapshot)
        return pendingDetail(target.snapshot);
      if (runtime.mode !== "mock" && runtime.connection.state !== "connected")
        throw new Error(
          tFor(zh ? "zh-CN" : "en-US", "pending.connection.unavailable"),
        );
      if (target.kind === "submitted")
        return backend.getSubmittedChangeDetail({
          changeId: target.changeId,
          operationId,
        });
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
        const page = await backend.queryPendingChanges({
          operationId,
          requestGeneration: retry,
          keyword: "",
          sort: "newest",
          pageSize: 100,
          cursor,
        });
        if (!live) throw new Error("Cancelled");
        const found = [
          ...(page.defaultChange ? [page.defaultChange] : []),
          ...page.items,
        ].find((c) => c.id === target.changeId);
        if (found) return pendingDetail(found);
        if (!page.hasMore || !page.nextCursor || seen.has(page.nextCursor))
          break;
        cursor = page.nextCursor;
        seen.add(cursor);
      }
      throw new Error(t("pending.pending.changelist.not.found.or.results"));
    };
    void load()
      .then((detail) => {
        if (!live) return;
        if (detail.changeId !== target.changeId)
          throw new Error(t("pending.returned.not.match"));
        if (detail.inspectionStatus === "unavailable")
          throw new Error(
            detail.message ||
              tFor(zh ? "zh-CN" : "en-US", "pending.details.unavailable"),
          );
        setValue(detail);
        // A pending/shelved CL answered through the submitted path must not be
        // reported back as a submitted-row classification update.
        const detailStatus = detail.status?.trim().toLowerCase();
        const submittedDetail = detailStatus
          ? detailStatus === "submitted"
          : target.kind === "submitted";
        if (target.kind === "submitted" && submittedDetail)
          target.onLoaded?.(detail);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
      void backend.cancelOperation(operationId).catch(() => undefined);
    };
  }, [target, runtime, retry]);
  const time =
    value?.time && Number.isFinite(Date.parse(value.time))
      ? new Intl.DateTimeFormat(zh ? "zh-CN" : "en", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value.time))
      : "—";
  // Backends now report the real status; fixtures without it fall back to the
  // page that opened the dialog (submitted describe vs. pending snapshot).
  const status = value?.status?.trim().toLowerCase();
  const submitted = status
    ? status === "submitted"
    : target.kind === "submitted";
  const statusKind: "submitted" | "pending" | "unknown" = status
    ? status === "submitted"
      ? "submitted"
      : status === "pending" || status === "shelved"
        ? "pending"
        : "unknown"
    : target.kind === "submitted"
      ? "submitted"
      : "pending";
  const statusLabel =
    statusKind === "submitted"
      ? tFor(zh ? "zh-CN" : "en-US", "pending.submitted")
      : statusKind === "pending"
        ? tFor(zh ? "zh-CN" : "en-US", "pending.pending")
        : tFor(zh ? "zh-CN" : "en-US", "pending.unknown");
  // A CL reached through the submitted path that turns out to be pending only
  // exposes shelved files; the pending snapshot path lists opened files.
  const shelvedFiles = target.kind === "submitted" && !submitted;
  const notice =
    value?.message ||
    (shelvedFiles
      ? t("pending.this.changelist.is.not.submitted.yet")
      : value?.inspectionStatus === "partial"
        ? tFor(zh ? "zh-CN" : "en-US", "pending.file.list.may.be.incomplete")
        : undefined);
  return (
    <Dialog
      title={`${tFor(zh ? "zh-CN" : "en-US", "pending.changelist.details")} · ${target.changeId || "default"}${
        value && value.files.length
          ? ` · ${value.files.length} ${
              shelvedFiles
                ? tFor(zh ? "zh-CN" : "en-US", "pending.shelved.files")
                : tFor(zh ? "zh-CN" : "en-US", "pending.files")
            }`
          : ""
      }`}
      // Status lives in the title bar as a colored badge so it is the first
      // thing read; the metadata list below no longer repeats it.
      titleBadge={
        value ? (
          <span className={`dialog-status-badge is-${statusKind}`}>
            {statusLabel}
          </span>
        ) : undefined
      }
      source={source}
      zh={zh}
      onRequestClose={onClose}
      footer={
        <button data-dialog-autofocus onClick={onClose}>
          {tFor(zh ? "zh-CN" : "en-US", "pending.close")}
        </button>
      }
    >
      <div className="change-details-dialog">
        {runtime.mode === "mock" && (
          <DialogNotice>
            {t("pending.simulated.data.no.real.p4.server")}
          </DialogNotice>
        )}
        {!value && !error && (
          <DialogNotice>
            {tFor(zh ? "zh-CN" : "en-US", "pending.loading")}
          </DialogNotice>
        )}
        {error && (
          <>
            <DialogNotice error>{error}</DialogNotice>
            <button onClick={() => setRetry((v) => v + 1)}>
              {tFor(zh ? "zh-CN" : "en-US", "pending.retry")}
            </button>
          </>
        )}
        {target.kind === "pending" && target.snapshot && (
          <DialogNotice>
            {tFor(zh ? "zh-CN" : "en-US", "pending.current.list.snapshot")}
          </DialogNotice>
        )}
        {value && (
          <>
            <dl className="change-details-meta">
              <div>
                <dt>CL</dt>
                <dd>{value.changeId || "default"}</dd>
              </div>
              <div>
                <dt>{tFor(zh ? "zh-CN" : "en-US", "pending.user")}</dt>
                <dd>{value.user || "—"}</dd>
              </div>
              <div>
                <dt>{tFor(zh ? "zh-CN" : "en-US", "pending.time")}</dt>
                <dd>{time}</dd>
              </div>
              <div>
                <dt>{tFor(zh ? "zh-CN" : "en-US", "pending.workspace")}</dt>
                <dd>{value.client || "—"}</dd>
              </div>
            </dl>
            <h3>{tFor(zh ? "zh-CN" : "en-US", "pending.description")}</h3>
            <p className="change-details-description">
              {value.description ||
                tFor(zh ? "zh-CN" : "en-US", "pending.no.description")}
            </p>
            {notice && <DialogNotice>{notice}</DialogNotice>}
            <h3>
              {shelvedFiles
                ? tFor(zh ? "zh-CN" : "en-US", "pending.shelved.files.2")
                : tFor(zh ? "zh-CN" : "en-US", "pending.files.2")}
            </h3>
            {value.files.length ? (
              <div
                className="change-details-table-scroll"
                data-testid="change-details-files-scroll"
              >
                <ResizableTable
                  tableId="change-details-files"
                  defaults={[220, 300, 120, 100, 80]}
                  minimums={[120, 160, 80, 70, 60]}
                  className="change-details-files-table"
                >
                  <thead>
                    <tr>
                      <th>
                        {tFor(zh ? "zh-CN" : "en-US", "pending.file.name")}
                      </th>
                      <th>{tFor(zh ? "zh-CN" : "en-US", "pending.path")}</th>
                      <th>{tFor(zh ? "zh-CN" : "en-US", "pending.type")}</th>
                      <th>{tFor(zh ? "zh-CN" : "en-US", "pending.action")}</th>
                      <th>
                        {tFor(zh ? "zh-CN" : "en-US", "pending.revision")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {value.files.map((file) => {
                      const name =
                        file.depotPath.split("/").at(-1) || file.depotPath;
                      const parent = file.depotPath.includes("/")
                        ? file.depotPath.slice(
                            0,
                            file.depotPath.lastIndexOf("/") + 1,
                          )
                        : "";
                      return (
                        <tr
                          key={`${file.depotPath}#${file.revision ?? "unknown"}`}
                        >
                          <td>
                            <span className="change-details-file-name">
                              <FileStatusIcon
                                facts={{ scope: "revision" }}
                                zh={zh}
                              />
                              <span
                                title={`${name}${file.fileType ? ` · ${file.fileType}` : ""}`}
                              >
                                {name}
                              </span>
                            </span>
                          </td>
                          <td title={file.depotPath}>
                            <span className="change-details-file-path">
                              {parent || "—"}
                            </span>
                          </td>
                          <td>{file.fileType || "—"}</td>
                          <td>{file.action || "—"}</td>
                          <td>
                            {file.revision === undefined
                              ? "#?"
                              : `#${file.revision}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </ResizableTable>
              </div>
            ) : (
              <p>
                {shelvedFiles
                  ? tFor(zh ? "zh-CN" : "en-US", "pending.no.shelved.files")
                  : tFor(zh ? "zh-CN" : "en-US", "pending.no.files")}
              </p>
            )}
            {shelvedFiles && value.files.length > 0 && (
              <button
                className="secondary"
                onClick={() => onUnshelveIntoNewChange?.(value)}
              >
                {tFor(zh ? "zh-CN" : "en-US", "pending.unshelve.into.new.cl")}
              </button>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
function pendingDetail(change: PendingChange): SubmittedChangeDetail {
  return {
    changeId: change.id,
    description: change.description,
    user: change.user,
    client: change.client,
    time: change.updatedAt || "",
    jobs: change.jobs,
    files: change.files,
    integrationEvidence: [],
    mergeClassification: "unknown",
    inspectionStatus: "complete",
    status: "pending",
  };
}
