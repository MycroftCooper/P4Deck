import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeInfo } from "../../shared/contracts/types";
import { runWithRetry, type RetryBinding } from "../../shared/lib/retry";
import { workspaceCache } from "../../features/files/workspaceQueries";
import type { PageId } from "../panels";

export type RefreshReason =
  "interval" | "focus" | "visible" | "online" | "manual";
export type AutoRefreshPhase = "idle" | "refreshing" | "failed" | "paused";
export interface AutoRefreshStatus {
  phase: AutoRefreshPhase;
  lastUpdated?: number;
  error?: string;
}

export interface AutoRefreshEnvironment {
  visible: boolean;
  focused: boolean;
  online: boolean;
  detached: boolean;
}

interface CoordinatorOptions {
  binding(): string;
  environment(): AutoRefreshEnvironment;
  paused(): boolean;
  refresh(signal: AbortSignal, reason: RefreshReason): Promise<void>;
  update(status: AutoRefreshStatus): void;
  now?: () => number;
  foregroundThrottleMs?: number;
  backgroundThrottleMs?: number;
}

/** Coordinates all automatic reads. Mutations must never be registered here. */
export class AutoRefreshCoordinator {
  private active?: AbortController;
  private lastStarted = 0;
  private sequence = 0;
  constructor(private readonly options: CoordinatorOptions) {}

  cancel() {
    this.sequence++;
    this.active?.abort();
    this.active = undefined;
  }

  async trigger(reason: RefreshReason): Promise<boolean> {
    const environment = this.options.environment();
    if (this.options.paused() && reason !== "manual") {
      this.options.update({ phase: "paused" });
      return false;
    }
    if (!environment.online || (!environment.visible && reason !== "manual"))
      return false;
    const now = (this.options.now ?? Date.now)();
    const throttle =
      environment.visible && environment.focused && !environment.detached
        ? (this.options.foregroundThrottleMs ?? 15_000)
        : (this.options.backgroundThrottleMs ?? 60_000);
    if (reason !== "manual" && now - this.lastStarted < throttle) return false;
    this.lastStarted = now;
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    const binding = this.options.binding();
    const sequence = ++this.sequence;
    this.options.update({ phase: "refreshing" });
    try {
      await this.options.refresh(controller.signal, reason);
      if (sequence !== this.sequence || binding !== this.options.binding())
        return false;
      this.options.update({
        phase: "idle",
        lastUpdated: (this.options.now ?? Date.now)(),
      });
      return true;
    } catch (error) {
      if (
        controller.signal.aborted ||
        sequence !== this.sequence ||
        binding !== this.options.binding()
      )
        return false;
      this.options.update({ phase: "failed", error: String(error) });
      return false;
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }
}

function emitRefreshEvents(reason: RefreshReason, activePage: PageId | null) {
  window.dispatchEvent(
    new CustomEvent("p4deck:auto-refresh", { detail: { reason, activePage } }),
  );
  if (activePage === "pending")
    window.dispatchEvent(new Event("p4deck:pending-refresh"));
  if (activePage === "submitted")
    window.dispatchEvent(new Event("p4deck:submitted-refresh"));
}

export function useAutoRefresh(
  runtime: RuntimeInfo,
  connectionKey: string,
  paused: boolean,
  detached: boolean,
  activePage: PageId | null,
) {
  const [status, setStatus] = useState<AutoRefreshStatus>({
    phase: paused ? "paused" : "idle",
  });
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const bindingRef = useRef(connectionKey);
  bindingRef.current = connectionKey;
  const retryBindingRef = useRef<RetryBinding>({
    profileId: runtime.activeProfileId,
    generation: runtime.contextGeneration,
  });
  retryBindingRef.current = {
    profileId: runtime.activeProfileId,
    generation: runtime.contextGeneration,
  };
  const coordinator = useMemo(
    () =>
      new AutoRefreshCoordinator({
        binding: () => bindingRef.current,
        paused: () => pausedRef.current,
        environment: () => ({
          visible: document.visibilityState !== "hidden",
          focused: document.hasFocus(),
          online: navigator.onLine,
          detached,
        }),
        update: setStatus,
        refresh: async (signal, reason) => {
          const binding = { ...retryBindingRef.current };
          await runWithRetry(
            async () => {
              if (signal.aborted)
                throw new DOMException("Refresh cancelled", "AbortError");
              await workspaceCache.cancelQueries();
              emitRefreshEvents(reason, activePage);
              await workspaceCache.refetchQueries(
                { type: "active" },
                { throwOnError: true },
              );
            },
            {
              kind: "refresh",
              idempotent: true,
              binding,
              currentBinding: () => retryBindingRef.current,
              signal,
              maxAttempts: 3,
            },
          );
        },
      }),
    [activePage, detached],
  );
  useEffect(() => {
    setStatus((old) => ({ ...old, phase: paused ? "paused" : "idle" }));
    if (!paused) void coordinator.trigger("visible");
  }, [coordinator, paused]);
  useEffect(() => {
    const focus = () => void coordinator.trigger("focus");
    const online = () => void coordinator.trigger("online");
    const visible = () => {
      if (document.visibilityState === "visible")
        void coordinator.trigger("visible");
    };
    const timer = setInterval(
      () => void coordinator.trigger("interval"),
      detached ? 120_000 : 30_000,
    );
    addEventListener("focus", focus);
    addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      coordinator.cancel();
      clearInterval(timer);
      removeEventListener("focus", focus);
      removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [coordinator, connectionKey, detached]);
  const refreshNow = useCallback(
    () => coordinator.trigger("manual"),
    [coordinator],
  );
  return { status, refreshNow };
}
