import type { Backend } from "../../infrastructure/backend/contract";
import type {
  CliDiscoveryResult,
  ConnectionState,
  ConnectionStatus,
  P4Context,
  RecoveryAction,
} from "../../shared/contracts/types";

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
    zh: ["找不到 P4 CLI", "请安装 p4，或填写受信任的 p4 可执行文件绝对路径。"],
    en: [
      "P4 CLI not found",
      "Install p4 or configure the absolute path to a trusted p4 executable.",
    ],
    tone: "danger",
  },
  notTested: {
    zh: ["尚未验证", "连接参数已就绪，但尚未访问服务器。"],
    en: [
      "Not tested",
      "The connection is configured but has not contacted the server.",
    ],
    tone: "neutral",
  },
  disconnected: {
    zh: ["服务器无响应", "服务器中断了连接；确认服务状态后重试。"],
    en: [
      "Server disconnected",
      "The server ended the connection. Check its status and retry.",
    ],
    tone: "danger",
  },
  sslUntrusted: {
    zh: [
      "SSL 服务器尚未信任",
      "核对下方服务器与指纹；只有明确确认后才会写入 Trust。",
    ],
    en: [
      "SSL server is not trusted",
      "Verify the server and fingerprint below. Trust is written only after explicit confirmation.",
    ],
    tone: "warning",
  },
  authRequired: {
    zh: ["需要登录", "连接可达，但当前用户没有有效登录票据。"],
    en: [
      "Login required",
      "The server is reachable, but this user has no valid login ticket.",
    ],
    tone: "warning",
  },
  connected: {
    zh: ["已连接并登录", "服务器连接和当前登录票据均已验证。"],
    en: [
      "Connected and authenticated",
      "Server connectivity and the current login ticket are verified.",
    ],
    tone: "success",
  },
  ticketExpired: {
    zh: ["登录票据已过期", "请重新登录；提交后密码会立即从界面内存中清除。"],
    en: [
      "Login ticket expired",
      "Log in again. The password is cleared from UI memory immediately after submission.",
    ],
    tone: "warning",
  },
  networkError: {
    zh: [
      "无法访问服务器",
      "检查服务器地址、网络、VPN、Proxy 或 Broker 后重试。",
    ],
    en: [
      "Server unreachable",
      "Check the server address, network, VPN, proxy, or broker, then retry.",
    ],
    tone: "danger",
  },
  permissionDenied: {
    zh: [
      "权限不足",
      "服务器拒绝当前身份；请联系管理员检查 protections 或相关策略。",
    ],
    en: [
      "Permission denied",
      "The server rejected this identity. Ask an administrator to check protections and policy.",
    ],
    tone: "danger",
  },
  invalidConfig: {
    zh: [
      "连接配置无效",
      "检查必填项、CLI 路径和凭证文件路径，然后保存并重新验证。",
    ],
    en: [
      "Invalid connection configuration",
      "Check required fields, CLI path, and credential-file paths, then save and test again.",
    ],
    tone: "danger",
  },
  externalAuthRequired: {
    zh: [
      "需要外部认证",
      "请按组织流程在浏览器或认证工具中完成 SSO/MFA，然后返回此处检查登录状态。普通密码框不能完成此流程。",
    ],
    en: [
      "External authentication required",
      "Complete your organization's SSO/MFA flow in its browser or authentication tool, then return to check login status. A password form cannot complete this flow.",
    ],
    tone: "warning",
  },
  unsupported: {
    zh: ["当前配置不受支持", "请检查 P4 CLI 与服务器策略，或联系管理员。"],
    en: [
      "Configuration not supported",
      "Check the P4 CLI and server policy, or contact an administrator.",
    ],
    tone: "danger",
  },
  unknown: {
    zh: [
      "无法确定连接状态",
      "未把未知结果当作成功；请重试或查看脱敏诊断日志。",
    ],
    en: [
      "Connection state unknown",
      "The unknown result was not treated as success. Retry or inspect sanitized diagnostics.",
    ],
    tone: "danger",
  },
};

const recoveryCopy: Record<RecoveryAction, { zh: string; en: string }> = {
  none: { zh: "无需恢复操作。", en: "No recovery action is required." },
  configureCli: {
    zh: "配置有效的 P4 CLI 后重新验证。",
    en: "Configure a valid P4 CLI, then test again.",
  },
  editConfig: {
    zh: "修正并保存连接参数后重新验证。",
    en: "Correct and save the connection settings, then test again.",
  },
  trustServer: {
    zh: "核对并确认当前 SSL 指纹。",
    en: "Verify and confirm the current SSL fingerprint.",
  },
  login: {
    zh: "登录或重新登录当前用户。",
    en: "Log in or re-authenticate the current user.",
  },
  retry: { zh: "确认环境后重试。", en: "Check the environment and retry." },
  contactAdmin: {
    zh: "联系 Helix Core 管理员。",
    en: "Contact the Helix Core administrator.",
  },
  completeExternalAuth: {
    zh: "在外部完成 SSO/MFA 后检查状态。",
    en: "Complete SSO/MFA externally, then check status.",
  },
};

export function connectionPresentation(
  status: ConnectionStatus,
  zh: boolean,
): ConnectionPresentation {
  const copy = stateCopy[status.state];
  const [title, detail] = zh ? copy.zh : copy.en;
  return {
    title,
    detail,
    recovery: zh
      ? recoveryCopy[status.recovery].zh
      : recoveryCopy[status.recovery].en,
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
