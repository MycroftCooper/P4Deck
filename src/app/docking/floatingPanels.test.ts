import { expect, it } from "vitest";
import { readFloatingPanels } from "./floatingPanels";

it("migrates legacy detached panels and sanitizes versioned recovery state", () => {
  expect(readFloatingPanels('["terminal","shelf--safe","unknown"]')).toEqual({
    version: 1,
    panels: [{ id: "terminal" }, { id: "shelf--safe" }],
  });
  expect(
    readFloatingPanels(
      JSON.stringify({
        version: 1,
        panels: [
          {
            id: "p4log",
            binding: {
              profileId: "profile-a",
              contextGeneration: 4,
              connectionKey: "binding-a",
            },
          },
          { id: "p4log" },
          { id: "files?<script>" },
        ],
      }),
    ),
  ).toEqual({
    version: 1,
    panels: [
      {
        id: "p4log",
        binding: {
          profileId: "profile-a",
          contextGeneration: 4,
          connectionKey: "binding-a",
        },
      },
    ],
  });
});
