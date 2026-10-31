import { expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import {
  lookupWorkflowAction,
  validWorkflowReceipt,
  type WorkflowActionReceipt,
  type WorkflowActionReceiptKind,
} from "./workflowReceipt";
const connection = {
  profileId: "p",
  generation: "18446744073709551615",
  server: "s",
  user: "u",
  client: "c",
};
const request = { operationId: "op", connection };
const receipt = (kind: WorkflowActionReceiptKind): WorkflowActionReceipt => ({
  ...request,
  kind,
  revision: "18446744073709551615",
  payloadDigest: "a".repeat(64),
  state: "interrupted",
  result: null,
});
it("lookup passes exact decimal identity and never dispatches confirm", async () => {
  await lookupWorkflowAction(request);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("workflow_action_lookup", {
    request,
  });
});
it("accepts interrupted evidence as identity-valid but not success", () => {
  const value = receipt("shelf");
  expect(validWorkflowReceipt(request, value, "shelf")).toBe(true);
  expect(value.result).toBeNull();
});
/**
 * Host `reserve_action` stores the literal receipt kinds below (Rust
 * `ipc/commands.rs`): shelf (2455), shelfDelete (2503), shelve (2640),
 * unshelve (2787/2903), revert (3798). The FE kind argument must match the
 * stored string, never a guessed default.
 */
it.each(["shelf", "shelve", "shelfDelete", "unshelve", "revert"] as const)(
  "accepts the host receipt kind %s only when expected",
  (kind) => {
    expect(validWorkflowReceipt(request, receipt(kind), kind)).toBe(true);
    const other = kind === "shelf" ? "shelve" : "shelf";
    expect(validWorkflowReceipt(request, receipt(kind), other)).toBe(false);
  },
);
it("rejects old identity, malformed revision and other operation", () => {
  const value = receipt("shelf");
  expect(
    validWorkflowReceipt(request, { ...value, operationId: "other" }, "shelf"),
  ).toBe(false);
  expect(
    validWorkflowReceipt(request, { ...value, revision: "01" }, "shelf"),
  ).toBe(false);
  expect(
    validWorkflowReceipt(
      request,
      { ...value, connection: { ...connection, generation: "2" } },
      "shelf",
    ),
  ).toBe(false);
});
