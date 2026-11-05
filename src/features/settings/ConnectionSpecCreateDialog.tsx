import { t, tFor } from "../../shared/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useUnsavedEditor } from "../../app/closeGuard";
import { Dialog, DialogNotice } from "../../app/dialogs/Dialog";
import { backend } from "../../infrastructure/backend";
import type { ConnectionSnapshot } from "../companySubmit/model";
import {
  lookupConnectionCreateAction,
  validConnectionCreateReceipt,
  type ConnectionCreateActionLookup,
} from "../actions/workflowReceipt";
import type {
  ConnectionSpecCreatePreflight,
  ConnectionSpecCreateResult,
  ConnectionWorkspaceCandidate,
  ConnectionWorkspaceCreatePlan,
  ConnectionWorkspaceMapping,
  P4Context,
} from "../../shared/contracts";
import { tokenize } from "../../shared/lib/tokenize";

type CreateKind = "user" | "workspace";
type Phase = "edit" | "review" | "result";

function parseClassicView(value: string): ConnectionWorkspaceMapping {
  return {
    kind: "classic",
    view: value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = tokenize(line);
        if (parts.length !== 2)
          throw new Error("Each View line needs depot and client paths.");
        return { depotPath: parts[0], clientPath: parts[1] };
      }),
  };
}

