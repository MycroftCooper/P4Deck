import { expect, it } from "vitest";
import { pendingFilePath } from "./pendingFilePath";

const context = {
  server: "p4",
  user: "tester",
  client: "workspace",
  cwd: "D:\\Project",
};
const depotPath =
  "//DM42.Beyond.Project/Development/Beyond_v2d0/Assets/Gameplay/File.cs";

it("displays workspace-relative client paths while retaining nested folders", () => {
  expect(
    pendingFilePath(
      {
        depotPath,
        clientPath: "//workspace/Assets/Gameplay/File.cs",
        action: "edit",
      },
      context,
    ),
  ).toBe("Assets/Gameplay/File.cs");
  expect(
    pendingFilePath(
      {
        depotPath,
        clientPath: "d:\\PROJECT\\Assets\\Gameplay\\File.cs",
        action: "add",
      },
      context,
    ),
  ).toBe("Assets/Gameplay/File.cs");
  expect(
    pendingFilePath(
      { depotPath, clientPath: "/work/project/Assets/世界.cs", action: "edit" },
      { ...context, cwd: "/work/project/" },
    ),
  ).toBe("Assets/世界.cs");
});

it("keeps full depot paths when mapping is absent, belongs to another workspace, or is outside the root", () => {
  for (const clientPath of [
    undefined,
    "//workspace-other/Assets/File.cs",
    "D:/Project-other/File.cs",
    "/Work/project/File.cs",
  ]) {
    expect(
      pendingFilePath(
        { depotPath, clientPath, action: "edit" },
        { ...context, cwd: "/work/project" },
      ),
    ).toBe(depotPath);
  }
  expect(
    pendingFilePath(
      { depotPath, clientPath: "D:/Project-other/File.cs", action: "edit" },
      context,
    ),
  ).toBe(depotPath);
  expect(
    pendingFilePath(
      { depotPath, clientPath: "//other/Assets/File.cs", action: "edit" },
      { ...context, cwd: "/" },
    ),
  ).toBe(depotPath);
});
