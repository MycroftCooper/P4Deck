import { t, tFor } from "../../shared/i18n";
import { useMemo, useState } from "react";
import { Dialog, DialogNotice } from "../../app/dialogs/Dialog";
import { backend } from "../../infrastructure/backend";
import { useOperationSession } from "../../shared/operationSession";
import type {
  ConnectionUserCandidate,
  ConnectionUserDirectoryResult,
  ConnectionWorkspaceCandidate,
  ConnectionWorkspaceDirectoryResult,
  P4Context,
} from "../../shared/contracts";
import { connectionPresentation } from "./connectionWizard";

type DirectoryKind = "user" | "workspace";
type DirectoryResult =
  ConnectionUserDirectoryResult | ConnectionWorkspaceDirectoryResult;

export function ConnectionDirectoryDialog({
  kind,
  context,
  requestGeneration,
  fallbackUser,
  source,
  zh,
  onDismiss,
  onSelect,
}: {
  kind: DirectoryKind;
  context: P4Context;
  requestGeneration: number;
  fallbackUser: string;
  source: HTMLElement | null;
  zh: boolean;
  onDismiss(): void;
  onSelect(value: ConnectionUserCandidate | ConnectionWorkspaceCandidate): void;
}) {
  const snapshot = useMemo(() => ({ ...context }), []);
  const [prefix, setPrefix] = useState("");
  const [queryUser, setQueryUser] = useState(
    snapshot.user.trim() || fallbackUser.trim(),
  );
  const [result, setResult] = useState<DirectoryResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const session = useOperationSession();

  const identity = kind === "user" ? queryUser.trim() : snapshot.user.trim();
  const canQuery = !!snapshot.server.trim() && !!identity;

  async function browse() {
    if (busy || !canQuery) return;
    const lease = session.start("operation");
    setBusy(true);
    setError("");
    setResult(undefined);
    const requestContext = {
      ...snapshot,
      user: identity,
      client: "",
    };
    try {
      const next =
        kind === "user"
          ? await backend.browseConnectionUsers({
              context: requestContext,
              requestGeneration,
              operationId: lease.operationId,
              prefix: prefix.trim() || undefined,
            })
          : await backend.browseConnectionWorkspaces({
              context: requestContext,
              requestGeneration,
              operationId: lease.operationId,
              prefix: prefix.trim() || undefined,
            });
      if (!session.isCurrent(lease)) return;
      if (next.requestGeneration !== requestGeneration) {
        setError(t("settings.the.connection.settings.for.this.query"));
        return;
      }
      setResult(next);
    } catch (cause) {
      if (session.isCurrent(lease))
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (session.isCurrent(lease)) setBusy(false);
      session.finish(lease);
    }
  }

  const status = result
    ? connectionPresentation(result.connection, zh)
    : undefined;
  const connectionReady = result?.connection.state === "connected";
  const items = connectionReady ? (result?.items ?? []) : [];
  return (
    <Dialog
      title={
        kind === "user"
          ? t("settings.browse.server.users")
          : t("settings.browse.server.workspaces")
      }
      description={tFor(zh ? "zh-CN" : "en-US", "settings.queries.the.server", {
        p1: snapshot.server || "—",
      })}
      source={source}
      zh={zh}
      busy={false}
      onRequestClose={onDismiss}
      footer={
        <>
          <button type="button" className="secondary" onClick={onDismiss}>
            {t("settings.cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canQuery || busy}
            onClick={() => void browse()}
          >
            {busy ? t("settings.searching") : t("settings.search")}
          </button>
        </>
      }
    >
      {kind === "user" && (
        <label>
          {t("settings.query.identity")}
          <input
            data-dialog-autofocus
            value={queryUser}
            disabled={busy}
            spellCheck={false}
            onChange={(event) => {
              setQueryUser(event.target.value);
              setResult(undefined);
              setError("");
            }}
          />
          <small>{t("settings.this.is.the.explicit.p4.user")}</small>
        </label>
      )}
      <label>
        {t("settings.name.prefix")}
        <input
          data-dialog-autofocus={kind === "workspace" ? true : undefined}
          value={prefix}
          disabled={busy}
          spellCheck={false}
          onChange={(event) => {
            setPrefix(event.target.value);
            setResult(undefined);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void browse();
            }
          }}
        />
      </label>
      {!snapshot.server.trim() && (
        <DialogNotice error>{t("settings.enter.server.first")}</DialogNotice>
      )}
      {!identity && (
        <DialogNotice error>
          {kind === "user"
            ? t("settings.enter.to.use")
            : t("settings.enter.user.in.connection.settings.first")}
        </DialogNotice>
      )}
      {error && <DialogNotice error>{error}</DialogNotice>}
      {result && (
        <>
          <DialogNotice error={!connectionReady}>
            {result.simulated && "Browser Mock simulated · "}
            {connectionReady
              ? `${t("settings.query.succeeded")} · ${result.stats.matchedCount} / ${result.stats.scannedCount}`
              : `${status?.title} · ${status?.detail} ${t("settings.complete.the.corresponding.cli.trust")} ${status?.recovery}`}
            {connectionReady && (result.partial || result.truncated)
              ? t("settings.bounded.result.may.be.incomplete")
              : ""}
          </DialogNotice>
          {connectionReady && (
            <div
              className="connection-directory-list"
              role="listbox"
              aria-label={
                kind === "user"
                  ? t("settings.server.users")
                  : t("settings.server.workspaces")
              }
            >
              {items.map((item) => (
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  key={item.name}
                  disabled={
                    kind === "workspace" &&
                    "selectable" in item &&
                    !item.selectable
                  }
                  onClick={() => onSelect(item)}
                >
                  <strong>{item.name}</strong>
                  <span>
                    {kind === "user"
                      ? [
                          "fullName" in item ? item.fullName : undefined,
                          "email" in item ? item.email : undefined,
                        ]
                          .filter(Boolean)
                          .join(" · ") || t("settings.no.additional.details")
                      : [
                          "root" in item ? item.root : undefined,
                          "stream" in item ? item.stream : undefined,
                          "rootStatus" in item && item.rootStatus !== "usable"
                            ? tFor(
                                zh ? "zh-CN" : "en-US",
                                "settings.root.unavailable",
                                { p1: item.rootStatus },
                              )
                            : undefined,
                        ]
                          .filter(Boolean)
                          .join(" · ") || t("settings.no.additional.details")}
                  </span>
                </button>
              ))}
              {!items.length && (
                <p role="status">
                  {t("settings.no.matches.the.server.returns.bounded")}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
