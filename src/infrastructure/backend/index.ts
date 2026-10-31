import { tauriBackend } from "./tauriBackend";
import type { Backend } from "./contract";

export type { Backend } from "./contract";
export { tokenize } from "../../shared/lib/tokenize";

// Native startup must not load browser fixtures and simulated workflows.
// `__P4DECK_DESKTOP__` is a build-time constant (see vite.config.ts): desktop
// builds inline `true`, so this browser mock branch - including its dynamic
// import - is removed from the packaged bundle by tree shaking.
function createBrowserMock(): Backend {
  return Object.fromEntries(
    Object.keys(tauriBackend).map((name) => [
      name,
      async (...args: unknown[]) => {
        const { mockBackend } = await import("./mockBackend");
        const method = mockBackend[name as keyof Backend] as (
          ...args: unknown[]
        ) => unknown;
        return method.apply(mockBackend, args);
      },
    ]),
  ) as unknown as Backend;
}

const browserMock: Backend | null = __P4DECK_DESKTOP__
  ? null
  : createBrowserMock();

export const backend: Backend = __P4DECK_DESKTOP__
  ? tauriBackend
  : typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? tauriBackend
    : (browserMock as Backend);
