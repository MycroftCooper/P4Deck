import { useCallback, useEffect, useRef, useState } from "react";
import { backend, tokenize } from "../../infrastructure/backend";
import type {
  OperationEvent,
  OperationResult,
  P4Context,
} from "../../shared/contracts";
import type { messages } from "../../shared/i18n";
import { storage } from "../../shared/lib/storage";
import { subscribeSafely } from "../../shared/lib/subscription";
import { ToolDrawer, type ToolTab } from "./components/ToolDrawer";

interface Props {
  kind: "terminal" | "p4log";
  t: (typeof messages)[keyof typeof messages];
  zh: boolean;
  native: boolean;
  connectionKey: string;
  context: P4Context;
  onOpenSettings(): void;
}

export function ToolPanel({
  kind,
  t,
  zh,
  native,
  connectionKey,
  context,
  onOpenSettings,
}: Props) {
  const tabKey = `p4deck.toolPanel.${kind}.tab`;
  const [active, setActive] = useState<ToolTab>(() => {
    const saved = storage.getItem(tabKey) as ToolTab | null;
    return kind === "p4log" &&
      saved &&
      ["logs", "journal", "diagnostics"].includes(saved)
      ? saved
      : kind === "terminal"
        ? "terminal"
        : "logs";
  });
  const filterKey = `p4deck.toolPanel.${kind}.operationFilter`;
  const [operationFilter, setOperationFilter] = useState<string | undefined>(
    () => storage.getItem(filterKey) || undefined,
  );
  const [journalOperation, setJournalOperation] = useState<string>();
  const [events, setEvents] = useState<OperationEvent[]>([]);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    if (operationFilter) storage.setItem(filterKey, operationFilter);
    else storage.removeItem(filterKey);
  }, [filterKey, operationFilter]);
  useEffect(() => {
    storage.setItem(tabKey, active);
  }, [active, tabKey]);

  useEffect(() => {
    generation.current += 1;
    setEvents([]);
    setError("");
    setRefreshKey((value) => value + 1);
  }, [connectionKey]);

  useEffect(() => {
    let live = true;
    const stop = subscribeSafely(
      () =>
        backend.subscribeOperationEvents((event) => {
          if (live) setEvents((current) => [...current.slice(-999), event]);
        }),
      (cause) => setError(String(cause)),
    );
    return () => {
      live = false;
      stop();
    };
  }, []);

  const run = useCallback(
    async (input: string, operationId: string): Promise<OperationResult> => {
      const requestGeneration = generation.current;
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
      if (requestGeneration !== generation.current)
        throw new Error(
          "Connection changed while the Terminal command was running.",
        );
      setRefreshKey((value) => value + 1);
      return result;
    },
    [context],
  );

  return (
    <div className="tool-panel-page">
      <ToolDrawer
        embedded
        visibleTabs={
          kind === "terminal"
            ? ["terminal"]
            : ["logs", "journal", "diagnostics"]
        }
        t={t}
        zh={zh}
        native={native}
        connectionKey={connectionKey}
        logRefreshKey={refreshKey}
        open
        active={active}
        operationFilter={operationFilter}
        journalOperation={journalOperation}
        unread={0}
        context={context}
        operationEvents={events}
        onOpenChange={() => undefined}
        onActiveChange={(tab, operationId) => {
          setActive(tab);
          if (tab === "logs") setOperationFilter(operationId);
          if (tab === "journal") setJournalOperation(operationId);
        }}
        onOperationFilter={setOperationFilter}
        onJournalOperation={setJournalOperation}
        onRun={run}
        onCancel={(operationId) => {
          void backend
            .cancelOperation(operationId)
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
    </div>
  );
}
