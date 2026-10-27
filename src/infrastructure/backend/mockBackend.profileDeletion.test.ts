import { expect, it } from "vitest";
import { backend } from ".";

it("disconnects on active deletion without selecting another profile, supports an empty store, and can create again", async () => {
  const initial = await backend.listConnectionProfiles();
  const before = await backend.runtimeInfo();
  const created = await backend.createConnectionProfile({
    expectedRevision: initial.revision,
    name: "Other",
    context: { ...before.context, client: "other-client" },
  });
  const deleted = await backend.deleteConnectionProfile({
    expectedRevision: created.revision,
    id: initial.activeProfileId!,
  });
  expect(deleted.activeProfileId).toBeUndefined();
  expect(deleted.profiles).toHaveLength(1);
  expect(await backend.getActiveConnectionProfile()).toBeNull();
  expect(await backend.runtimeInfo()).toMatchObject({
    context: { server: "", user: "", client: "" },
    connection: { state: "disconnected" },
  });
  expect((await backend.runtimeInfo()).contextGeneration).toBeGreaterThan(
    before.contextGeneration,
  );
  const empty = await backend.deleteConnectionProfile({
    expectedRevision: deleted.revision,
    id: deleted.profiles[0].id,
  });
  expect(empty.profiles).toEqual([]);
  expect(empty.activeProfileId).toBeUndefined();
  const recreated = await backend.createConnectionProfile({
    expectedRevision: empty.revision,
    name: "Recreated",
    context: before.context,
  });
  expect(recreated.profiles).toHaveLength(1);
  expect((await backend.runtimeInfo()).activeProfileId).toBe(
    recreated.profiles[0].id,
  );
  expect((await backend.runtimeInfo()).context).toEqual(before.context);
});
