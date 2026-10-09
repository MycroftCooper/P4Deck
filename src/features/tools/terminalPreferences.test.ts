import { expect, it } from "vitest";
import { readTerminalHistory, readToolHeight } from "./terminalPreferences";
it("rejects damaged saved terminal state", () => {
  expect(readTerminalHistory("broken")).toEqual([]);
  expect(readTerminalHistory("null")).toEqual([]);
  expect(readTerminalHistory('[1,"info",false]')).toEqual(["info"]);
  expect(readToolHeight("NaN")).toBe(260);
  expect(readToolHeight("99999")).toBe(560);
});

it("drops credential-sensitive legacy terminal history", () => {
  const sentinel = "P4DECK_SECRET_history_0e72";
  expect(
    readTerminalHistory(
      JSON.stringify([
        "info",
        "tickets",
        `info -P${sentinel}`,
        `info P4PASSWD=${sentinel}`,
      ]),
    ),
  ).toEqual(["info"]);
});
