// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ConnectionProfile,
  ConnectionProfiles,
  ConnectionStatus,
  RuntimeInfo,
} from "../../shared/contracts/types";
import { defaultUi } from "./preferences";
import { SettingsPage } from "./SettingsPage";

const backend = vi.hoisted(() => ({
  listConnectionProfiles: vi.fn(),
  createConnectionProfile: vi.fn(),
  updateConnectionProfile: vi.fn(),
  deleteConnectionProfile: vi.fn(),
  setActiveConnectionProfile: vi.fn(),
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
  connection: ConnectionStatus = status("connected"),
  mode: RuntimeInfo["mode"] = "tauri",
): RuntimeInfo {
  return {
    mode,
    p4Version: "Rev. P4/TEST/2026.1",
    activeProfileId: "primary",
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

function profile(
  id: string,
  name: string,
  server = id === "primary" ? "ssl:fixture:1666" : `${id}:1666`,
): ConnectionProfile {
  return {
    id,
    name,
    context: {
      executable: "C:\\fixture\\p4.exe",
      server,
      user: "tester",
      client: id === "primary" ? "fixture-client" : `${id}-client`,
      cwd: `C:\\fixture\\${id}`,
    },
  };
}

function profilesDocument(
  profiles = [profile("primary", "Primary"), profile("secondary", "Secondary")],
  revision = 4,
  activeProfileId = "primary",
): ConnectionProfiles {
  return { schemaVersion: 3, revision, activeProfileId, profiles };
}

function props(
  value: RuntimeInfo,
  locale: "zh-CN" | "en-US" = "zh-CN",
): ComponentProps<typeof SettingsPage> {
  return {
    runtime: value,
    onConnection,
    onRuntime,
    theme: "light",
    onTheme: vi.fn(),
    locale,
    onLocale: vi.fn(),
    ui: defaultUi,
    onUi: vi.fn(),
  };
}

async function render(
  value: RuntimeInfo = runtime(),
  locale: "zh-CN" | "en-US" = "zh-CN",
) {
  await act(async () => {
    root.render(<SettingsPage {...props(value, locale)} />);
    await Promise.resolve();
  });
}

function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes(text),
  )!;
}

function input(label: string) {
  return host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

async function change(control: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    setTimeout(() => callback(0), 0);
    return 1;
  });
  localStorage.clear();
  onConnection.mockReset();
  onRuntime.mockReset();
  for (const mock of Object.values(backend)) mock.mockReset();
  backend.listConnectionProfiles.mockResolvedValue(profilesDocument());
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
  vi.unstubAllGlobals();
});

it("renders the profile list, active marker, revision, and every structured connection state", async () => {
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
    expect(host.textContent).toContain("Primary");
    expect(host.textContent).toContain("Secondary");
    expect(host.textContent).toContain("活动");
    expect(host.textContent).toContain("Revision 4");
    expect(
      host.querySelector(".connection-status-heading div span")?.textContent,
    ).toBe(state);
    expect(host.textContent).not.toContain("structured backend status");
  }
});

it("creates a profile with CAS and never persists sensitive authentication state", async () => {
  const created = profile("created", "Office", "office:1666");
  backend.createConnectionProfile.mockResolvedValue(
    profilesDocument(
      [
        profile("primary", "Primary"),
        profile("secondary", "Secondary"),
        created,
      ],
      5,
    ),
  );
  await render();
  await act(async () => button("新建").click());
  await change(input("Profile 名称"), "Office");
  await change(input("服务器 / P4PORT"), "office:1666");
  await change(input("用户 / P4USER"), "tester");
  await change(input("工作区 / P4CLIENT"), "created-client");
  await act(async () => button("保存 Profile").click());
  expect(backend.createConnectionProfile).toHaveBeenCalledWith({
    expectedRevision: 4,
    name: "Office",
    context: expect.objectContaining({
      server: "office:1666",
      user: "tester",
      client: "created-client",
    }),
  });
  const serialized = JSON.stringify(
    backend.createConnectionProfile.mock.calls[0][0],
  );
  expect(serialized).not.toMatch(/password|fingerprint|ticketContents/i);
  expect(host.textContent).toContain("状态仍为“尚未验证”");
  expect(onRuntime).not.toHaveBeenCalled();
});

