import { expect, it } from "vitest";
import { stableConnectionKey } from "./connectionKey";

it("keeps resource snapshots stable across view and context generations", () => {
  const first =
    '0:7:profile-a:{"server":"ssl:p4:1666","client":"main","cwd":"C:\\\\work"}';
  const restarted =
    '3:1:profile-a:{"server":"ssl:p4:1666","client":"main","cwd":"C:\\\\work"}';

  expect(stableConnectionKey(first)).toBe(stableConnectionKey(restarted));
  expect(stableConnectionKey(first)).toContain("profile-a:");
  expect(stableConnectionKey(first)).toContain("C:\\\\work");
});

it("leaves non-runtime test scopes unchanged", () => {
  expect(stableConnectionKey("connection-a")).toBe("connection-a");
});
