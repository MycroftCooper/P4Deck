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
  browseConnectionUsers: vi.fn(),
  browseConnectionWorkspaces: vi.fn(),
  preflightCreateConnectionUser: vi.fn(),
  preflightCreateConnectionWorkspace: vi.fn(),
  confirmCreateConnectionUser: vi.fn(),
  confirmCreateConnectionWorkspace: vi.fn(),
  cancelOperation: vi.fn(),
}));
vi.mock("../../infrastructure/backend", () => ({ backend }));

let host: HTMLDivElement;
let root: Root;
const onConnection = vi.fn();
const onRuntime = vi.fn();
const dialogMethods = ["showModal", "close"] as const;
const dialogOriginals = dialogMethods.map((name) =>
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
);

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
  return document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!;
}

function fieldAction(label: string, text: string) {
  return [
    ...input(label)
      .closest(".connection-field")!
      .querySelectorAll<HTMLButtonElement>("button"),
  ].find((item) => item.textContent?.includes(text))!;
}

function dialogButton(text: string) {
  return [
    ...document.querySelectorAll<HTMLButtonElement>("dialog button"),
  ].find((item) => item.textContent?.includes(text))!;
}

function dialogInput(label: string) {
  const owner = [
    ...document.querySelectorAll<HTMLLabelElement>("dialog label"),
  ].find((item) => item.childNodes[0]?.textContent?.trim() === label)!;
  return owner.querySelector<HTMLInputElement>("input")!;
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

async function waitForResolvedRoot(expected?: string) {
  let rootStatus: Element | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    rootStatus = host.querySelector(".connection-root-resolved");
    if (rootStatus && (!expected || rootStatus.textContent?.includes(expected)))
      break;
  }
  expect(rootStatus).toBeTruthy();
  if (expected) expect(rootStatus?.textContent).toContain(expected);
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    setTimeout(() => callback(0), 0);
    return 1;
  });
  for (const name of dialogMethods)
    Object.defineProperty(HTMLDialogElement.prototype, name, {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.toggleAttribute("open", name === "showModal");
      },
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
  backend.browseConnectionWorkspaces.mockImplementation(
    async (request: {
      context: RuntimeInfo["context"];
      requestGeneration: number;
      operationId?: string;
      prefix?: string;
    }) => {
      const name = request.prefix ?? request.context.client;
      const knownRoots: Record<string, string> = {
        "fixture-client": "C:\\fixture\\workspace",
        "secondary-client": "C:\\fixture\\secondary",
        "created-client": "C:\\fixture\\created",
        "generated-client": "C:\\fixture\\generated",
      };
      const rootPath = knownRoots[name] ?? `C:\\fixture\\${name}`;
      return {
        requestGeneration: request.requestGeneration,
        items: [
          {
            name,
            owner: request.context.user,
            host: "",
            root: rootPath,
            stream: "",
            description: "",
            updated: null,
            accessed: null,
            rootStatus: "usable" as const,
            selectable: true,
          },
        ],
        partial: false,
        truncated: false,
        stats: { scannedCount: 1, matchedCount: 1, safetyLimit: 500 },
        operationIds: [request.operationId ?? "workspace-root"],
        connection: status("connected", { server: request.context.server }),
        simulated: true,
      };
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  dialogMethods.forEach((name, index) => {
    if (dialogOriginals[index])
      Object.defineProperty(
        HTMLDialogElement.prototype,
        name,
        dialogOriginals[index]!,
      );
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  });
  vi.unstubAllGlobals();
});

it("renders saved connections with friendly current and status labels while hiding internal state", async () => {
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
    expect(host.textContent).toContain("当前");
    expect(host.textContent).toContain("连接设置");
    expect(host.textContent).toContain("P4 设置");
    expect(host.textContent).not.toContain("Revision 4");
    expect(
      host.querySelector(".connection-status-heading div span"),
    ).toBeNull();
    expect(host.textContent).not.toContain("structured backend status");
    expect(host.textContent).not.toContain("页签行为");
  }
});

