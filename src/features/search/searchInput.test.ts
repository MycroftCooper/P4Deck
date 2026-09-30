import { expect, it } from "vitest";
import { changelistNumber } from "./searchInput";
it("recognizes exact CL identifiers without interpreting keywords or revisions", () => {
  for (const value of ["12345", " CL 12345 ", "cl #12345", "#12345"])
    expect(changelistNumber(value)).toBe("12345");
  for (const value of [
    "",
    "0",
    "-3",
    "123abc",
    "fix CL 123",
    "//depot/a#4",
    "12\n34",
  ])
    expect(changelistNumber(value)).toBeUndefined();
});
