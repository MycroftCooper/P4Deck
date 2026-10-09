// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ConnectionStatus,
  RuntimeInfo,
} from "../../shared/contracts/types";
import { defaultUi } from "./preferences";
import { SettingsPage } from "./SettingsPage";

const backend = vi.hoisted(() => ({
  saveConnection: vi.fn(),
  runtimeInfo: vi.fn(),
  discoverP4Cli: vi.fn(),
  testConnection: vi.fn(),
  queryLoginStatus: vi.fn(),
  trustServer: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));

let host: HTMLDivElement;
let root: Root;
const onConnection = vi.fn();
const onRuntime = vi.fn();

function status(
  state: ConnectionStatus["state"],
  overrides: Partial<ConnectionStatus> = {},
): ConnectionStatus {
  return {
    state,
    errorCode:
      state === "connected" || state === "notTested" ? undefined : state,
    message: "structured backend status",
    recovery:
      state === "connected"
        ? "none"
        : state === "sslUntrusted"
          ? "trustServer"
          : state === "authRequired" || state === "ticketExpired"
            ? "login"
            : state === "externalAuthRequired"
              ? "completeExternalAuth"
              : "retry",
    server: "ssl:fixture:1666",
    ...overrides,
  };
}

function runtime(
  connection: ConnectionStatus,
  mode: RuntimeInfo["mode"] = "tauri",
): RuntimeInfo {
  return {
    mode,
    p4Version: "Rev. P4/TEST/2026.1",
    contextGeneration: 1,
    context: {
      executable: "C:\\fixture\\p4.exe",
      server: connection.server,
      user: "tester",
      client: "fixture-client",
      cwd: "C:\\fixture\\workspace",
      trustPath: "C:\\fixture\\trust",
      ticketsPath: "C:\\fixture\\tickets",
    },
    connection,
  };
}

function props(value: RuntimeInfo): ComponentProps<typeof SettingsPage> {
  return {
    runtime: value,
    onConnection,
    onRuntime,
    theme: "light",
    onTheme: vi.fn(),
    locale: "zh-CN",
    onLocale: vi.fn(),
    ui: defaultUi,
    onUi: vi.fn(),
  };
}

async function render(value: RuntimeInfo) {
  await act(async () => root.render(<SettingsPage {...props(value)} />));
}

function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  )!;
}

async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  onConnection.mockReset();
  onRuntime.mockReset();
  for (const mock of Object.values(backend)) mock.mockReset();
  backend.discoverP4Cli.mockResolvedValue({
    state: "notTested",
    executable: "C:\\fixture\\p4.exe",
    version: "Rev. P4/TEST/2026.1",
    message: "available",
  });
  backend.testConnection.mockResolvedValue(status("connected"));
  backend.queryLoginStatus.mockResolvedValue(status("connected"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("renders every structured connection state without parsing backend text", async () => {
  const states: ConnectionStatus["state"][] = [
    "cliMissing",
    "notTested",
    "disconnected",
    "sslUntrusted",
    "authRequired",
    "connected",
    "ticketExpired",
    "networkError",
    "permissionDenied",
    "invalidConfig",
    "externalAuthRequired",
    "unsupported",
    "unknown",
  ];
  for (const state of states) {
    await render(runtime(status(state)));
    expect(
      host.querySelector(".connection-status-heading div span")?.textContent,
    ).toBe(state);
    expect(host.textContent).not.toContain("structured backend status");
  }
});

it("trusts only the exact displayed server fingerprint after explicit confirmation and blocks duplicates", async () => {
  const fingerprint = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
  backend.trustServer.mockResolvedValue(status("connected"));
  await render(
    runtime(
      status("sslUntrusted", {
        fingerprint,
        recovery: "trustServer",
      }),
    ),
  );
  expect(host.textContent).toContain(fingerprint);
  const trust = button("信任此精确指纹");
  expect(trust.disabled).toBe(true);
  await act(async () =>
    host
      .querySelector<HTMLInputElement>(".connection-confirmation input")!
      .click(),
  );
  await act(async () => {
    trust.click();
    trust.click();
  });
  expect(backend.trustServer).toHaveBeenCalledExactlyOnceWith({
    context: runtime(status("sslUntrusted")).context,
    fingerprint,
    confirmed: true,
  });
});

it("clears a single-use password immediately, never persists it, and prevents duplicate login", async () => {
  let complete!: (value: ConnectionStatus) => void;
  backend.login.mockReturnValue(
    new Promise<ConnectionStatus>((resolve) => {
      complete = resolve;
    }),
  );
  await render(runtime(status("ticketExpired")));
  const input = host.querySelector<HTMLInputElement>(
    'input[aria-label="P4 密码"]',
  )!;
  const secret = "one-request-secret";
  await change(input, secret);
  const submit = button("重新登录");
  await act(async () => {
    submit.click();
    submit.click();
    await Promise.resolve();
  });
  expect(backend.login).toHaveBeenCalledOnce();
  expect(backend.login.mock.calls[0][0]).toMatchObject({
    password: secret,
    confirmed: true,
  });
  expect(input.value).toBe("");
  expect(JSON.stringify(localStorage)).not.toContain(secret);
  expect(location.href).not.toContain(secret);
  expect(host.textContent).not.toContain(secret);
  await act(async () => complete(status("connected")));
  expect(backend.queryLoginStatus).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("密码已清空");
  expect(host.textContent).not.toContain(secret);
});

it("supports logout followed by an explicit login recovery", async () => {
  backend.logout.mockResolvedValue(status("authRequired"));
  backend.login.mockResolvedValue(status("connected"));
  await render(runtime(status("connected")));
  await act(async () => button("退出登录").click());
  expect(backend.logout).toHaveBeenCalledExactlyOnceWith({
    context: runtime(status("connected")).context,
    confirmed: true,
  });
  expect(host.textContent).toContain("需要登录");
  const input = host.querySelector<HTMLInputElement>(
    'input[aria-label="P4 密码"]',
  )!;
  await change(input, "relogin-secret");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        ".connection-login button[type=submit]",
      )!
      .click(),
  );
  expect(backend.login).toHaveBeenCalledOnce();
  expect(backend.queryLoginStatus).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("已连接并登录");
});

