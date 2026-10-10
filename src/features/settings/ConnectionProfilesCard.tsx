import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cable,
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
import type {
  ConnectionProfile,
  ConnectionProfileErrorCode,
  ConnectionProfiles,
  ConnectionStatus,
  Locale,
  P4Context,
  RuntimeInfo,
} from "../../shared/contracts/types";
import {
  connectionPresentation,
  contextIdentity,
  notTestedStatus,
  probeConnection,
} from "./connectionWizard";
import { normalizeSwarmBaseUrl } from "../swarm/swarmLinks";
import { ConnectionDirectoryDialog } from "./ConnectionDirectoryDialog";
import { ConnectionSpecCreateDialog } from "./ConnectionSpecCreateDialog";

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

type SwitchPhase = "idle" | "verifying" | "committing" | "success" | "error";
type ResourceDialog = {
  kind: "user" | "workspace";
  mode: "browse" | "create";
  context: P4Context;
  requestGeneration: number;
  source: HTMLButtonElement;
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
  return {
    code: parsed.code,
    message:
      (selected && (zh ? selected[0] : selected[1])) ||
      (zh
        ? "操作未完成；当前连接未改动，请重试。"
        : "The operation did not complete. The current connection was not changed; retry."),
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
  const [switchPhase, setSwitchPhase] = useState<SwitchPhase>("idle");
  const [password, setPassword] = useState("");
  const [trustConfirmed, setTrustConfirmed] = useState(false);
  const [profileSearch, setProfileSearch] = useState("");
  const [deleteId, setDeleteId] = useState("");
  const [resourceDialog, setResourceDialog] = useState<ResourceDialog>();
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const generation = useRef(0);
  const inFlight = useRef(false);
  const selectedIdRef = useRef(selectedId);
  const dirtyRef = useRef(false);
  const skipRuntimeGeneration = useRef<number | undefined>(undefined);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLButtonElement | undefined>(undefined);

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
  selectedIdRef.current = selectedId;
  dirtyRef.current = dirty;
  const selectedProfile = profiles?.profiles.find(
    (item) => item.id === selectedId,
  );
  const isActive = !!draft.id && profiles?.activeProfileId === draft.id;
  const savedName = draft.name.trim() || suggestedConnectionName(current);
  const valid = !!(
    savedName &&
    savedName.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(savedName) &&
    current.server &&
    current.user &&
    current.client &&
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
      "cwd",
      "P4 工作目录",
      "P4 working directory",
      "/workspace/project / C:\\project",
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
      setSwitchPhase("idle");
      setPassword("");
      setTrustConfirmed(false);
      setDeleteId("");
      setResourceDialog(undefined);
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
    if (isActive && !dirty) {
      setConnection(runtime.connection);
      setCliVersion(runtime.p4Version);
    }
  }, [dirty, isActive, runtime.connection, runtime.p4Version]);

  useEffect(() => {
    if (!busy && restoreFocusRef.current) {
      restoreFocusRef.current.focus();
      restoreFocusRef.current = undefined;
    }
  }, [busy]);

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
    if (
      isActive &&
      !dirty &&
      contextIdentity(current) === contextIdentity(runtime.context)
    )
      onConnection(current, status, version);
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
      : tr("连接名称已存在。", "That connection name already exists.");
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
    try {
      const document = draft.id
        ? await backend.updateConnectionProfile({
            expectedRevision: profiles.revision,
            id: draft.id,
            name: savedName,
            context: current,
          })
        : await backend.createConnectionProfile({
            expectedRevision: profiles.revision,
            name: savedName,
            context: current,
          });
      if (!isCurrent(token)) return;
      setProfiles(document);
      const saved = draft.id
        ? document.profiles.find((item) => item.id === draft.id)
        : document.profiles.find(
            (item) =>
              item.name === savedName &&
              contextIdentity(item.context) === contextIdentity(current),
          );
      if (!saved)
        throw new Error("notFound: Saved connection was not returned.");
      const nextDraft = fromProfile(saved);
      setSelectedId(saved.id);
      setDraft(nextDraft);
      setBaseline(nextDraft);
      const status = notTestedStatus(saved.context.server);
      setConnection(status);
      setPassword("");
      setTrustConfirmed(false);
      setNotice(
        tr(
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
      if (result.status.state === "connected")
        setNotice(
          runtime.mode === "mock"
            ? tr(
                "浏览器 Mock：仅模拟验证，未发起真实网络连接；此操作不会切换当前连接。",
                "Browser Mock: validation was simulated with no real network connection. This does not activate the saved connection.",
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
    try {
      const trusted = await backend.trustServer({
        context: current,
        fingerprint: snapshot.fingerprint,
        confirmed: true,
      });
      if (!isCurrent(token)) return;
      if (trusted.state === "notTested") {
        const result = await probeConnection(backend, current, () =>
          isCurrent(token),
        );
        if (!result.stale && isCurrent(token))
          publish(result.status, result.discovery.version ?? cliVersion);
      } else publish(trusted);
    } catch {
      if (isCurrent(token))
        setError(
          tr(
            "Trust 请求未完成；未信任其他指纹。",
            "The trust request did not complete. No other fingerprint was trusted.",
          ),
        );
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
    try {
      const authenticated = await backend.login({
        context: current,
        password: singleUsePassword,
        confirmed: true,
      });
      if (!isCurrent(token)) return;
      const status =
        authenticated.state === "connected"
          ? await backend.queryLoginStatus(current)
          : authenticated;
      if (!isCurrent(token)) return;
      publish(status);
      if (status.state === "connected")
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
    } catch {
      if (isCurrent(token))
        setError(
          tr(
            "登录未完成；密码已清空。",
            "Login did not complete; the password was cleared.",
          ),
        );
    } finally {
      finish(token);
    }
  }

  async function logout() {
    if (connection.state !== "connected") return;
    const token = begin("logout");
    if (token == null) return;
    setPassword("");
    try {
      const status = await backend.logout({
        context: current,
        confirmed: true,
      });
      if (!isCurrent(token)) return;
      publish(status);
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
    } catch {
      if (isCurrent(token))
        setError(tr("退出登录未完成。", "Logout did not complete."));
    } finally {
      finish(token);
    }
  }

  function selectProfile(profile: ConnectionProfile) {
    if (dirty) {
      setError(
        tr(
          "请先保存或撤销当前修改。",
          "Save or discard the current changes first.",
        ),
      );
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
      setError(
        tr(
          "请先保存或撤销当前修改。",
          "Save or discard the current changes first.",
        ),
      );
      return;
    }
    setSelectedId("new");
    resetTransient(emptyDraft(runtime));
  }

  function updateContext(key: keyof P4Context, value: string) {
    generation.current += 1;
    setResourceDialog(undefined);
    const next = { ...draft.context, [key]: value };
    setDraft({ ...draft, context: next });
    setConnection(
      notTestedStatus(key === "server" ? value.trim() : next.server.trim()),
    );
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

  async function switchProfile(source: HTMLButtonElement) {
    if (
      !profiles ||
      !draft.id ||
      dirty ||
      draft.id === profiles.activeProfileId
    )
      return;
    const token = begin("switch");
    if (token == null) return;
    setSwitchPhase("verifying");
    try {
      const next = await backend.setActiveConnectionProfile({
        expectedRevision: profiles.revision,
        id: draft.id,
      });
      if (!isCurrent(token)) return;
      setSwitchPhase("committing");
      setProfiles({
        ...profiles,
        revision: profiles.revision + 1,
        activeProfileId: draft.id,
      });
      skipRuntimeGeneration.current = next.contextGeneration;
      onRuntime(next);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (!isCurrent(token)) return;
      setConnection(next.connection);
      setCliVersion(next.p4Version);
      setSwitchPhase("success");
      setNotice(
        runtime.mode === "mock"
          ? tr(
              "浏览器 Mock：模拟切换成功；未访问真实网络。",
              "Browser Mock: switch simulated successfully; no real network was accessed.",
            )
          : tr(
              "当前连接已切换；旧选择、详情、搜索和日志视图已安全清理。",
              "Current connection switched. Old selections, details, search, and log views were safely cleared.",
            ),
      );
    } catch (cause) {
      if (!isCurrent(token)) return;
      const failure = localizedError(cause, zh);
      setSwitchPhase("error");
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

  async function deleteProfile(source: HTMLButtonElement) {
    if (!profiles || !deleteId) return;
    const token = begin("delete");
    if (token == null) return;
    try {
      const document = await backend.deleteConnectionProfile({
        expectedRevision: profiles.revision,
        id: deleteId,
      });
      if (!isCurrent(token)) return;
      setProfiles(document);
      setDeleteId("");
      chooseDocumentProfile(document);
      setNotice(tr("已保存连接已删除。", "Saved connection deleted."));
      requestAnimationFrame(() => newButtonRef.current?.focus());
    } catch (cause) {
      if (!isCurrent(token)) return;
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

  const switchMessage = {
    idle: "",
    verifying: tr("正在验证目标连接…", "Verifying target connection…"),
    committing: tr(
      "验证通过，正在切换当前连接…",
      "Verified; switching the current connection…",
    ),
    success: tr("连接切换成功。", "Connection switch succeeded."),
    error: tr(
      "连接切换失败，原连接保持不变。",
      "Connection switch failed; the previous connection remains active.",
    ),
  }[switchPhase];

  return (
    <section className="settings-card connection-profiles-card">
      <h2>
        <Cable size={18} />
        {tr("已保存连接", "Saved connections")}
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
          aria-label={tr("已保存连接列表", "Saved connections list")}
        >
          <div className="profile-list-tools">
            <label className="profile-search">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label={tr("搜索已保存连接", "Search saved connections")}
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
              <Plus size={14} /> {tr("新建", "New")}
            </button>
          </div>
          <div className="profile-list" role="list" aria-busy={loading}>
            {filteredProfiles.map((profile) => {
              const active = profile.id === profiles?.activeProfileId;
              const last = profiles?.profiles.length === 1;
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
                      {active && <em>{tr("当前", "Current")}</em>}
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
                    title={
                      active
                        ? tr("请先切换当前连接", "Switch connections first")
                        : last
                          ? tr(
                              "不能删除最后一个已保存连接",
                              "The last saved connection cannot be deleted",
                            )
                          : tr("删除已保存连接", "Delete saved connection")
                    }
                    disabled={busy || active || last}
                    onClick={() => setDeleteId(profile.id)}
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
                  ? tr("编辑已保存连接", "Edit saved connection")
                  : tr("新建连接", "New connection")}
              </strong>
              <span>
                {isActive
                  ? tr("当前正在使用", "Currently in use")
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
                {tr("连接名称（可选）", "Connection name (optional)")}
                <input
                  aria-label={tr(
                    "连接名称（可选）",
                    "Connection name (optional)",
                  )}
                  value={draft.name}
                  maxLength={128}
                  placeholder={
                    suggestedConnectionName(current) ||
                    tr("保存时自动生成", "Generated when saved")
                  }
                  onChange={(event) => {
                    generation.current += 1;
                    setDraft({ ...draft, name: event.target.value });
                    setConnection(notTestedStatus(current.server));
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
                  {tr("连接设置", "Connection settings")}
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
                              <Search size={13} /> {tr("浏览", "Browse")}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={(event) =>
                                openResourceDialog(
                                  key === "user" ? "user" : "workspace",
                                  "create",
                                  event.currentTarget,
                                )
                              }
                            >
                              <Plus size={13} /> {tr("新建", "New")}
                            </button>
                          </div>
                        )}
                      </div>
                    ),
                  )}
                </div>
              </section>

              <section
                className="profile-field-group profile-p4-settings"
                aria-labelledby="p4-settings-heading"
              >
                <h3 id="p4-settings-heading">{tr("P4 设置", "P4 settings")}</h3>
                <p>
                  {tr(
                    "这些值随当前已保存连接保存。P4 工作目录是命令执行上下文，不是新建 Workspace 的 Root。",
                    "These values are saved with this connection. The P4 working directory is command context, not the Root of a newly created Workspace.",
                  )}
                </p>
                <div className="settings-grid profile-fields">
                  {p4Fields.map(([key, zhLabel, enLabel, placeholder]) => (
                    <label key={key}>
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
                  ))}
                </div>
                <p className="settings-field-note">
                  {tr(
                    "Swarm URL 仅用于生成只读网页链接；不会保存 Swarm token、密码或登录信息。",
                    "The Swarm URL only builds read-only web links. Swarm tokens, passwords, and login data are never stored.",
                  )}
                </p>
              </section>
              <div className="settings-actions">
                <button
                  className="primary"
                  type="submit"
                  disabled={!valid || !dirty}
                >
                  <Save size={14} />
                  {operation === "save"
                    ? tr("正在保存…", "Saving…")
                    : tr("保存连接", "Save connection")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!connectionValid}
                  onClick={() => void testConnection()}
                >
                  <RefreshCw
                    size={14}
                    className={operation === "test" ? "spin" : ""}
                  />
                  {operation === "test"
                    ? tr("正在验证…", "Checking…")
                    : tr("验证这些设置", "Verify these settings")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!dirty}
                  onClick={() => {
                    setDraft(baseline);
                    setConnection(
                      isActive
                        ? runtime.connection
                        : notTestedStatus(baseline.context.server),
                    );
                    setNotice("");
                    setError("");
                    setPassword("");
                    setTrustConfirmed(false);
                  }}
                >
                  {tr("撤销修改", "Discard edits")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!draft.id || isActive || dirty || busy}
                  onClick={(event) => void switchProfile(event.currentTarget)}
                >
                  {operation === "switch"
                    ? tr("正在切换…", "Switching…")
                    : tr("连接并使用", "Connect and use")}
                </button>
              </div>
            </fieldset>
          </form>

          {dirty && (
            <p role="status" className="settings-unsaved-note">
              {tr(
                "有未保存修改。验证和认证只针对这些设置；保存后状态仍为“尚未验证”。",
                "There are unsaved changes. Validation and authentication target only these settings; after saving they still remain Not tested.",
              )}
            </p>
          )}

          <section
            className={`connection-status-card connection-status-${presentation.tone}`}
            aria-live="polite"
            aria-busy={busy}
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
            <dl className="connection-facts">
              <div>
                <dt>{tr("服务器", "Server")}</dt>
                <dd>{connection.server || current.server || "—"}</dd>
              </div>
              <div>
                <dt>P4 CLI</dt>
                <dd>{cliVersion || tr("未知", "Unknown")}</dd>
              </div>
            </dl>
            <p className="connection-recovery">
              <strong>{tr("下一步：", "Next: ")}</strong>
              {presentation.recovery}
            </p>

            {connection.state === "sslUntrusted" && (
              <div className="connection-recovery-panel">
                {connection.fingerprint ? (
                  <>
                    <div className="connection-fingerprint">
                      <span>{tr("服务器指纹", "Server fingerprint")}</span>
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
                        ? tr("正在写入 Trust…", "Trusting…")
                        : tr("信任此精确指纹", "Trust this exact fingerprint")}
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
                      aria-label={tr("P4 密码", "P4 password")}
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
                    ? tr("正在登录…", "Logging in…")
                    : connection.state === "ticketExpired"
                      ? tr("重新登录", "Log in again")
                      : tr("登录", "Log in")}
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
                  ? tr("正在退出…", "Logging out…")
                  : tr("退出登录", "Log out")}
              </button>
            )}
          </section>
        </div>
      </div>

      {deleteId && profiles && (
        <div
          className="profile-delete-confirm"
          role="alertdialog"
          aria-modal="false"
          aria-labelledby="delete-profile-title"
        >
          <strong id="delete-profile-title">
            {tr("确认删除已保存连接？", "Delete this saved connection?")}
          </strong>
          <p>
            {tr(
              "此操作删除已保存的非敏感连接设置，不能撤销。当前连接和最后一个已保存连接始终受保护。",
              "This permanently deletes the saved non-secret connection settings. The current and last saved connections are always protected.",
            )}
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="danger"
              onClick={(event) => void deleteProfile(event.currentTarget)}
            >
              {tr("确认删除", "Delete connection")}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setDeleteId("")}
            >
              {tr("取消", "Cancel")}
            </button>
          </div>
        </div>
      )}

      <div
        className="profile-operation-status"
        role="status"
        aria-live="polite"
      >
        {switchMessage}
      </div>
      {notice && (
        <p role="status" className="settings-note">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="workspace-load-error">
          {error}
        </p>
      )}
      {selectedProfile && isActive && profiles?.profiles.length === 1 && (
        <p className="settings-note">
          {tr(
            "这是当前且唯一的已保存连接，不能删除。请先新建并连接到另一个连接。",
            "This is the current and only saved connection. Create and connect to another connection before deleting it.",
          )}
        </p>
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
          onSelect={(value) =>
            updateContext(
              resourceDialog.kind === "user" ? "user" : "client",
              value,
            )
          }
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
          onCreated={(value) =>
            updateContext(
              resourceDialog.kind === "user" ? "user" : "client",
              value,
            )
          }
        />
      )}
    </section>
  );
}