export function ConnectionSpecCreateDialog({
  kind,
  context,
  requestGeneration,
  source,
  zh,
  onDismiss: dismissCallback,
  onCreated,
  connection: connectionProvider,
  lookup: lookupReceipt,
}: {
  kind: CreateKind;
  context: P4Context;
  requestGeneration: number;
  source: HTMLElement | null;
  zh: boolean;
  onDismiss(): void;
  onCreated(value: string | ConnectionWorkspaceCandidate): void;
  /** Exact dispatching connection snapshot; captured once per confirm. */
  connection?(): Promise<ConnectionSnapshot>;
  /** Durable receipt recovery by the SAME operationId. */
  lookup?(request: {
    operationId: string;
    connection: ConnectionSnapshot;
  }): Promise<ConnectionCreateActionLookup>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const snapshot = useMemo(() => ({ ...context }), []);
  const [phase, setPhase] = useState<Phase>("edit");
  const [name, setName] = useState(
    kind === "user" ? snapshot.user : snapshot.client,
  );
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [root, setRoot] = useState("");
  const [description, setDescription] = useState("");
  const [mappingKind, setMappingKind] = useState<"stream" | "classic">(
    "stream",
  );
  const [stream, setStream] = useState("");
  const [classicView, setClassicView] = useState("");
  const [syncMode, setSyncMode] =
    useState<ConnectionWorkspaceCreatePlan["syncMode"]>("standard");
  const [preflight, setPreflight] = useState<ConnectionSpecCreatePreflight>();
  const [result, setResult] = useState<ConnectionSpecCreateResult>();
  const formState = JSON.stringify([
    name,
    fullName,
    email,
    root,
    description,
    mappingKind,
    stream,
    classicView,
    syncMode,
  ]);
  const [savedForm, setSavedForm] = useState(formState);
  const clearUnsaved = useUnsavedEditor(
    formState !== savedForm ? "dirty" : "clean",
  );
  const onDismiss = () => {
    clearUnsaved();
    dismissCallback();
  };
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const operation = useRef<string | undefined>(undefined);

  useEffect(
    () => () => {
      sequence.current += 1;
      if (operation.current)
        void Promise.resolve(backend.cancelOperation(operation.current)).catch(
          () => undefined,
        );
    },
    [],
  );

  function workspaceMapping() {
    if (mappingKind === "stream")
      return { kind: "stream", stream: stream.trim() } as const;
    return parseClassicView(classicView);
  }

  async function inspect() {
    if (busy) return;
    const trimmedName = name.trim();
    if (!snapshot.server.trim()) {
      setError(t("settings.enter.server.first"));
      return;
    }
    if (!trimmedName) {
      setError(t("settings.name.is.required"));
      return;
    }
    if (
      kind === "user" &&
      (!fullName.trim() || !email.trim() || !email.includes("@"))
    ) {
      setError(t("settings.full.name.and.a.valid.email"));
      return;
    }
    if (kind === "workspace" && !snapshot.user.trim()) {
      setError(t("settings.enter.user.in.connection.settings.first"));
      return;
    }
    let mapping: ConnectionWorkspaceMapping | undefined;
    try {
      if (kind === "workspace") mapping = workspaceMapping();
    } catch (cause) {
      setError(
        zh
          ? tFor(zh ? "zh-CN" : "en-US", "settings.classicViewNeedsPaths")
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
      return;
    }
    const seq = ++sequence.current;
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    setBusy(true);
    setError("");
    setPreflight(undefined);
    setConfirmed(false);
    try {
      const next =
        kind === "user"
          ? await backend.preflightCreateConnectionUser({
              context: { ...snapshot, user: trimmedName, client: "" },
              requestGeneration,
              operationId,
              plan: {
                name: trimmedName,
                fullName: fullName.trim(),
                email: email.trim(),
              },
            })
          : await backend.preflightCreateConnectionWorkspace({
              context: { ...snapshot, client: "" },
              requestGeneration,
              operationId,
              plan: {
                name: trimmedName,
                root: root.trim(),
                description: description.trim() || undefined,
                mapping: mapping!,
                syncMode,
              },
            });
      if (seq !== sequence.current) return;
      if (next.requestGeneration !== requestGeneration) {
        setError(t("settings.the.connection.settings.for.this.preflight"));
        return;
      }
      setPreflight(next);
      setPhase("review");
    } catch (cause) {
      if (seq === sequence.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === sequence.current) {
        operation.current = undefined;
        setBusy(false);
      }
    }
  }

  /** One same-operationId receipt lookup. `settled` is persisted, never success. */
  async function recover(
    operationId: string,
    dispatching: ConnectionSnapshot,
  ): Promise<ConnectionSpecCreateResult | undefined> {
    try {
      const request = { operationId, connection: dispatching };
      const lookup = await (lookupReceipt ?? lookupConnectionCreateAction)(
        request,
      );
      if (
        lookup.kind === "found" &&
        validConnectionCreateReceipt(
          request,
          lookup.receipt,
          kind === "user"
            ? "connectionCreateUser"
            : "connectionCreateWorkspace",
        ) &&
        lookup.receipt.state === "settled" &&
        lookup.receipt.result
      )
        return lookup.receipt.result;
    } catch {
      /* Lookup failure never retries the write. */
    }
    return undefined;
  }

  async function create() {
    if (busy || !confirmed || !preflight?.ready || !preflight.token) return;
    if (preflight.expiresAt <= Date.now()) {
      setError(t("settings.the.preflight.expired.run.it.again"));
      setPreflight(undefined);
      setConfirmed(false);
      setPhase("edit");
      return;
    }
    const seq = ++sequence.current;
    // One UUID for dispatch + same-id receipt lookup; never a retry identity.
    const operationId = crypto.randomUUID();
    operation.current = operationId;
    setBusy(true);
    setError("");
    let dispatching: ConnectionSnapshot | undefined;
    try {
      dispatching = await (
        connectionProvider ?? (() => backend.companySubmitConnectionSnapshot())
      )();
      if (seq !== sequence.current) return;
      // Generation is the drift marker captured for the same-id receipt lookup;
      // the host revalidates the full exact context (server/user/client) itself.
      if (String(requestGeneration) !== dispatching.generation)
        throw new Error(
          t("settings.connection.generation.changed.nothing.was.created"),
        );
      const confirmation = {
        token: preflight.token,
        operationId,
        context:
          kind === "user"
            ? { ...snapshot, user: preflight.name, client: "" }
            : { ...snapshot, client: "" },
        requestGeneration,
        stateDigest: preflight.stateDigest,
        confirmed: true,
      };
      let next =
        kind === "user"
          ? await backend.confirmCreateConnectionUser(confirmation)
          : await backend.confirmCreateConnectionWorkspace(confirmation);
      if (seq !== sequence.current) return;
      if (next.outcome === "unknown")
        next = (await recover(operationId, dispatching)) ?? next;
      if (seq !== sequence.current) return;
      setResult(next);
      if (next.outcome === "created") setSavedForm(formState);
      setPhase("result");
    } catch (cause) {
      if (seq !== sequence.current) return;
      const recovered = dispatching
        ? await recover(operationId, dispatching)
        : undefined;
      if (seq !== sequence.current) return;
      if (recovered) {
        setResult(recovered);
        if (recovered.outcome === "created") setSavedForm(formState);
        setPhase("result");
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setResult({
        outcome: "unknown",
        failure: "verificationFailed",
        kind: kind === "user" ? "userSelf" : "workspace",
        name: preflight.name,
        message: t("settings.outcome.uncertain.the.creation.may.have"),
        operationIds: [operationId],
        simulated: false,
      });
      setPhase("result");
    } finally {
      if (seq === sequence.current) {
        operation.current = undefined;
        setBusy(false);
      }
    }
  }

  const issues = [
    ...(preflight?.blockers ?? []),
    ...(preflight?.warnings ?? []),
  ];
  const created = result?.outcome === "created";
  const createdWorkspaceUsable =
    kind === "user" ||
    (!!result?.workspace &&
      result.workspace.selectable &&
      result.workspace.rootStatus === "usable");
  return (
    <Dialog
      title={
        kind === "user"
          ? t("settings.create.p4.user")
          : t("settings.create.workspace")
      }
      description={tr(
        `目标服务器：${snapshot.server || "—"}。打开或取消不会写服务器；只有预检后明确确认才会创建。创建成功也只填入当前设置，不会自动保存或切换连接。`,
        `Target server: ${snapshot.server || "—"}. Opening or cancelling does not write to the server; creation requires preflight and explicit confirmation. Success only fills the current settings and never saves or switches connections automatically.`,
      )}
      source={source}
      zh={zh}
      busy={busy && phase !== "edit"}
      onRequestClose={onDismiss}
      footer={
        phase === "edit" ? (
          <>
            <button type="button" className="secondary" onClick={onDismiss}>
              {t("settings.cancel")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void inspect()}
            >
              {busy ? t("settings.checking.2") : t("settings.preflight")}
            </button>
          </>
        ) : phase === "review" ? (
          <>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setPhase("edit");
                setPreflight(undefined);
                setConfirmed(false);
              }}
            >
              {t("settings.back")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={
                !preflight?.ready || !preflight.token || !confirmed || busy
              }
              onClick={() => void create()}
            >
              {busy ? t("settings.creating.2") : t("settings.create")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="secondary" onClick={onDismiss}>
              {t("settings.close")}
            </button>
            {!created && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setPhase("edit");
                  setPreflight(undefined);
                  setResult(undefined);
                  setConfirmed(false);
                  setError("");
                }}
              >
                {t("settings.back.to.edit")}
              </button>
            )}
            {created && createdWorkspaceUsable && (
              <button
                type="button"
                className="primary"
                onClick={() =>
                  onCreated(kind === "user" ? result.name : result.workspace!)
                }
              >
                {t("settings.use.in.connection.settings")}
              </button>
            )}
          </>
        )
      }
    >
      {phase === "edit" && (
        <fieldset disabled={busy}>
          <label>
            {kind === "user"
              ? t("settings.user.id")
              : t("settings.workspace.name")}
            <input
              data-dialog-autofocus
              value={name}
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {kind === "user" ? (
            <>
              <label>
                {t("settings.full.name")}
                <input
                  required
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                />
              </label>
              <label>
                {t("settings.email")}
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <DialogNotice>
                {t("settings.creation.uses.this.user.s.own")}
              </DialogNotice>
            </>
          ) : (
            <>
              <label>
                {tr("Workspace Root", "Workspace Root")}
                <input
                  value={root}
                  spellCheck={false}
                  onChange={(event) => setRoot(event.target.value)}
                />
                <small>{t("settings.root.is.used.only.to.create")}</small>
              </label>
              <label>
                {t("settings.description.optional")}
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label>
                {t("settings.mapping.type")}
                <select
                  value={mappingKind}
                  onChange={(event) =>
                    setMappingKind(event.target.value as "stream" | "classic")
                  }
                >
                  <option value="stream">Stream</option>
                  <option value="classic">Classic View</option>
                </select>
              </label>
              {mappingKind === "stream" ? (
                <label>
                  Stream
                  <input
                    value={stream}
                    spellCheck={false}
                    onChange={(event) => setStream(event.target.value)}
                  />
                </label>
              ) : (
                <label>
                  Classic View
                  <textarea
                    rows={6}
                    value={classicView}
                    spellCheck={false}
                    placeholder="//depot/project/... //workspace-name/project/..."
                    onChange={(event) => setClassicView(event.target.value)}
                  />
                  <small>
                    {t("settings.one.explicit.depot.path.and.client")}
                  </small>
                </label>
              )}
              <label className="workflow-checkbox">
                <input
                  type="checkbox"
                  checked={syncMode === "virtual"}
                  onChange={(event) =>
                    setSyncMode(event.target.checked ? "virtual" : "standard")
                  }
                />
                <span>
                  {t("settings.enable.p4vfs.virtual.sync.metadata.first")}
                </span>
              </label>
              {syncMode === "virtual" && (
                <DialogNotice>
                  {t("settings.requires.windows.p4.server.2023.1")}
                </DialogNotice>
              )}
            </>
          )}
        </fieldset>
      )}
      {phase === "review" && preflight && (
        <>
          <dl className="connection-create-summary">
            <div>
              <dt>{t("settings.server")}</dt>
              <dd>{snapshot.server}</dd>
            </div>
            <div>
              <dt>{t("settings.type")}</dt>
              <dd>
                {kind === "user" ? t("settings.user") : t("settings.workspace")}
              </dd>
            </div>
            <div>
              <dt>{t("settings.name")}</dt>
              <dd>{preflight.name}</dd>
            </div>
            {kind === "user" ? (
              <>
                <div>
                  <dt>{t("settings.full.name")}</dt>
                  <dd>{fullName.trim()}</dd>
                </div>
                <div>
                  <dt>{t("settings.email")}</dt>
                  <dd>{email.trim()}</dd>
                </div>
              </>
            ) : (
              <>
                <div>
                  <dt>{t("settings.owner")}</dt>
                  <dd>{snapshot.user}</dd>
                </div>
                <div>
                  <dt>Root</dt>
                  <dd>{root.trim()}</dd>
                </div>
                <div>
                  <dt>{t("settings.mapping")}</dt>
                  <dd>
                    {mappingKind === "stream"
                      ? `Stream · ${stream.trim()}`
                      : `Classic View · ${classicView.trim()}`}
                  </dd>
                </div>
                <div>
                  <dt>{t("settings.sync.mode")}</dt>
                  <dd>
                    {syncMode === "virtual"
                      ? t("settings.p4vfs.virtual.sync")
                      : t("settings.standard.sync")}
                  </dd>
                </div>
              </>
            )}
          </dl>
          {preflight.simulated && (
            <DialogNotice>Browser Mock simulated</DialogNotice>
          )}
          {issues.map((issue, index) => (
            <DialogNotice
              key={`${issue.code}-${index}`}
              error={preflight.blockers.includes(issue)}
            >
              {issue.message}
            </DialogNotice>
          ))}
          {!issues.length && (
            <DialogNotice>
              {t("settings.preflight.passed.creation.can.be.confirmed")}
            </DialogNotice>
          )}
          <label className="workflow-checkbox">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              {tr(
                `我确认在 ${snapshot.server} 创建 ${preflight.name}；此操作会写服务器，但不会保存或切换当前连接。`,
                `I confirm creating ${preflight.name} on ${snapshot.server}. This writes to the server but does not save or switch the current connection.`,
              )}
            </span>
          </label>
        </>
      )}
      {phase === "result" && (
        <>
          {error && <DialogNotice error>{error}</DialogNotice>}
          {result && (
            <DialogNotice error={!created || !createdWorkspaceUsable}>
              {result.simulated && "Browser Mock simulated · "}
              {result.outcome === "created" &&
                t("settings.created.confirmed.by.server.readback")}
              {result.message}
              {created && !createdWorkspaceUsable
                ? t("settings.the.not.return")
                : ""}
            </DialogNotice>
          )}
          {result?.outcome === "unknown" && (
            <DialogNotice error>
              {t("settings.outcome.uncertain.the.creation.may.have")}
            </DialogNotice>
          )}
          {result && !!result.operationIds.length && (
            <p className="workflow-context">
              {t("settings.operation")} {result.operationIds.join(", ")}
            </p>
          )}
        </>
      )}
      {phase !== "result" && error && (
        <DialogNotice error>{error}</DialogNotice>
      )}
    </Dialog>
  );
}
