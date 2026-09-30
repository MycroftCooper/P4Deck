import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ToolDrawer } from "./components/ToolDrawer";
import { backend, tokenize } from "../../infrastructure/backend";
import type {
  LogEntry,
  OperationEvent,
  OperationResult,
  P4Context,
} from "../../shared/contracts/types";
import type { messages } from "../../shared/i18n";
import { storage } from "../../shared/lib/storage";
import { subscribeSafely } from "../../shared/lib/subscription";

export type ToolTab = "terminal" | "logs";
export interface ToolHandle {
  open(tab: ToolTab, operationId?: string): void;
  afterOperation(warnings: string[]): Promise<void>;
}
interface Props {
  t: (typeof messages)[keyof typeof messages];
  context: P4Context;
  onOpenChange(open: boolean): void;
}
export const ToolArea = forwardRef<ToolHandle, Props>(function ToolArea(
  { t, context, onOpenChange },
  ref,
) {
  const [open, setOpen] = useState(
    () => storage.getItem("p4deck.toolOpen") === "true",
  );
  const [active, setActive] = useState<ToolTab>("terminal");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [operationFilter, setOperationFilter] = useState<string>();
  const [unread, setUnread] = useState(0);
  const [events, setEvents] = useState<OperationEvent[]>([]);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    storage.setItem("p4deck.toolOpen", String(open));
    onOpenChange(open);
  }, [open, onOpenChange]);
  useEffect(() => {
    let live = true;
    const stop = subscribeSafely(
      () =>
        backend.subscribeOperationEvents((event) => {
          if (live) setEvents((current) => [...current.slice(-999), event]);
        }),
      (e) => setError(String(e)),
    );
    return () => {
      live = false;
      generation.current++;
      stop();
    };
  }, []);
  const refresh = useCallback(
    async (openOnProblem = true) => {
      const request = ++generation.current;
      try {
        const next = await backend.queryLogs({ limit: 10_000 });
        if (request !== generation.current) return;
        setLogs(next);
        setError("");
        if (
          openOnProblem &&
          next[0] &&
          ["warning", "error"].includes(next[0].level)
        ) {
          if (!open) {
            setOpen(true);
            setActive("logs");
          } else if (active !== "logs") setUnread((n) => n + 1);
        }
      } catch (e) {
        if (request === generation.current) setError(String(e));
      }
    },
    [open, active],
  );
  const show = (tab: ToolTab, operationId?: string) => {
    setOperationFilter(operationId);
    setActive(tab);
    setOpen(true);
    if (tab === "logs") {
      setUnread(0);
      void refresh(false);
    }
  };
  useImperativeHandle(ref, () => ({
    open: show,
    async afterOperation(warnings) {
      await refresh();
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
    await refresh();
    return result;
  }
  return (
    <>
      <ToolDrawer
        t={t}
        open={open}
        active={active}
        logs={logs}
        operationFilter={operationFilter}
        onOperationFilter={setOperationFilter}
        unread={unread}
        context={context}
        operationEvents={events}
        onOpenChange={setOpen}
        onActiveChange={show}
        onRun={run}
        onRefreshLogs={() => refresh(false)}
        onCancel={(id) => {
          void backend.cancelOperation(id).catch((e) => setError(String(e)));
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
