// @vitest-environment jsdom
import { it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  passiveStatusPresentation,
  type PassiveStatusView,
} from "./passiveStatus";
import {
  PassiveServerStatusIcon,
  PassiveServerStatusDetails,
} from "./PassiveServerStatus";
import { setLocale } from "../../shared/i18n";
const healthy: PassiveStatusView = {
  connection: "reachable",
  access: "ok",
  quality: "smooth",
  fresh: true,
};
it.each([
  [
    {
      connection: "failed",
      access: "loginRequired",
      quality: "persistentTimeout",
    },
    "failed",
  ],
  [{ access: "loginRequired", quality: "persistentTimeout" }, "login"],
  [{ access: "permissionDenied", quality: "persistentTimeout" }, "permission"],
  [{ quality: "persistentTimeout" }, "timeout"],
  [{ quality: "slow" }, "slow"],
  [{}, "healthy"],
  [{ connection: "unknown" }, "unknown"],
  // reachable wins over unknown quality: the icon must not wait for 5 bucketed samples
  [{ quality: "unknown" }, "healthy"],
] as const)("maps host facts using agreed precedence %j", (override, icon) =>
  expect(
    passiveStatusPresentation({ ...healthy, ...override }, false).icon,
  ).toBe(icon),
);
// Components translate through the module-level locale.
beforeEach(() => {
  setLocale("zh-CN");
});

it("initial state and stale failures are entirely unknown", () => {
  expect(passiveStatusPresentation(undefined, false).icon).toBe("unknown");
  const old = passiveStatusPresentation(
    {
      ...healthy,
      connection: "failed",
      access: "loginRequired",
      quality: "persistentTimeout",
      fresh: false,
    },
    true,
  );
  expect(old.icon).toBe("unknown");
  expect(old.rows.map((r) => r.value)).toEqual(Array(3).fill("暂无近期样本"));
});
it.each(["loginRequired", "permissionDenied"] as const)(
  "%s does not imply connection failure",
  (access) => {
    const view = passiveStatusPresentation({ ...healthy, access }, false);
    expect(view.rows[0].value).toBe("Reachable");
    expect(view.rows[1].value).not.toBe("Access confirmed");
    expect(view.tone).toBe("warning");
  },
);
it("timeout quality does not rewrite the independent connection dimension", () => {
  const view = passiveStatusPresentation(
    { ...healthy, quality: "persistentTimeout" },
    false,
  );
  expect(view.icon).toBe("timeout");
  expect(view.rows[0].value).toBe("Reachable");
});
it.each([false, true])(
  "three localized rows, accessible icon and passive limitation (zh=%s)",
  (zh) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <>
        <PassiveServerStatusIcon status={healthy} zh={zh} />
        <PassiveServerStatusDetails status={healthy} zh={zh} />
      </>,
    );
    expect(host.querySelectorAll("dl > div")).toHaveLength(3);
    expect(host.querySelectorAll("dt")).toHaveLength(3);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    const icon = host.querySelector('[role="img"]')!;
    expect(icon.getAttribute("aria-label")).toContain(
      zh ? "连接正常" : "Reachable",
    );
    expect(icon.getAttribute("title")).toContain(
      zh ? "非服务器负载" : "not server load",
    );
    expect(host.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(icon.className).toContain("tone-success");
  },
);
it.each(["light", "dark"])(
  "semantic classes and wrapping structure persist under %s theme without new controls",
  (theme) => {
    const host = document.createElement("div");
    host.dataset.theme = theme;
    host.style.width = "240px";
    host.innerHTML = renderToStaticMarkup(
      <PassiveServerStatusIcon
        status={{ ...healthy, access: "permissionDenied" }}
        zh={false}
      />,
    );
    expect(
      host.querySelector('[data-status-icon="permission"]')?.className,
    ).toContain("tone-warning");
    expect(host.querySelector("button,input,progress")).toBeNull();
  },
);

it("renders the three statuses as separate rows (not one inline row)", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <PassiveServerStatusDetails status={healthy} zh={false} />,
  );
  const dl = host.querySelector("dl")!;
  expect(dl.className).toContain("passive-server-details");
  expect(dl.className).not.toContain("inline");
  expect(dl.querySelectorAll(":scope > div")).toHaveLength(3);
  expect(dl.querySelectorAll("dt")).toHaveLength(3);
  expect(dl.querySelectorAll("dd")).toHaveLength(3);
  expect(dl.querySelectorAll("button")).toHaveLength(0);
});
it("manual provenance is explicit without claiming universal access", () => {
  const view = passiveStatusPresentation(
    { ...healthy, connectionSource: "manual" },
    false,
  );
  expect(view.title).toContain("connection from manual check");
  expect(view.rows[1].value).toBe("Last request authorized");
});
it("local response shows the latest request duration without waiting for bucketed samples", () => {
  const view = passiveStatusPresentation(
    { ...healthy, quality: "unknown", lastElapsedMs: 320, samples: 0 },
    false,
  );
  expect(view.rows[2].value).toBe("Last 320 ms");
  expect(
    passiveStatusPresentation(
      { ...healthy, quality: "unknown", lastElapsedMs: 320 },
      true,
    ).rows[2].value,
  ).toBe("最近 320 ms");
  // bucketed quality still refines the wording
  expect(
    passiveStatusPresentation(
      { ...healthy, quality: "slow", lastElapsedMs: 2100 },
      false,
    ).rows[2].value,
  ).toBe("Slower · Last 2100 ms");
});
