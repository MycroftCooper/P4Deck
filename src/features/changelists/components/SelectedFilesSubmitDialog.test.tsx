// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { dialogHarness, dialogButton } from "../../../app/dialogs/testHarness";
import { SelectedFilesSubmitDialog } from "./SelectedFilesSubmitDialog";
import type {
  SelectedSubmitReceipt,
  SelectedSubmitRequest,
} from "../selectedSubmit";
import { setLocale } from "../../../shared/i18n";
const port = vi.hoisted(() => ({
  selectedSubmitPrepare: vi.fn(),
  selectedSubmitStatus: vi.fn(),
  selectedSubmitClaim: vi.fn(),
}));
vi.mock("../../../infrastructure/backend", () => ({ backend: port }));
const dirtyGuard = vi.hoisted(() => ({ clear: vi.fn(), states: vi.fn() }));
vi.mock("../../../app/closeGuard", () => ({
  useUnsavedEditor: (state: string) => {
    dirtyGuard.states(state);
    return dirtyGuard.clear;
  },
}));
const root = dialogHarness();
const files = [
  { depotPath: "//test/a", originalChangeId: 0 },
  { depotPath: "//test/b", originalChangeId: 12 },
];
const expected = {
  connection: {
    profileId: "p",
    generation: "9007199254740993",
    server: "fake",
    user: "test",
    client: "fixture",
  },
  customSubmitExecutablePath: "",
};
const continueSubmit = vi.fn(),
  dismiss = vi.fn();
