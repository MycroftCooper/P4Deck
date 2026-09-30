import { expect, it } from "vitest";
import { resourceScope } from "./resourceScope";

it("keeps workspace root independent from the browsed child", () => {
  expect(
    resourceScope("workspace", "/work/project/src", "/work/project"),
  ).toEqual({
    current: "/work/project/src",
    root: "/work/project",
    depot: undefined,
  });
});
it("never uses a depot path as a local directory", () => {
  expect(resourceScope("workspace", "//depot/src", "C:\\work")).toEqual({
    current: undefined,
    root: "C:\\work",
    depot: undefined,
  });
});
it("distinguishes all depots from a specific depot or subfolder", () => {
  expect(resourceScope("depot", "/work/project", "/work/project").depot).toBe(
    "",
  );
  expect(resourceScope("depot", "//depot").depot).toBe("//depot");
  expect(resourceScope("depot", "//depot/src").depot).toBe("//depot/src");
});
it("does not invent a root when configuration is absent", () => {
  expect(resourceScope("workspace", "/some/child").root).toBe("");
});
