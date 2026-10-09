import { expect, it } from "vitest";
import { checkRenamePath } from "./renamePath";
it("accepts local macOS, Windows and Depot destination syntax", () => {
  expect(
    checkRenamePath("/a/old", "/a/new name", false, false),
  ).toBeUndefined();
  expect(
    checkRenamePath("C:\\a\\old", "C:\\a\\new", false, false),
  ).toBeUndefined();
  expect(
    checkRenamePath("//depot/main/old", "//depot/main/new", false, true),
  ).toBeUndefined();
});
it("rejects empty paths, traversal, wildcards, relative paths and roots", () => {
  for (const target of [
    "",
    "../a",
    "/a/../b",
    "/a/./b",
    "/a//b",
    "/a/*",
    "/a/name@change",
    "/a/name#revision",
    "/a/name%40encoded",
    "/a/...",
    "/a/\n",
    "/",
    "C:/",
  ])
    expect(checkRenamePath("/a/old", target, false, false)).toBeDefined();
  expect(checkRenamePath("//depot/main/a", "/local/a", false, true)).toBe(
    "absolute",
  );
});
it("rejects identical paths and self-descendant folder moves", () => {
  expect(checkRenamePath("/a/b", "/a/b", false, false)).toBe("same");
  expect(checkRenamePath("/a/b", "/a/b/c", true, false)).toBe("descendant");
  expect(checkRenamePath("C:\\a\\b", "c:\\A\\b\\c", true, false)).toBe(
    "descendant",
  );
  expect(checkRenamePath("/a/b", "/a/b2", true, false)).toBeUndefined();
});