it("discards an old CLI result when the active connection changes", async () => {
  let finishDiscovery!: (value: {
    state: "notTested";
    executable: string;
    version: string;
    message: string;
  }) => void;
  backend.discoverP4Cli.mockReturnValue(
    new Promise((resolve) => {
      finishDiscovery = resolve;
    }),
  );
  const first = runtime(status("notTested"));
  await render(first);
  await act(async () => {
    button("验证连接与登录").click();
    await Promise.resolve();
  });
  const second = runtime(status("notTested", { server: "fixture-b:1666" }));
  await render(second);
  await act(async () =>
    finishDiscovery({
      state: "notTested",
      executable: "C:\\fixture\\p4.exe",
      version: "Rev. P4/TEST/2026.1",
      message: "old result",
    }),
  );
  expect(backend.testConnection).not.toHaveBeenCalled();
  expect(onConnection).not.toHaveBeenCalled();
  expect(host.textContent).toContain("fixture-b:1666");
});

it("keeps save separate from verification and marks the saved context not tested", async () => {
  const initial = runtime(status("connected"));
  await render(initial);
  const server = host.querySelector<HTMLInputElement>(
    'input[aria-label="服务器 / P4PORT"]',
  )!;
  await change(server, "fixture-new:1666");
  expect(button("验证连接与登录").disabled).toBe(true);
  expect(host.textContent).toContain("保存本身不会显示为已连接");
  const saved = { ...initial.context, server: "fixture-new:1666" };
  backend.saveConnection.mockResolvedValue(saved);
  backend.runtimeInfo.mockResolvedValue({
    ...initial,
    context: saved,
    contextGeneration: initial.contextGeneration + 1,
  });
  await act(async () => button("保存并应用").click());
  expect(backend.saveConnection).toHaveBeenCalledWith(saved);
  expect(onRuntime).toHaveBeenCalledWith(
    expect.objectContaining({
      context: saved,
      contextGeneration: 2,
      connection: expect.objectContaining({ state: "notTested" }),
    }),
  );
  await render({
    ...initial,
    context: saved,
    connection: status("notTested", { server: saved.server }),
  });
  expect(host.textContent).toContain("保存不代表已连接成功");
});

it("shows actionable external-auth guidance without a password form and discloses Mock isolation", async () => {
  await render(runtime(status("externalAuthRequired"), "mock"));
  expect(host.textContent).toContain("不会用普通密码框伪装完成外部认证");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.textContent).toContain("不会发起真实网络连接");
  expect(button("我已完成外部认证，检查状态")).toBeTruthy();
});
