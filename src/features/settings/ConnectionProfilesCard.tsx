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

type SwitchPhase = "idle" | "verifying" | "committing" | "success" | "error";

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
      "Profile 名称已存在，请使用唯一名称。",
      "That profile name already exists. Use a unique name.",
    ],
    duplicateContext: [
      "相同连接参数的 Profile 已存在。",
      "A profile with the same connection context already exists.",
    ],
    notFound: [
      "该 Profile 或 Workspace 已不存在，请刷新后重试。",
      "That profile or workspace no longer exists. Refresh and retry.",
    ],
    revisionConflict: [
      "Profile 已被其他操作修改；已重新加载，请核对草稿后重试。",
      "Profiles changed elsewhere. The list was reloaded; review the draft and retry.",
    ],
    activeProfileDelete: [
      "活动 Profile 不能删除；请先切换到其他 Profile。",
      "The active profile cannot be deleted. Switch to another profile first.",
    ],
    lastProfileDelete: [
      "最后一个 Profile 不能删除。",
      "The last profile cannot be deleted.",
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
      "验证失败，仍保留原活动 Profile 和页面数据。",
      "Verification failed. The previous active profile and page data were preserved.",
    ],
    authenticationRequired: [
      "目标 Profile 尚未登录；原活动 Profile 保持不变。",
      "The target profile is not authenticated. The previous active profile remains active.",
    ],
    contextChanged: [
      "活动连接在操作期间已变化；已保留最新运行时。",
      "The active connection changed during the operation. The latest runtime was preserved.",
    ],
  };
  const selected = parsed.code ? copy[parsed.code] : undefined;
  return {
    code: parsed.code,
    message:
      (selected && (zh ? selected[0] : selected[1])) ||
      (zh
        ? "操作未完成；未改动活动运行时，请重试。"
        : "The operation did not complete. The active runtime was not changed; retry."),
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
  const valid = !!(
    draft.name.trim() &&
    draft.name.trim().length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(draft.name) &&
    current.server &&
    current.user &&
    current.client &&
    swarmUrlValid
  );
  const presentation = connectionPresentation(connection, zh);
  const fields: [keyof P4Context, string, string][] = [
    ["server", "服务器 / P4PORT", "ssl:perforce:1666"],
    ["user", "用户 / P4USER", "username"],
    ["client", "工作区 / P4CLIENT", "workspace-name"],
    ["cwd", "工作目录", "/workspace/project / C:\\project"],
    ["charset", "字符集 / P4CHARSET", "utf8"],
    ["executable", "P4 可执行文件", "p4 / p4.exe"],
    ["trustPath", "Trust 文件路径", "P4TRUST"],
    ["ticketsPath", "Tickets 文件路径", "P4TICKETS"],
    ["swarmBaseUrl", "Swarm 基础 URL（可选）", "https://swarm.example/"],
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
        "Profile 名称需为 1–128 个非控制字符，Server、User、Workspace 为必填。",
        "Profile name must contain 1–128 non-control characters; Server, User, and Workspace are required.",
      );
    const duplicate = profiles?.profiles.find(
      (profile) =>
        profile.id !== draft.id &&
        (profile.name.trim().toLocaleLowerCase() ===
          draft.name.trim().toLocaleLowerCase() ||
          contextIdentity(profile.context) === contextIdentity(current)),
    );
    if (!duplicate) return "";
    return contextIdentity(duplicate.context) === contextIdentity(current)
      ? tr(
          "相同连接参数的 Profile 已存在。",
          "A profile with the same connection context already exists.",
        )
      : tr("Profile 名称已存在。", "That profile name already exists.");
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
            name: draft.name.trim(),
            context: current,
          })
        : await backend.createConnectionProfile({
            expectedRevision: profiles.revision,
            name: draft.name.trim(),
            context: current,
          });
      if (!isCurrent(token)) return;
      setProfiles(document);
      const saved = draft.id
        ? document.profiles.find((item) => item.id === draft.id)
        : document.profiles.find(
            (item) =>
              item.name === draft.name.trim() &&
              contextIdentity(item.context) === contextIdentity(current),
          );
      if (!saved) throw new Error("notFound: Saved profile was not returned.");
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
          "Profile 已保存；状态仍为“尚未验证”，保存不会冒充已连接。",
          "Profile saved. It remains Not tested; saving never pretends the profile is connected.",
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
              "Profile 已并发修改，且重新加载失败；请稍后重试。",
              "Profiles changed concurrently and reload failed. Retry later.",
            ),
          );
        }
      }
    } finally {
      finish(token);
    }
  }

  async function testConnection() {
    const validation = clientValidation();
    if (validation && !valid) {
      setError(validation);
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
                "浏览器 Mock：仅模拟验证，未发起真实网络连接；此操作不会激活 Profile。",
                "Browser Mock: validation was simulated with no real network connection. This does not activate the profile.",
              )
            : tr(
                "当前编辑草稿的连接与登录已验证；验证不会激活或保存 Profile。",
                "The current editor draft is connected and authenticated. Validation does not save or activate the profile.",
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
                "当前草稿登录成功；密码已清空。",
                "The current draft is authenticated; the password was cleared.",
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
              "当前草稿对应用户已退出。",
              "The user for the current draft was logged out.",
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
          "请先保存或撤销当前草稿。",
          "Save or discard the current draft first.",
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
          "请先保存或撤销当前草稿。",
          "Save or discard the current draft first.",
        ),
      );
      return;
    }
    setSelectedId("new");
    resetTransient(emptyDraft(runtime));
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
              "活动 Profile 已切换；旧选择、详情、搜索和日志视图已按新代次清理。",
              "Active profile switched. Old selections, details, search, and log views were cleared for the new generation.",
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
      setNotice(tr("Profile 已删除。", "Profile deleted."));
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
    verifying: tr("正在验证目标 Profile…", "Verifying target profile…"),
    committing: tr(
      "验证通过，正在提交活动 Profile…",
      "Verified; committing the active profile…",
    ),
    success: tr("Profile 切换成功。", "Profile switch succeeded."),
    error: tr(
      "Profile 切换失败，原活动 Profile 保持不变。",
      "Profile switch failed; the previous profile remains active.",
    ),
  }[switchPhase];

  return (
    <section className="settings-card connection-profiles-card">
      <h2>
        <Cable size={18} />
        {tr("连接 Profile", "Connection profiles")}
      </h2>
      <p>
        {tr(
          "Profile 只保存后端允许的非敏感 Context 字段和凭证文件路径；密码、ticket 内容与服务器指纹不会进入 Profile、Storage、URL 或日志。",
          "Profiles store only allowlisted, non-secret context fields and credential-file paths. Passwords, ticket contents, and server fingerprints never enter profiles, storage, URLs, or logs.",
        )}
      </p>
      {runtime.mode === "mock" && (
        <p className="settings-note settings-mock-disclosure">
          {tr(
            "浏览器 Mock 明确为 simulated：CRUD、验证和切换只改变模拟状态，不访问真实网络。",
            "Browser Mock is explicitly simulated: CRUD, validation, and switching only change mock state and never access a real network.",
          )}
        </p>
      )}
      <div className="profile-manager">
        <aside
          className="profile-list-panel"
          aria-label={tr("Profile 列表", "Profile list")}
        >
          <div className="profile-list-tools">
            <label className="profile-search">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label={tr("搜索 Profile", "Search profiles")}
                value={profileSearch}
                placeholder={tr(
                  "搜索名称或 Context…",
                  "Search name or context…",
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
                      <strong>{profile.name}</strong>
                      {active && <em>{tr("活动", "Active")}</em>}
                    </span>
                    <small>
                      {profile.context.server} · {profile.context.user} ·{" "}
                      {profile.context.client}
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
                        ? tr("先切换活动 Profile", "Switch profiles first")
                        : last
                          ? tr(
                              "不能删除最后一个 Profile",
                              "The last profile cannot be deleted",
                            )
                          : tr("删除 Profile", "Delete profile")
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
                  ? tr("没有匹配的 Profile。", "No matching profiles.")
                  : tr(
                      "尚无 Profile，请新建。",
                      "No profiles yet. Create one.",
                    )}
              </p>
            )}
          </div>
          <small className="profile-list-count">
            {filteredProfiles.length} / {profiles?.profiles.length ?? 0} ·{" "}
            {tr("Revision", "Revision")} {profiles?.revision ?? "—"}
          </small>
        </aside>

        <div className="profile-editor">
          <div className="profile-editor-heading">
            <div>
              <strong>
                {draft.id
                  ? tr("编辑 Profile", "Edit profile")
                  : tr("新建 Profile", "New profile")}
              </strong>
              <span>
                {isActive
                  ? tr("活动运行时", "Active runtime")
                  : tr(
                      "草稿/非活动 Profile；验证不会切换运行时",
                      "Draft/inactive profile; validation does not switch runtime",
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
              <div className="settings-grid profile-fields">
                <label className="profile-name-field">
                  {tr("Profile 名称", "Profile name")}
                  <input
                    aria-label={tr("Profile 名称", "Profile name")}
                    value={draft.name}
                    maxLength={128}
                    required
                    autoFocus={!draft.id}
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
                </label>
                {fields.map(([key, label, placeholder]) => (
                  <label key={key}>
                    {zh ? label : key}
                    <input
                      aria-label={label}
                      value={draft.context[key] ?? ""}
                      placeholder={placeholder}
                      required={["server", "user", "client"].includes(key)}
                      spellCheck={false}
                      onChange={(event) => {
                        generation.current += 1;
                        const next = {
                          ...draft.context,
                          [key]: event.target.value,
                        };
                        setDraft({ ...draft, context: next });
                        setConnection(
                          notTestedStatus(
                            key === "server"
                              ? event.target.value.trim()
                              : next.server.trim(),
                          ),
                        );
                        setNotice("");
                        setError("");
                        setPassword("");
                        setTrustConfirmed(false);
                      }}
                    />
                  </label>
                ))}
              </div>
              <p className="settings-field-note">
                {tr(
                  "Swarm URL 按 Profile 保存，仅用于生成只读网页链接；不会保存 Swarm token、密码或登录信息。",
                  "The Swarm URL is profile-scoped and only builds read-only web links. Swarm tokens, passwords, and login data are never stored.",
                )}
              </p>
              <div className="settings-actions">
                <button
                  className="primary"
                  type="submit"
                  disabled={!valid || !dirty}
                >
                  <Save size={14} />
                  {operation === "save"
                    ? tr("正在保存…", "Saving…")
                    : tr("保存 Profile", "Save profile")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!valid}
                  onClick={() => void testConnection()}
                >
                  <RefreshCw
                    size={14}
                    className={operation === "test" ? "spin" : ""}
                  />
                  {operation === "test"
                    ? tr("正在验证…", "Checking…")
                    : tr("验证当前草稿", "Verify current draft")}
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
                    : tr("设为活动 Profile", "Make active")}
                </button>
              </div>
            </fieldset>
          </form>

          {dirty && (
            <p role="status" className="settings-unsaved-note">
              {tr(
                "草稿有未保存修改。验证/认证只针对当前草稿；保存后状态仍为“尚未验证”。",
                "The draft has unsaved changes. Validation/authentication targets this draft only; after saving it still remains Not tested.",
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
                <span>{connection.state}</span>
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
                    "密码不写入草稿、Profile、Storage、URL、历史或日志；提交后立即清空。",
                    "The password is never written to drafts, profiles, storage, URLs, history, or logs and is cleared immediately on submit.",
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
                    "P4Deck 不会用普通密码框伪装完成外部认证。请完成组织的 SSO/MFA 后，再验证当前草稿。",
                    "P4Deck will not pretend a normal password form can complete external authentication. Finish your organization's SSO/MFA flow, then verify this draft again.",
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
            {tr("确认删除 Profile？", "Delete this profile?")}
          </strong>
          <p>
            {tr(
              "此操作删除已保存的非敏感连接参数，不能撤销。活动 Profile 和最后一个 Profile 始终受保护。",
              "This permanently deletes the saved non-secret connection parameters. Active and last profiles are always protected.",
            )}
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="danger"
              onClick={(event) => void deleteProfile(event.currentTarget)}
            >
              {tr("确认删除", "Delete profile")}
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
            "这是活动且唯一的 Profile，不能删除。请先新建并切换到其他 Profile。",
            "This is the active and only profile. Create and switch to another profile before deleting it.",
          )}
        </p>
      )}
    </section>
  );
}
