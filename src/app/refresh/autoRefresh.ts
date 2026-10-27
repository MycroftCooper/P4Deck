import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeInfo } from "../../shared/contracts/types";
import { runWithRetry, type RetryBinding } from "../../shared/lib/retry";
import { workspaceCache } from "../../features/files/workspaceQueries";
import { markSnapshotsStale } from "../../shared/cache/dataEffects";
import type { PageId } from "../panels";
import { defaultUi } from "../../features/settings/preferences";

export type RefreshReason =
  "interval" | "focus" | "visible" | "online" | "manual";
export type AutoRefreshPhase = "idle" | "refreshing" | "failed" | "paused";
const defaultRefreshMs = defaultUi.autoRefreshMinutes * 60_000;
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
  intervalMs?: () => number;
}

/** Coordinates all automatic reads. Mutations must never be registered here. */
export class AutoRefreshCoordinator {
  private active?: AbortController;
  private lastStarted: number;
  private sequence = 0;
  constructor(private readonly options: CoordinatorOptions) {
    // Pages load on mount; do not immediately duplicate those initial reads.
    this.lastStarted = (options.now ?? Date.now)();
  }

  cancel() {
    this.sequence++;
    this.active?.abort();
    this.active = undefined;
    this.lastStarted = (this.options.now ?? Date.now)();
  }

  async trigger(reason: RefreshReason): Promise<boolean> {
    const environment = this.options.environment();
    const interval = this.options.intervalMs?.() ?? defaultRefreshMs;
    if ((this.options.paused() || interval === 0) && reason !== "manual") {
      this.options.update({ phase: "paused" });
      return false;
    }
    if (!environment.online || (!environment.visible && reason !== "manual"))
      return false;
    if (this.active) return false;
    const now = (this.options.now ?? Date.now)();
    if (reason !== "manual" && now - this.lastStarted < interval) return false;
    this.lastStarted = now;
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
      if (this.active === controller) {
        this.active = undefined;
        this.lastStarted = (this.options.now ?? Date.now)();
      }
    }
  }
}

function emitRefreshEvents(reason: RefreshReason, activePage: PageId | null) {
  window.dispatchEvent(
    new CustomEvent("p4deck:auto-refresh", { detail: { reason, activePage } }),
  );
  if (activePage === "pending")
    window.dispatchEvent(
      new CustomEvent("p4deck:pending-refresh", { detail: { reason } }),
    );
  if (activePage === "submitted")
    window.dispatchEvent(
      new CustomEvent("p4deck:submitted-refresh", { detail: { reason } }),
    );
}

export function useAutoRefresh(
  runtime: RuntimeInfo,
  connectionKey: string,
  paused: boolean,
  detached: boolean,
  activePage: PageId | null,
  intervalMinutes = defaultUi.autoRefreshMinutes,
) {
  paused = paused || intervalMinutes === 0;
  const [status, setStatus] = useState<AutoRefreshStatus>({
    phase: paused ? "paused" : "idle",
  });
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const intervalRef = useRef(intervalMinutes);
  intervalRef.current = intervalMinutes;
  const bindingRef = useRef(connectionKey);
  bindingRef.current = connectionKey;
  const pageRef = useRef(activePage);
  pageRef.current = activePage;
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
        intervalMs: () => intervalRef.current * 60_000,
        environment: () => ({
          visible: document.visibilityState !== "hidden",
          focused: document.hasFocus(),
          online: navigator.onLine,
          detached,
        }),
        update: setStatus,
        refresh: async (signal, reason) => {
          const binding = { ...retryBindingRef.current };
          // P4V model: only the visible view asks the server now; every other
          // snapshot becomes stale and revalidates when its tab is shown.
          await markSnapshotsStale();
          emitRefreshEvents(reason, pageRef.current);
          await runWithRetry(
            async () => {
              if (signal.aborted)
                throw new DOMException("Refresh cancelled", "AbortError");
              await workspaceCache.refetchQueries(
                {
                  type: "active",
                  predicate: (query) =>
                    ["workspace-files", "depot-files"].includes(
                      String(query.queryKey[0]),
                    ),
                },
                { throwOnError: true, cancelRefetch: false },
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
    [detached],
  );
  useEffect(() => {
    setStatus((old) => ({ ...old, phase: paused ? "paused" : "idle" }));
    if (paused) coordinator.cancel();
  }, [coordinator, paused]);
  useEffect(() => {
    const focus = () => void coordinator.trigger("focus");
    const online = () => void coordinator.trigger("online");
    const visible = () => {
      if (document.visibilityState === "visible")
        void coordinator.trigger("visible");
    };
    const timer = paused
      ? undefined
      : setInterval(() => void coordinator.trigger("interval"), 60_000);
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
  }, [coordinator, connectionKey, detached, intervalMinutes, paused]);
  const refreshNow = useCallback(
    () => coordinator.trigger("manual"),
    [coordinator],
  );
  return { status, refreshNow };
}
