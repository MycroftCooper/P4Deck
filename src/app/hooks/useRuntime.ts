import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { backend } from "../../infrastructure/backend";
import type {
  ConnectionStatus,
  P4Context,
  RuntimeInfo,
} from "../../shared/contracts/types";
import { subscribeSafely } from "../../shared/lib/subscription";

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
  const currentRuntime = useRef(runtime);
  currentRuntime.current = runtime;
  const applyRuntime = useCallback((next: RuntimeInfo) => {
    revision.current++;
    currentRuntime.current = next;
    setRuntime(next);
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
      setViewGeneration((value) => value + 1);
      setRuntime(next);
    },
    [],
  );
  useEffect(() => {
    let live = true;
    const initialRevision = revision.current;
    void backend
      .runtimeInfo()
      .then((value) => {
        if (live && revision.current === initialRevision) {
          currentRuntime.current = value;
          setRuntime(value);
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
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
  return {
    runtime,
    applyRuntime,
    applyConnection,
    error,
    connectionKey: `${viewGeneration}:${runtime.contextGeneration}:${runtime.activeProfileId ?? "environment"}:${JSON.stringify(runtime.context)}`,
  };
}
