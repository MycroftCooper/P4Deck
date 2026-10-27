import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { backend, tokenize } from "../../infrastructure/backend";
import type {
  OperationEvent,
  OperationResult,
  P4Context,
} from "../../shared/contracts/types";
import type { messages } from "../../shared/i18n";
import { storage } from "../../shared/lib/storage";
import { subscribeSafely } from "../../shared/lib/subscription";
import { ToolDrawer, type ToolTab } from "./components/ToolDrawer";
import { readToolTab } from "./terminalPreferences";

export type { ToolTab } from "./components/ToolDrawer";
export interface ToolHandle {
  open(tab: ToolTab, operationId?: string): void;
  afterOperation(warnings: string[]): Promise<void>;
}
interface Props {
  t: (typeof messages)[keyof typeof messages];
  zh: boolean;
  native: boolean;
  connectionKey: string;
  context: P4Context;
  onOpenChange(open: boolean): void;
  onOpenSettings(): void;
}

export const ToolArea = forwardRef<ToolHandle, Props>(function ToolArea(
  { t, zh, native, connectionKey, context, onOpenChange, onOpenSettings },
  ref,
) {
  const [open, setOpen] = useState(
    () => storage.getItem("p4deck.toolOpen") === "true",
  );
  const [active, setActive] = useState<ToolTab>(() =>
    readToolTab(storage.getItem("p4deck.toolTab")),
  );
  const [operationFilter, setOperationFilter] = useState<string>();
  const [journalOperation, setJournalOperation] = useState<string>();
  const [unread, setUnread] = useState(0);
  const [events, setEvents] = useState<OperationEvent[]>([]);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const openRef = useRef(open);
  const activeRef = useRef(active);
  const seenAlerts = useRef(new Set<string>());
  openRef.current = open;
  activeRef.current = active;

  useEffect(() => {
    storage.setItem("p4deck.toolOpen", String(open));
    onOpenChange(open);
  }, [open, onOpenChange]);
  useEffect(() => {
    storage.setItem("p4deck.toolTab", active);
  }, [active]);

  useEffect(() => {
    seenAlerts.current.clear();
    setOperationFilter(undefined);
    setJournalOperation(undefined);
    setUnread(0);
    setEvents([]);
    setError("");
    setRefreshKey((value) => value + 1);
  }, [connectionKey]);

  useEffect(() => {
    let live = true;
    const stopOperations = subscribeSafely(
      () =>
        backend.subscribeOperationEvents((event) => {
          if (live) setEvents((current) => [...current.slice(-999), event]);
        }),
      (cause) => setError(String(cause)),
    );
    const stopAlerts = subscribeSafely(
      () =>
        backend.subscribeDiagnosticAlerts((alert) => {
          if (!live) return;
          const key = `${alert.operationId}:${alert.level}`;
          if (seenAlerts.current.has(key)) return;
          seenAlerts.current.add(key);
          if (seenAlerts.current.size > 256) {
            const oldest = seenAlerts.current.values().next().value;
            if (oldest) seenAlerts.current.delete(oldest);
          }
          const logsVisible = openRef.current && activeRef.current === "logs";
          if (logsVisible) setRefreshKey((value) => value + 1);
          else if (alert.level === "error") setUnread((value) => value + 1);
        }),
      (cause) => setError(String(cause)),
    );
    const stopCleared = subscribeSafely(
      () =>
        backend.subscribeLogsCleared(() => {
          if (!live) return;
          seenAlerts.current.clear();
          setUnread(0);
        }),
      (cause) => setError(String(cause)),
    );
    return () => {
      live = false;
      stopOperations();
      stopAlerts();
      stopCleared();
    };
  }, []);

  const show = useCallback((tab: ToolTab, operationId?: string) => {
    if (tab === "logs") {
      setOperationFilter(operationId);
      setUnread(0);
      setRefreshKey((value) => value + 1);
    }
    if (tab === "journal") setJournalOperation(operationId);
    setActive(tab);
    setOpen(true);
  }, []);
  const handleOpenChange = useCallback((value: boolean) => {
    setOpen(value);
    if (value && activeRef.current === "logs") {
      setUnread(0);
      setRefreshKey((current) => current + 1);
    }
  }, []);

  useImperativeHandle(ref, () => ({
    open: show,
    async afterOperation(_warnings) {
      setRefreshKey((value) => value + 1);
    },
  }));

  async function run(
    input: string,
    operationId: string,
  ): Promise<OperationResult> {
    const args = tokenize(input);
    if (args[0]?.toLowerCase() === "p4") args.shift();
    const result = await backend.runP4({
      operationId,
      source: "terminal",
      command: args.shift() ?? "help",
      args,
      context,
      outputMode: "text",
      timeoutMs: 120_000,
    });
    setRefreshKey((value) => value + 1);
    return result;
  }

  return (
    <>
      <ToolDrawer
        t={t}
        zh={zh}
        native={native}
        connectionKey={connectionKey}
        logRefreshKey={refreshKey}
        open={open}
        active={active}
        operationFilter={operationFilter}
        journalOperation={journalOperation}
        onOperationFilter={setOperationFilter}
        onJournalOperation={setJournalOperation}
        unread={unread}
        context={context}
        operationEvents={events}
        onOpenChange={handleOpenChange}
        onActiveChange={show}
        onRun={run}
        onCancel={(id) => {
          void backend
            .cancelOperation(id)
            .catch((cause) => setError(String(cause)));
        }}
        onOpenSettings={onOpenSettings}
      />
      {error && (
        <div className="tool-error" role="alert">
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      )}
    </>
  );
});
