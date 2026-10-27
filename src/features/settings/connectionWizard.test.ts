import { describe, expect, it, vi } from "vitest";
import type {
  ConnectionState,
  ConnectionStatus,
  RecoveryAction,
} from "../../shared/contracts/types";
import {
  cliStatus,
  connectionPresentation,
  probeConnection,
  sameOperationalContext,
} from "./connectionWizard";

it("matches equivalent Windows contexts while isolating different connections, roots and credential files", () => {
  const context = {
    server: "p4:1666",
    user: "tester",
    client: "workspace",
    cwd: "C:\\work\\project",
    executable: "C:\\tools\\p4.exe",
    trustPath: "C:\\work\\trust",
    ticketsPath: "C:\\work\\tickets",
  };
  expect(
    sameOperationalContext(context, {
      ...context,
      cwd: "c:/WORK/project/",
      swarmBaseUrl: "https://swarm.example.com",
    }),
  ).toBe(true);
  for (const field of [
    "server",
    "user",
    "client",
    "cwd",
    "executable",
    "trustPath",
    "ticketsPath",
  ] as const) {
    expect(
      sameOperationalContext(context, { ...context, [field]: "different" }),
    ).toBe(false);
  }
  expect(
    sameOperationalContext(
      { ...context, cwd: "/work/project" },
      { ...context, cwd: "/Work/project" },
    ),
  ).toBe(false);
  expect(
    sameOperationalContext(
      { ...context, cwd: "/" },
      { ...context, cwd: undefined },
    ),
  ).toBe(false);
});

const recoveries: Record<ConnectionState, RecoveryAction> = {
  cliMissing: "configureCli",
  notTested: "retry",
  disconnected: "retry",
  sslUntrusted: "trustServer",
  authRequired: "login",
  connected: "none",
  ticketExpired: "login",
  networkError: "retry",
  permissionDenied: "contactAdmin",
  invalidConfig: "editConfig",
  externalAuthRequired: "completeExternalAuth",
  unsupported: "contactAdmin",
  unknown: "retry",
};

describe("connection wizard contract", () => {
  it("has bilingual structured presentation for every backend state", () => {
    for (const [state, recovery] of Object.entries(recoveries) as [
      ConnectionState,
      RecoveryAction,
    ][]) {
      const status: ConnectionStatus = {
        state,
        errorCode:
          state === "connected" || state === "notTested" ? undefined : state,
        message: "backend detail is not parsed",
        recovery,
        server: "ssl:fixture:1666",
      };
      const zh = connectionPresentation(status, true);
      const en = connectionPresentation(status, false);
      expect(zh.title).toBeTruthy();
      expect(zh.detail).toBeTruthy();
      expect(zh.recovery).toBeTruthy();
      expect(en.title).toBeTruthy();
      expect(en.detail).toBeTruthy();
      expect(en.recovery).toBeTruthy();
      expect(JSON.stringify({ zh, en })).not.toContain(status.message);
    }
  });

  it("stops after structured CLI discovery failures", async () => {
    const api = {
      discoverP4Cli: vi.fn(async () => ({
        state: "cliMissing" as const,
        errorCode: "cliMissing" as const,
        message: "missing",
      })),
      testConnection: vi.fn(),
      queryLoginStatus: vi.fn(),
    };
    const result = await probeConnection(api, {
      server: "fixture:1666",
      user: "tester",
      client: "fixture",
    });
    expect(result.status).toMatchObject({
      state: "cliMissing",
      recovery: "configureCli",
    });
    expect(api.testConnection).not.toHaveBeenCalled();
    expect(api.queryLoginStatus).not.toHaveBeenCalled();
  });

  it("checks login status only after ordinary connectivity succeeds", async () => {
    const connected: ConnectionStatus = {
      state: "connected",
      message: "connected",
      recovery: "none",
      server: "fixture:1666",
    };
    const expired: ConnectionStatus = {
      state: "ticketExpired",
      errorCode: "ticketExpired",
      message: "expired",
      recovery: "login",
      server: "fixture:1666",
    };
    const api = {
      discoverP4Cli: vi.fn(async () => ({
        state: "notTested" as const,
        executable: "p4",
        version: "Rev. P4/TEST/2026.1",
        message: "ready",
      })),
      testConnection: vi.fn(async () => connected),
      queryLoginStatus: vi.fn(async () => expired),
    };
    const context = {
      server: "fixture:1666",
      user: "tester",
      client: "fixture",
    };
    const result = await probeConnection(api, context);
    expect(api.discoverP4Cli).toHaveBeenCalledWith({ executable: undefined });
    expect(api.testConnection).toHaveBeenCalledWith(context);
    expect(api.queryLoginStatus).toHaveBeenCalledWith(context);
    expect(result.status).toBe(expired);
  });

  it("maps invalid CLI configuration without inspecting its message", () => {
    expect(
      cliStatus(
        {
          state: "invalidConfig",
          executable: "not-p4",
          errorCode: "invalidConfig",
          message: "arbitrary localized output",
        },
        "fixture:1666",
      ),
    ).toMatchObject({ state: "invalidConfig", recovery: "editConfig" });
  });
});
