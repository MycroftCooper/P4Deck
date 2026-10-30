// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { dialogHarness } from "../../app/dialogs/testHarness";
import { useCustomSubmit } from "./useCustomSubmit";
import { resetCustomSubmitSessions } from "./customSubmitSessions";
import type { Backend } from "../../infrastructure/backend/contract";
import type { CustomSubmitSession } from "./customSubmit";
const root = dialogHarness();
const connection = {
  profileId: "fixture",
  generation: "9007199254740993",
  server: "fixture.invalid",
  user: "u",
  client: "c",
};
function fixture(path = "C:\\fixture\\submit.exe") {
  return {
    companySubmitConnectionSnapshot: vi.fn(async () => connection),
    listConnectionProfiles: vi
      .fn<Backend["listConnectionProfiles"]>()
      .mockResolvedValue({
        schemaVersion: 3,
        revision: 1,
        activeProfileId: "fixture",
        profiles: [
          {
            id: "fixture",
            name: "Fixture",
            context: { ...connection, customSubmitExecutablePath: path },
          },
        ],
      }),
    customSubmitStart: vi
      .fn<Backend["customSubmitStart"]>()
      .mockImplementation(async (r) => ({
        requestId: r.requestId,
        changeId: r.changeId,
        state: "started",
        executablePath: path,
        exitCode: null,
        reason: null,
      })),
    customSubmitStatus: vi
      .fn<Backend["customSubmitStatus"]>()
      .mockResolvedValue(null),
  };
}
async function mount(port = fixture()) {
  resetCustomSubmitSessions();
  let latest!: ReturnType<typeof useCustomSubmit>;
  function Probe({ scope }: { scope: string }) {
    latest = useCustomSubmit(scope, port);
    return null;
  }
  await root.render(<Probe scope="one" />);
  return {
    port,
    get: () => latest,
    changeScope: () => root.render(<Probe scope="two" />),
  };
}
it("only empty persisted configuration returns control to native submit", async () => {
  const f = await mount(fixture(" "));
  let handled;
  await act(async () => {
    handled = await f.get().handle(["42"]);
  });
  expect(handled).toBe(false);
  expect(f.port.customSubmitStart).not.toHaveBeenCalled();
});
it("starts per changelist, deduplicates the same CL, and allows another CL concurrently", async () => {
  const f = await mount();
  expect(f.port.customSubmitStart).not.toHaveBeenCalled();
  await act(async () => {
    await Promise.all([f.get().handle(["00042"]), f.get().handle(["42"])]);
  });
  expect(f.port.customSubmitStart).toHaveBeenCalledTimes(1);
  expect(f.port.customSubmitStart).toHaveBeenCalledWith({
    changeId: "42",
    connection,
    requestId: expect.any(String),
  });
  await act(async () => {
    await f.get().handle(["43"]);
  });
  // A different CL may run its own tool window concurrently.
  expect(f.port.customSubmitStart).toHaveBeenCalledTimes(2);
  expect(f.port.customSubmitStart).toHaveBeenLastCalledWith({
    changeId: "43",
    connection,
    requestId: expect.any(String),
  });
  expect(f.get().view).toMatchObject({
    phase: "session",
    session: { state: "started" },
  });
});
it("invalid custom target is handled without starting or native fallback", async () => {
  const f = await mount();
  await act(async () => {
    expect(await f.get().handle(["0"])).toBe(true);
  });
  expect(f.port.customSubmitStart).not.toHaveBeenCalled();
  expect(f.get().view).toMatchObject({ phase: "error", uncertain: false });
});
it("transport failure remains uncertain and cannot silently retry", async () => {
  const f = await mount();
  f.port.customSubmitStart.mockRejectedValue(new Error("transport lost"));
  await act(async () => {
    expect(await f.get().handle(["42"])).toBe(true);
  });
  expect(f.get().view).toMatchObject({ phase: "error", uncertain: true });
  await act(async () => {
    await f.get().handle(["42"]);
  });
  expect(f.port.customSubmitStart).toHaveBeenCalledTimes(1);
});
it("explicit notStarted permits a later deliberate attempt, never an automatic fallback", async () => {
  const f = await mount();
  f.port.customSubmitStart.mockImplementation(async (r) => ({
    ...r,
    state: "notStarted",
    executablePath: "bad",
    exitCode: null,
    reason: "toolMissing",
  }));
  await act(async () => {
    expect(await f.get().handle(["42"])).toBe(true);
  });
  expect(f.port.customSubmitStart).toHaveBeenCalledTimes(1);
  await act(async () => {
    await f.get().handle(["42"]);
  });
  expect(f.port.customSubmitStart).toHaveBeenCalledTimes(2);
});
it("connection changes isolate late responses", async () => {
  const f = await mount();
  let resolve!: (s: CustomSubmitSession) => void;
  f.port.customSubmitStart.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = f.get().handle(["42"]);
  });
  const request = f.port.customSubmitStart.mock.calls[0][0];
  await f.changeScope();
  await act(async () => {
    resolve({
      ...request,
      state: "started",
      executablePath: "fixture",
      exitCode: null,
      reason: null,
    });
    await pending;
  });
  expect(f.get().view).toBeUndefined();
  expect(f.get().visible).toBe(false);
});

