import { describe, expect, it } from "vitest";
import {
  cleanAddress,
  completeFileAddress,
  parentPath,
  pathKey,
  workspaceRelativePath,
} from "./address";
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

const workspace = { cwd: "D:\\Work\\Game", client: "game-main" };
describe("workspace review addresses", () => {
  it.each([
    ["Assets/Code/File.cs", "D:/Work/Game/Assets/Code/File.cs"],
    [String.raw`.\Assets\Code\..\世界.cs`, "D:/Work/Game/Assets/世界.cs"],
    [String.raw`\Assets\Code\File.cs`, "D:/Work/Game/Assets/Code/File.cs"],
    [
      ' \ufeff"D:\\Work\\Game\\Assets\\A File.cs"\r\n',
      "D:/Work/Game/Assets/A File.cs",
    ],
    [
      "file:///D:/Work/Game/Assets/A%20File.cs",
      "D:/Work/Game/Assets/A File.cs",
    ],
    ["//game-main/Assets/Code/File.cs", "D:/Work/Game/Assets/Code/File.cs"],
    ["//Depot/Release/Assets/File.cs", "//Depot/Release/Assets/File.cs"],
    [
      String.raw`//Depot\Release\Assets\File.cs`,
      "//Depot/Release/Assets/File.cs",
    ],
    [
      String.raw`\\?\D:\Work\Game\Assets\File.cs`,
      "D:/Work/Game/Assets/File.cs",
    ],
    [String.raw`\\server\share\a#b.cs`, String.raw`\\server\share\a#b.cs`],
  ])("completes %s without guessing depot prefixes", (raw, expected) => {
    expect(completeFileAddress(raw, workspace)).toBe(expected);
  });
  it("handles POSIX and UNC workspace roots", () => {
    expect(
      completeFileAddress("./Assets/../Source/a.ts", {
        cwd: "/work/game",
        client: "game",
      }),
    ).toBe("/work/game/Source/a.ts");
    expect(
      completeFileAddress("Source\\a.ts", {
        cwd: String.raw`\\server\share\game`,
        client: "game",
      }),
    ).toBe(String.raw`\\server\share\game\Source\a.ts`);
    const uncWorkspace = {
      cwd: String.raw`\\server\share\game`,
      client: "game",
    };
    expect(
      workspaceRelativePath(
        String.raw`\\server\share\game\Source\a.ts`,
        uncWorkspace,
      ),
    ).toBe("Source/a.ts");
    expect(
      workspaceRelativePath("//server/share/game/Source/a.ts", uncWorkspace),
    ).toBeUndefined();
  });
  it("only shortens known local/client mappings within the current root", () => {
    expect(
      workspaceRelativePath("d:/work/GAME/Assets/File.cs", workspace),
    ).toBe("Assets/File.cs");
    expect(workspaceRelativePath("//game-main/Assets/File.cs", workspace)).toBe(
      "Assets/File.cs",
    );
    expect(
      workspaceRelativePath(
        String.raw`\\?\D:\Work\Game\Assets\File.cs`,
        workspace,
      ),
    ).toBe("Assets/File.cs");
    for (const path of [
      "//Depot/Release/Assets/File.cs",
      "//other-client/Assets/File.cs",
      "D:/Work/Game-old/Assets/File.cs",
    ])
      expect(workspaceRelativePath(path, workspace)).toBeUndefined();
    expect(
      workspaceRelativePath("/work/Game/a.ts", {
        cwd: "/work/game",
        client: "game",
      }),
    ).toBeUndefined();
  });
  it.each([
    "",
    "a\nb",
    "https://example.com",
    "//Depot/...",
    "//Depot/a.cs#head",
  ])("rejects invalid pasted input %s", (raw) =>
    expect(() => completeFileAddress(raw, workspace)).toThrow(),
  );
});
