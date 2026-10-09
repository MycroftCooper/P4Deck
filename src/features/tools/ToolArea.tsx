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
  LogPolicy,
  OperationEvent,
  OperationResult,
  P4Context,
} from "../../shared/contracts/types";
import type { messages } from "../../shared/i18n";
import { storage } from "../../shared/lib/storage";
import { subscribeSafely } from "../../shared/lib/subscription";
import { ToolDrawer, type ToolTab } from "./components/ToolDrawer";

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
}

const defaultPolicy: LogPolicy = {
  autoExpandWarning: false,
  autoExpandError: true,
  retentionDays: 14,
  maxMib: 50,
};

export const ToolArea = forwardRef<ToolHandle, Props>(function ToolArea(
  { t, zh, native, connectionKey, context, onOpenChange },
  ref,
) {
  const [open, setOpen] = useState(
    () => storage.getItem("p4deck.toolOpen") === "true",
  );
  const [active, setActive] = useState<ToolTab>("terminal");
  const [operationFilter, setOperationFilter] = useState<string>();
  const [journalOperation, setJournalOperation] = useState<string>();
  const [unread, setUnread] = useState(0);
  const [events, setEvents] = useState<OperationEvent[]>([]);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const policy = useRef(defaultPolicy);
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
    let live = true;
    seenAlerts.current.clear();
    setOperationFilter(undefined);
    setJournalOperation(undefined);
    setUnread(0);
    setEvents([]);
    setError("");
    setRefreshKey((value) => value + 1);
    void backend
      .getLogPolicy()
      .then((value) => {
        if (live) policy.current = value;
      })
      .catch((cause) => {
        if (live) setError(String(cause));
      });
    return () => {
      live = false;
    };
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
          const enabled =
            alert.level === "error"
              ? policy.current.autoExpandError
              : policy.current.autoExpandWarning;
          if (!enabled) return;
          setRefreshKey((value) => value + 1);
          if (!openRef.current || activeRef.current !== "logs") {
            setOpen(true);
            setActive("logs");
          }
          setOperationFilter(alert.operationId);
          setUnread(0);
        }),
      (cause) => setError(String(cause)),
    );
    return () => {
      live = false;
      stopOperations();
      stopAlerts();
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
  const handlePolicy = useCallback((value: LogPolicy) => {
    policy.current = value;
  }, []);

  useImperativeHandle(ref, () => ({
    open: show,
    async afterOperation(warnings) {
      setRefreshKey((value) => value + 1);
      if (warnings.length) show("logs");
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
        onPolicy={handlePolicy}
        unread={unread}
        context={context}
        operationEvents={events}
        onOpenChange={setOpen}
        onActiveChange={show}
        onRun={run}
        onCancel={(id) => {
          void backend
            .cancelOperation(id)
            .catch((cause) => setError(String(cause)));
        }}
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