it("re-resolves an existing saved Workspace Root instead of trusting its stored cwd", async () => {
  backend.browseConnectionWorkspaces.mockImplementation(
    async (request: {
      context: RuntimeInfo["context"];
      requestGeneration: number;
      operationId?: string;
      prefix?: string;
    }) => ({
      requestGeneration: request.requestGeneration,
      items: [
        {
          name: request.prefix!,
          owner: request.context.user,
          host: "",
          root: "D:\\server-root\\fixture-client",
          stream: "",
          description: "",
          updated: null,
          accessed: null,
          rootStatus: "usable" as const,
          selectable: true,
        },
      ],
      partial: false,
      truncated: false,
      stats: { scannedCount: 1, matchedCount: 1, safetyLimit: 500 },
      operationIds: [request.operationId ?? "workspace-root"],
      connection: status("connected", { server: request.context.server }),
      simulated: true,
    }),
  );
  await render();
  await waitForResolvedRoot("D:\\server-root\\fixture-client");
  expect(backend.browseConnectionWorkspaces).toHaveBeenCalledTimes(1);
  expect(backend.browseConnectionWorkspaces).toHaveBeenCalledWith(
    expect.objectContaining({
      prefix: "fixture-client",
      context: expect.objectContaining({ client: "", cwd: undefined }),
    }),
  );
  expect(button("保存连接").disabled).toBe(false);
});

