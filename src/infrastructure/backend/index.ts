import { mockBackend } from "./mockBackend";
import { tauriBackend } from "./tauriBackend";

export type { Backend } from "./contract";
export { tokenize } from "../../shared/lib/tokenize";

export const backend =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    ? tauriBackend
    : mockBackend;