it("normalizes a safe Swarm base URL and rejects credentials or non-http schemes", async () => {
  const created = profile("created", "Office", "office:1666");
  backend.createConnectionProfile.mockResolvedValue(
    profilesDocument(
      [
        profile("primary", "Primary"),
        profile("secondary", "Secondary"),
        created,
      ],
      5,
    ),
  );
  await render();
  await act(async () => button("新建").click());
  await change(input("Profile 名称"), "Office");
  await change(input("服务器 / P4PORT"), "office:1666");
  await change(input("用户 / P4USER"), "tester");
  await change(input("工作区 / P4CLIENT"), "created-client");
  const swarm = input("Swarm 基础 URL（可选）");
  await change(swarm, "javascript:alert(1)");
  expect(button("保存 Profile").disabled).toBe(true);
  await change(swarm, "https://user:secret@swarm.example/");
  expect(button("保存 Profile").disabled).toBe(true);
  await change(swarm, "https://swarm.example/team");
  expect(button("保存 Profile").disabled).toBe(false);
  await act(async () => button("保存 Profile").click());
  expect(backend.createConnectionProfile).toHaveBeenCalledWith(
    expect.objectContaining({
      context: expect.objectContaining({
        swarmBaseUrl: "https://swarm.example/team/",
      }),
    }),
  );
  expect(
    JSON.stringify(backend.createConnectionProfile.mock.calls),
  ).not.toContain("secret");
});

it("edits and renames the active profile, refreshes runtime generation, and remains not tested", async () => {
  const renamed = profile("primary", "Primary renamed");
  const nextDocument = profilesDocument(
    [renamed, profile("secondary", "Secondary")],
    5,
  );
  const nextRuntime = { ...runtime(status("notTested")), contextGeneration: 2 };
  backend.updateConnectionProfile.mockResolvedValue(nextDocument);
  backend.runtimeInfo.mockResolvedValue(nextRuntime);
  await render();
  await change(input("Profile 名称"), "Primary renamed");
  await act(async () => button("保存 Profile").click());
  expect(backend.updateConnectionProfile).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedRevision: 4,
      id: "primary",
      name: "Primary renamed",
    }),
  );
  expect(onRuntime).toHaveBeenCalledWith(
    expect.objectContaining({
      contextGeneration: 2,
      connection: expect.objectContaining({ state: "notTested" }),
    }),
  );
});

it("rejects empty, control-character, duplicate-name, and duplicate-context drafts", async () => {
  await render();
  await act(async () => button("新建").click());
  expect(button("保存 Profile").disabled).toBe(true);
  await change(input("Profile 名称"), "Secondary");
  await change(input("服务器 / P4PORT"), "unique:1666");
  await change(input("用户 / P4USER"), "tester");
  await change(input("工作区 / P4CLIENT"), "unique-client");
  await act(async () => button("保存 Profile").click());
  expect(host.textContent).toContain("Profile 名称已存在");
  expect(backend.createConnectionProfile).not.toHaveBeenCalled();
  await change(input("Profile 名称"), "Bad\u0001name");
  expect(button("保存 Profile").disabled).toBe(true);
  await change(input("Profile 名称"), "Duplicate context");
  await change(input("服务器 / P4PORT"), "secondary:1666");
  await change(input("工作区 / P4CLIENT"), "secondary-client");
  await change(input("工作目录"), "C:\\fixture\\secondary");
  await act(async () => button("保存 Profile").click());
  expect(host.textContent).toContain("相同连接参数");
});

it("handles revision conflicts by reloading the list while preserving the local draft", async () => {
  backend.updateConnectionProfile.mockRejectedValue({
    code: "revisionConflict",
    message: "changed",
  });
  backend.listConnectionProfiles
    .mockResolvedValueOnce(profilesDocument())
    .mockResolvedValueOnce(profilesDocument(undefined, 5));
  await render();
  await change(input("Profile 名称"), "My local rename");
  await act(async () => {
    button("保存 Profile").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(host.textContent).toContain("已重新加载");
  expect(input("Profile 名称").value).toBe("My local rename");
  expect(host.textContent).toContain("Revision 5");
});

it("protects active and last profiles and requires explicit confirmation for deletion", async () => {
  const activeDelete = host;
  void activeDelete;
  backend.deleteConnectionProfile.mockResolvedValue(
    profilesDocument([profile("primary", "Primary")], 5),
  );
  await render();
  const activeButton = host.querySelector<HTMLButtonElement>(
    'button[aria-label="删除 Primary"]',
  )!;
  expect(activeButton.disabled).toBe(true);
  const secondaryDelete = host.querySelector<HTMLButtonElement>(
    'button[aria-label="删除 Secondary"]',
  )!;
  await act(async () => secondaryDelete.click());
  expect(host.querySelector('[role="alertdialog"]')).toBeTruthy();
  await act(async () => button("确认删除").click());
  expect(backend.deleteConnectionProfile).toHaveBeenCalledWith({
    expectedRevision: 4,
    id: "secondary",
  });
  backend.listConnectionProfiles.mockResolvedValue(
    profilesDocument([profile("primary", "Primary")], 5),
  );
  await render({ ...runtime(), contextGeneration: 2 });
  expect(host.textContent).toContain("活动且唯一");
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="删除 Primary"]')!
      .disabled,
  ).toBe(true);
});

