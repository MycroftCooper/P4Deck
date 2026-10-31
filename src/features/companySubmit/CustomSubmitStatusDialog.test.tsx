// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { dialogHarness, dialogButton } from "../../app/dialogs/testHarness";
import { CustomSubmitStatusDialog } from "./CustomSubmitStatusDialog";
const root = dialogHarness();
it.each([false, true])(
  "labels the recorded attempt path without changing status/close behavior (zh=%s)",
  async (zh) => {
    const refresh = vi.fn(),
      close = vi.fn();
    await root.render(
      <CustomSubmitStatusDialog
        zh={zh}
        view={{
          phase: "session",
          intent: "rejected",
          session: {
            requestId: "fixture",
            changeId: "42",
            state: "notStarted",
            executablePath: "C:\\old-attempt\\submit.exe",
            exitCode: null,
            reason: "toolMissing",
          },
        }}
        onRefresh={refresh}
        onClose={close}
      />,
    );
    expect(document.body.textContent).toContain(
      zh ? "本次尝试路径：" : "Path used for this attempt:",
    );
    expect(document.body.textContent).toContain("C:\\old-attempt\\submit.exe");
    expect(document.body.textContent).toContain(
      zh ? "不代表当前已保存配置" : "not the current saved configuration",
    );
    expect(refresh).not.toHaveBeenCalled();
    await act(async () =>
      dialogButton(zh ? "检查状态" : "Check status").click(),
    );
    expect(refresh).toHaveBeenCalledOnce();
    await act(async () => dialogButton(zh ? "关闭" : "Close").click());
    expect(close).toHaveBeenCalledOnce();
  },
);
