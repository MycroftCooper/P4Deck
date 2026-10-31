import { useEffect, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { backend } from "../../infrastructure/backend";
import { invalidatePersisted } from "../../shared/cache/persistentStore";
import { appCache } from "../../shared/cache/appCache";
import { subscribeSafely } from "../../shared/lib/subscription";
import type { RuntimeInfo } from "../../shared/contracts";
import { refreshPendingAfterToolExit } from "../changelists/pendingCache";
import { createCustomExitConsumer, type CustomParentExit } from "./customExit";
import type { ConnectionSnapshot } from "./model";
export function matchesExitCache(
  key: readonly unknown[],
  c: ConnectionSnapshot,
) {
  if (
    key[0] !== "snapshot" ||
    key[1] !== "pending" ||
    typeof key[2] !== "string"
  )
    return false;
  try {
    const scope = JSON.parse(key[2]);
    return (
      Array.isArray(scope) &&
      scope[0] === "tauri" &&
      scope[1] === c.profileId &&
      scope[2] === c.server &&
      scope[3] === c.user &&
      scope[4] === c.client
    );
  } catch {
    return false;
  }
}
const receivedExits = new Set<string>();
/** App-level mount, independent of submit dialogs. Popouts invalidate only. */
export function useCustomExitRefresh(
  runtime: RuntimeInfo,
  connectionKey: string,
  report: (event: CustomParentExit | undefined, error: unknown) => void,
) {
  const latest = useRef({ runtime, connectionKey, report });
  latest.current = { runtime, connectionKey, report };
  useEffect(() => {
    if (!isTauri()) return;
    const consumer = createCustomExitConsumer(
      {
        owner: getCurrentWindow().label === "main",
        scope: () => latest.current.connectionKey,
        snapshot: () => backend.companySubmitConnectionSnapshot(),
        invalidate: async (c) => {
          await invalidatePersisted((id) => {
            try {
              return matchesExitCache(JSON.parse(id), c);
            } catch {
              return false;
            }
          });
          await appCache.invalidateQueries({
            predicate: (q) => matchesExitCache(q.queryKey, c),
            refetchType: "none",
          });
        },
        refresh: async (c, current) => {
          const r = latest.current.runtime;
          if (
            r.activeProfileId !== c.profileId ||
            r.context.server !== c.server ||
            r.context.user !== c.user ||
            r.context.client !== c.client ||
            r.connection.state !== "connected"
          )
            return;
          await refreshPendingAfterToolExit(r, current);
        },
        report: (event, error) => latest.current.report(event, error),
      },
      receivedExits,
    );
    const stop = subscribeSafely(
      () =>
        listen<unknown>("custom-submit-parent-exited", (event) => {
          void consumer.receive(event.payload);
        }),
      (error) => latest.current.report(undefined, error),
    );
    return () => {
      consumer.stop();
      stop();
    };
  }, []);
}
