import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import {
  beginConnectionControlIntent,
  connectionControlIntentsSnapshot,
  connectionControlIntentActive,
  connectionStatusVerdict,
  lookupConnectionControlReceipt,
  recoverConnectionControlUnknown,
  resetConnectionControlIntentsForTests,
  settleConnectionControlIntent,
} from "./connectionControlLifecycle";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionStatus } from "../../shared/contracts";

const status = (
  state: ConnectionStatus["state"],
  errorCode?: string,
): ConnectionStatus =>
  ({
    state,
    errorCode: errorCode as ConnectionStatus["errorCode"],
    message: "",
    recovery: "none",
    server: "s",
  }) as ConnectionStatus;

it("intent store is intent-only and never carries credential material", () => {
  resetConnectionControlIntentsForTests();
  const intent = beginConnectionControlIntent({
    operationId: "op-login",
    kind: "authLogin",
    label: "server:1666 / tester",
    // @ts-expect-error credentials must not be accepted by the intent shape
    password: "super-secret",
  });
  expect(intent?.kind).toBe("authLogin");
  expect(connectionControlIntentActive("op-login")).toBe(true);
  const serialized = JSON.stringify(connectionControlIntentsSnapshot());
  expect(serialized).not.toContain("super-secret");
  expect(serialized).not.toContain("password");
  settleConnectionControlIntent("op-login");
  expect(connectionControlIntentActive("op-login")).toBe(false);
});
it("auth verdict table: login needs connected+no error; logout needs non-connected+no error; trust needs no error", () => {
  expect(connectionStatusVerdict("authLogin", status("connected"))).toBe(
    "success",
  );
  expect(
    connectionStatusVerdict("authLogin", status("connected", "permission")),
  ).toBe("notProven");
  expect(connectionStatusVerdict("authLogin", status("authRequired"))).toBe(
    "notProven",
  );
  expect(connectionStatusVerdict("authLogout", status("authRequired"))).toBe(
    "success",
  );
  expect(connectionStatusVerdict("authLogout", status("connected"))).toBe(
    "notProven",
  );
  expect(
    connectionStatusVerdict("authLogout", status("notTested", "network")),
  ).toBe("notProven");
  expect(connectionStatusVerdict("authTrust", status("sslUntrusted"))).toBe(
    "success",
  );
  expect(
    connectionStatusVerdict("authTrust", status("sslUntrusted", "ssl")),
  ).toBe("notProven");
});
it("unknown recovery: one lookup with the same operationId; settled status corrected, notFound conservative", async () => {
  const connection = {
    profileId: "p",
    generation: "1",
    server: "s",
    user: "u",
    client: "c",
  };
  const lookup = vi.fn().mockResolvedValue({
    kind: "found",
    receipt: { state: "settled", result: status("connected") },
  });
  const recovered = await recoverConnectionControlUnknown("op-login", {
    connection: async () => connection,
    lookup,
  });
  expect(lookup).toHaveBeenCalledExactlyOnceWith("op-login", connection);
  expect(recovered.result?.state).toBe("connected");
  lookup.mockReset();
  lookup.mockResolvedValue({ kind: "notFound" });
  expect(
    await recoverConnectionControlUnknown("op-login", {
      connection: async () => connection,
      lookup,
    }),
  ).toEqual({ found: false });
  expect(lookup).toHaveBeenCalledTimes(1);
});
it("lookup helper sends only operationId + exact snapshot (no credentials)", async () => {
  const connection = {
    profileId: "p",
    generation: "11",
    server: "s",
    user: "u",
    client: "c",
  };
  vi.mocked(invoke).mockResolvedValue({ kind: "notFound" });
  await lookupConnectionControlReceipt("op-x", connection);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("workflow_action_lookup", {
    request: { operationId: "op-x", connection },
  });
  const payload = JSON.stringify(vi.mocked(invoke).mock.calls[0][1]);
  expect(payload).not.toContain("password");
});
