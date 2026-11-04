import { describe, expect, it } from "vitest";
import { localizeBackendError } from "./localizeError";

describe("localizeBackendError", () => {
  it("shows the Chinese wording for known workspace errors", () => {
    expect(
      localizeBackendError(
        "Preview is restricted to the current workspace directory",
        true,
      ),
    ).toBe("仅可预览当前工作区目录内的文件。");
    expect(
      localizeBackendError("Path is outside the current workspace", true),
    ).toBe("路径不在当前工作区内。");
    expect(
      localizeBackendError("Path is outside the current client view", true),
    ).toBe("路径不在当前客户端视图中。");
  });

  it("shows the English wording when the UI is English", () => {
    expect(
      localizeBackendError(
        "Preview is restricted to the current workspace directory",
        false,
      ),
    ).toBe("Preview is restricted to the current workspace directory.");
    expect(
      localizeBackendError("Path is outside the current workspace", false),
    ).toBe("Path is outside the current workspace.");
  });

  it("ignores the Error: prefix that IPC rejections carry", () => {
    expect(
      localizeBackendError(
        "Error: Path is outside the current workspace",
        true,
      ),
    ).toBe("路径不在当前工作区内。");
  });

  it("keeps the dynamic path of a prefixed message", () => {
    expect(
      localizeBackendError(
        "The path is outside the workspace: E:\\Project\\other\\a.ts",
        true,
      ),
    ).toBe("路径不在当前工作区内：E:\\Project\\other\\a.ts");
    expect(
      localizeBackendError(
        "The path is outside the workspace: E:\\Project\\other\\a.ts",
        false,
      ),
    ).toBe("The path is outside the workspace: E:\\Project\\other\\a.ts");
  });

  it("passes unknown messages through unchanged", () => {
    expect(localizeBackendError("p4 failed: no such file", true)).toBe(
      "p4 failed: no such file",
    );
    expect(localizeBackendError("", true)).toBe("");
  });
});
