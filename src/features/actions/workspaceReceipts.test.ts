import { expect, it } from "vitest";
import type { ConnectionSnapshot } from "../companySubmit/model";
import {
  validConnectionCreateReceipt,
  validWorkspaceMutationReceipt,
} from "./workflowReceipt";

const connection: ConnectionSnapshot = {
  profileId: "primary",
  generation: "1",
  server: "ssl:fixture:1666",
  user: "tester",
  client: "fixture-client",
};
const request = { operationId: "op-1", connection };
const envelope = {
  operationId: "op-1",
  connection,
  payloadDigest: "a".repeat(64),
  revision: "2",
  state: "settled" as const,
};

it("accepts only a matching workspace-mutation receipt identity", () => {
  expect(
    validWorkspaceMutationReceipt(request, {
      ...envelope,
      kind: "workspaceMutation",
      result: {
        outcome: "succeeded",
        message: "verified",
        workspace: "fixture-client",
        action: "rename",
        verified: true,
      },
    }),
  ).toBe(true);
  expect(
    validWorkspaceMutationReceipt(request, {
      ...envelope,
      kind: "workspaceMutation",
      operationId: "other",
      result: null,
    }),
  ).toBe(false);
  expect(
    validWorkspaceMutationReceipt(request, {
      ...envelope,
      kind: "workspaceMutation",
      connection: { ...connection, generation: "2" },
      result: null,
    }),
  ).toBe(false);
  expect(
    validWorkspaceMutationReceipt(request, {
      ...envelope,
      kind: "workspaceMutation",
      payloadDigest: "short",
      result: null,
    }),
  ).toBe(false);
});

it("keeps connection-create receipt kinds distinct (user vs workspace)", () => {
  const base = {
    ...envelope,
    kind: "connectionCreateUser" as const,
    result: null,
  };
  expect(validConnectionCreateReceipt(request, base)).toBe(true);
  expect(
    validConnectionCreateReceipt(request, base, "connectionCreateUser"),
  ).toBe(true);
  expect(
    validConnectionCreateReceipt(request, base, "connectionCreateWorkspace"),
  ).toBe(false);
  expect(
    validConnectionCreateReceipt(
      request,
      { ...base, kind: "connectionCreateWorkspace" },
      "connectionCreateWorkspace",
    ),
  ).toBe(true);
});
