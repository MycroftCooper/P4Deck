import { describe, expect, it } from "vitest";
import { cleanAddress, parentPath, pathKey } from "./address";
describe("clipboard address normalization", () => {
  it("matches canonical Windows paths without changing depot case", () => {
    expect(pathKey(String.raw`\\?\C:\Work\File.txt`)).toBe(
      pathKey("C:/work/file.txt"),
    );
    expect(pathKey(String.raw`\\?\UNC\server\share\file`)).toBe(
      pathKey(String.raw`\\server\share\file`),
    );
    expect(pathKey("//Depot/File")).not.toBe(pathKey("//depot/file"));
  });
  it.each([
    [' \ufeff"C:\\My Files\\中文.txt"\r\n', "C:\\My Files\\中文.txt"],
    ["“/work/My Files/a.txt”", "/work/My Files/a.txt"],
    ["file:///Users/test/a%20b.txt", "/Users/test/a b.txt"],
    ["file:///C:/My%20Files/a.txt", "C:/My Files/a.txt"],
    ["file://server/share/a%20b.txt", "\\\\server\\share\\a b.txt"],
    ["//depot/main/a%23b.txt", "//depot/main/a%23b.txt"],
    ["/work/a#2.txt", "/work/a#2.txt"],
  ])("cleans %s without losing filename characters", (input, expected) =>
    expect(cleanAddress(input)).toBe(expected),
  );
  it.each([
    "",
    "a\nb",
    "a\r\nb",
    "file:///x%00y",
    "https://example.com",
    "//depot/...",
    "//depot/file#head",
  ])("rejects ambiguous or unsafe input %s", (input) =>
    expect(() => cleanAddress(input)).toThrow(),
  );
  it("finds Windows and POSIX parents", () => {
    expect(parentPath("C:\\file.txt")).toBe("C:/");
    expect(parentPath("/file.txt")).toBe("/");
    expect(parentPath("//depot/main/a")).toBe("//depot/main");
  });
});
