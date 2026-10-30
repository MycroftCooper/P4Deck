import { expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import {
  lookupWorkflowAction,
  validWorkflowReceipt,
  type WorkflowActionReceipt,
} from "./workflowReceipt";
const connection = {
  profileId: "p",
  generation: "18446744073709551615",
  server: "s",
  user: "u",
  client: "c",
};
const request = { operationId: "op", connection };
const receipt: WorkflowActionReceipt = {
  ...request,
  kind: "shelf",
  revision: "18446744073709551615",
  payloadDigest: "a".repeat(64),
  state: "interrupted",
  result: null,
};
it("lookup passes exact decimal identity and never dispatches confirm", async () => {
  await lookupWorkflowAction(request);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("workflow_action_lookup", {
    request,
  });
});
it("accepts interrupted evidence as identity-valid but not success", () => {
  expect(validWorkflowReceipt(request, receipt)).toBe(true);
  expect(receipt.result).toBeNull();
});
it("rejects old identity, malformed revision and other operation", () => {
  expect(
    validWorkflowReceipt(request, { ...receipt, operationId: "other" }),
  ).toBe(false);
  expect(validWorkflowReceipt(request, { ...receipt, revision: "01" })).toBe(
    false,
  );
  expect(
    validWorkflowReceipt(request, {
      ...receipt,
      connection: { ...connection, generation: "2" },
    }),
  ).toBe(false);
});
