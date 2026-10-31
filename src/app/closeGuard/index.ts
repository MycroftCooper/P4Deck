import { useLayoutEffect, useMemo } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CloseStateRegistry,
  connectCloseGuard,
  type CloseState,
  type DirtyCategory,
} from "./state";

export const closeState = new CloseStateRegistry();
export function useCloseGuard() {
  useLayoutEffect(() => {
    if (!isTauri()) return;
    const unknown = () => closeState.markUnknown();
    window.addEventListener("error", unknown);
    window.addEventListener("unhandledrejection", unknown);
    window.addEventListener("p4deck:startup-error", unknown);
    const stop = connectCloseGuard(closeState, {
      register: () => invoke("close_guard_register"),
      report: (payload) => invoke("close_guard_report", payload),
      listen: (handler) =>
        listen<{ generation: string; probeId: string }>(
          "close-guard-probe",
          (event) => handler(event.payload),
        ),
    });
    return () => {
      stop();
      window.removeEventListener("error", unknown);
      window.removeEventListener("unhandledrejection", unknown);
      window.removeEventListener("p4deck:startup-error", unknown);
    };
  }, []);
}
export function useCloseGuardReady() {
  useLayoutEffect(() => {
    closeState.setReady(true);
    return () => closeState.setReady(false);
  }, []);
}
export function useUnsavedEditor(
  state: CloseState,
  scope = "",
  category: DirtyCategory = "otherDraft",
) {
  const token = useMemo(() => Symbol("editor"), [scope]);
  useLayoutEffect(() => closeState.attach(token, state, category), [token]);
  useLayoutEffect(
    () => closeState.update(token, state, category),
    [token, state, category],
  );
  // Call only after successful save or an explicit user discard/close action.
  return () => closeState.clear(token);
}
export async function requestGuardedClose(scope: "window" | "application") {
  if (!isTauri()) return { accepted: false };
  return invoke<{ accepted: boolean }>("close_guard_request", { scope });
}
