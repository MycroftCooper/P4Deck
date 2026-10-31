import { expect, it } from "vitest";
import { readLogViewPreferences } from "./logPreferences";

it("restores only bounded non-sensitive P4 Log view preferences", () => {
  expect(
    readLogViewPreferences(
      JSON.stringify({
        level: "warning",
        source: "terminal",
        followTail: false,
      }),
    ),
  ).toEqual({ level: "warning", source: "terminal", followTail: false });
  expect(
    readLogViewPreferences(
      JSON.stringify({
        level: "secret",
        source: "disk",
        followTail: "yes",
        keyword: "must-not-be-restored",
        command: "login hunter2",
      }),
    ),
  ).toEqual({ level: "", source: "", followTail: true });
  expect(
    readLogViewPreferences(
      JSON.stringify({ level: "cancelled", source: "", followTail: true }),
    ).level,
  ).toBe("cancelled");
  expect(readLogViewPreferences("broken")).toEqual({
    level: "",
    source: "",
    followTail: true,
  });
});
