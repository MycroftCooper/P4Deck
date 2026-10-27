// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import {
  dialogHarness,
  dialogButton,
  chooseSelect,
} from "../../../app/dialogs/testHarness";
import { CheckoutChangelistDialog } from "./CheckoutChangelistDialog";

const harness = dialogHarness();
const changes = [
  { id: 101, description: "Fix checkout\nDetails" },
  { id: 102, description: "Other work" },
];
it("returns the selected numbered changelist and displays its complete description", async () => {
  const close = vi.fn();
  await harness.render(
    <CheckoutChangelistDialog
      changes={changes}
      client="workspace"
      count={2}
      recursive={false}
      source={null}
      zh={false}
      onClose={close}
    />,
  );
  await chooseSelect("101");
  expect(document.querySelector("textarea")!.value).toBe(
    "Fix checkout\nDetails",
  );
  await act(async () => dialogButton("Check out").click());
  expect(close).toHaveBeenCalledWith({
    changelistId: 101,
    alwaysUseDefault: false,
  });
});
it("checking always Default overrides a numbered selection; cancel does not save it", async () => {
  const close = vi.fn();
  await harness.render(
    <CheckoutChangelistDialog
      changes={changes}
      client="workspace"
      count={1}
      recursive={false}
      source={null}
      zh={false}
      onClose={close}
    />,
  );
  await chooseSelect("102");
  const check = document.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  await act(async () => check.click());
  expect(document.querySelector("select")!.value).toBe("0");
  expect(document.querySelector("select")!.disabled).toBe(true);
  await act(async () => check.click());
  expect(document.querySelector("select")!.value).toBe("102");
  await act(async () => check.click());
  await act(async () => dialogButton("Cancel").click());
  expect(close).toHaveBeenCalledWith(null);
  await act(async () => dialogButton("Check out").click());
  expect(close).toHaveBeenLastCalledWith({
    changelistId: 0,
    alwaysUseDefault: true,
  });
});