it("shows verify/commit success and consumes backend runtime generation on profile switch", async () => {
  let resolveSwitch!: (value: RuntimeInfo) => void;
  backend.setActiveConnectionProfile.mockReturnValue(
    new Promise<RuntimeInfo>((resolve) => {
      resolveSwitch = resolve;
    }),
  );
  const next = {
    ...runtime(status("connected")),
    activeProfileId: "secondary",
    contextGeneration: 2,
    context: profile("secondary", "Secondary").context,
  };
  await render();
  await act(async () => button("Secondary").click());
  const switchButton = button("设为活动 Profile");
  await act(async () => {
    switchButton.click();
    await Promise.resolve();
  });
  expect(host.textContent).toContain("正在验证目标 Profile");
  await act(async () => resolveSwitch(next));
  expect(onRuntime).toHaveBeenCalledWith(next);
  expect(host.textContent).toContain("Profile 切换成功");
  expect(host.textContent).toContain(
    "旧选择、详情、搜索和日志视图已按新代次清理",
  );
});

it("rolls back a failed profile switch and restores focus", async () => {
  backend.setActiveConnectionProfile.mockRejectedValue({
    code: "connectionFailed",
    message: "offline",
  });
  await render();
  await act(async () => button("Secondary").click());
  const switchButton = button("设为活动 Profile");
  await act(async () => {
    switchButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(onRuntime).not.toHaveBeenCalled();
  expect(host.textContent).toContain("原活动 Profile 和页面数据");
  expect(host.textContent).toContain("Profile 切换失败");
  expect(document.activeElement).toBe(switchButton);
  expect(host.querySelector('[aria-current="true"]')?.textContent).toContain(
    "Primary",
  );
});

it("keeps draft validation separate from activation and clears a single-use password", async () => {
  backend.testConnection.mockResolvedValue(status("ticketExpired"));
  backend.login.mockResolvedValue(status("connected"));
  await render();
  await act(async () => button("Secondary").click());
  await act(async () => button("验证当前草稿").click());
  expect(onRuntime).not.toHaveBeenCalled();
  expect(onConnection).not.toHaveBeenCalled();
  const password = input("P4 密码");
  const secret = "single-use-only";
  await change(password, secret);
  await act(async () => button("重新登录").click());
  expect(password.value).toBe("");
  expect(JSON.stringify(localStorage)).not.toContain(secret);
  expect(location.href).not.toContain(secret);
  expect(host.textContent).not.toContain(secret);
  expect(onConnection).not.toHaveBeenCalled();
});

it("never publishes an unsaved active-profile draft into the global runtime", async () => {
  await render();
  await change(input("服务器 / P4PORT"), "unsaved-active:1666");
  await act(async () => button("验证当前草稿").click());
  expect(backend.testConnection).toHaveBeenCalledWith(
    expect.objectContaining({ server: "unsaved-active:1666" }),
  );
  expect(onConnection).not.toHaveBeenCalled();
  expect(onRuntime).not.toHaveBeenCalled();
  expect(host.textContent).toContain("验证不会激活或保存 Profile");
});

it("requires exact fingerprint confirmation and provides external-auth guidance", async () => {
  const fingerprint = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
  backend.trustServer.mockResolvedValue(status("connected"));
  await render(
    runtime(status("sslUntrusted", { fingerprint, recovery: "trustServer" })),
  );
  expect(button("信任此精确指纹").disabled).toBe(true);
  await act(async () =>
    host
      .querySelector<HTMLInputElement>(".connection-confirmation input")!
      .click(),
  );
  await act(async () => button("信任此精确指纹").click());
  expect(backend.trustServer).toHaveBeenCalledWith({
    context: expect.objectContaining({
      server: "ssl:fixture:1666",
      user: "tester",
      client: "fixture-client",
    }),
    fingerprint,
    confirmed: true,
  });
  await render(runtime(status("externalAuthRequired")));
  expect(host.textContent).toContain("不会用普通密码框伪装完成外部认证");
  expect(host.querySelector('input[type="password"]')).toBeNull();
});

it("renders English copy, a keyboard-focusable scrollable list, and explicit simulated Mock disclosure", async () => {
  await render(runtime(status("notTested"), "mock"), "en-US");
  expect(host.textContent).toContain("Connection profiles");
  expect(host.textContent).toContain("explicitly simulated");
  expect(host.textContent).toContain("never access a real network");
  expect(host.querySelector(".profile-list")).toBeTruthy();
  const profileButton = button("Secondary");
  profileButton.focus();
  expect(document.activeElement).toBe(profileButton);
  expect(
    host.querySelector('[role="status"][aria-live="polite"]'),
  ).toBeTruthy();
});
