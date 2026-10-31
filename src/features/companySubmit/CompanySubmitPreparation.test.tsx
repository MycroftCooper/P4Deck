// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanySubmitPreparation } from "./CompanySubmitPreparation";
import type { ConnectionSnapshot } from "./model";
const snapshot: ConnectionSnapshot = {
  profileId: "fixture",
  generation: "18446744073709551615",
  server: "synthetic.invalid:1666",
  user: "fixture",
  client: "synthetic-client",
};
let host: HTMLDivElement, root: Root;
const read = vi.fn<() => Promise<ConnectionSnapshot>>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  read.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = (connectionKey = "one") =>
  act(async () =>
    root.render(
      <CompanySubmitPreparation
        changeIds={["42"]}
        connectionKey={connectionKey}
        readSnapshot={read}
      />,
    ),
  );
it("uses exact host string identity, keeps path only in memory and real launch disabled", async () => {
  read.mockResolvedValue(snapshot);
  await render();
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "C:\\Synthetic\\Submit.exe");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(read).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("未核验");
  expect([...host.querySelectorAll("button")].at(-1)?.disabled).toBe(true);
});
it("discards late snapshots after connection change", async () => {
  let resolve!: (value: ConnectionSnapshot) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await render();
  read.mockRejectedValueOnce(new Error("synthetic failure"));
  await render("two");
  await act(async () => resolve(snapshot));
  expect(host.querySelector("[role=alert]")).not.toBeNull();
  expect(host.textContent).not.toContain("自定义提交工具（未接入）");
});
it("keeps failure disabled and permits an explicit retry", async () => {
  read
    .mockRejectedValueOnce(new Error("invalidConnection"))
    .mockResolvedValueOnce(snapshot);
  await render();
  expect(host.querySelector("[role=alert]")).not.toBeNull();
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector("[role=alert]")?.textContent).toContain("路径");
  expect(read).toHaveBeenCalledTimes(2);
});
it("rejects numeric generation rather than stringifying RuntimeInfo", async () => {
  read.mockResolvedValue({ ...snapshot, generation: 7 as unknown as string });
  await render();
  expect(host.textContent).toContain("无法取得有效连接身份");
});
it("rejects absent profile instead of synthesizing an identity", async () => {
  read.mockResolvedValue({ ...snapshot, profileId: "" });
  await render();
  expect(host.textContent).toContain("无法取得有效连接身份");
});
it("coalesces repeated refresh clicks while a read is pending", async () => {
  read.mockResolvedValueOnce(snapshot);
  await render();
  let resolve!: (value: ConnectionSnapshot) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await act(async () => {
    host.querySelector("button")!.click();
    host.querySelector("button")!.click();
  });
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => resolve(snapshot));
});
