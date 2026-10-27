import { tauriBackend } from "./tauriBackend";
import type { Backend } from "./contract";

export type { Backend } from "./contract";
export { tokenize } from "../../shared/lib/tokenize";

// Native startup must not load browser fixtures and simulated workflows.
// Every backend method is asynchronous, so the mock can load on its first call.
const lazyMock = Object.fromEntries(
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

export const backend: Backend =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? tauriBackend
    : lazyMock;