let request: SelectedSubmitRequest;
function receipt(
  stage: SelectedSubmitReceipt["stage"] = "readyForSubmit",
): SelectedSubmitReceipt {
  return {
    operationId: request.operationId,
    newChangeId: 99,
    stage,
    canContinue: stage === "handedOff",
    files: request.files.map((f) => ({ ...f, state: "moved" })),
    message: "fixture",
  };
}
beforeEach(() => {
  // Components translate through the module-level locale.
  setLocale("en-US");
  vi.clearAllMocks();
  port.selectedSubmitPrepare.mockImplementation(async (r) => {
    request = r;
    return receipt();
  });
  port.selectedSubmitClaim.mockImplementation(async () => receipt("handedOff"));
  port.selectedSubmitStatus.mockImplementation(async () => receipt());
});
async function render(active = true) {
  await root.render(
    <SelectedFilesSubmitDialog
      files={files}
      expected={expected}
      active={active}
      zh={false}
      onDismiss={dismiss}
      onContinue={continueSubmit}
    />,
  );
}
async function prepare() {
  await render();
  await act(async () => {
    const input = document.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "description");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
it("prepare and status never submit; only explicit claim grants exact selected files", async () => {
  await prepare();
  expect(continueSubmit).not.toHaveBeenCalled();
  expect(request.files).toEqual([
    { depotPath: "//test/a", sourceChangeId: 0 },
    { depotPath: "//test/b", sourceChangeId: 12 },
  ]);
  expect(request.connection.generation).toBe("9007199254740993");
  await act(async () => dialogButton("Check status").click());
  expect(continueSubmit).not.toHaveBeenCalled();
  await act(async () => dialogButton("Continue to submit").click());
  expect(continueSubmit).toHaveBeenCalledExactlyOnceWith(99, 2, expected);
  await act(async () => dialogButton("Continue to submit").click());
  expect(port.selectedSubmitClaim).toHaveBeenCalledOnce();
});
it("partial and unknown moves cannot continue and preserve new CL", async () => {
  port.selectedSubmitPrepare.mockImplementation(async (r) => {
    request = r;
    return {
      ...receipt("stopped"),
      files: [
        { ...r.files[0], state: "moved" },
        { ...r.files[1], state: "unknown" },
      ],
    };
  });
  await prepare();
  expect(dialogButton("Continue to submit").disabled).toBe(true);
  expect(document.body.textContent).toContain("CL 99");
  expect(document.body.textContent).toContain("unknown");
  await act(async () => dialogButton("Close").click());
  expect(dismiss).toHaveBeenCalledOnce();
  expect(continueSubmit).not.toHaveBeenCalled();
});
it("lost prepare response recovers status under same operation ID without recreate", async () => {
  port.selectedSubmitPrepare.mockImplementation(async (r) => {
    request = r;
    throw new Error("lost");
  });
  await prepare();
  const id = request.operationId;
  await act(async () => dialogButton("Check status").click());
  expect(port.selectedSubmitPrepare).toHaveBeenCalledOnce();
  expect(port.selectedSubmitStatus.mock.calls[0][0].operationId).toBe(id);
  expect(continueSubmit).not.toHaveBeenCalled();
});
it("lost claim response never retries or uses status as a grant", async () => {
  port.selectedSubmitClaim.mockRejectedValue(new Error("lost"));
  await prepare();
  await act(async () => dialogButton("Continue to submit").click());
  await act(async () => dialogButton("Check status").click());
  expect(dialogButton("Continue to submit").disabled).toBe(true);
  expect(continueSubmit).not.toHaveBeenCalled();
});
it("connection changes stop follow-up while retaining the receipt", async () => {
  await prepare();
  await render(false);
  expect(document.body.textContent).toContain("CL 99");
  expect(dialogButton("Continue to submit").disabled).toBe(true);
  expect(continueSubmit).not.toHaveBeenCalled();
});
it("rejects a claim with extra target membership", async () => {
  port.selectedSubmitClaim.mockImplementation(async () => ({
    ...receipt("handedOff"),
    files: [
      ...receipt().files,
      { depotPath: "//extra", sourceChangeId: 0, state: "moved" },
    ],
  }));
  await prepare();
  await act(async () => dialogButton("Continue to submit").click());
  expect(continueSubmit).not.toHaveBeenCalled();
});

it("late claim after connection switch never opens submit", async () => {
  let release!: (value: SelectedSubmitReceipt) => void;
  port.selectedSubmitClaim.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await prepare();
  await act(async () => dialogButton("Continue to submit").click());
  await render(false);
  await act(async () => release(receipt("handedOff")));
  expect(continueSubmit).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("CL 99");
});

it("owns the draft during prepare and clears dirty only after the new CL is known", async () => {
  let release!: (value: SelectedSubmitReceipt) => void;
  port.selectedSubmitPrepare.mockImplementation((r) => {
    request = r;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  await prepare();
  expect(dirtyGuard.states).toHaveBeenLastCalledWith("dirty");
  await act(async () => release(receipt()));
  expect(dirtyGuard.states).toHaveBeenLastCalledWith("clean");
});
it("lost prepare retains draft dirty until the user explicitly closes it", async () => {
  port.selectedSubmitPrepare.mockImplementation(async (r) => {
    request = r;
    throw new Error("lost");
  });
  await prepare();
  expect(dirtyGuard.states).toHaveBeenLastCalledWith("dirty");
  dirtyGuard.clear.mockClear();
  await act(async () => dialogButton("Close").click());
  expect(dirtyGuard.clear).toHaveBeenCalledOnce();
});

it("shows a restart-interrupted preparation as stopped and never offers continue", async () => {
  await prepare();
  port.selectedSubmitStatus.mockImplementation(async () => ({
    ...receipt("stopped"),
    canContinue: false,
    message:
      "Interrupted by a previous process; the batch is not resumed and must not be replayed.",
  }));
  await act(async () => dialogButton("Check status").click());
  expect(document.body.textContent).toContain(
    "The previous process was interrupted",
  );
  expect(document.body.textContent).toContain("not resumed");
  expect(document.body.textContent).toContain("not resumed");
  expect(dialogButton("Continue to submit").disabled).toBe(true);
  expect(continueSubmit).not.toHaveBeenCalled();
});
