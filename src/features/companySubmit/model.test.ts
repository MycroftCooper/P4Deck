import { expect, it } from "vitest";
import golden from "../../../src-tauri/src/app/company_submit_golden_v1.json";
import {
  applySimulation,
  beginSimulation,
  currentReply,
  inputHint,
  requestBinding,
  snapshotRequest,
  type PlanRequest,
  type PlanResult,
} from "./model";
const vectors = golden.cases as unknown as {
  name: string;
  request: PlanRequest;
  expected: PlanResult;
}[];
const request = () => snapshotRequest(vectors[0].request);
it.each(vectors)(
  "consumes BE golden response $name without replanning it",
  (vector) => {
    const reply = {
      requestId: "one",
      binding: requestBinding(vector.request),
      result: vector.expected,
    };
    expect(currentReply(reply, vector.request, "one")).toBe(vector.expected);
    expect(currentReply(reply, vector.request, "late")).toBeUndefined();
    if (vector.expected.ok) {
      expect(inputHint(vector.request)).toBeUndefined();
      expect(vector.expected.plan.realStartAllowed).toBe(false);
    }
  },
);
it("copies only identity fields and preserves decimal strings", () => {
  const value = {
    ...vectors[0].request,
    changeIds: ["9007199254740993"],
    connection: { ...vectors[0].request.connection, password: "discard" },
  };
  const copy = snapshotRequest(value);
  value.changeIds[0] = "2";
  value.connection.user = "changed";
  expect(copy.changeIds).toEqual(["9007199254740993"]);
  expect(copy.connection.user).not.toBe("changed");
  expect(JSON.stringify(copy)).not.toContain("discard");
});
it("ignores old identity and response generations", () => {
  const original = request();
  const reply = {
    requestId: "one",
    binding: requestBinding(original),
    result: vectors[0].expected,
  };
  for (const connection of [
    { ...original.connection, profileId: "other" },
    { ...original.connection, generation: "4" },
  ])
    expect(
      currentReply(reply, { ...original, connection }, "one"),
    ).toBeUndefined();
});
it("rejects duplicate local reservations, including after connection switch", () => {
  const first = beginSimulation(undefined, request(), "one")!;
  expect(beginSimulation(first, request(), "two")).toBe(first);
  expect(
    beginSimulation(
      first,
      {
        ...request(),
        connection: { ...request().connection, generation: "4" },
      },
      "two",
    ),
  ).toBe(first);
});
it("only allows explicit retry after authoritative notStarted, never unknown", () => {
  const first = beginSimulation(undefined, request(), "one")!;
  const failed = applySimulation(first, {
    requestId: "one",
    binding: first.binding,
    state: { state: "notStarted" },
  });
  expect(beginSimulation(failed, request(), "two")?.state.state).toBe(
    "reserved",
  );
  const unknown = applySimulation(first, {
    requestId: "one",
    binding: first.binding,
    state: { state: "outcomeUnknown", exitCode: null },
  });
  expect(beginSimulation(unknown, request(), "two")).toBe(unknown);
  expect(
    applySimulation(unknown, {
      requestId: "one",
      binding: first.binding,
      state: { state: "running" },
    }),
  ).toBe(unknown);
});
it("does not clear running occupancy from a late non-creation or mismatched reply", () => {
  const first = beginSimulation(undefined, request(), "one")!;
  const running = applySimulation(first, {
    requestId: "one",
    binding: first.binding,
    state: { state: "running" },
  });
  expect(
    applySimulation(running, {
      requestId: "one",
      binding: first.binding,
      state: { state: "notStarted" },
    }),
  ).toBe(running);
  expect(
    applySimulation(first, {
      requestId: "old",
      binding: first.binding,
      state: { state: "running" },
    }),
  ).toBe(first);
  expect(
    applySimulation(first, {
      requestId: "one",
      binding: "other",
      state: { state: "running" },
    }),
  ).toBe(first);
});
