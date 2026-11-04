import { t } from "../../shared/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUnsavedEditor } from "../../app/closeGuard";
import {
  Cable,
  FolderOpen,
  KeyRound,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { backend } from "../../infrastructure/backend";
import { canPickExecutables, pickExecutablePath } from "./executablePicker";
import {
  beginConnectionControlIntent,
  connectionStatusVerdict,
  lookupConnectionControlReceipt,
  recoverConnectionControlUnknown,
  settleConnectionControlIntent,
  type ConnectionControlKind,
} from "./connectionControlLifecycle";
import type {
  ConnectionProfile,
  ConnectionProfileErrorCode,
  ConnectionProfiles,
  ConnectionStatus,
  ConnectionWorkspaceCandidate,
  Locale,
  P4Context,
  RuntimeInfo,
} from "../../shared/contracts";
import {
  connectionPresentation,
  cliStatus,
  contextIdentity,
  notTestedStatus,
  probeConnection,
  sameOperationalContext,
} from "./connectionWizard";
import { normalizeSwarmBaseUrl } from "../swarm/swarmLinks";
import { ConnectionDirectoryDialog } from "./ConnectionDirectoryDialog";
import { ConnectionSpecCreateDialog } from "./ConnectionSpecCreateDialog";
import { pathKey } from "../files/address";
import { Dialog, DialogNotice } from "../../app/dialogs/Dialog";

interface Props {
  runtime: RuntimeInfo;
  onConnection(
    context: P4Context,
    connection?: ConnectionStatus,
    p4Version?: string,
  ): void;
  onRuntime(runtime: RuntimeInfo): void;
  locale: Locale;
}

interface ProfileDraft {
  id?: string;
  name: string;
  context: P4Context;
}

type ContextField = [
  key: keyof P4Context,
  zhLabel: string,
  enLabel: string,
  placeholder: string,
];

type ResourceDialog = {
  kind: "user" | "workspace";
  mode: "browse" | "create";
  context: P4Context;
  requestGeneration: number;
  source: HTMLButtonElement;
};

type RootResolution = {
  identity: string;
  phase: "idle" | "saved" | "hint" | "resolving" | "resolved" | "error";
  root?: string;
  message?: string;
  simulated?: boolean;
};

const profileErrorCodes: ConnectionProfileErrorCode[] = [
  "invalidInput",
  "duplicateName",
  "duplicateContext",
  "notFound",
  "revisionConflict",
  "activeProfileDelete",
  "lastProfileDelete",
  "corruptStore",
  "unsupportedSchema",
  "persistenceFailed",
  "connectionFailed",
  "authenticationRequired",
  "contextChanged",
];

function normalizeContext(draft: P4Context): P4Context {
  const normalized = Object.fromEntries(
    Object.entries(draft).map(([key, value]) => [
      key,
      typeof value === "string"
        ? value.trim() ||
          (["server", "user", "client"].includes(key) ? "" : undefined)
        : value,
    ]),
  ) as unknown as P4Context;
  if (normalized.swarmBaseUrl)
    try {
      normalized.swarmBaseUrl = normalizeSwarmBaseUrl(normalized.swarmBaseUrl);
    } catch {
      // Keep invalid draft text available for inline validation and correction.
    }
  return normalized;
}

function emptyDraft(runtime: RuntimeInfo): ProfileDraft {
  return {
    name: "",
    context: {
      executable: runtime.context.executable,
      server: "",
      user: "",
      client: "",
    },
  };
}

function fromProfile(profile: ConnectionProfile): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    context: { ...profile.context },
  };
}

function draftIdentity(draft: ProfileDraft) {
  return JSON.stringify({
    id: draft.id ?? "new",
    name: draft.name.trim(),
    context: normalizeContext(draft.context),
  });
}

function suggestedConnectionName(context: P4Context) {
  return `${context.client} · ${context.user}@${context.server}`.slice(0, 128);
}

function workspaceRootIdentity(context: P4Context) {
  return JSON.stringify({
    executable: context.executable ?? "",
    server: context.server.trim(),
    user: context.user.trim(),
    client: context.client.trim(),
    charset: context.charset ?? "",
    trustPath: context.trustPath ?? "",
    ticketsPath: context.ticketsPath ?? "",
  });
}

function savedRootResolution(context: P4Context): RootResolution {
  return context.client.trim() && context.cwd?.trim()
    ? {
        identity: workspaceRootIdentity(context),
        phase: "saved",
        root: context.cwd.trim(),
      }
    : { identity: workspaceRootIdentity(context), phase: "idle" };
}

