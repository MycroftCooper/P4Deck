import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { backend } from "../../infrastructure/backend";
import type { P4Context, RuntimeInfo } from "../../shared/contracts/types";
import { subscribeSafely } from "../../shared/lib/subscription";

export function useRuntime() {
  const [runtime, setRuntime] = useState<RuntimeInfo>({
    mode: "mock",
    p4Version: "loading",
    context: { server: "…", user: "…", client: "…" },
    connection: {
      state: "notTested",
      message: "Loading connection state.",
      recovery: "retry",
      server: "…",
    },
  });
  const [error, setError] = useState("");
  const revision = useRef(0);
  const applyConnection = useCallback((context: P4Context) => {
    revision.current++;
    setRuntime((current) => ({ ...current, context }));
  }, []);
  useEffect(() => {
    let live = true;
    const initialRevision = revision.current;
    void backend
      .runtimeInfo()
      .then((value) => {
        if (live)
          setRuntime((current) =>
            revision.current === initialRevision
              ? value
              : { ...value, context: current.context },
          );
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    const stop = isTauri()
      ? subscribeSafely(
          () =>
            listen<P4Context>("connection-changed", ({ payload }) =>
              applyConnection(payload),
            ),
          (e) => setError(String(e)),
        )
      : () => undefined;
    return () => {
      live = false;
      stop();
    };
  }, [applyConnection]);
  return {
    runtime,
    applyConnection,
    error,
    connectionKey: JSON.stringify(runtime.context),
  };
}
