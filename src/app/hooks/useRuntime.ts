import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { backend } from "../../infrastructure/backend";
import type {
  ConnectionStatus,
  P4Context,
  RuntimeInfo,
} from "../../shared/contracts";
import { subscribeSafely } from "../../shared/lib/subscription";
import {
  contextIdentity,
  sameOperationalContext,
} from "../../features/settings/connectionWizard";

// Info and login each have a 20 s native timeout. Bound the complete IPC
// workflow as well, so a lost response cannot leave the UI checking forever.
const CONNECTION_CHECK_TIMEOUT_MS = 45_000;

function sameContext(left: P4Context, right: P4Context) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pendingStatus(context: P4Context): ConnectionStatus {
  return {
    state: "notTested",
    message: "Server connectivity has not been tested.",
    recovery: "retry",
    server: context.server,
  };
}

function canRetry(state: ConnectionStatus["state"]) {
  return [
    "notTested",
    "networkError",
    "disconnected",
    "unknown",
    "authRequired",
    "ticketExpired",
    "externalAuthRequired",
  ].includes(state);
}

export function useRuntime() {
  const [runtime, setRuntime] = useState<RuntimeInfo>({
    mode: "mock",
    p4Version: "loading",
    contextGeneration: 0,
    context: { server: "…", user: "…", client: "…" },
    connection: {
      state: "notTested",
      message: "Loading connection state.",
      recovery: "retry",
      server: "…",
    },
  });
  const [error, setError] = useState("");
  const [viewGeneration, setViewGeneration] = useState(0);
  const revision = useRef(0);
  const initialRequest = useRef<Promise<RuntimeInfo> | undefined>(undefined);
  const verification = useRef<
    | {
        key: string;
        revision: number;
        promise: Promise<ConnectionStatus | undefined>;
      }
    | undefined
  >(undefined);
  const [retry, setRetry] = useState(0);
  const [checking, setChecking] = useState<string>();
  const currentRuntime = useRef(runtime);
  currentRuntime.current = runtime;
  const applyRuntime = useCallback((next: RuntimeInfo) => {
    const current = currentRuntime.current;
    if (
      next.contextGeneration === current.contextGeneration &&
      next.activeProfileId === current.activeProfileId &&
      sameContext(next.context, current.context) &&
      next.p4Version === current.p4Version &&
      next.connection.state === "notTested" &&
      current.connection.state === "notTested"
    )
      return;
    // A delayed notification for the same generation must not erase a newer
    // successful verification published by Settings.
    if (
      next.contextGeneration === current.contextGeneration &&
      next.activeProfileId === current.activeProfileId &&
      sameOperationalContext(next.context, current.context) &&
      next.connection.state === "notTested" &&
      current.connection.state === "connected"
    )
      return;
    revision.current++;
    currentRuntime.current = next;
    setRuntime(next);
    if (
      next.contextGeneration !== current.contextGeneration ||
      !sameContext(next.context, current.context)
    )
      setViewGeneration((value) => value + 1);
  }, []);
  const applyConnection = useCallback(
    (context: P4Context, connection?: ConnectionStatus, p4Version?: string) => {
      const current = currentRuntime.current;
      // save_connection emits the same context that Settings already applied. Ignore that
      // duplicate event so it cannot replace a verified status with "not tested".
      if (!connection && sameContext(current.context, context)) return;
      const next: RuntimeInfo = {
        ...current,
        context,
        connection: connection ?? pendingStatus(context),
        p4Version: p4Version ?? current.p4Version,
      };
      currentRuntime.current = next;
      revision.current++;
      if (!sameContext(context, current.context))
        setViewGeneration((value) => value + 1);
      setRuntime(next);
    },
    [],
  );
  useEffect(() => {
    let live = true;
    const initialRevision = revision.current;
    // StrictMode replays effects. Keep one discovery request for this app instance.
    initialRequest.current ??= backend.runtimeInfo();
    void initialRequest.current
      .then((value) => {
        if (
          live &&
          revision.current === initialRevision &&
          currentRuntime.current.p4Version === "loading"
        ) {
          // Fast Refresh reconnects effects with refs and state intact. Discovery
          // is startup data; never replay it over a newer connection verdict.
          applyRuntime(value);
          performance.mark("p4deck:runtime-ready");
        }
      })
      .catch((e) => {
        if (live && revision.current === initialRevision) setError(String(e));
      });
    const stop = isTauri()
      ? subscribeSafely(
          () =>
            listen<RuntimeInfo>("connection-changed", ({ payload }) => {
              applyRuntime(payload);
            }),
          (e) => setError(String(e)),
        )
      : () => undefined;
    return () => {
      live = false;
      stop();
    };
  }, [applyConnection, applyRuntime]);
  const binding = JSON.stringify([
    runtime.activeProfileId,
    runtime.contextGeneration,
    contextIdentity(runtime.context),
  ]);
  useEffect(() => {
    const online = () => {
      if (
        (currentRuntime.current.connection.state === "connected" ||
          canRetry(currentRuntime.current.connection.state)) &&
        verification.current?.revision !== revision.current
      )
        setRetry((value) => value + 1);
    };
    window.addEventListener("online", online);
    window.addEventListener("focus", online);
    window.addEventListener("p4deck:auto-refresh", online);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("focus", online);
      window.removeEventListener("p4deck:auto-refresh", online);
    };
  }, []);
  useEffect(() => {
    const snapshot = currentRuntime.current;
    if (
      snapshot.p4Version === "loading" ||
      !snapshot.context.server.trim() ||
      !snapshot.context.user.trim()
    )
      return;
    const recoverable =
      snapshot.connection.state === "connected" ||
      canRetry(snapshot.connection.state);
    if (
      snapshot.connection.state !== "notTested" &&
      !(retry > 0 && recoverable)
    )
      return;
    let live = true;
    const key = `${binding}:${retry}`;
    const expectedRevision = revision.current;
    // Reattach in StrictMode/Fast Refresh. A newer verdict wins, but an
    // unverified revision still needs its own probe, even for the same binding.
    if (
      verification.current?.key === key &&
      verification.current.revision !== expectedRevision &&
      snapshot.connection.state !== "notTested"
    )
      return;
    const active = () =>
      verification.current?.key === key &&
      revision.current === expectedRevision &&
      currentRuntime.current.contextGeneration === snapshot.contextGeneration &&
      currentRuntime.current.activeProfileId === snapshot.activeProfileId &&
      sameOperationalContext(currentRuntime.current.context, snapshot.context);
    if (
      verification.current?.key !== key ||
      verification.current.revision !== expectedRevision
    ) {
      const probe = (async () => {
        if (navigator.onLine === false)
          return {
            state: "networkError" as const,
            errorCode: "networkError" as const,
            message:
              "Offline. The active connection will be checked when the network returns.",
            recovery: "retry" as const,
            server: snapshot.context.server,
          };
        // runtimeInfo already discovered the CLI; don't launch another p4 -V.
        const status = await backend.testConnection(snapshot.context);
        if (!active()) return;
        return status.state === "connected"
          ? backend.queryLoginStatus(snapshot.context)
          : status;
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<ConnectionStatus>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              state: "networkError",
              errorCode: "networkError",
              message:
                "The automatic connection and login check timed out. Retry or check connection settings.",
              recovery: "retry",
              server: snapshot.context.server,
            }),
          CONNECTION_CHECK_TIMEOUT_MS,
        );
      });
      const promise = Promise.race([probe, deadline]).finally(() =>
        clearTimeout(timer),
      );
      verification.current = { key, revision: expectedRevision, promise };
    }
    setChecking(key);
    void verification.current.promise
      .then((status) => {
        if (!live || !active() || !status) return;
        applyConnection(snapshot.context, status, snapshot.p4Version);
        performance.mark("p4deck:connection-checked");
      })
      .catch(() => {
        if (!live || !active()) return;
        applyConnection(snapshot.context, {
          state: "networkError",
          errorCode: "networkError",
          message:
            "The automatic connection check could not complete. Check the network or connection settings.",
          recovery: "retry",
          server: snapshot.context.server,
        });
      })
      .finally(() => {
        if (live) setChecking((value) => (value === key ? undefined : value));
      });
    return () => {
      live = false;
    };
  }, [binding, runtime, retry, applyConnection]);
  return {
    runtime,
    applyRuntime,
    applyConnection,
    error,
    checkingConnection:
      !!checking &&
      checking === `${binding}:${retry}` &&
      verification.current?.revision === revision.current &&
      runtime.connection.state !== "connected",
    connectionKey: `${viewGeneration}:${runtime.contextGeneration}:${runtime.activeProfileId ?? "environment"}:${JSON.stringify(runtime.context)}`,
  };
}
