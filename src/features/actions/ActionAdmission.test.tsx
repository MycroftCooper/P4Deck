// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { dialogHarness } from "../../app/dialogs/testHarness";
import { AdmissionList, ActionAdmission } from "./ActionAdmission";
import {
  createAdmissionView,
  type AdmissionPort,
  type WriteFence,
} from "./admission";
vi.mock("./admissionPort", () => ({ admissionPort: {} }));
const snapshot = vi.hoisted(() => vi.fn());
vi.mock("../../infrastructure/backend", () => ({
  backend: { companySubmitConnectionSnapshot: snapshot },
}));
const h = dialogHarness();
const connection = {
  profileId: "p",
  generation: "1",
  server: "s",
  user: "u",
  client: "c",
};
const fence: WriteFence = {
  fenceId: "f",
  operationId: "o",
  scope: connection,
  revision: "1",
  active: false,
  outcome: "unknown",
  released: false,
};
it("non-native view never queries the host", async () => {
  await h.render(<ActionAdmission native={false} zh connectionKey="a" />);
  expect(snapshot).not.toHaveBeenCalled();
});
it("requires explicit acknowledgement, has no modal, resets acknowledgement on revision", async () => {
  const port: AdmissionPort = {
    query: vi.fn(async () => ({ connection, fences: [fence] })),
    release: vi.fn(async () => "stale" as const),
    subscribe: vi.fn(async () => () => {}),
    released: vi.fn(),
    log: vi.fn(),
  };
  const controller = createAdmissionView(connection, port);
  await controller.start();
  await h.render(<AdmissionList controller={controller} zh />);
  const checkbox = document.querySelector<HTMLInputElement>("input")!;
  const button = document.querySelector<HTMLButtonElement>("button")!;
  expect(button.disabled).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => checkbox.click());
  expect(button.disabled).toBe(false);
  vi.mocked(port.query).mockResolvedValue({
    connection,
    fences: [{ ...fence, revision: "2" }],
  });
  await act(async () => controller.refresh());
  expect(document.querySelector<HTMLButtonElement>("button")!.disabled).toBe(
    true,
  );
  expect(port.release).not.toHaveBeenCalled();
  controller.dispose();
});