it("ignores another session during status refresh and never treats zero exit as success", async () => {
  const f = await mount();
  await act(async () => {
    await f.get().handle(["42"]);
  });
  const request = f.port.customSubmitStart.mock.calls[0][0];
  f.port.customSubmitStatus.mockResolvedValue({
    ...request,
    requestId: "other",
    state: "notStarted",
    executablePath: "fixture",
    exitCode: null,
    reason: null,
  });
  await act(async () => {
    await f.get().refresh();
  });
  expect(f.get().view).toMatchObject({
    phase: "session",
    session: { state: "started" },
  });
  f.port.customSubmitStatus.mockResolvedValue({
    ...request,
    state: "outcomeUnknown",
    executablePath: "fixture",
    exitCode: 0,
    reason: "submissionAndChildLifetimeUnknown",
  });
  await act(async () => {
    await f.get().refresh();
    await f.get().handle(["42"]);
  });
  expect(f.get().view).toMatchObject({
    phase: "session",
    session: { state: "outcomeUnknown", exitCode: 0 },
  });
  expect(f.port.customSubmitStart).toHaveBeenCalledTimes(1);
});

it("CL07 cannot silently switch a frozen custom route to native", async () => {
  const f = await mount(fixture(""));
  await act(async () =>
    expect(
      await f.get().handle(["99"], {
        connection,
        customSubmitExecutablePath: "C:\\fixture\\submit.exe",
      }),
    ).toBe(true),
  );
  expect(f.port.customSubmitStart).not.toHaveBeenCalled();
  expect(f.get().view).toMatchObject({ phase: "error", uncertain: false });
});
it("CL07 rejects a different exact generation before native or custom submission", async () => {
  const f = await mount(fixture(""));
  await act(async () =>
    expect(
      await f.get().handle(["99"], {
        connection: { ...connection, generation: "9007199254740994" },
        customSubmitExecutablePath: "",
      }),
    ).toBe(true),
  );
  expect(f.port.customSubmitStart).not.toHaveBeenCalled();
});
it("CL07 matching native expectation retains existing confirmation route", async () => {
  const f = await mount(fixture(""));
  await act(async () =>
    expect(
      await f
        .get()
        .handle(["99"], { connection, customSubmitExecutablePath: "" }),
    ).toBe(false),
  );
  expect(f.port.customSubmitStart).not.toHaveBeenCalled();
});

it("CL07 matching custom expectation launches only the new CL", async () => {
  const f = await mount(fixture("C:\\fixture\\submit.exe"));
  await act(async () =>
    expect(
      await f.get().handle(["99"], {
        connection,
        customSubmitExecutablePath: "C:\\fixture\\submit.exe",
      }),
    ).toBe(true),
  );
  expect(f.port.customSubmitStart).toHaveBeenCalledWith(
    expect.objectContaining({ changeId: "99", connection }),
  );
});
