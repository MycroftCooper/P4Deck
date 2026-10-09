import { expect, it } from "vitest";
import {
  detachedBindingMatches,
  opaqueConnectionBinding,
  readDetachedBinding,
} from "./detachedBinding";

it("binds detached routes to profile, connection key, and runtime generation", () => {
  const expected = readDetachedBinding(
    "?panel=terminal&profileId=one%2Ftwo&contextGeneration=7&connectionKey=key%3A7",
  );
  expect(expected).toEqual({
    profileId: "one/two",
    contextGeneration: 7,
    connectionKey: "key:7",
  });
  expect(detachedBindingMatches(expected, expected!)).toBe(true);
  expect(
    detachedBindingMatches(expected, { ...expected!, contextGeneration: 8 }),
  ).toBe(false);
  expect(readDetachedBinding("?contextGeneration=nan")).toBeUndefined();
});

it("uses an opaque connection token instead of persisting context paths", () => {
  const input =
    '2:7:profile:{"server":"ssl:1666","ticketsPath":"C:\\\\secret\\\\tickets"}';
  const token = opaqueConnectionBinding(input);
  expect(token).toMatch(/^v1-[0-9a-f]{8}$/);
  expect(token).not.toContain("tickets");
  expect(opaqueConnectionBinding(input)).toBe(token);
  expect(opaqueConnectionBinding(`${input}:changed`)).not.toBe(token);
});
