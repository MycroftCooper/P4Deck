import { notifyManager } from "@tanstack/react-query";
import { beforeEach } from "vitest";
import { appCache } from "../shared/cache/appCache";

// Tests flush React work with act(), which drains microtasks but not timers.
// Deliver cached query results on a microtask so they land inside act().
notifyManager.setScheduler(queueMicrotask);

// Views share one process-wide data cache; each test starts without snapshots.
beforeEach(() => {
  appCache.clear();
});
