import type { Backend } from "../../infrastructure/backend/contract";
import { tFor, type MsgKey } from "../../shared/i18n";
import { pathKey } from "../files/address";
import type {
  CliDiscoveryResult,
  ConnectionState,
  ConnectionStatus,
  P4Context,
  RecoveryAction,
} from "../../shared/contracts";

export interface ConnectionPresentation {
  title: string;
  detail: string;
  recovery: string;
  tone: "neutral" | "success" | "warning" | "danger";
}

const stateCopy: Record<
  ConnectionState,
  {
    zh: [string, string];
    en: [string, string];
    tone: ConnectionPresentation["tone"];
  }
> = {
  cliMissing: {
    zh: [
      "settings.connectionState.cliMissing.title",
      "settings.connectionState.cliMissing.detail",
    ],

    en: [
      "settings.connectionState.cliMissing.title",
      "settings.connectionState.cliMissing.detail",
    ],
    tone: "danger",
  },
  notTested: {
    zh: [
      "settings.connectionState.notTested.title",
      "settings.connectionState.notTested.detail",
    ],

    en: [
      "settings.connectionState.notTested.title",
      "settings.connectionState.notTested.detail",
    ],
    tone: "neutral",
  },
  disconnected: {
    zh: [
      "settings.connectionState.disconnected.title",
      "settings.connectionState.disconnected.detail",
    ],

    en: [
      "settings.connectionState.disconnected.title",
      "settings.connectionState.disconnected.detail",
    ],
    tone: "danger",
  },
  sslUntrusted: {
    zh: [
      "settings.connectionState.sslUntrusted.title",
      "settings.connectionState.sslUntrusted.detail",
    ],

    en: [
      "settings.connectionState.sslUntrusted.title",
      "settings.connectionState.sslUntrusted.detail",
    ],
    tone: "warning",
  },
  authRequired: {
    zh: [
      "settings.connectionState.authRequired.title",
      "settings.connectionState.authRequired.detail",
    ],

    en: [
      "settings.connectionState.authRequired.title",
      "settings.connectionState.authRequired.detail",
    ],
    tone: "warning",
  },
  connected: {
    zh: [
      "settings.connectionState.connected.title",
      "settings.connectionState.connected.detail",
    ],

    en: [
      "settings.connectionState.connected.title",
      "settings.connectionState.connected.detail",
    ],
    tone: "success",
  },
  ticketExpired: {
    zh: [
      "settings.connectionState.ticketExpired.title",
      "settings.connectionState.ticketExpired.detail",
    ],

    en: [
      "settings.connectionState.ticketExpired.title",
      "settings.connectionState.ticketExpired.detail",
    ],
    tone: "warning",
  },
  networkError: {
    zh: [
      "settings.connectionState.networkError.title",
      "settings.connectionState.networkError.detail",
    ],

    en: [
      "settings.connectionState.networkError.title",
      "settings.connectionState.networkError.detail",
    ],
    tone: "danger",
  },
  permissionDenied: {
    zh: [
      "settings.connectionState.permissionDenied.title",
      "settings.connectionState.permissionDenied.detail",
    ],

    en: [
      "settings.connectionState.permissionDenied.title",
      "settings.connectionState.permissionDenied.detail",
    ],
    tone: "danger",
  },
  invalidConfig: {
    zh: [
      "settings.connectionState.invalidConfig.title",
      "settings.connectionState.invalidConfig.detail",
    ],

    en: [
      "settings.connectionState.invalidConfig.title",
      "settings.connectionState.invalidConfig.detail",
    ],
    tone: "danger",
  },
  externalAuthRequired: {
    zh: [
      "settings.connectionState.externalAuthRequired.title",
      "settings.connectionState.externalAuthRequired.detail",
    ],

    en: [
      "settings.connectionState.externalAuthRequired.title",
      "settings.connectionState.externalAuthRequired.detail",
    ],
    tone: "warning",
  },
  unsupported: {
    zh: [
      "settings.connectionState.unsupported.title",
      "settings.connectionState.unsupported.detail",
    ],

    en: [
      "settings.connectionState.unsupported.title",
      "settings.connectionState.unsupported.detail",
    ],
    tone: "danger",
  },
  unknown: {
    zh: [
      "settings.connectionState.unknown.title",
      "settings.connectionState.unknown.detail",
    ],

    en: [
      "settings.connectionState.unknown.title",
      "settings.connectionState.unknown.detail",
    ],
    tone: "danger",
  },
};

