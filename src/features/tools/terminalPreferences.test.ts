import { expect, it } from "vitest";
import { readTerminalHistory, readToolHeight } from "./terminalPreferences";
it("rejects damaged saved terminal state", () => {
  expect(readTerminalHistory("broken")).toEqual([]);
  expect(readTerminalHistory("null")).toEqual([]);
  expect(readTerminalHistory('[1,"info",false]')).toEqual(["info"]);
  expect(readToolHeight("NaN")).toBe(260);
  expect(readToolHeight("99999")).toBe(560);
});
