import { t, tFor, type MsgKey } from "../../shared/i18n";
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
import { useOperationSession } from "../../shared/operationSession";
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
      "settings.connectionError.invalidInput",
      "settings.connectionError.invalidInput",
    ],
    duplicateName: [
      "settings.connectionError.duplicateName",
      "settings.connectionError.duplicateName",
    ],
    duplicateContext: [
      "settings.connectionError.duplicateContext",
      "settings.connectionError.duplicateContext",
    ],
    notFound: [
      "settings.connectionError.notFound",
      "settings.connectionError.notFound",
    ],
    revisionConflict: [
      "settings.connectionError.revisionConflict",
      "settings.connectionError.revisionConflict",
    ],
    activeProfileDelete: [
      "settings.connectionError.activeProfileDelete",
      "settings.connectionError.activeProfileDelete",
    ],
    lastProfileDelete: [
      "settings.connectionError.lastProfileDelete",
      "settings.connectionError.lastProfileDelete",
    ],
    corruptStore: [
      "settings.connectionError.corruptStore",
      "settings.connectionError.corruptStore",
    ],
    unsupportedSchema: [
      "settings.connectionError.unsupportedSchema",
      "settings.connectionError.unsupportedSchema",
    ],
    persistenceFailed: [
      "settings.connectionError.persistenceFailed",
      "settings.connectionError.persistenceFailed",
    ],
    connectionFailed: [
      "settings.connectionError.connectionFailed",
      "settings.connectionError.connectionFailed",
    ],
    authenticationRequired: [
      "settings.connectionError.authenticationRequired",
      "settings.connectionError.authenticationRequired",
    ],
    contextChanged: [
      "settings.connectionError.contextChanged",
      "settings.connectionError.contextChanged",
    ],
  };
  const selected = parsed.code ? copy[parsed.code] : undefined;
  const base =
    (selected && tFor(zh ? "zh-CN" : "en-US", selected[0] as MsgKey)) ||
    tFor(zh ? "zh-CN" : "en-US", "settings.the.operation.did.not.complete");
  // Surface the backend OS error (path/errno) for support; the localized text alone hides it.
  const detail = parsed.detail.trim().slice(0, 300);
  return {
    code: parsed.code,
    message: detail
      ? base +
        tFor(zh ? "zh-CN" : "en-US", "settings.detail") +
        detail +
        (zh ? "）" : ")")
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
  /** The busy token; see `bumpToken` for why it is not a session lease. */
  const tokenRef = useRef(0);
  const bumpToken = () => ++tokenRef.current;
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  /**
   * The busy token below is an ordering token, not a cancellable operation: it
   * only answers "is this still the newest action", and every increment is a
   * supersede point. The workspace-root browse has its own channel because it
   * is the one request here that must actually be cancelled.
   */
  const session = useOperationSession();
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
    [
      "server",
      "settings.field.server",
      "settings.field.server",
      "ssl:perforce:1666",
    ],
    ["user", "settings.field.user", "settings.field.user", "username"],
    [
      "client",
      "settings.field.client",
      "settings.field.client",
      "workspace-name",
    ],
  ];
  const p4Fields: ContextField[] = [
    ["charset", "settings.field.charset", "settings.field.charset", "utf8"],
    [
      "trustPath",
      "settings.field.trustPath",
      "settings.field.trustPath",
      "P4TRUST",
    ],
    [
      "ticketsPath",
      "settings.field.ticketsPath",
      "settings.field.ticketsPath",
      "P4TICKETS",
    ],
    [
      "swarmBaseUrl",
      "settings.field.swarmBaseUrl",
      "settings.field.swarmBaseUrl",
      "https://swarm.example/",
    ],
    [
      "executable",
      "settings.field.executable",
      "settings.field.executable",
      "p4 / p4.exe",
    ],
    [
      "customSubmitExecutablePath",
      "settings.field.customSubmitExecutablePath",
      "settings.field.customSubmitExecutablePath",
      "C:\\Tools\\submit.exe",
    ],
  ];

  const resetTransient = useCallback(
    (next: ProfileDraft, status?: ConnectionStatus) => {
      bumpToken();
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
    // The root browse is the one request here that must be cancelled: it names
    // a runner prefix and its cleanup aborts it. It is also the only place the
    // host compares the generation (a re-confirmation must match), which is why
    // it keeps the monotonic `seq` rather than a shared lease value.
    const lease = session.start("workspace-root", {
      operationId: `workspace-root-${crypto.randomUUID()}`,
      cancelBackend: false,
    });
    const operationId = lease.operationId;
    rootOperation.current = operationId;
    /** The browse is still the current one for this effect run. */
    const isCurrent = () => seq === rootSequence.current;
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
            !isCurrent() ||
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
                ? t("settings.the.root.returned")
                : t("settings.the.server.returned.no.exact.workspace"),
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
          if (!isCurrent()) return;
          clearDerivedRoot();
          setConnection(notTestedStatus(current.server));
          setRootResolution({
            identity,
            phase: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        })
        .finally(() => {
          if (isCurrent()) rootOperation.current = undefined;
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      rootSequence.current += 1;
      // Superseding the lease is the cancel: it fires once, only for the id
      // this run actually sent.
      if (rootOperation.current === operationId)
        rootOperation.current = undefined;
      session.abandon(lease);
    };
    // current is intentionally captured by the explicit, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootIdentity, rootRequestRevision, tr, zh]);

  function begin(nextOperation: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    const token = bumpToken();
    setBusy(true);
    setOperation(nextOperation);
    setError("");
    setNotice("");
    return token;
  }

  function isCurrent(token: number) {
    return token === tokenRef.current;
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
    if (!swarmUrlValid) return t("settings.swarm.url.must.be.an.http");
    if (!valid) return t("settings.connection.name.must.contain.1.128");
    const duplicate = profiles?.profiles.find(
      (profile) =>
        profile.id !== draft.id &&
        (profile.name.trim().toLocaleLowerCase() ===
          savedName.toLocaleLowerCase() ||
          contextIdentity(profile.context) === contextIdentity(current)),
    );
    if (!duplicate) return "";
    return contextIdentity(duplicate.context) === contextIdentity(current)
      ? t("settings.a.saved.connection.with.the.same")
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
          ? t("settings.profile.saved.p4.connection.settings.are")
          : t("settings.connection.saved.it.remains.not.tested"),
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
            t("settings.saved.connections.changed.concurrently.and.reload"),
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
      if (!unavailable) setNotice(t("settings.p4.cli.found.use.verify.these"));
    } catch {
      if (isCurrent(token))
        setError(t("settings.cli.detection.did.not.complete.retry"));
    } finally {
      finish(token);
    }
  }

  async function testConnection() {
    if (!connectionValid) {
      setError(t("settings.verifying.requires.server"));
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
            ? t("settings.browser.was.simulated")
            : activeContextMatches
              ? t("settings.the.active.connection.and.login.are")
              : t("settings.the.current.unsaved.settings.are.connected"),
        );
    } catch {
      if (isCurrent(token))
        setError(t("settings.the.connection.check.did.not.complete"));
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
        setError(t("settings.the.trust.result.was.not.proven"));
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
        setError(t("settings.the.trust.request.did.not.complete"));
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
            ? t("settings.browser.mock.login.was.simulated.without")
            : t("settings.the.are.authenticated"),
        );
      else setError(t("settings.login.not.proven"));
    } catch {
      if (isCurrent(token)) {
        await recoverControlOnce(operationId);
        setError(t("settings.login.did.not.complete.the.password"));
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
            ? t("settings.browser.mock.logout.was.simulated.without")
            : t("settings.the.user.for.the.current.settings"),
        );
      else setError(t("settings.logout.not.proven"));
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
    bumpToken();
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
      setError(t("settings.this.workspace.root.is.not.usable"));
      return;
    }
    bumpToken();
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
    const requestGeneration = bumpToken();
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
      ? t("settings.wait.for.the.current.connection.operation")
      : "";
  const saveDisabledReason = sharedDisabledReason
    ? sharedDisabledReason
    : !dirty
      ? t("settings.there.no.changes")
      : !valid
        ? t("settings.saving.requires.valid.server.user.workspace")
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
      <p>{t("settings.saved.connections.contain.only.allowlisted.non")}</p>
      {runtime.mode === "mock" && (
        <p className="settings-note settings-mock-disclosure">
          {t("settings.browser.mock.is.explicitly.simulated.saving")}
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
                placeholder={t("settings.search.name.server.user.or.workspace")}
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
                    aria-label={tFor(
                      zh ? "zh-CN" : "en-US",
                      "settings.delete.profile",
                      {
                        name: profile.name,
                      },
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
                  ? t("settings.no.matching.saved.connections")
                  : t("settings.no.saved.connections.yet.create.one")}
              </p>
            )}
          </div>
          <small className="profile-list-count">
            {tFor(zh ? "zh-CN" : "en-US", "settings.showing.connections", {
              shown: filteredProfiles.length,
              total: profiles?.profiles.length ?? 0,
            })}
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
                  : t("settings.changes.are.not.applied.validation.does")}
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
                  aria-label={t("settings.connection.name.optional")}
                  value={draft.name}
                  maxLength={128}
                  placeholder={
                    suggestedConnectionName(current) ||
                    t("settings.generated.when.saved")
                  }
                  onChange={(event) => {
                    bumpToken();
                    setDraft({ ...draft, name: event.target.value });
                    setNotice("");
                    setError("");
                    setPassword("");
                    setTrustConfirmed(false);
                  }}
                />
                <small>
                  {t("settings.used.only.to.distinguish.saved.connections")}
                </small>
              </label>

              <section
                className="profile-field-group"
                aria-labelledby="connection-settings-heading"
              >
                <h3 id="connection-settings-heading">
                  {t("settings.connection.settings")}
                </h3>
                <p>{t("settings.choose.the.server.user.and.workspace")}</p>
                <div className="settings-grid profile-fields">
                  {connectionFields.map(
                    ([key, zhLabel, _enLabel, placeholder]) => (
                      <div className="connection-field" key={key}>
                        <label>
                          {tFor(zh ? "zh-CN" : "en-US", zhLabel as MsgKey)}
                          <input
                            aria-label={tFor(
                              zh ? "zh-CN" : "en-US",
                              zhLabel as MsgKey,
                            )}
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
                    <span>{t("settings.choose.a.workspace")}</span>
                  ) : rootResolution.phase === "resolving" ||
                    rootResolution.phase === "hint" ||
                    rootResolution.phase === "idle" ? (
                    <span>
                      {tFor(zh ? "zh-CN" : "en-US", "settings.resolving.root", {
                        client: current.client,
                      })}
                    </span>
                  ) : rootResolution.phase === "error" ? (
                    <>
                      <span>
                        {rootResolution.message ||
                          t("settings.workspace.root.resolution.failed")}
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
                          ? t("settings.saved.root.the.backend.rechecks.it")
                          : t(
                              "settings.resolved.exactly.from.the.current.draft",
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
                <p>{t("settings.these.are.saved")}</p>
                <div className="settings-grid profile-fields">
                  {p4Fields.map(([key, zhLabel, _enLabel, placeholder]) => (
                    <div className="connection-field" key={key}>
                      <label>
                        {tFor(zh ? "zh-CN" : "en-US", zhLabel as MsgKey)}
                        <input
                          aria-label={tFor(
                            zh ? "zh-CN" : "en-US",
                            zhLabel as MsgKey,
                          )}
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
                              title={t(
                                "settings.choose.an.exe.file.desktop.only",
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
                  {t("settings.leave.the.custom.submit.tool.empty")}
                </p>
                <p className="settings-field-note">
                  {t("settings.the.swarm.url.only.builds.read")}
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
                  {t("settings.see.the.connection.status.card.below")}
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
                ? t("settings.there.profile.changes")
                : t("settings.there.changes.validation")}
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
                <p>{t("settings.first.check.for.an.existing.p4")}</p>
                <a
                  href="https://www.perforce.com/downloads"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("settings.official.perforce.downloads.p4.cli")}
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
                        {tFor(
                          zh ? "zh-CN" : "en-US",
                          "settings.verified.fingerprint.through.trusted",
                          {
                            server: connection.server,
                          },
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
                    {t(
                      "settings.the.server.returned.no.verifiable.fingerprint",
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
                  <span>{t("settings.p4.password.this.request.only")}</span>
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
                <p>{t("settings.the.never.written")}</p>
                <button
                  type="submit"
                  className="primary"
                  disabled={!password || busy}
                >
                  <LogIn size={14} />{" "}
                  {operation === "login"
                    ? t("settings.loggingIn")
                    : connection.state === "ticketExpired"
                      ? t("settings.log.in.again")
                      : t("settings.logIn")}
                </button>
              </form>
            )}

            {connection.state === "externalAuthRequired" && (
              <div className="connection-recovery-panel">
                <p>{t("settings.p4deck.will.not.pretend.a.normal")}</p>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void testConnection()}
                >
                  <RefreshCw size={14} />
                  {t(
                    "settings.i.completed.external.authentication.check.status",
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
              ? t("settings.deleting.the.current.connection.will.disconnect")
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
          <p>{t("settings.this.removes.the.saved.connection.settings")}</p>
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