const recoveryCopy: Record<RecoveryAction, { zh: string; en: string }> = {
  none: {
    zh: "settings.no.recovery.action.is.required",
    en: "settings.no.recovery.action.is.required",
  },
  configureCli: {
    zh: "settings.configure.a.valid.p4.cli.then",
    en: "settings.configure.a.valid.p4.cli.then",
  },
  editConfig: {
    zh: "settings.correct.and.save.the.connection.settings",
    en: "settings.correct.and.save.the.connection.settings",
  },
  trustServer: {
    zh: "settings.verify.and.confirm.the.current.ssl",
    en: "settings.verify.and.confirm.the.current.ssl",
  },
  login: {
    zh: "settings.log.re.authenticate",
    en: "settings.log.re.authenticate",
  },
  retry: {
    zh: "settings.check.the.environment.and.retry",
    en: "settings.check.the.environment.and.retry",
  },
  contactAdmin: {
    zh: "settings.contact.the.helix.core.administrator",
    en: "settings.contact.the.helix.core.administrator",
  },
  completeExternalAuth: {
    zh: "settings.complete.sso.mfa.externally.then.check",
    en: "settings.complete.sso.mfa.externally.then.check",
  },
};

export function connectionPresentation(
  status: ConnectionStatus,
  zh: boolean,
): ConnectionPresentation {
  const copy = stateCopy[status.state];
  const locale = zh ? "zh-CN" : "en-US";
  return {
    title: tFor(locale, copy.zh[0] as MsgKey),
    detail: tFor(locale, copy.zh[1] as MsgKey),
    recovery: tFor(locale, recoveryCopy[status.recovery].zh as MsgKey),
    tone: copy.tone,
  };
}

export function notTestedStatus(server: string): ConnectionStatus {
  return {
    state: "notTested",
    message: "Connection has not been tested.",
    recovery: "retry",
    server,
  };
}

export function cliStatus(
  discovery: CliDiscoveryResult,
  server: string,
): ConnectionStatus | undefined {
  if (discovery.state === "notTested") return undefined;
  return {
    state: discovery.state,
    errorCode: discovery.errorCode,
    message: discovery.message,
    recovery: discovery.state === "cliMissing" ? "configureCli" : "editConfig",
    server,
  };
}

export async function probeConnection(
  api: Pick<Backend, "discoverP4Cli" | "testConnection" | "queryLoginStatus">,
  context: P4Context,
  active: () => boolean = () => true,
) {
  const discovery = await api.discoverP4Cli({
    executable: context.executable,
  });
  if (!active())
    return {
      discovery,
      status: notTestedStatus(context.server),
      stale: true,
    };
  const unavailable = cliStatus(discovery, context.server);
  if (unavailable) return { discovery, status: unavailable, stale: false };
  const connection = await api.testConnection(context);
  if (!active()) return { discovery, status: connection, stale: true };
  const status =
    connection.state === "connected"
      ? await api.queryLoginStatus(context)
      : connection;
  return { discovery, status, stale: !active() };
}

/** Compare the actual P4 connection, independent of profile labels and Windows path spelling. */
export function sameOperationalContext(left: P4Context, right: P4Context) {
  const normalize = (context: P4Context) => ({
    ...context,
    executable: context.executable ? pathKey(context.executable) : undefined,
    cwd: context.cwd ? pathKey(context.cwd) || "/" : undefined,
    trustPath: context.trustPath ? pathKey(context.trustPath) : undefined,
    ticketsPath: context.ticketsPath ? pathKey(context.ticketsPath) : undefined,
  });
  return contextIdentity(normalize(left)) === contextIdentity(normalize(right));
}

export function contextIdentity(context: P4Context) {
  return JSON.stringify({
    executable: context.executable ?? "",
    server: context.server,
    user: context.user,
    client: context.client,
    cwd: context.cwd ?? "",
    charset: context.charset ?? "",
    trustPath: context.trustPath ?? "",
    ticketsPath: context.ticketsPath ?? "",
  });
}
