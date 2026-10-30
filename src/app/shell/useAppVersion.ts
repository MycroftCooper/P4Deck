import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";

let cached: Promise<string | undefined> | undefined;

/**
 * Real app version from the Tauri `@tauri-apps/api/app` module (never hard-coded).
 * Module-level cache keeps it a single async request across the whole window; the dynamic import
 * keeps the app module out of the browser bundle path until a desktop window actually asks for it.
 * Browser/non-Tauri or a failed lookup resolves to undefined and the status bar simply omits it.
 */
export function loadAppVersion(): Promise<string | undefined> {
  if (!isTauri()) return Promise.resolve(undefined);
  cached ??= import("@tauri-apps/api/app")
    .then((mod) => mod.getVersion())
    .then((version) =>
      typeof version === "string" && version.trim()
        ? version.trim()
        : undefined,
    )
    .catch(() => undefined);
  return cached;
}

export function resetAppVersionCacheForTests() {
  cached = undefined;
}

/** Single request per window; async so the status bar never blocks on it. */
export function useAppVersion(): string | undefined {
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    let alive = true;
    void loadAppVersion().then((value) => {
      if (alive) setVersion(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return version;
}
