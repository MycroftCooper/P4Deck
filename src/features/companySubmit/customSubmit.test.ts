import { expect, it } from "vitest";
import { customSubmitRequest, customSubmitRoute } from "./customSubmit";
import type { ConnectionProfiles } from "../../shared/contracts";
const connection = {
  profileId: "fixture",
  generation: "18446744073709551615",
  server: "fixture.invalid",
  user: "user",
  client: "client",
};
function profiles(path?: string): ConnectionProfiles {
  return {
    schemaVersion: 3,
    revision: 1,
    activeProfileId: "fixture",
    profiles: [
      {
        id: "fixture",
        name: "Fixture",
        context: { ...connection, customSubmitExecutablePath: path },
      },
    ],
  };
}
it.each([undefined, "", "  "])(
  "only empty saved configuration selects native: %s",
  (path) => {
    expect(customSubmitRoute(profiles(path), connection, ["0"])).toEqual({
      kind: "native",
    });
  },
);
it.each(["C:\\fixture\\submit.exe", "bad-path", "missing.exe"])(
  "nonempty configuration never falls back: %s",
  (path) => {
    expect(customSubmitRoute(profiles(path), connection, ["00042"])).toEqual({
      kind: "custom",
      changeId: "42",
      path,
    });
  },
);
it.each([["0"], [], ["1", "2"], ["default"], ["18446744073709551616"]])(
  "rejects unsupported custom target %j",
  (...ids) => {
    expect(() =>
      customSubmitRoute(profiles("configured"), connection, ids),
    ).toThrow();
  },
);
it("retains precise u64 and strips caller-only execution fields", () => {
  expect(
    customSubmitRoute(profiles("configured"), connection, [
      "18446744073709551615",
    ]),
  ).toMatchObject({ changeId: "18446744073709551615" });
  expect(
    customSubmitRequest(
      "42",
      { ...connection, executablePath: "untrusted" } as typeof connection,
      "click-1",
    ),
  ).toEqual({ changeId: "42", connection, requestId: "click-1" });
});
it("fails closed on changed/missing active identity", () => {
  const changed = profiles("");
  changed.activeProfileId = "other";
  expect(() => customSubmitRoute(changed, connection, ["42"])).toThrow(
    "connectionChanged",
  );
  expect(() =>
    customSubmitRoute(profiles(""), { ...connection, client: "other" }, ["42"]),
  ).toThrow("connectionChanged");
});
