// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import golden from "../../../src-tauri/src/app/company_submit_golden_v1.json";
import { CompanySubmitPreview } from "./CompanySubmitPreview";
import { requestBinding, type PlanRequest, type PlanResult } from "./model";
const vectors = golden.cases as unknown as {
  name: string;
  request: PlanRequest;
  expected: PlanResult;
}[];
it.each(vectors)(
  "renders BE golden $name with real launch always disabled",
  async (vector) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      for (const zh of [true, false]) {
        await act(async () =>
          root.render(
            <CompanySubmitPreview
              request={vector.request}
              requestId="one"
              reply={{
                requestId: "one",
                binding: requestBinding(vector.request),
                result: vector.expected,
              }}
              zh={zh}
            />,
          ),
        );
        expect(host.querySelector("button")?.disabled).toBe(true);
        if (vector.expected.ok)
          expect(
            [...host.querySelectorAll("ol li")].map((n) => n.textContent),
          ).toEqual(vector.expected.plan.argv);
        else expect(host.querySelector("[role=alert]")).not.toBeNull();
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  },
);
it("never displays a stale plan after a context change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const vector = vectors[0];
  try {
    await act(async () =>
      root.render(
        <CompanySubmitPreview
          request={{
            ...vector.request,
            connection: { ...vector.request.connection, generation: "999" },
          }}
          requestId="one"
          reply={{
            requestId: "one",
            binding: requestBinding(vector.request),
            result: vector.expected,
          }}
        />,
      ),
    );
    expect(host.querySelector("ol")).toBeNull();
    expect(host.textContent).toContain("未核验");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(golden.sessionStates)(
  "renders shared session state $state without enabling launch",
  async (state) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    const vector = vectors[0];
    try {
      await act(async () =>
        root.render(
          <CompanySubmitPreview
            request={vector.request}
            requestId="one"
            simulation={{
              requestId: "one",
              binding: requestBinding(vector.request),
              state: state as import("./model").SessionState,
            }}
            zh={false}
          />,
        ),
      );
      expect(host.querySelector("button")?.disabled).toBe(true);
      if (state.state === "outcomeUnknown")
        expect(host.textContent).toContain("outcome unknown");
      expect(host.textContent).not.toContain("submission succeeded");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
