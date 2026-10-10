import { expect, it } from "vitest";
import { mockBackend } from "./mockBackend";

it("simulates stream and bounded shelf deep-search facets", async () => {
  const streamResult = await mockBackend.globalSearch({
    operationId: "mock-global-stream-shelf",
    requestGeneration: 1,
    text: "atlas",
    kinds: ["stream"],
    pageSize: 100,
  });
  const shelfResult = await mockBackend.globalSearch({
    operationId: "mock-global-shelf",
    requestGeneration: 2,
    text: "atlas",
    kinds: ["shelf"],
    pageSize: 100,
  });

  expect(streamResult.simulated).toBe(true);
  expect(streamResult.groups.some((group) => group.kind === "stream")).toBe(
    true,
  );
  expect(shelfResult.groups.some((group) => group.kind === "shelf")).toBe(true);
  expect(
    shelfResult.facets.find((facet) => facet.kind === "shelf"),
  ).toMatchObject({
    partial: true,
    partialReason: expect.stringContaining("simulated"),
  });
  const shelfIds = shelfResult.groups
    .flatMap((group) => group.items)
    .filter((item) => item.kind === "shelf")
    .map((item) => item.identity);
  expect(new Set(shelfIds).size).toBe(shelfIds.length);
});

it("binds mock cursors to page size and consumes them once", async () => {
  const first = await mockBackend.globalSearch({
    operationId: "mock-global-page-1",
    requestGeneration: 2,
    text: "atlas",
    kinds: ["shelf"],
    pageSize: 2,
  });
  expect(first.nextCursor).toBeTruthy();
  const nextQuery = {
    operationId: "mock-global-page-2",
    requestGeneration: 3,
    text: "atlas",
    kinds: ["shelf" as const],
    pageSize: 2,
    cursor: first.nextCursor,
  };
  await expect(mockBackend.globalSearch(nextQuery)).resolves.toMatchObject({
    simulated: true,
  });
  await expect(mockBackend.globalSearch(nextQuery)).rejects.toThrow(
    /replayed/i,
  );

  const another = await mockBackend.globalSearch({
    ...nextQuery,
    operationId: "mock-global-page-size-first",
    cursor: undefined,
  });
  await expect(
    mockBackend.globalSearch({
      ...nextQuery,
      operationId: "mock-global-page-size",
      pageSize: 3,
      cursor: another.nextCursor,
    }),
  ).rejects.toThrow(/cursor/i);
});

it("honors an explicit mock cancellation before collection", async () => {
  await mockBackend.cancelOperation("mock-global-cancelled");
  await expect(
    mockBackend.globalSearch({
      operationId: "mock-global-cancelled",
      requestGeneration: 4,
      text: "atlas",
      kinds: ["stream"],
      pageSize: 10,
    }),
  ).rejects.toThrow(/cancelled/i);
});
