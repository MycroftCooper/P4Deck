import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogNotice } from "../../app/dialogs/Dialog";
import { backend } from "../../infrastructure/backend";
import type {
  ConnectionSpecCreatePreflight,
  ConnectionSpecCreateResult,
  ConnectionWorkspaceCandidate,
  ConnectionWorkspaceMapping,
  P4Context,
} from "../../shared/contracts/types";
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
  onDismiss,
  onCreated,
}: {
  kind: CreateKind;
  context: P4Context;
  requestGeneration: number;
  source: HTMLElement | null;
  zh: boolean;
  onDismiss(): void;
  onCreated(value: string | ConnectionWorkspaceCandidate): void;
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
  const [preflight, setPreflight] = useState<ConnectionSpecCreatePreflight>();
  const [result, setResult] = useState<ConnectionSpecCreateResult>();
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
      setError(tr("请先填写 Server。", "Enter Server first."));
      return;
    }
    if (!trimmedName) {
      setError(tr("名称不能为空。", "Name is required."));
      return;
    }
    if (
      kind === "user" &&
      (!fullName.trim() || !email.trim() || !email.includes("@"))
    ) {
      setError(
        tr(
          "姓名和有效邮箱均为必填项。",
          "Full name and a valid email address are required.",
        ),
      );
      return;
    }
    if (kind === "workspace" && !snapshot.user.trim()) {
      setError(
        tr(
          "请先在连接设置中填写 User。",
          "Enter User in Connection settings first.",
        ),
      );
      return;
    }
    let mapping: ConnectionWorkspaceMapping | undefined;
    try {
      if (kind === "workspace") mapping = workspaceMapping();
    } catch (cause) {
      setError(
        zh
          ? "Classic View 每行必须包含 depot path 和 client path。"
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
              },
            });
      if (seq !== sequence.current) return;
      if (next.requestGeneration !== requestGeneration) {
        setError(
          tr(
            "预检对应的连接设置已变化，请关闭后重试。",
            "The connection settings for this preflight changed. Close and retry.",
          ),
        );
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

  async function create() {
    if (busy || !confirmed || !preflight?.ready || !preflight.token) return;
    if (preflight.expiresAt <= Date.now()) {
      setError(
        tr(
          "预检已过期，请重新预检后确认。",
          "The preflight expired. Run it again before confirming.",
        ),
      );
      setPreflight(undefined);
      setConfirmed(false);
      setPhase("edit");
      return;
    }
    const seq = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const confirmation = {
        token: preflight.token,
        context:
          kind === "user"
            ? { ...snapshot, user: preflight.name, client: "" }
            : { ...snapshot, client: "" },
        requestGeneration,
        stateDigest: preflight.stateDigest,
        confirmed: true,
      };
      const next =
        kind === "user"
          ? await backend.confirmCreateConnectionUser(confirmation)
          : await backend.confirmCreateConnectionWorkspace(confirmation);
      if (seq !== sequence.current) return;
      setResult(next);
      setPhase("result");
    } catch (cause) {
      if (seq === sequence.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase("result");
      }
    } finally {
      if (seq === sequence.current) setBusy(false);
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
          ? tr("新建 P4 用户", "Create P4 user")
          : tr("新建 Workspace", "Create workspace")
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
              {tr("取消", "Cancel")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void inspect()}
            >
              {busy ? tr("预检中…", "Checking…") : tr("预检", "Preflight")}
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
              {tr("返回修改", "Back")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={
                !preflight?.ready || !preflight.token || !confirmed || busy
              }
              onClick={() => void create()}
            >
              {busy ? tr("创建中…", "Creating…") : tr("确认创建", "Create")}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="secondary" onClick={onDismiss}>
              {tr("关闭", "Close")}
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
                {tr("返回修改", "Back to edit")}
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
                {tr("填入连接设置", "Use in connection settings")}
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
              ? tr("用户 ID", "User ID")
              : tr("Workspace 名称", "Workspace name")}
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
                {tr("姓名", "Full name")}
                <input
                  required
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                />
              </label>
              <label>
                {tr("邮箱", "Email")}
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <DialogNotice>
                {tr(
                  "仅按该用户自身身份创建，不会以旧登录身份创建其他用户，也不会使用管理员 -f。",
                  "Creation uses this user's own identity. It never creates another user through an old login and never uses administrator -f.",
                )}
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
                <small>
                  {tr(
                    "Root 仅用于创建新 Workspace；创建成功后会以后端回读结果自动填入连接设置并再次精确核对。",
                    "Root is used only to create the new Workspace. After creation, the server read-back fills the connection settings and is checked again exactly.",
                  )}
                </small>
              </label>
              <label>
                {tr("描述（可选）", "Description (optional)")}
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label>
                {tr("映射类型", "Mapping type")}
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
                    {tr(
                      "每行一个明确的 depot path 与 client path；含空格的路径必须使用引号。不会自动生成全库映射。",
                      "One explicit depot path and client path per line; quote paths containing spaces. No all-depot mapping is generated automatically.",
                    )}
                  </small>
                </label>
              )}
            </>
          )}
        </fieldset>
      )}
      {phase === "review" && preflight && (
        <>
          <dl className="connection-create-summary">
            <div>
              <dt>{tr("服务器", "Server")}</dt>
              <dd>{snapshot.server}</dd>
            </div>
            <div>
              <dt>{tr("类型", "Type")}</dt>
              <dd>
                {kind === "user"
                  ? tr("用户", "User")
                  : tr("工作区", "Workspace")}
              </dd>
            </div>
            <div>
              <dt>{tr("名称", "Name")}</dt>
              <dd>{preflight.name}</dd>
            </div>
            {kind === "user" ? (
              <>
                <div>
                  <dt>{tr("姓名", "Full name")}</dt>
                  <dd>{fullName.trim()}</dd>
                </div>
                <div>
                  <dt>{tr("邮箱", "Email")}</dt>
                  <dd>{email.trim()}</dd>
                </div>
              </>
            ) : (
              <>
                <div>
                  <dt>{tr("所有者", "Owner")}</dt>
                  <dd>{snapshot.user}</dd>
                </div>
                <div>
                  <dt>Root</dt>
                  <dd>{root.trim()}</dd>
                </div>
                <div>
                  <dt>{tr("映射", "Mapping")}</dt>
                  <dd>
                    {mappingKind === "stream"
                      ? `Stream · ${stream.trim()}`
                      : `Classic View · ${classicView.trim()}`}
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
              {tr(
                "预检通过，可以确认创建。",
                "Preflight passed. Creation can be confirmed.",
              )}
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
              {result.message}
              {created && !createdWorkspaceUsable
                ? tr(
                    " 服务端未返回可在本机使用的 Workspace Root，不能填入连接设置。",
                    " The server did not return a Workspace Root usable on this machine, so it cannot be used in connection settings.",
                  )
                : ""}
            </DialogNotice>
          )}
        </>
      )}
      {phase !== "result" && error && (
        <DialogNotice error>{error}</DialogNotice>
      )}
    </Dialog>
  );
}
