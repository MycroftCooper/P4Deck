import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionSnapshot } from "./model";
export type SnapshotReader = () => Promise<ConnectionSnapshot>;
type SnapshotState =
  | { scope: string; status: "loading" }
  | { scope: string; status: "ready"; snapshot: ConnectionSnapshot }
  | { scope: string; status: "error" };
function copySnapshot(value: ConnectionSnapshot): ConnectionSnapshot {
  const { profileId, generation, server, user, client } = value;
  // RuntimeInfo's numeric generation is deliberately not accepted/coerced.
  if (
    typeof generation !== "string" ||
    !/^\d+$/.test(generation) ||
    ![profileId, server, user, client].every(
      (v) => typeof v === "string" && v.trim(),
    )
  )
    throw new Error("invalidConnection");
  return Object.freeze({ profileId, generation, server, user, client });
}
/** Independent adapter; its caller must inject the approved no-argument host reader. */
export function useCompanySubmitSnapshot(scope: string, read: SnapshotReader) {
  const [state, setState] = useState<SnapshotState>({
    scope,
    status: "loading",
  });
  const live = useRef(false),
    epoch = useRef(0),
    currentScope = useRef(scope);
  const pending = useRef<{ scope: string; promise: Promise<void> } | undefined>(
    undefined,
  );
  currentScope.current = scope;
  const refresh = useCallback(() => {
    if (!live.current) return Promise.resolve();
    if (pending.current?.scope === scope) return pending.current.promise;
    const ticket = ++epoch.current;
    setState({ scope, status: "loading" });
    const promise = Promise.resolve()
      .then(read)
      .then((value) => {
        const snapshot = copySnapshot(value);
        if (
          live.current &&
          currentScope.current === scope &&
          ticket === epoch.current
        )
          setState({ scope, status: "ready", snapshot });
      })
      .catch(() => {
        if (
          live.current &&
          currentScope.current === scope &&
          ticket === epoch.current
        )
          setState({ scope, status: "error" });
      })
      .finally(() => {
        if (ticket === epoch.current) pending.current = undefined;
      });
    pending.current = { scope, promise };
    return promise;
  }, [scope, read]);
  useEffect(() => {
    live.current = true;
    void refresh();
    return () => {
      live.current = false;
      epoch.current++;
      pending.current = undefined;
    };
  }, [refresh]);
  return {
    state:
      state.scope === scope ? state : { scope, status: "loading" as const },
    refresh,
  };
}
