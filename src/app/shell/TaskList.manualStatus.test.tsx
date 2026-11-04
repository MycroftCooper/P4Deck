// @vitest-environment jsdom
import { act } from "react";
import { it, expect, vi, beforeEach } from "vitest";
import { dialogHarness } from "../dialogs/testHarness";
import { PassiveStatusPanel } from "./PassiveServerStatus";
import { setLocale } from "../../shared/i18n";

const h = dialogHarness();
it.each([false, true])(
  "passive panel lists the three statuses as rows and gates manual check with a reason (zh=%s)",
  async (zh) => {
    const check = vi.fn(),
      close = vi.fn();
    const render = (busy: boolean, enabled = true) =>
      h.render(
        <PassiveStatusPanel
          id="fixture"
          native
          status={{
            connection: "reachable",
            access: "loginRequired",
            quality: "unknown",
            fresh: true,
          }}
          zh={zh}
          onCheckServer={enabled ? check : undefined}
          checkingServer={busy}
          onClose={close}
        />,
      );
    await render(false);
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    // three stacked label/value rows, not a single inline row
    const row = panel.querySelector<HTMLElement>(".passive-server-details")!;
    expect(row).toBeTruthy();
    expect(row.querySelectorAll(":scope > div")).toHaveLength(3);
    expect(row.textContent).toContain(zh ? "连接" : "Connection");
    expect(row.textContent).toContain(zh ? "需要登录" : "Sign in required");
    expect(row.textContent).toContain(zh ? "本机响应" : "Local response");
    expect(panel.textContent).toContain(
      zh ? "暂无近期样本" : "No recent samples",
    );
    const button = () =>
      panel.querySelector<HTMLButtonElement>(".passive-server-check button")!;
    expect(button().textContent).toBe(zh ? "手动检查" : "Check now");
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(check).toHaveBeenCalledOnce();
    // busy: spinner label + disabled + aria-busy, no extra calls
    await render(true);
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(button().textContent).toBe(zh ? "检查中…" : "Checking…");
    await act(async () => {
      button().click();
      button().click();
    });
    expect(check).toHaveBeenCalledTimes(1);
    // unavailable: explicit reason, never a silent disabled button
    await render(false, false);
    expect(button().disabled).toBe(true);
    const reason = panel.querySelector<HTMLElement>(
      ".passive-server-check-reason",
    )!;
    expect(reason.textContent).toBeTruthy();
    expect(button().title).toBe(reason.textContent);
    expect(panel.textContent).toMatch(
      zh ? /未就绪|桌面版/ : /not ready|desktop app/,
    );
    expect(close).not.toHaveBeenCalled();
  },
);

// Components translate through the module-level locale.
beforeEach(() => {
  setLocale("en-US");
  setLocale("en-US");
});

it("browser/non-desktop shares the same explicit unavailable reason", async () => {
  await h.render(
    <PassiveStatusPanel
      id="p"
      native={false}
      zh={false}
      onClose={() => {}}
      checkingServer={false}
    />,
  );
  const button = document.querySelector<HTMLButtonElement>(
    ".passive-server-check button",
  )!;
  expect(button.disabled).toBe(true);
  expect(
    document.querySelector(".passive-server-check-reason")?.textContent,
  ).toContain("desktop app");
});