function profileError(cause: unknown): {
  code?: ConnectionProfileErrorCode;
  detail: string;
} {
  if (cause && typeof cause === "object") {
    const value = cause as { code?: unknown; message?: unknown };
    if (
      typeof value.code === "string" &&
      profileErrorCodes.includes(value.code as ConnectionProfileErrorCode)
    )
      return {
        code: value.code as ConnectionProfileErrorCode,
        detail: typeof value.message === "string" ? value.message : "",
      };
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  const code = profileErrorCodes.find((candidate) =>
    new RegExp(`(?:^|\\b)${candidate}(?:\\b|:)`, "i").test(detail),
  );
  return { code, detail };
}

function localizedError(
  cause: unknown,
  zh: boolean,
): { code?: ConnectionProfileErrorCode; message: string } {
  const parsed = profileError(cause);
  const copy: Partial<Record<ConnectionProfileErrorCode, [string, string]>> = {
    invalidInput: [
      "字段为空、过长或包含非法字符。",
      "A field is empty, too long, or contains invalid characters.",
    ],
    duplicateName: [
      "连接名称已存在，请使用唯一名称。",
      "That connection name already exists. Use a unique name.",
    ],
    duplicateContext: [
      "相同参数的已保存连接已存在。",
      "A saved connection with the same settings already exists.",
    ],
    notFound: [
      "该已保存连接或 Workspace 已不存在，请刷新后重试。",
      "That saved connection or workspace no longer exists. Refresh and retry.",
    ],
    revisionConflict: [
      "已保存连接在其他位置被修改；列表已重新加载，请核对未保存修改后重试。",
      "Saved connections changed elsewhere. The list was reloaded; review your unsaved changes and retry.",
    ],
    activeProfileDelete: [
      "当前连接不能删除；请先连接到另一个已保存连接。",
      "The current connection cannot be deleted. Connect to another saved connection first.",
    ],
    lastProfileDelete: [
      "最后一个已保存连接不能删除。",
      "The last saved connection cannot be deleted.",
    ],
    corruptStore: [
      "连接存储已损坏且未被覆盖；请修复或恢复 connection.json。",
      "The connection store is corrupt and was left unchanged. Repair or restore connection.json.",
    ],
    unsupportedSchema: [
      "连接存储版本不受支持，文件未被覆盖。",
      "The connection store schema is unsupported and the file was left unchanged.",
    ],
    persistenceFailed: [
      "连接存储写入失败；原数据保持不变，请检查磁盘与权限。",
      "The connection store could not be written. Existing data is unchanged; check disk and permissions.",
    ],
    connectionFailed: [
      "验证失败，仍保留原连接和页面数据。",
      "Verification failed. The previous connection and page data were preserved.",
    ],
    authenticationRequired: [
      "目标连接尚未登录；当前连接保持不变。",
      "The target connection is not authenticated. The current connection remains active.",
    ],
    contextChanged: [
      "当前连接在操作期间已变化；已保留最新连接。",
      "The current connection changed during the operation. The latest connection was preserved.",
    ],
  };
  const selected = parsed.code ? copy[parsed.code] : undefined;
  const base =
    (selected && (zh ? selected[0] : selected[1])) ||
    t("settings.the.operation.did.not.complete");
  // Surface the backend OS error (path/errno) for support; the localized text alone hides it.
  const detail = parsed.detail.trim().slice(0, 300);
  return {
    code: parsed.code,
    message: detail
      ? base + t("settings.detail") + detail + (zh ? "）" : ")")
      : base,
  };
}

export function ConnectionProfilesCard({
  runtime,
  onConnection,
  onRuntime,
  locale,
}: Props) {
  const zh = locale === "zh-CN";
  const tr = useCallback((a: string, b: string) => (zh ? a : b), [zh]);
  const [profiles, setProfiles] = useState<ConnectionProfiles>();
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<ProfileDraft>(() => emptyDraft(runtime));
  const [baseline, setBaseline] = useState<ProfileDraft>(() =>
    emptyDraft(runtime),
  );
  const [connection, setConnection] = useState(runtime.connection);
  const [cliVersion, setCliVersion] = useState(runtime.p4Version);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [trustConfirmed, setTrustConfirmed] = useState(false);
  // UI-15: desktop-only native .exe picker (dynamic plugin import; hidden in browser/failure).
  const [pickerAvailable, setPickerAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    void canPickExecutables().then((available) => {
      if (live) setPickerAvailable(available);
    });
    return () => {
      live = false;
    };
  }, []);
  const [profileSearch, setProfileSearch] = useState("");
  const [deleteId, setDeleteId] = useState("");
  const deleteSource = useRef<HTMLButtonElement | null>(null);
  const [resourceDialog, setResourceDialog] = useState<ResourceDialog>();
  const [rootResolution, setRootResolution] = useState<RootResolution>(() =>
    savedRootResolution(runtime.context),
  );
  const [rootRequestRevision, setRootRequestRevision] = useState(0);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const generation = useRef(0);
  const inFlight = useRef(false);
  const selectedIdRef = useRef(selectedId);
  const dirtyRef = useRef(false);
  const skipRuntimeGeneration = useRef<number | undefined>(undefined);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLButtonElement | undefined>(undefined);
  const actionFeedbackRef = useRef<HTMLDivElement>(null);
  const connectionStatusRef = useRef<HTMLElement>(null);
  const rootSequence = useRef(0);
  const rootOperation = useRef<string | undefined>(undefined);

  const current = normalizeContext(draft.context);
  const swarmUrlValid = (() => {
    if (!current.swarmBaseUrl) return true;
    try {
      normalizeSwarmBaseUrl(current.swarmBaseUrl);
      return true;
    } catch {
      return false;
    }
  })();
  const dirty =
    draftIdentity({ ...draft, context: current }) !== draftIdentity(baseline);
  const clearUnsaved = useUnsavedEditor(
    dirty || password.length > 0
      ? "dirty"
      : loading || !profiles
        ? "unknown"
        : "clean",
    `${runtime.activeProfileId}:${runtime.contextGeneration}`,
    "connectionSettings",
  );
  selectedIdRef.current = selectedId;
  dirtyRef.current = dirty;
  const isActive = !!draft.id && profiles?.activeProfileId === draft.id;
  const activeContextMatches =
    isActive && sameOperationalContext(current, runtime.context);
  const savedName = draft.name.trim() || suggestedConnectionName(current);
  const rootIdentity = workspaceRootIdentity(current);
  const rootResolved =
    rootResolution.identity === rootIdentity &&
    rootResolution.phase === "resolved" &&
    !!rootResolution.root &&
    rootResolution.root === current.cwd;
  const valid = !!(
    savedName &&
    savedName.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(savedName) &&
    current.server &&
    current.user &&
    current.client &&
    rootResolved &&
    swarmUrlValid
  );
  const connectionValid = !!(current.server && current.user);
  const presentation = connectionPresentation(connection, zh);
  const connectionFields: ContextField[] = [
    ["server", "服务器", "Server", "ssl:perforce:1666"],
    ["user", "用户", "User", "username"],
    ["client", "工作区", "Workspace", "workspace-name"],
  ];
  const p4Fields: ContextField[] = [
    ["charset", "字符集 / P4CHARSET", "Charset / P4CHARSET", "utf8"],
    ["trustPath", "Trust 文件路径", "Trust file path", "P4TRUST"],
    ["ticketsPath", "Tickets 文件路径", "Tickets file path", "P4TICKETS"],
    [
      "swarmBaseUrl",
      "Swarm 基础 URL（可选）",
      "Swarm base URL (optional)",
      "https://swarm.example/",
    ],
    ["executable", "P4 可执行文件", "P4 executable", "p4 / p4.exe"],
    [
      "customSubmitExecutablePath",
      "自定义提交工具（可选）",
      "Custom submit tool (optional)",
      "C:\\Tools\\submit.exe",
    ],
  ];

  const resetTransient = useCallback(
    (next: ProfileDraft, status?: ConnectionStatus) => {
      generation.current += 1;
      inFlight.current = false;
      setBusy(false);
      setOperation("");
      setDraft(next);
      setBaseline(next);
      setConnection(status ?? notTestedStatus(next.context.server));
      setCliVersion(runtimeRef.current.p4Version);
      setNotice("");
      setError("");
      setPassword("");
      setTrustConfirmed(false);
      setDeleteId("");
      setResourceDialog(undefined);
      setRootResolution(savedRootResolution(next.context));
      setRootRequestRevision((revision) => revision + 1);
    },
    [],
  );

  const chooseDocumentProfile = useCallback(
    (document: ConnectionProfiles, preferred?: string) => {
      const id =
        preferred || document.activeProfileId || document.profiles[0]?.id;
      const profile = document.profiles.find((item) => item.id === id);
      const currentRuntime = runtimeRef.current;
      if (profile) {
        setSelectedId(profile.id);
        resetTransient(
          fromProfile(profile),
          profile.id === currentRuntime.activeProfileId
            ? currentRuntime.connection
            : notTestedStatus(profile.context.server),
        );
      } else {
        setSelectedId("new");
        resetTransient(emptyDraft(currentRuntime));
      }
    },
    [resetTransient],
  );

  const reloadProfiles = useCallback(
    async (preserveDraft: boolean) => {
      const document = await backend.listConnectionProfiles();
      setProfiles(document);
      const id = selectedIdRef.current;
      const stillExists = document.profiles.some((item) => item.id === id);
      if (!preserveDraft || !stillExists)
        chooseDocumentProfile(document, stillExists ? id : undefined);
      return document;
    },
    [chooseDocumentProfile],
  );

  useEffect(() => {
    if (skipRuntimeGeneration.current === runtime.contextGeneration) {
      skipRuntimeGeneration.current = undefined;
      return;
    }
    let live = true;
    setLoading(true);
    void backend
      .listConnectionProfiles()
      .then((document) => {
        if (!live) return;
        setProfiles(document);
        const currentId = selectedIdRef.current;
        const currentProfile = document.profiles.find(
          (item) => item.id === currentId,
        );
        if (!currentProfile) chooseDocumentProfile(document);
        else if (!dirtyRef.current)
          chooseDocumentProfile(document, currentProfile.id);
      })
      .catch((cause) => {
        if (live) setError(localizedError(cause, zh).message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [chooseDocumentProfile, runtime.contextGeneration]);

  useEffect(() => {
    if ((isActive && !dirty) || activeContextMatches) {
      setConnection(runtime.connection);
      setCliVersion(runtime.p4Version);
    }
  }, [
    isActive,
    dirty,
    activeContextMatches,
    runtime.connection,
    runtime.p4Version,
  ]);

  useEffect(() => {
    if (!busy && restoreFocusRef.current) {
      restoreFocusRef.current.focus();
      restoreFocusRef.current = undefined;
    }
  }, [busy]);

  useEffect(() => {
    if (!error || deleteId) return;
    requestAnimationFrame(() => actionFeedbackRef.current?.focus());
  }, [error, deleteId]);

  useEffect(() => {
    if (rootRequestRevision === 0) return;
    const identity = rootIdentity;
    const client = current.client.trim();
    if (!current.server.trim() || !current.user.trim() || !client) {
      setRootResolution({ identity, phase: "idle" });
      return;
    }
    const seq = ++rootSequence.current;
    const operationId = `workspace-root-${crypto.randomUUID()}`;
    rootOperation.current = operationId;
    const clearDerivedRoot = () =>
      setDraft((value) => {
        if (workspaceRootIdentity(normalizeContext(value.context)) !== identity)
          return value;
        return { ...value, context: { ...value.context, cwd: undefined } };
      });
    setRootResolution((value) => ({
      identity,
      phase: "resolving",
      root: value.identity === identity ? value.root : undefined,
      message: undefined,
    }));
    const timer = window.setTimeout(() => {
      void backend
        .browseConnectionWorkspaces({
          context: { ...current, client: "", cwd: undefined },
          requestGeneration: seq,
          operationId,
          prefix: client,
        })
        .then((result) => {
          if (
            seq !== rootSequence.current ||
            result.requestGeneration !== seq ||
            workspaceRootIdentity(normalizeContext(draft.context)) !== identity
          )
            return;
          if (result.connection.state !== "connected") {
            const status = connectionPresentation(result.connection, zh);
            clearDerivedRoot();
            setConnection(result.connection);
            setRootResolution({
              identity,
              phase: "error",
              message: `${status.title} · ${status.detail}`,
              simulated: result.simulated,
            });
            return;
          }
          const candidate = result.items.find((item) => item.name === client);
          if (
            !candidate ||
            !candidate.selectable ||
            candidate.rootStatus !== "usable" ||
            !candidate.root.trim()
          ) {
            clearDerivedRoot();
            setConnection(notTestedStatus(current.server));
            setRootResolution({
              identity,
              phase: "error",
              message: candidate
                ? tr(
                    "服务器返回的 Workspace Root 在本机不可用。",
                    "The Workspace Root returned by the server is not usable on this machine.",
                  )
                : tr(
                    "服务器未返回完全匹配的 Workspace。",
                    "The server returned no exact Workspace match.",
                  ),
              simulated: result.simulated,
            });
            return;
          }
          setDraft((value) => {
            if (
              workspaceRootIdentity(normalizeContext(value.context)) !==
              identity
            )
              return value;
            return {
              ...value,
              context: { ...value.context, cwd: candidate.root },
            };
          });
          setBaseline((value) => {
            if (
              workspaceRootIdentity(normalizeContext(value.context)) !==
                identity ||
              !value.context.cwd ||
              pathKey(value.context.cwd) !== pathKey(candidate.root)
            )
              return value;
            return {
              ...value,
              context: { ...value.context, cwd: candidate.root },
            };
          });
          if (pathKey(candidate.root) !== pathKey(current.cwd || "")) {
            setConnection(notTestedStatus(current.server));
            setPassword("");
            setTrustConfirmed(false);
          }
          setRootResolution({
            identity,
            phase: "resolved",
            root: candidate.root,
            simulated: result.simulated,
          });
        })
        .catch((cause) => {
          if (seq !== rootSequence.current) return;
          clearDerivedRoot();
          setConnection(notTestedStatus(current.server));
          setRootResolution({
            identity,
            phase: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        })
        .finally(() => {
          if (seq === rootSequence.current) rootOperation.current = undefined;
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      rootSequence.current += 1;
      if (rootOperation.current === operationId) {
        rootOperation.current = undefined;
        void Promise.resolve(backend.cancelOperation(operationId)).catch(
          () => undefined,
        );
      }
    };
    // current is intentionally captured by the explicit, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootIdentity, rootRequestRevision, tr, zh]);

  function begin(nextOperation: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    const token = ++generation.current;
    setBusy(true);
    setOperation(nextOperation);
    setError("");
    setNotice("");
    return token;
  }

  function isCurrent(token: number) {
    return token === generation.current;
  }

  function finish(token: number) {
    if (!isCurrent(token)) return;
    inFlight.current = false;
    setBusy(false);
    setOperation("");
  }

  function publish(status: ConnectionStatus, version = cliVersion) {
    setConnection(status);
    setTrustConfirmed(false);
    setCliVersion(version);
    const active = runtimeRef.current;
    if (
      draft.id === active.activeProfileId &&
      sameOperationalContext(current, active.context)
    )
      onConnection(active.context, status, version);
  }

  function clientValidation() {
    if (!swarmUrlValid)
      return tr(
        "Swarm URL 必须是无凭据、query、fragment、控制字符的 http/https 基础地址。",
        "Swarm URL must be an http(s) base URL without credentials, query, fragment, or control characters.",
      );
    if (!valid)
      return tr(
        "连接名称需为 1–128 个非控制字符；Server、User、Workspace 为必填。名称留空时会自动生成。",
        "Connection name must contain 1–128 non-control characters. Server, User, and Workspace are required; a blank name is generated automatically.",
      );
    const duplicate = profiles?.profiles.find(
      (profile) =>
        profile.id !== draft.id &&
        (profile.name.trim().toLocaleLowerCase() ===
          savedName.toLocaleLowerCase() ||
          contextIdentity(profile.context) === contextIdentity(current)),
    );
    if (!duplicate) return "";
    return contextIdentity(duplicate.context) === contextIdentity(current)
      ? tr(
          "相同参数的已保存连接已存在。",
          "A saved connection with the same settings already exists.",
        )
      : t("settings.that.connection.name.already.exists");
  }

  function controlSnapshot() {
    return {
      profileId: profiles?.activeProfileId ?? "",
      generation: String(runtime.contextGeneration),
      server: current.server,
      user: current.user,
      client: current.client,
    };
  }
  function beginControl(kind: ConnectionControlKind, label: string) {
    const operationId = crypto.randomUUID();
    beginConnectionControlIntent({ operationId, kind, label });
    return operationId;
  }
  /** Exactly one same-id lookup; never a new id and never a credential replay. */
  async function recoverControlOnce(operationId: string) {
    settleConnectionControlIntent(operationId);
    return recoverConnectionControlUnknown(operationId, {
      connection: async () => controlSnapshot(),
      lookup: lookupConnectionControlReceipt,
    });
  }
  async function saveProfile() {
    const validation = clientValidation();
    if (validation) {
      setError(validation);
      return;
    }
    if (!profiles) return;
    const token = begin("save");
    if (token == null) return;
    const wasActive = !!draft.id && draft.id === profiles.activeProfileId;
    const operationId = beginControl(
      draft.id ? "connectionProfileUpdate" : "connectionProfileCreate",
      `${current.server} / ${current.user}`,
    );
    const existingProfileIds = new Set(
      profiles.profiles.map((item) => item.id),
    );
    try {
      const document = draft.id
        ? await backend.updateConnectionProfile({
            expectedRevision: profiles.revision,
            id: draft.id,
            name: savedName,
            context: current,
            operationId,
          })
        : await backend.createConnectionProfile({
            expectedRevision: profiles.revision,
            name: savedName,
            context: current,
            operationId,
          });
      if (!isCurrent(token)) return;
      setProfiles(document);
      const saved = draft.id
        ? document.profiles.find((item) => item.id === draft.id)
        : document.profiles.find(
            (item) =>
              item.name === savedName && !existingProfileIds.has(item.id),
          );
      if (!saved)
        throw new Error("notFound: Saved connection was not returned.");
      clearUnsaved();
      const nextDraft = fromProfile(saved);
      setSelectedId(saved.id);
      setDraft(nextDraft);
      setBaseline(nextDraft);
      // A saved non-active profile is persisted, not activated. Treat its
      // returned Root as a hint and independently re-resolve the exact draft.
      setRootResolution(savedRootResolution(saved.context));
      setRootRequestRevision((revision) => revision + 1);
      const status =
        wasActive && sameOperationalContext(saved.context, runtime.context)
          ? runtime.connection
          : notTestedStatus(saved.context.server);
      setConnection(status);
      setPassword("");
      setTrustConfirmed(false);
      setNotice(
        status.state === "connected"
          ? tr(
              "连接配置已保存；实际连接参数未变，验证状态已保留。",
              "Profile saved. P4 connection settings are unchanged; verification is preserved.",
            )
          : tr(
              "连接已保存；状态仍为“尚未验证”，保存不会冒充已连接。",
              "Connection saved. It remains Not tested; saving never pretends the connection is active.",
            ),
      );
      if (wasActive || document.activeProfileId === saved.id) {
        const nextRuntime = await backend.runtimeInfo();
        if (!isCurrent(token)) return;
        skipRuntimeGeneration.current = nextRuntime.contextGeneration;
        onRuntime({ ...nextRuntime, connection: status });
      }
    } catch (cause) {
      if (!isCurrent(token)) return;
      await recoverControlOnce(operationId);
      const failure = localizedError(cause, zh);
      setError(failure.message);
      if (failure.code === "revisionConflict") {
        try {
          await reloadProfiles(true);
        } catch {
          setError(
            tr(
              "已保存连接被并发修改，且重新加载失败；请稍后重试。",
              "Saved connections changed concurrently and reload failed. Retry later.",
            ),
          );
        }
      }
    } finally {
      finish(token);
    }
  }

  async function rediscoverCli() {
    const token = begin("test");
    if (token == null) return;
    try {
      const result = await backend.discoverP4Cli({
        executable: current.executable,
      });
      if (!isCurrent(token)) return;
      const unavailable = cliStatus(result, current.server);
      publish(
        unavailable ?? notTestedStatus(current.server),
        result.version ?? cliVersion,
      );
      if (!unavailable)
        setNotice(
          tr(
            "已找到 P4 CLI。可点击“验证这些设置”验证连接；尚未访问服务器。",
            "P4 CLI found. Use Verify these settings to check the connection; no server has been contacted.",
          ),
        );
    } catch {
      if (isCurrent(token))
        setError(
          tr(
            "CLI 检测未完成，请重试。",
            "CLI detection did not complete. Retry.",
          ),
        );
    } finally {
      finish(token);
    }
  }

  async function testConnection() {
    if (!connectionValid) {
      setError(
        tr(
          "验证连接需要 Server 和 User；可在选择 Workspace 之前验证并完成 Trust 或登录恢复。",
          "Verifying a connection requires Server and User. You can verify and complete Trust or login recovery before choosing a Workspace.",
        ),
      );
      return;
    }
    const token = begin("test");
    if (token == null) return;
    try {
      const result = await probeConnection(backend, current, () =>
        isCurrent(token),
      );
      if (result.stale || !isCurrent(token)) return;
      const version =
        result.discovery.version ??
        (result.discovery.state === "notTested"
          ? cliVersion
          : "P4 CLI unavailable");
      publish(result.status, version);
      if (result.status.state !== "connected")
        requestAnimationFrame(() => connectionStatusRef.current?.focus());
      if (result.status.state === "connected")
        setNotice(
          runtime.mode === "mock"
            ? tr(
                "浏览器 Mock：仅模拟验证，未发起真实网络连接；此操作不会切换当前连接。",
                "Browser Mock: validation was simulated with no real network connection. This does not activate the saved connection.",
              )
            : activeContextMatches
              ? tr(
                  "当前连接与登录已验证，文件树已可加载。",
                  "The active connection and login are verified. The file tree is ready.",
                )
              : tr(
                  "当前未保存设置的连接与登录已验证；验证不会保存或切换当前连接。",
                  "The current unsaved settings are connected and authenticated. Validation does not save or switch the current connection.",
                ),
        );
    } catch {
      if (isCurrent(token))
        setError(
          tr(
            "连接验证请求未完成；未将该结果视为成功。",
            "The connection check did not complete and was not treated as success.",
          ),
        );
    } finally {
      finish(token);
    }
  }

  async function trust() {
    const snapshot = connection;
    if (
      snapshot.state !== "sslUntrusted" ||
      !snapshot.fingerprint ||
      snapshot.server !== current.server ||
      !trustConfirmed
    )
      return;
    const token = begin("trust");
    if (token == null) return;
    const operationId = beginControl(
      "authTrust",
      `${current.server} / ${current.user}`,
    );
    try {
      const trusted = await backend.trustServer({
        context: current,
        fingerprint: snapshot.fingerprint,
        confirmed: true,
        operationId,
      });
      if (!isCurrent(token)) return;
      settleConnectionControlIntent(operationId);
      if (connectionStatusVerdict("authTrust", trusted) !== "success") {
        setError(
          tr(
            "Trust 结果未被权威状态证实；卡片刻意保持不确定，请刷新后再试。",
            "The trust result was not proven by the authoritative status. The card stays uncertain; refresh before retrying.",
          ),
        );
        return;
      }
      if (trusted.state === "notTested") {
        const result = await probeConnection(backend, current, () =>
          isCurrent(token),
        );
        if (!result.stale && isCurrent(token))
          publish(result.status, result.discovery.version ?? cliVersion);
      } else publish(trusted);
    } catch {
      if (isCurrent(token)) {
        await recoverControlOnce(operationId);
        setError(
          tr(
            "Trust 请求未完成；未信任其他指纹。",
            "The trust request did not complete. No other fingerprint was trusted.",
          ),
        );
      }
    } finally {
      finish(token);
    }
  }

  async function login() {
    if (
      !password ||
      !["authRequired", "ticketExpired"].includes(connection.state)
    )
      return;
    const token = begin("login");
    if (token == null) return;
    const singleUsePassword = password;
    setPassword("");
    const operationId = beginControl(
      "authLogin",
      `${current.server} / ${current.user}`,
    );
    try {
      const authenticated = await backend.login({
        context: current,
        password: singleUsePassword,
        confirmed: true,
        operationId,
      });
      if (!isCurrent(token)) return;
      const status =
        authenticated.state === "connected"
          ? await backend.queryLoginStatus(current)
          : authenticated;
      if (!isCurrent(token)) return;
      settleConnectionControlIntent(operationId);
      publish(status);
      if (connectionStatusVerdict("authLogin", status) === "success")
        setNotice(
          runtime.mode === "mock"
            ? tr(
                "浏览器 Mock：模拟登录完成，未访问真实服务器。",
                "Browser Mock: login was simulated without contacting a real server.",
              )
            : tr(
                "当前设置登录成功；密码已清空。",
                "The current settings are authenticated; the password was cleared.",
              ),
        );
      else
        setError(
          tr(
            "登录结果未被权威连接状态证实；密码已清空，请刷新后再试。",
            "Login was not proven by the authoritative connection status; the password was cleared. Refresh before retrying.",
          ),
        );
    } catch {
      if (isCurrent(token)) {
        await recoverControlOnce(operationId);
        setError(
          tr(
            "登录未完成；密码已清空。",
            "Login did not complete; the password was cleared.",
          ),
        );
      }
    } finally {
      finish(token);
    }
  }

  async function logout() {
    if (connection.state !== "connected") return;
    const token = begin("logout");
    if (token == null) return;
    setPassword("");
    const operationId = beginControl(
      "authLogout",
      `${current.server} / ${current.user}`,
    );
    try {
      const status = await backend.logout({
        context: current,
        confirmed: true,
        operationId,
      });
      if (!isCurrent(token)) return;
      settleConnectionControlIntent(operationId);
      publish(status);
      if (connectionStatusVerdict("authLogout", status) === "success")
        setNotice(
          runtime.mode === "mock"
            ? tr(
                "浏览器 Mock：模拟退出，未访问真实服务器。",
                "Browser Mock: logout was simulated without contacting a real server.",
              )
            : tr(
                "当前设置对应用户已退出。",
                "The user for the current settings was logged out.",
              ),
        );
      else
        setError(
          tr(
            "退出结果未被权威状态证实；卡片刻意保持不确定。",
            "Logout was not proven by the authoritative status; the card stays uncertain.",
          ),
        );
    } catch {
      if (isCurrent(token)) {
        await recoverControlOnce(operationId);
        setError(t("settings.logout.did.not.complete"));
      }
    } finally {
      finish(token);
    }
  }

  function selectProfile(profile: ConnectionProfile) {
    if (dirty) {
      setError(t("settings.save.the.current.changes.first"));
      return;
    }
    setSelectedId(profile.id);
    resetTransient(
      fromProfile(profile),
      profile.id === runtime.activeProfileId
        ? runtime.connection
        : notTestedStatus(profile.context.server),
    );
  }

  function createProfile() {
    if (dirty) {
      setError(t("settings.save.the.current.changes.first"));
      return;
    }
    setSelectedId("new");
    resetTransient(emptyDraft(runtime));
  }

  async function chooseExecutableFile(
    key: "executable" | "customSubmitExecutablePath",
  ) {
    // Cancel/failure resolves undefined and leaves the current value untouched; never saves.
    const selected = await pickExecutablePath();
    if (selected) updateContext(key, selected);
  }
  function updateContext(key: keyof P4Context, value: string) {
    generation.current += 1;
    if (key === "swarmBaseUrl" || key === "customSubmitExecutablePath") {
      setDraft({ ...draft, context: { ...draft.context, [key]: value } });
      setNotice("");
      setError("");
      return;
    }
    setResourceDialog(undefined);
    const next = { ...draft.context, [key]: value, cwd: undefined };
    setDraft({ ...draft, context: next });
    setRootResolution({
      identity: workspaceRootIdentity(next),
      phase: "idle",
    });
    setRootRequestRevision((revision) => revision + 1);
    setConnection(
      notTestedStatus(key === "server" ? value.trim() : next.server.trim()),
    );
    setNotice("");
    setError("");
    setPassword("");
    setTrustConfirmed(false);
  }

  function applyWorkspaceCandidate(candidate: ConnectionWorkspaceCandidate) {
    if (
      !candidate.selectable ||
      candidate.rootStatus !== "usable" ||
      !candidate.root.trim()
    ) {
      setError(
        tr(
          "该 Workspace 的 Root 在当前机器上不可用，不能填入连接设置。",
          "This Workspace Root is not usable on this machine and cannot be selected.",
        ),
      );
      return;
    }
    generation.current += 1;
    setResourceDialog(undefined);
    const next = {
      ...draft.context,
      client: candidate.name,
      cwd: candidate.root,
    };
    const identity = workspaceRootIdentity(next);
    setDraft({ ...draft, context: next });
    setRootResolution({
      identity,
      phase: "hint",
      root: candidate.root,
    });
    setRootRequestRevision((revision) => revision + 1);
    setConnection(notTestedStatus(next.server.trim()));
    setNotice("");
    setError("");
    setPassword("");
    setTrustConfirmed(false);
  }

  function openResourceDialog(
    kind: ResourceDialog["kind"],
    mode: ResourceDialog["mode"],
    source: HTMLButtonElement,
  ) {
    const requestGeneration = ++generation.current;
    setResourceDialog({
      kind,
      mode,
      context: { ...current },
      requestGeneration,
      source,
    });
  }

  async function deleteProfile(source: HTMLButtonElement) {
    if (!profiles || !deleteId) return;
    const wasActive = profiles.activeProfileId === deleteId;
    const token = begin("delete");
    if (token == null) return;
    const operationId = beginControl("connectionProfileDelete", deleteId);
    try {
      const document = await backend.deleteConnectionProfile({
        expectedRevision: profiles.revision,
        id: deleteId,
        operationId,
      });
      if (!isCurrent(token)) return;
      if (wasActive) {
        const next = await backend.runtimeInfo();
        if (!isCurrent(token)) return;
        skipRuntimeGeneration.current = next.contextGeneration;
        onRuntime(next);
      }
      setProfiles(document);
      setDeleteId("");
      chooseDocumentProfile(document);
      setNotice(t("settings.saved.connection.deleted"));
      requestAnimationFrame(() => newButtonRef.current?.focus());
    } catch (cause) {
      if (!isCurrent(token)) return;
      await recoverControlOnce(operationId);
      const failure = localizedError(cause, zh);
      setError(failure.message);
      if (failure.code === "revisionConflict") {
        try {
          await reloadProfiles(true);
        } catch {
          /* The original conflict remains actionable. */
        }
      }
      restoreFocusRef.current = source;
    } finally {
      finish(token);
    }
  }

  async function connectSavedProfile() {
    if (!profiles || !draft.id || dirty) return;
    const token = begin("connect");
    if (token == null) return;
    const operationId = beginControl("connectionProfileSetActive", draft.id);
    try {
      const next = await backend.setActiveConnectionProfile({
        expectedRevision: profiles.revision,
        id: draft.id,
        operationId,
      });
      if (!isCurrent(token)) return;
      const document = await backend.listConnectionProfiles();
      if (!isCurrent(token)) return;
      skipRuntimeGeneration.current = next.contextGeneration;
      onRuntime(next);
      setProfiles(document);
      setConnection(next.connection);
      setNotice(t("settings.connection.is.now.active"));
    } catch (cause) {
      if (isCurrent(token)) {
        await recoverControlOnce(operationId);
        setError(localizedError(cause, zh).message);
      }
    } finally {
      finish(token);
    }
  }

  const filteredProfiles = useMemo(() => {
    const term = profileSearch.trim().toLocaleLowerCase();
    if (!term) return profiles?.profiles ?? [];
    return (profiles?.profiles ?? []).filter((profile) =>
      [
        profile.name,
        profile.context.server,
        profile.context.user,
        profile.context.client,
      ]
        .join("\n")
        .toLocaleLowerCase()
        .includes(term),
    );
  }, [profileSearch, profiles]);

  const operationMessage = operation
    ? {
        save: t("settings.saving.connection"),
        test: t("settings.verifying.server.and.user"),
        trust: t("settings.writing.confirmed.trust"),
        login: t("settings.checking.login"),
        logout: t("settings.logging.out"),
        delete: t("settings.deleting.saved.connection"),
        connect: t("settings.connecting"),
      }[operation]
    : "";
  const sharedDisabledReason = loading
    ? t("settings.saved.connections.are.loading")
    : busy
      ? tr(
          "请等待当前连接操作完成。",
          "Wait for the current connection operation.",
        )
      : "";
  const saveDisabledReason = sharedDisabledReason
    ? sharedDisabledReason
    : !dirty
      ? t("settings.there.are.no.changes.to")
      : !valid
        ? tr(
            "保存需要有效的 Server、User、Workspace 与自动解析的 Workspace Root。",
            "Saving requires valid Server, User, Workspace, and an automatically resolved Workspace Root.",
          )
        : "";
  const verifyDisabledReason = sharedDisabledReason
    ? sharedDisabledReason
    : !current.server
      ? t("settings.enter.server.first")
      : !current.user
        ? t("settings.enter.user.first")
        : "";
  const connectionFailureNearActions = !["connected", "notTested"].includes(
    connection.state,
  );

  return (
    <section className="settings-card connection-profiles-card">
      <h2>
        <Cable size={18} />
        {t("settings.saved.connections")}
      </h2>
      <p>
        {tr(
          "已保存连接只包含后端允许的非敏感设置和凭证文件路径；密码、ticket 内容与服务器指纹不会进入已保存连接、Storage、URL 或日志。",
          "Saved connections contain only allowlisted, non-secret settings and credential-file paths. Passwords, ticket contents, and server fingerprints never enter saved connections, storage, URLs, or logs.",
        )}
      </p>
      {runtime.mode === "mock" && (
        <p className="settings-note settings-mock-disclosure">
          {tr(
            "浏览器 Mock 明确为 simulated：保存、验证和切换只改变模拟状态，不访问真实网络。",
            "Browser Mock is explicitly simulated: saving, validation, and switching only change mock state and never access a real network.",
          )}
        </p>
      )}
      <div className="profile-manager">
        <aside
          className="profile-list-panel"
          aria-label={t("settings.saved.connections.list")}
        >
          <div className="profile-list-tools">
            <label className="profile-search">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label={t("settings.search.saved.connections")}
                value={profileSearch}
                placeholder={tr(
                  "搜索名称、服务器、用户或工作区…",
                  "Search name, server, user, or workspace…",
                )}
                onChange={(event) => setProfileSearch(event.target.value)}
              />
            </label>
            <button
              ref={newButtonRef}
              type="button"
              className="secondary"
              disabled={busy}
              onClick={createProfile}
            >
              <Plus size={14} /> {t("settings.new")}
            </button>
          </div>
          <div className="profile-list" role="list" aria-busy={loading}>
            {filteredProfiles.map((profile) => {
              const active = profile.id === profiles?.activeProfileId;
              return (
                <div
                  className={`profile-list-item ${profile.id === selectedId ? "selected" : ""}`}
                  role="listitem"
                  key={profile.id}
                >
                  <button
                    type="button"
                    className="profile-select"
                    aria-current={active ? "true" : undefined}
                    onClick={() => selectProfile(profile)}
                  >
                    <span>
                      <strong>
                        {profile.context.client} · {profile.context.user}
                      </strong>
                      {active && <em>{t("settings.current")}</em>}
                    </span>
                    <small>
                      {profile.name} · {profile.context.server}
                    </small>
                  </button>
                  <button
                    type="button"
                    className="profile-delete"
                    aria-label={tr(
                      `删除 ${profile.name}`,
                      `Delete ${profile.name}`,
                    )}
                    title={t("settings.delete.saved.connection")}
                    disabled={busy}
                    onClick={(event) => {
                      deleteSource.current = event.currentTarget;
                      setError("");
                      setDeleteId(profile.id);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
            {!loading && !filteredProfiles.length && (
              <p role="status" className="profile-list-empty">
                {profileSearch
                  ? tr(
                      "没有匹配的已保存连接。",
                      "No matching saved connections.",
                    )
                  : tr(
                      "尚无已保存连接，请新建。",
                      "No saved connections yet. Create one.",
                    )}
              </p>
            )}
          </div>
          <small className="profile-list-count">
            {tr(
              `显示 ${filteredProfiles.length} / ${profiles?.profiles.length ?? 0} 个连接`,
              `Showing ${filteredProfiles.length} of ${profiles?.profiles.length ?? 0} connections`,
            )}
          </small>
        </aside>

        <div className="profile-editor">
          <div className="profile-editor-heading">
            <div>
              <strong>
                {draft.id
                  ? t("settings.edit.saved.connection")
                  : t("settings.new.connection")}
              </strong>
              <span>
                {isActive
                  ? t("settings.currently.in.use")
                  : tr(
                      "修改尚未应用；验证不会切换当前连接",
                      "Changes are not applied; validation does not switch the current connection",
                    )}
              </span>
            </div>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveProfile();
            }}
          >
            <fieldset disabled={busy || loading}>
              <label className="profile-name-field profile-connection-name">
                {t("settings.connection.name.optional")}
                <input
                  aria-label={tr(
                    "连接名称（可选）",
                    "Connection name (optional)",
                  )}
                  value={draft.name}
                  maxLength={128}
                  placeholder={
                    suggestedConnectionName(current) ||
                    t("settings.generated.when.saved")
                  }
                  onChange={(event) => {
                    generation.current += 1;
                    setDraft({ ...draft, name: event.target.value });
                    setNotice("");
                    setError("");
                    setPassword("");
                    setTrustConfirmed(false);
                  }}
                />
                <small>
                  {tr(
                    "仅用于区分已保存连接；留空会根据 Server、User 和 Workspace 自动生成。",
                    "Used only to distinguish saved connections. Leave blank to generate it from Server, User, and Workspace.",
                  )}
                </small>
              </label>

              <section
                className="profile-field-group"
                aria-labelledby="connection-settings-heading"
              >
                <h3 id="connection-settings-heading">
                  {t("settings.connection.settings")}
                </h3>
                <p>
                  {tr(
                    "选择要连接的服务器、用户和工作区。保存或验证前不会切换当前连接。",
                    "Choose the server, user, and workspace. The current connection is not switched until you save and explicitly connect.",
                  )}
                </p>
                <div className="settings-grid profile-fields">
                  {connectionFields.map(
                    ([key, zhLabel, enLabel, placeholder]) => (
                      <div className="connection-field" key={key}>
                        <label>
                          {zh ? zhLabel : enLabel}
                          <input
                            aria-label={zh ? zhLabel : enLabel}
                            value={draft.context[key] ?? ""}
                            placeholder={placeholder}
                            required
                            autoFocus={!draft.id && key === "server"}
                            spellCheck={false}
                            onChange={(event) =>
                              updateContext(key, event.target.value)
                            }
                          />
                        </label>
                        {(key === "user" || key === "client") && (
                          <div className="connection-field-actions">
                            <button
                              type="button"
                              className="secondary"
                              onClick={(event) =>
                                openResourceDialog(
                                  key === "user" ? "user" : "workspace",
                                  "browse",
                                  event.currentTarget,
                                )
                              }
                            >
                              <Search size={13} /> {t("settings.browse")}
                            </button>
                          </div>
                        )}
                      </div>
                    ),
                  )}
                </div>
                <div
                  className={`connection-root-status connection-root-${rootResolution.phase}`}
                  role="status"
                  aria-live="polite"
                >
                  <strong>Workspace Root</strong>
                  {!current.client ? (
                    <span>
                      {tr(
                        "选择或填写 Workspace 后自动从服务器解析；无需手填本地路径。",
                        "Choose or enter a Workspace to resolve its Root from the server automatically; no local path entry is needed.",
                      )}
                    </span>
                  ) : rootResolution.phase === "resolving" ||
                    rootResolution.phase === "hint" ||
                    rootResolution.phase === "idle" ? (
                    <span>
                      {tr(
                        `正在解析 ${current.client} 的 Root…`,
                        `Resolving Root for ${current.client}…`,
                      )}
                    </span>
                  ) : rootResolution.phase === "error" ? (
                    <>
                      <span>
                        {rootResolution.message ||
                          tr(
                            "Workspace Root 解析失败。",
                            "Workspace Root resolution failed.",
                          )}
                      </span>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setRootResolution({
                            identity: rootIdentity,
                            phase: "idle",
                          });
                          setRootRequestRevision((revision) => revision + 1);
                        }}
                      >
                        {t("settings.retry.root")}
                      </button>
                    </>
                  ) : (
                    <>
                      <code>{rootResolution.root || current.cwd}</code>
                      <span>
                        {rootResolution.phase === "saved"
                          ? tr(
                              "已保存的 Root；保存或激活时后端会再次向服务器核对。",
                              "Saved Root; the backend rechecks it with the server on save or activation.",
                            )
                          : tr(
                              "已按当前草稿从服务器精确解析；保存时仍会再次核对。",
                              "Resolved exactly from the current draft; saving rechecks it again.",
                            )}
                        {rootResolution.simulated
                          ? " · Browser Mock simulated"
                          : ""}
                      </span>
                    </>
                  )}
                </div>
              </section>

              <section
                className="profile-field-group profile-p4-settings"
                aria-labelledby="p4-settings-heading"
              >
                <h3 id="p4-settings-heading">{t("settings.p4.settings")}</h3>
                <p>
                  {tr(
                    "这些高级值随当前已保存连接保存。Workspace Root 始终由上方所选 Workspace 自动解析。",
                    "These advanced values are saved with this connection. Workspace Root is always resolved automatically from the selected Workspace above.",
                  )}
                </p>
                <div className="settings-grid profile-fields">
                  {p4Fields.map(([key, zhLabel, enLabel, placeholder]) => (
                    <div className="connection-field" key={key}>
                      <label>
                        {zh ? zhLabel : enLabel}
                        <input
                          aria-label={zh ? zhLabel : enLabel}
                          value={draft.context[key] ?? ""}
                          placeholder={placeholder}
                          spellCheck={false}
                          onChange={(event) =>
                            updateContext(key, event.target.value)
                          }
                        />
                      </label>
                      {(key === "executable" ||
                        key === "customSubmitExecutablePath") &&
                        pickerAvailable && (
                          <div className="connection-field-actions">
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy || loading}
                              title={tr(
                                "选择 .exe 文件（仅桌面版）",
                                "Choose an .exe file (desktop only)",
                              )}
                              onClick={() => void chooseExecutableFile(key)}
                            >
                              <FolderOpen size={13} /> {t("settings.browse")}
                            </button>
                          </div>
                        )}
                    </div>
                  ))}
                </div>
                <p className="settings-field-note">
                  {tr(
                    "自定义提交工具留空时使用普通提交；配置后，原“提交 CL”按钮启动工具，失败不会回退。保存不会试运行。工作目录使用 exe 所在目录，继承应用环境；首版仅支持一次工具会话，退出不等于提交成功，也不会自动解除占用。",
                    "Leave the custom submit tool empty for native submission. When configured, Submit CL starts the tool without fallback on failure. Saving never runs it. Working directory is the exe folder; environment is inherited. This version supports one tool session; exit does not confirm submission or release occupancy.",
                  )}
                </p>
                <p className="settings-field-note">
                  {tr(
                    "Swarm URL 仅用于生成只读网页链接；不会保存 Swarm token、密码或登录信息。",
                    "The Swarm URL only builds read-only web links. Swarm tokens, passwords, and login data are never stored.",
                  )}
                </p>
              </section>
              <div className="settings-actions">
                {!profiles?.activeProfileId && draft.id && (
                  <button
                    type="button"
                    className="primary"
                    disabled={dirty || busy || loading}
                    onClick={() => void connectSavedProfile()}
                  >
                    {t("settings.use.this.connection")}
                  </button>
                )}
                <button
                  className="primary"
                  type="submit"
                  disabled={!valid || !dirty}
                  aria-describedby={
                    saveDisabledReason ? "save-connection-reason" : undefined
                  }
                  title={saveDisabledReason || undefined}
                >
                  <Save size={14} />
                  {operation === "save"
                    ? t("settings.saving")
                    : t("settings.save.connection")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!connectionValid}
                  aria-describedby={
                    verifyDisabledReason
                      ? "verify-connection-reason"
                      : undefined
                  }
                  title={verifyDisabledReason || undefined}
                  onClick={() => void testConnection()}
                >
                  <RefreshCw
                    size={14}
                    className={operation === "test" ? "spin" : ""}
                  />
                  {operation === "test"
                    ? t("settings.checking")
                    : t("settings.verify.these.settings")}
                </button>
              </div>
            </fieldset>
          </form>

          <div
            ref={actionFeedbackRef}
            className="connection-action-feedback"
            tabIndex={-1}
          >
            {operationMessage && (
              <p role="status" aria-live="polite">
                {operationMessage}
              </p>
            )}
            {notice && (
              <p role="status" aria-live="polite">
                {notice}
              </p>
            )}
            {error && <p role="alert">{error}</p>}
            {connectionFailureNearActions && !error && (
              <p role="alert" className="connection-action-failure">
                <strong>{presentation.title}</strong> — {presentation.detail}{" "}
                <span>
                  {tr(
                    "详细恢复操作见下方连接状态卡片。",
                    "See the connection status card below for recovery steps.",
                  )}
                </span>
              </p>
            )}
            {saveDisabledReason && (
              <p id="save-connection-reason">{saveDisabledReason}</p>
            )}
            {verifyDisabledReason && (
              <p id="verify-connection-reason">{verifyDisabledReason}</p>
            )}
          </div>

          {dirty && (
            <p role="status" className="settings-unsaved-note">
              {activeContextMatches
                ? tr(
                    "有未保存的配置修改；当前使用的连接参数未变，验证状态仍有效。",
                    "There are unsaved profile changes. The active P4 connection settings are unchanged and its verification remains valid.",
                  )
                : tr(
                    "有未保存修改。验证和认证只针对这些设置；保存后状态仍为“尚未验证”。",
                    "There are unsaved changes. Validation and authentication target only these settings; after saving they still remain Not tested.",
                  )}
            </p>
          )}

          <section
            ref={connectionStatusRef}
            className={`connection-status-card connection-status-${presentation.tone}`}
            aria-live="polite"
            aria-busy={busy}
            tabIndex={-1}
          >
            <div className="connection-status-heading">
              <span
                className="connection-status-indicator"
                aria-hidden="true"
              />
              <div>
                <strong>{presentation.title}</strong>
              </div>
            </div>
            <p>{presentation.detail}</p>
            {connection.state === "cliMissing" && (
              <div className="connection-recovery-panel">
                <p>
                  {tr(
                    "先重新检测已有的 P4 CLI。若未安装，请从 Perforce 官方页面选择 P4 CLI，自行确认适用条款并完成安装，再重新检测。打开下载页不会自动安装。",
                    "First check for an existing P4 CLI. If missing, select P4 CLI on the official Perforce page, review the applicable terms and complete installation, then check again. Opening the page does not install it.",
                  )}
                </p>
                <a
                  href="https://www.perforce.com/downloads"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {tr(
                    "Perforce 官方下载（P4 CLI）",
                    "Official Perforce downloads (P4 CLI)",
                  )}
                </a>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void rediscoverCli()}
                >
                  {t("settings.detect.cli.again")}
                </button>
              </div>
            )}
            <dl className="connection-facts">
              <div>
                <dt>{t("settings.server")}</dt>
                <dd>{connection.server || current.server || "—"}</dd>
              </div>
              <div>
                <dt>P4 CLI</dt>
                <dd>{cliVersion || t("settings.unknown")}</dd>
              </div>
            </dl>
            <p className="connection-recovery">
              <strong>{t("settings.next")}</strong>
              {presentation.recovery}
            </p>

            {connection.state === "sslUntrusted" && (
              <div className="connection-recovery-panel">
                {connection.fingerprint ? (
                  <>
                    <div className="connection-fingerprint">
                      <span>{t("settings.server.fingerprint")}</span>
                      <code>{connection.fingerprint}</code>
                    </div>
                    <label className="connection-confirmation">
                      <input
                        type="checkbox"
                        checked={trustConfirmed}
                        disabled={busy}
                        onChange={(event) =>
                          setTrustConfirmed(event.target.checked)
                        }
                      />
                      <span>
                        {tr(
                          `我已通过可信渠道核对 ${connection.server} 的上述完整指纹。`,
                          `I verified the full fingerprint above for ${connection.server} through a trusted channel.`,
                        )}
                      </span>
                    </label>
                    <button
                      type="button"
                      className="secondary"
                      disabled={!trustConfirmed || busy}
                      onClick={() => void trust()}
                    >
                      <ShieldCheck size={14} />{" "}
                      {operation === "trust"
                        ? t("settings.trusting")
                        : t("settings.trust.this.exact.fingerprint")}
                    </button>
                  </>
                ) : (
                  <p role="alert">
                    {tr(
                      "服务器未返回可核对指纹，不能执行 Trust。",
                      "The server returned no verifiable fingerprint, so trust is blocked.",
                    )}
                  </p>
                )}
              </div>
            )}

            {["authRequired", "ticketExpired"].includes(connection.state) && (
              <form
                className="connection-recovery-panel connection-login"
                onSubmit={(event) => {
                  event.preventDefault();
                  void login();
                }}
              >
                <label>
                  <span>
                    {tr(
                      "P4 密码（仅用于本次请求）",
                      "P4 password (this request only)",
                    )}
                  </span>
                  <span className="connection-password-field">
                    <KeyRound size={15} aria-hidden="true" />
                    <input
                      type="password"
                      aria-label={t("settings.p4.password")}
                      value={password}
                      autoComplete="off"
                      disabled={busy}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </span>
                </label>
                <p>
                  {tr(
                    "密码不写入未保存设置、已保存连接、Storage、URL、历史或日志；提交后立即清空。",
                    "The password is never written to unsaved settings, saved connections, storage, URLs, history, or logs and is cleared immediately on submit.",
                  )}
                </p>
                <button
                  type="submit"
                  className="primary"
                  disabled={!password || busy}
                >
                  <LogIn size={14} />{" "}
                  {operation === "login"
                    ? t("settings.logging.in")
                    : connection.state === "ticketExpired"
                      ? t("settings.log.in.again")
                      : t("settings.log.in")}
                </button>
              </form>
            )}

            {connection.state === "externalAuthRequired" && (
              <div className="connection-recovery-panel">
                <p>
                  {tr(
                    "P4Deck 不会用普通密码框伪装完成外部认证。请完成组织的 SSO/MFA 后，再验证这些设置。",
                    "P4Deck will not pretend a normal password form can complete external authentication. Finish your organization's SSO/MFA flow, then verify these settings again.",
                  )}
                </p>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void testConnection()}
                >
                  <RefreshCw size={14} />
                  {tr(
                    "我已完成外部认证，检查状态",
                    "I completed external authentication; check status",
                  )}
                </button>
              </div>
            )}

            {connection.state === "connected" && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void logout()}
              >
                <LogOut size={14} />{" "}
                {operation === "logout"
                  ? t("settings.logging.out.2")
                  : t("settings.log.out")}
              </button>
            )}
          </section>
        </div>
      </div>

      {deleteId && profiles && (
        <Dialog
          title={t("settings.delete.this.saved.connection")}
          description={
            profiles.activeProfileId === deleteId
              ? tr(
                  "删除当前连接后会断开连接并清空相关视图。",
                  "Deleting the current connection will disconnect it and clear related views.",
                )
              : t("settings.delete.this.saved.connection.2")
          }
          source={deleteSource.current}
          zh={zh}
          danger
          busy={busy}
          onRequestClose={() => setDeleteId("")}
          footer={
            <>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                data-dialog-autofocus
                onClick={() => setDeleteId("")}
              >
                {t("settings.cancel")}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={(event) => void deleteProfile(event.currentTarget)}
              >
                {t("settings.delete.connection")}
              </button>
            </>
          }
        >
          <strong>
            {profiles.profiles.find((profile) => profile.id === deleteId)?.name}
          </strong>
          <p>
            {tr(
              "只删除本机保存的连接配置，不删除服务器上的 Workspace 或文件。",
              "This removes the saved connection settings only. Server workspaces and files are kept.",
            )}
          </p>
          {error && <DialogNotice error>{error}</DialogNotice>}
        </Dialog>
      )}
      {resourceDialog?.mode === "browse" && (
        <ConnectionDirectoryDialog
          key={`${resourceDialog.kind}-${resourceDialog.requestGeneration}`}
          kind={resourceDialog.kind}
          context={resourceDialog.context}
          requestGeneration={resourceDialog.requestGeneration}
          fallbackUser={runtime.context.user}
          source={resourceDialog.source}
          zh={zh}
          onDismiss={() => setResourceDialog(undefined)}
          onSelect={(value) => {
            if (resourceDialog.kind === "user")
              updateContext("user", value.name);
            else applyWorkspaceCandidate(value as ConnectionWorkspaceCandidate);
          }}
        />
      )}
      {resourceDialog?.mode === "create" && (
        <ConnectionSpecCreateDialog
          key={`${resourceDialog.kind}-${resourceDialog.requestGeneration}`}
          kind={resourceDialog.kind}
          context={resourceDialog.context}
          requestGeneration={resourceDialog.requestGeneration}
          source={resourceDialog.source}
          zh={zh}
          onDismiss={() => setResourceDialog(undefined)}
          onCreated={(value) => {
            if (resourceDialog.kind === "user")
              updateContext("user", value as string);
            else applyWorkspaceCandidate(value as ConnectionWorkspaceCandidate);
          }}
        />
      )}
    </section>
  );
}
