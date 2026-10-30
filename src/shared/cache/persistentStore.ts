/**
 * Best-effort disk copy of selected snapshots. It only speeds up display after
 * a restart; writes always go through the backend, which validates P4 state.
 */
const DB_NAME = "p4deck-cache";
const STORE = "entries";
const SCHEMA = 1;

export interface PersistedEntry {
  schema: number;
  updatedAt: number;
  data: unknown;
}

let database: Promise<IDBDatabase | undefined> | undefined;

/** Without IndexedDB (unit tests, locked-down profiles) snapshots stay in memory. */
export function persistenceAvailable() {
  return typeof indexedDB !== "undefined";
}

function openDatabase() {
  if (!persistenceAvailable()) return Promise.resolve(undefined);
  return (database ??= new Promise((resolve) => {
    try {
      // Remove the first Pending-only prototype store.
      indexedDB.deleteDatabase("p4deck-pending-v1");
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

export async function readPersisted(
  id: string,
): Promise<PersistedEntry | undefined> {
  const queued = pending.get(id);
  if (queued) return queued;
  try {
    const db = await openDatabase();
    if (!db) return undefined;
    return await new Promise((resolve) => {
      const request = db.transaction(STORE).objectStore(STORE).get(id);
      request.onsuccess = () => {
        const entry = request.result as PersistedEntry | undefined;
        resolve(
          entry?.schema === SCHEMA && Number.isFinite(entry.updatedAt)
            ? entry
            : undefined,
        );
      };
      request.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

const pending = new Map<string, PersistedEntry>();
let scheduled = false;
let writing: Promise<void> | undefined;

/** Coalesces writes and clones them when the UI is idle. */
export function writePersisted(id: string, updatedAt: number, data: unknown) {
  if (!persistenceAvailable()) return;
  pending.set(id, { schema: SCHEMA, updatedAt, data });
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    scheduled = false;
    void flushPersisted();
  };
  if (typeof requestIdleCallback === "function")
    requestIdleCallback(run, { timeout: 2_000 });
  else setTimeout(run, 200);
}

/** Flush now, without waiting for an idle callback; serialize overlapping writes. */
export function flushPersisted(): Promise<void> {
  if (writing) return writing;
  if (!pending.size) return Promise.resolve();
  writing = (async () => {
    while (pending.size) await flush();
  })().finally(() => {
    writing = undefined;
  });
  return writing;
}

async function flush() {
  const entries = [...pending];
  pending.clear();
  if (!entries.length) return;
  try {
    const db = await openDatabase();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      for (const [id, entry] of entries) store.put(entry, id);
      transaction.oncomplete =
        transaction.onerror =
        transaction.onabort =
          () => resolve();
    });
  } catch {
    /* The in-memory snapshot remains authoritative for this session. */
  }
}

// Best effort before a reload/close; normal writes are still saved while idle.
if (typeof window !== "undefined") {
  const flushNow = () => void flushPersisted();
  const hidden = () => {
    if (document.visibilityState === "hidden") flushNow();
  };
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", hidden);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("pagehide", flushNow);
    document.removeEventListener("visibilitychange", hidden);
    flushNow();
  });
}

/** Mark matching display snapshots stale without loading or querying their workspace. */
export async function invalidatePersisted(matches: (id: string) => boolean) {
  for (const [id, entry] of pending)
    if (matches(id)) pending.set(id, { ...entry, updatedAt: 0 });
  await flushPersisted();
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const cursor = tx.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      if (typeof c.key === "string" && matches(c.key))
        c.update({ ...c.value, updatedAt: 0 });
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(Error("Snapshot invalidation failed"));
  });
}
