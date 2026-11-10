import { describe, expect, it } from "vitest";
import { plainLocalPath } from "./plainPath";

describe("plainLocalPath", () => {
  it("strips drive and UNC verbatim prefixes", () => {
    expect(plainLocalPath("\\\\?\\D:\\Workspace\\File.txt")).toBe(
      "D:\\Workspace\\File.txt",
    );
    expect(plainLocalPath("\\\\?\\UNC\\server\\share\\file.txt")).toBe(
      "\\\\server\\share\\file.txt",
    );
    expect(plainLocalPath("\\\\?\\unc\\server\\share\\file.txt")).toBe(
      "\\\\server\\share\\file.txt",
    );
  });

  it("normalizes forward-slash verbatim forms", () => {
    expect(plainLocalPath("//?/D:/Workspace/File.txt")).toBe(
      "D:/Workspace/File.txt",
    );
  });

  it("leaves ordinary paths untouched", () => {
    expect(plainLocalPath("D:\\Workspace\\File.txt")).toBe(
      "D:\\Workspace\\File.txt",
    );
    expect(plainLocalPath("//depot/main/file.txt")).toBe(
      "//depot/main/file.txt",
    );
  });
});