it("isolates a late Workspace Root response after the draft identity changes", async () => {
  let resolveOld!: (value: unknown) => void;
  backend.browseConnectionWorkspaces.mockImplementation(
    (request: {
      context: RuntimeInfo["context"];
      requestGeneration: number;
      operationId?: string;
      prefix?: string;
    }) => {
      const result = (name: string, rootPath: string) => ({
        requestGeneration: request.requestGeneration,
        items: [
          {
            name,
            owner: request.context.user,
            host: "",
            root: rootPath,
            stream: "",
            description: "",
            updated: null,
            accessed: null,
            rootStatus: "usable" as const,
            selectable: true,
          },
        ],
        partial: false,
        truncated: false,
        stats: { scannedCount: 1, matchedCount: 1, safetyLimit: 500 },
        operationIds: [request.operationId ?? "workspace-root"],
        connection: status("connected", { server: request.context.server }),
        simulated: true,
      });
      if (request.prefix === "old-client")
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      return Promise.resolve(
        result(
          request.prefix!,
          request.prefix === "new-client"
            ? "D:\\roots\\new-client"
            : "C:\\fixture\\workspace",
        ),
      );
    },
  );
  await render();
  await waitForResolvedRoot("C:\\fixture\\workspace");
  await change(input("工作区"), "old-client");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  await change(input("工作区"), "new-client");
  await waitForResolvedRoot("D:\\roots\\new-client");
  const oldRequest = backend.browseConnectionWorkspaces.mock.calls.find(
    ([request]) => request.prefix === "old-client",
  )![0];
  await act(async () => {
    resolveOld({
      requestGeneration: oldRequest.requestGeneration,
      items: [
        {
          name: "old-client",
          owner: "tester",
          host: "",
          root: "D:\\roots\\old-client",
          stream: "",
          description: "",
          updated: null,
          accessed: null,
          rootStatus: "usable",
          selectable: true,
        },
      ],
      partial: false,
      truncated: false,
      stats: { scannedCount: 1, matchedCount: 1, safetyLimit: 500 },
      operationIds: [oldRequest.operationId],
      connection: status("connected"),
      simulated: true,
    });
    await Promise.resolve();
  });
  expect(
    host.querySelector(".connection-root-resolved")?.textContent,
  ).toContain("D:\\roots\\new-client");
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
  await change(input("连接名称（可选）"), "Office");
  await change(input("服务器"), "office:1666");
  await change(input("用户"), "tester");
  await change(input("工作区"), "created-client");
  await waitForResolvedRoot("C:\\fixture\\created");
  await act(async () => button("保存连接").click());
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

it("accepts a newly saved profile when the backend returns a normalized Root", async () => {
  let saved = false;
  const normalized = {
    ...profile("normalized", "Normalized", "normalized:1666"),
    context: {
      ...profile("normalized", "Normalized", "normalized:1666").context,
      client: "normalized-client",
      cwd: "D:\\server-root\\normalized-client",
    },
  };
  backend.createConnectionProfile.mockImplementation(async () => {
    saved = true;
    return profilesDocument(
      [
        profile("primary", "Primary"),
        profile("secondary", "Secondary"),
        normalized,
      ],
      5,
    );
  });
  backend.browseConnectionWorkspaces.mockImplementation(
    async (request: {
      context: RuntimeInfo["context"];
      requestGeneration: number;
      operationId?: string;
      prefix?: string;
    }) => ({
      requestGeneration: request.requestGeneration,
      items: [
        {
          name: request.prefix!,
          owner: request.context.user,
          host: "",
          root: saved
            ? "D:\\server-root\\normalized-client"
            : "C:\\preview\\normalized-client",
          stream: "",
          description: "",
          updated: null,
          accessed: null,
          rootStatus: "usable" as const,
          selectable: true,
        },
      ],
      partial: false,
      truncated: false,
      stats: { scannedCount: 1, matchedCount: 1, safetyLimit: 500 },
      operationIds: [request.operationId ?? "workspace-root"],
      connection: status("connected", { server: request.context.server }),
      simulated: true,
    }),
  );
  await render();
  await act(async () => button("新建").click());
  await change(input("连接名称（可选）"), "Normalized");
  await change(input("服务器"), "normalized:1666");
  await change(input("用户"), "tester");
  await change(input("工作区"), "normalized-client");
  await waitForResolvedRoot("C:\\preview\\normalized-client");
  await act(async () => button("保存连接").click());
  expect(host.textContent).toContain("状态仍为“尚未验证”");
  await waitForResolvedRoot("D:\\server-root\\normalized-client");
  expect(input("连接名称（可选）").value).toBe("Normalized");
});

it("generates a secondary saved-connection name when the optional name is blank", async () => {
  const created = profile(
    "generated",
    "generated-client · generated-user@generated:1666",
    "generated:1666",
  );
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
  await change(input("服务器"), "generated:1666");
  await change(input("用户"), "generated-user");
  await change(input("工作区"), "generated-client");
  await waitForResolvedRoot("C:\\fixture\\generated");
  await act(async () => button("保存连接").click());
  expect(backend.createConnectionProfile).toHaveBeenCalledWith({
    expectedRevision: 4,
    name: "generated-client · generated-user@generated:1666",
    context: expect.objectContaining({
      server: "generated:1666",
      user: "generated-user",
      client: "generated-client",
    }),
  });
});

it("browses users against the current draft server and only fills the draft", async () => {
  backend.browseConnectionUsers.mockImplementation(
    async (request: { requestGeneration: number }) => ({
      requestGeneration: request.requestGeneration,
      items: [
        { name: "alice", fullName: "Alice Example", email: "alice@example" },
      ],
      partial: false,
      truncated: false,
      stats: { scannedCount: 1, matchedCount: 1, safetyLimit: 500 },
      operationIds: ["browse-users"],
      connection: status("connected", { server: "draft:1666" }),
      simulated: true,
    }),
  );
  await render();
  await change(input("服务器"), "draft:1666");
  await act(async () => fieldAction("用户", "浏览").click());
  expect(document.querySelector("dialog")?.textContent).toContain(
    "只查询当前未保存设置中的服务器 draft:1666",
  );
  await act(async () => dialogButton("查询").click());
  expect(backend.browseConnectionUsers).toHaveBeenCalledWith(
    expect.objectContaining({
      context: expect.objectContaining({
        server: "draft:1666",
        user: "tester",
        client: "",
      }),
    }),
  );
  expect(document.querySelector("dialog")?.textContent).toContain(
    "Browser Mock simulated",
  );
  await act(async () => dialogButton("alice").click());
  expect(input("用户").value).toBe("alice");
  expect(backend.createConnectionProfile).not.toHaveBeenCalled();
  expect(backend.setActiveConnectionProfile).not.toHaveBeenCalled();
  expect(onRuntime).not.toHaveBeenCalled();
});

it("opens user Browse with an explicit visible identity when a new draft has no user", async () => {
  await render();
  await act(async () => button("新建").click());
  await change(input("服务器"), "new-draft:1666");
  await act(async () => fieldAction("用户", "浏览").click());
  expect(dialogInput("查询身份").value).toBe("tester");
  expect(document.querySelector("dialog")?.textContent).toContain(
    "不会从活动连接或环境中静默回退",
  );
  expect(document.querySelector("dialog")?.textContent).toContain(
    "先把该用户名填入主卡 User 字段",
  );
  expect(backend.browseConnectionUsers).not.toHaveBeenCalled();
});

it("locks user directory inputs while a query is pending and isolates its late result", async () => {
  let resolveBrowse!: (value: unknown) => void;
  backend.browseConnectionUsers.mockReturnValue(
    new Promise((resolve) => {
      resolveBrowse = resolve;
    }),
  );
  await render();
  await act(async () => fieldAction("用户", "浏览").click());
  await act(async () => {
    dialogButton("查询").click();
    await Promise.resolve();
  });
  expect(dialogInput("查询身份").disabled).toBe(true);
  expect(dialogInput("按名称前缀搜索").disabled).toBe(true);
  const request = backend.browseConnectionUsers.mock.calls[0][0];
  await act(async () => dialogButton("取消").click());
  expect(backend.cancelOperation).toHaveBeenCalledWith(request.operationId);
  await act(async () =>
    resolveBrowse({
      requestGeneration: request.requestGeneration,
      items: [{ name: "late-user" }],
      partial: false,
      truncated: false,
      stats: { scannedCount: 1, matchedCount: 1, safetyLimit: 500 },
      operationIds: [request.operationId],
      connection: status("connected"),
      simulated: true,
    }),
  );
  expect(input("用户").value).toBe("tester");
});

it("shows connection recovery instead of a false empty directory", async () => {
  backend.browseConnectionUsers.mockImplementation(
    async (request: { requestGeneration: number }) => ({
      requestGeneration: request.requestGeneration,
      items: [],
      partial: false,
      truncated: false,
      stats: { scannedCount: 0, matchedCount: 0, safetyLimit: 500 },
      operationIds: ["auth-required"],
      connection: status("authRequired"),
      simulated: false,
    }),
  );
  await render();
  await act(async () => fieldAction("用户", "浏览").click());
  await act(async () => dialogButton("查询").click());
  expect(document.querySelector("dialog")?.textContent).toContain("需要登录");
  expect(document.querySelector("dialog")?.textContent).toContain(
    "请在设置主区完成对应的 CLI、Trust 或登录恢复后重试",
  );
  expect(document.querySelector('dialog [role="listbox"]')).toBeNull();
  expect(document.querySelector("dialog")?.textContent).not.toContain(
    "没有匹配结果",
  );
});

it("browses workspaces with the draft user and cancels a pending lookup on close", async () => {
  let resolveBrowse!: (value: unknown) => void;
  backend.browseConnectionWorkspaces.mockReturnValue(
    new Promise((resolve) => {
      resolveBrowse = resolve;
    }),
  );
  await render();
  await change(input("服务器"), "workspace-draft:1666");
  await change(input("用户"), "draft-owner");
  await act(async () => fieldAction("工作区", "浏览").click());
  await act(async () => {
    dialogButton("查询").click();
    await Promise.resolve();
  });
  expect(dialogInput("按名称前缀搜索").disabled).toBe(true);
  const request = backend.browseConnectionWorkspaces.mock.calls[0][0];
  expect(request).toEqual(
    expect.objectContaining({
      context: expect.objectContaining({
        server: "workspace-draft:1666",
        user: "draft-owner",
        client: "",
      }),
      operationId: expect.any(String),
    }),
  );
  await act(async () => dialogButton("取消").click());
  expect(backend.cancelOperation).toHaveBeenCalledWith(request.operationId);
  expect(document.querySelector("dialog")).toBeNull();
  await act(async () =>
    resolveBrowse({
      requestGeneration: request.requestGeneration,
      items: [{ name: "late-workspace" }],
      partial: false,
      truncated: false,
      stats: { scannedCount: 1, matchedCount: 1, safetyLimit: 500 },
      operationIds: [request.operationId],
      connection: status("connected"),
      simulated: true,
    }),
  );
  expect(input("工作区").value).toBe("fixture-client");
});

it("preflights and confirms self-service user creation before filling without saving", async () => {
  backend.preflightCreateConnectionUser.mockImplementation(
    async (request: { requestGeneration: number; plan: { name: string } }) => ({
      ready: true,
      kind: "userSelf",
      name: request.plan.name,
      requestGeneration: request.requestGeneration,
      stateDigest: "user-state",
      token: "user-token",
      expiresAt: Date.now() + 60_000,
      blockers: [],
      warnings: [],
      operationIds: ["user-preflight"],
      simulated: true,
    }),
  );
  backend.confirmCreateConnectionUser.mockResolvedValue({
    outcome: "created",
    kind: "userSelf",
    name: "new-user",
    message: "Browser Mock simulated user creation.",
    operationIds: ["user-confirm"],
    simulated: true,
  });
  await render();
  await change(input("服务器"), "draft:1666");
  await act(async () => fieldAction("用户", "新建").click());
  expect(backend.preflightCreateConnectionUser).not.toHaveBeenCalled();
  expect(backend.confirmCreateConnectionUser).not.toHaveBeenCalled();
  await change(dialogInput("用户 ID"), "new-user");
  await change(dialogInput("姓名"), "New User");
  await change(dialogInput("邮箱"), "new-user@example.invalid");
  await act(async () => dialogButton("预检").click());
  expect(backend.preflightCreateConnectionUser).toHaveBeenCalledWith(
    expect.objectContaining({
      context: expect.objectContaining({
        server: "draft:1666",
        user: "new-user",
        client: "",
      }),
      plan: expect.objectContaining({
        name: "new-user",
        fullName: "New User",
        email: "new-user@example.invalid",
      }),
    }),
  );
  expect(document.querySelector("dialog")?.textContent).toContain("New User");
  expect(document.querySelector("dialog")?.textContent).toContain(
    "new-user@example.invalid",
  );
  expect(document.querySelector("dialog")?.textContent).not.toContain(
    "userSelf",
  );
  expect(input("用户").value).toBe("tester");
  await act(async () =>
    document
      .querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!
      .click(),
  );
  await act(async () => dialogButton("确认创建").click());
  expect(backend.confirmCreateConnectionUser).toHaveBeenCalledWith(
    expect.objectContaining({
      token: "user-token",
      stateDigest: "user-state",
      confirmed: true,
    }),
  );
  expect(input("用户").value).toBe("tester");
  await act(async () => dialogButton("填入连接设置").click());
  expect(input("用户").value).toBe("new-user");
  expect(backend.createConnectionProfile).not.toHaveBeenCalled();
  expect(backend.setActiveConnectionProfile).not.toHaveBeenCalled();
});

it("creates a workspace only after explicit preview and fills its server-read Root", async () => {
  backend.preflightCreateConnectionWorkspace.mockImplementation(
    async (request: { requestGeneration: number; plan: { name: string } }) => ({
      ready: true,
      kind: "workspace",
      name: request.plan.name,
      requestGeneration: request.requestGeneration,
      stateDigest: "workspace-state",
      token: "workspace-token",
      expiresAt: Date.now() + 60_000,
      blockers: [],
      warnings: [],
      operationIds: ["workspace-preflight"],
      simulated: true,
    }),
  );
  backend.confirmCreateConnectionWorkspace.mockResolvedValue({
    outcome: "created",
    kind: "workspace",
    name: "new-workspace",
    message: "Browser Mock simulated workspace creation.",
    operationIds: ["workspace-confirm"],
    simulated: true,
    workspace: {
      name: "new-workspace",
      owner: "tester",
      host: "",
      root: "D:\\work\\new-workspace",
      stream: "//depot/main",
      description: "",
      updated: null,
      accessed: null,
      rootStatus: "usable",
      selectable: true,
    },
  });
  backend.browseConnectionWorkspaces.mockImplementation(
    async (request: {
      context: RuntimeInfo["context"];
      requestGeneration: number;
      operationId?: string;
      prefix?: string;
    }) => {
      const name = request.prefix ?? request.context.client;
      return {
        requestGeneration: request.requestGeneration,
        items: [
          {
            name,
            owner: request.context.user,
            host: "",
            root:
              name === "new-workspace"
                ? "D:\\work\\new-workspace"
                : "C:\\fixture\\workspace",
            stream: name === "new-workspace" ? "//depot/main" : "",
            description: "",
            updated: null,
            accessed: null,
            rootStatus: "usable" as const,
            selectable: true,
          },
        ],
        partial: false,
        truncated: false,
        stats: { scannedCount: 1, matchedCount: 1, safetyLimit: 500 },
        operationIds: [request.operationId ?? "workspace-root"],
        connection: status("connected", { server: request.context.server }),
        simulated: true,
      };
    },
  );
  await render();
  await act(async () => fieldAction("工作区", "新建").click());
  expect(backend.preflightCreateConnectionWorkspace).not.toHaveBeenCalled();
  await change(dialogInput("Workspace 名称"), "new-workspace");
  await change(dialogInput("Workspace Root"), "D:\\work\\new-workspace");
  await change(dialogInput("Stream"), "//depot/main");
  await act(async () => dialogButton("预检").click());
  expect(backend.preflightCreateConnectionWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({
      context: expect.objectContaining({ user: "tester", client: "" }),
      plan: expect.objectContaining({
        name: "new-workspace",
        root: "D:\\work\\new-workspace",
        mapping: { kind: "stream", stream: "//depot/main" },
      }),
    }),
  );
  await act(async () =>
    document
      .querySelector<HTMLInputElement>('dialog input[type="checkbox"]')!
      .click(),
  );
  await act(async () => dialogButton("确认创建").click());
  await act(async () => dialogButton("填入连接设置").click());
  expect(input("工作区").value).toBe("new-workspace");
  expect(document.querySelector('input[aria-label="P4 工作目录"]')).toBeNull();
  await waitForResolvedRoot("D:\\work\\new-workspace");
  expect(backend.createConnectionProfile).not.toHaveBeenCalled();
  expect(backend.setActiveConnectionProfile).not.toHaveBeenCalled();
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
  await change(input("连接名称（可选）"), "Office");
  await change(input("服务器"), "office:1666");
  await change(input("用户"), "tester");
  await change(input("工作区"), "created-client");
  const swarm = input("Swarm 基础 URL（可选）");
  await change(swarm, "javascript:alert(1)");
  expect(button("保存连接").disabled).toBe(true);
  await change(swarm, "https://user:secret@swarm.example/");
  expect(button("保存连接").disabled).toBe(true);
  await change(swarm, "https://swarm.example/team");
  await waitForResolvedRoot("C:\\fixture\\created");
  expect(button("保存连接").disabled).toBe(false);
  await act(async () => button("保存连接").click());
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
  await waitForResolvedRoot("C:\\fixture\\workspace");
  await change(input("连接名称（可选）"), "Primary renamed");
  await act(async () => button("保存连接").click());
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
  expect(button("保存连接").disabled).toBe(true);
  await change(input("连接名称（可选）"), "Secondary");
  await change(input("服务器"), "unique:1666");
  await change(input("用户"), "tester");
  await change(input("工作区"), "unique-client");
  await waitForResolvedRoot("C:\\fixture\\unique-client");
  await act(async () => button("保存连接").click());
  expect(host.textContent).toContain("连接名称已存在");
  expect(backend.createConnectionProfile).not.toHaveBeenCalled();
  await change(input("连接名称（可选）"), "Bad\u0001name");
  expect(button("保存连接").disabled).toBe(true);
  await change(input("连接名称（可选）"), "Duplicate context");
  await change(input("服务器"), "secondary:1666");
  await change(input("工作区"), "secondary-client");
  await waitForResolvedRoot("C:\\fixture\\secondary");
  await act(async () => button("保存连接").click());
  expect(host.textContent).toContain("相同参数的已保存连接");
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
  await waitForResolvedRoot("C:\\fixture\\workspace");
  await change(input("连接名称（可选）"), "My local rename");
  await act(async () => {
    button("保存连接").click();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(host.textContent).toContain("已重新加载");
  expect(input("连接名称（可选）").value).toBe("My local rename");
  expect(host.textContent).not.toContain("Revision 5");
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
  expect(host.textContent).toContain("当前且唯一");
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
  const switchButton = button("连接并使用");
  await act(async () => {
    switchButton.click();
    await Promise.resolve();
  });
  expect(host.textContent).toContain("正在验证目标连接");
  await act(async () => resolveSwitch(next));
  expect(onRuntime).toHaveBeenCalledWith(next);
  expect(host.textContent).toContain("连接切换成功");
  expect(host.textContent).toContain("旧选择、详情、搜索和日志视图已安全清理");
});

it("rolls back a failed profile switch and restores focus", async () => {
  backend.setActiveConnectionProfile.mockRejectedValue({
    code: "connectionFailed",
    message: "offline",
  });
  await render();
  await act(async () => button("Secondary").click());
  const switchButton = button("连接并使用");
  await act(async () => {
    switchButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(onRuntime).not.toHaveBeenCalled();
  expect(host.textContent).toContain("原连接和页面数据");
  expect(host.textContent).toContain("连接切换失败");
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
  await act(async () => button("验证这些设置").click());
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
  await change(input("服务器"), "unsaved-active:1666");
  await act(async () => button("验证这些设置").click());
  expect(backend.testConnection).toHaveBeenCalledWith(
    expect.objectContaining({ server: "unsaved-active:1666" }),
  );
  expect(onConnection).not.toHaveBeenCalled();
  expect(onRuntime).not.toHaveBeenCalled();
  expect(host.textContent).toContain("验证不会保存或切换当前连接");
});

it("verifies Server and User before a Workspace is selected so recovery is reachable", async () => {
  backend.testConnection.mockResolvedValue(status("authRequired"));
  await render();
  await act(async () => button("新建").click());
  await change(input("服务器"), "draft-without-workspace:1666");
  await change(input("用户"), "draft-user");
  expect(input("工作区").value).toBe("");
  expect(button("保存连接").disabled).toBe(true);
  expect(button("验证这些设置").disabled).toBe(false);
  await act(async () => button("验证这些设置").click());
  expect(backend.testConnection).toHaveBeenCalledWith(
    expect.objectContaining({
      server: "draft-without-workspace:1666",
      user: "draft-user",
      client: "",
    }),
  );
  expect(host.textContent).toContain("需要登录");
  expect(
    host.querySelector(".connection-action-feedback")?.textContent,
  ).toContain("需要登录");
  expect(
    host.querySelector(".connection-action-feedback")?.textContent,
  ).toContain("详细恢复操作见下方连接状态卡片");
  expect(button("登录")).toBeTruthy();
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
  expect(host.textContent).toContain("Saved connections");
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
