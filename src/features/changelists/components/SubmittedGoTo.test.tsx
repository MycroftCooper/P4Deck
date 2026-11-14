// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { SubmittedGoTo } from "./SubmittedGoTo";
import { requestSubmittedClFocus } from "../submittedFocus";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<SubmittedGoTo zh />);
  });
  return host.querySelector<HTMLInputElement>("#submitted-go-to")!;
}

it("focuses and selects the go-to-CL input for a Ctrl+G request", async () => {
  const input = await mount();
  await act(async () => requestSubmittedClFocus());
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
});

it("consumes a request issued before the input mounts", async () => {
  requestSubmittedClFocus();
  const input = await mount();
  expect(document.activeElement).toBe(input);
});
