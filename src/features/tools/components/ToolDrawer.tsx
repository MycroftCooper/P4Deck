import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Ban,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Eraser,
  Play,
  TerminalSquare,
  Wrench,
  ListChecks,
} from "lucide-react";
import type {
  OperationEvent,
  OperationResult,
  P4Context,
} from "../../../shared/contracts/types";
import type { messages } from "../../../shared/i18n";
import { storage } from "../../../shared/lib/storage";
import { tokenize } from "../../../shared/lib/tokenize";
import { readTerminalHistory, readToolHeight } from "../terminalPreferences";
import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { action, copy } from "../../../app/context-menu/bindings";
import { useFullTextSelection } from "../../../app/context-menu/FullTextSelection";
import { readClipboardText } from "../../../infrastructure/clipboard";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { useDialogRequest } from "../../../app/dialogs/useDialogRequest";
import { LogView } from "./LogView";
import { OperationJournalView } from "./OperationJournalView";
import { DiagnosticsView } from "./DiagnosticsView";
import { inspectTerminalCommand } from "../terminalSecurity";

export type ToolTab = "terminal" | "logs" | "journal" | "diagnostics";
type CopyText = (typeof messages)[keyof typeof messages];

interface Props {
  t: CopyText;
  zh: boolean;
  native: boolean;
  connectionKey: string;
  logRefreshKey: number;
  open: boolean;
  active: ToolTab;
  operationFilter?: string;
  journalOperation?: string;
  unread: number;
  context: P4Context;
  operationEvents: OperationEvent[];
  onOpenChange(open: boolean): void;
  onActiveChange(tab: ToolTab, operationId?: string): void;
  onOperationFilter(id?: string): void;
  onJournalOperation(id?: string): void;
  onRun(input: string, operationId: string): Promise<OperationResult>;
  onCancel(operationId: string): void;
  onOpenSettings(): void;
  embedded?: boolean;
  visibleTabs?: ToolTab[];
}

export function ToolDrawer(props: Props) {
  const pasteDialog = useDialogRequest<
    { text: string; source: HTMLElement | null },
    string
  >(JSON.stringify(props.context));
  const menu = useContextMenu();
  const textSelection = useFullTextSelection();
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<string[]>([
    "P4Deck controlled terminal — only p4 commands are allowed.",
  ]);
  const [running, setRunning] = useState<string | null>(null);
  const [credentialBlocked, setCredentialBlocked] = useState(false);
  const [height, setHeight] = useState(() =>
    readToolHeight(storage.getItem("p4deck.toolHeight")),
  );
  const historyRef = useRef<string[]>(
    readTerminalHistory(storage.getItem("p4deck.terminalHistory")),
  );
  const historyIndex = useRef(-1);
  const streamedCount = useRef(0);
  const terminalGeneration = useRef(0);
  const runningRef = useRef<string | null>(null);
  const terminalConnection = useRef(props.connectionKey);
  runningRef.current = running;

  useEffect(
    () => storage.setItem("p4deck.toolHeight", String(height)),
    [height],
  );
  useEffect(() => {
    // Rewrite legacy history after read-time filtering so older sensitive entries
    // do not remain in browser storage.
    storage.setItem(
      "p4deck.terminalHistory",
      JSON.stringify(historyRef.current),
    );
  }, []);
  useEffect(() => {
    if (terminalConnection.current === props.connectionKey) return;
    terminalConnection.current = props.connectionKey;
    const operation = runningRef.current;
    terminalGeneration.current += 1;
    if (operation) props.onCancel(operation);
    setRunning(null);
    setInput("");
    setCredentialBlocked(false);
    setLines([
      "P4Deck controlled terminal — connection context changed; previous output was cleared.",
    ]);
    streamedCount.current = 0;
  }, [props.connectionKey]);
  useEffect(
    () => () => {
      terminalGeneration.current += 1;
      const operation = runningRef.current;
      if (operation) props.onCancel(operation);
    },
    [],
  );
  useEffect(() => {
    if (!running) return;
    const matching = props.operationEvents.filter(
      (event) =>
        event.operationId === running &&
        ["stdout", "stderr", "warning", "error"].includes(event.type),
    );
    const fresh = matching
      .slice(streamedCount.current)
      .map((event) => event.message ?? "");
    if (fresh.length) setLines((value) => [...value, ...fresh]);
    streamedCount.current = matching.length;
  }, [props.operationEvents, running]);

  async function execute() {
    const generation = terminalGeneration.current;
    const raw = input.trim();
    if (!raw || running) return;
    const parts = tokenize(raw);
    const decision = inspectTerminalCommand(raw, parts);
    if (!parts.length) return;
    setLines((value) => [...value, `p4> ${decision.display}`]);
    setInput("");
    if (decision.blocked) {
      setCredentialBlocked(decision.reason === "credential");
      setLines((value) => [
        ...value,
        props.zh
          ? decision.reason === "lockWorkflow"
            ? "Lock/Unlock 不能从 Terminal 执行；请使用文件工具栏或右键菜单的预检工作流。"
            : "安全策略已阻止该命令。请在设置 > 连接中使用受控的 Trust、登录或退出流程。"
          : decision.reason === "lockWorkflow"
            ? "Lock/Unlock cannot run from Terminal; use the file toolbar or context-menu preflight workflow."
            : "Security policy blocked this command. Use the controlled Trust, Login or Logout flow in Settings > Connections.",
      ]);
      return;
    }
    setCredentialBlocked(false);
    const temporaryId = crypto.randomUUID();
    streamedCount.current = 0;
    setRunning(temporaryId);
    try {
      const result = await props.onRun(raw, temporaryId);
      if (generation !== terminalGeneration.current) return;
      if (!decision.sensitive) rememberHistory(raw);
      setRunning(result.operationId);
      const output = streamedCount.current
        ? []
        : result.events
            .filter((event) =>
              ["stdout", "stderr", "warning", "error"].includes(event.type),
            )
            .map((event) => event.message ?? "");
      setLines((value) => [
        ...value,
        ...output,
        `[exit ${result.exitCode} · ${result.durationMs}ms]`,
      ]);
    } catch (error) {
      if (generation !== terminalGeneration.current) return;
      const message = String(error);
      const controlled = message.includes(
        "use Settings > Connection authentication",
      );
      if (controlled) setCredentialBlocked(true);
      if (!decision.sensitive && !controlled) rememberHistory(raw);
      setLines((value) => [
        ...value,
        controlled
          ? props.zh
            ? "安全策略已阻止该命令。请在设置 > 连接中使用受控认证流程。"
            : "Security policy blocked this command. Use controlled authentication in Settings > Connections."
          : props.zh
            ? "error: 命令未返回安全结果；请查看已脱敏的 P4 Log。"
            : "error: The command returned no safe result; inspect the redacted P4 Log.",
      ]);
    } finally {
      if (generation === terminalGeneration.current) setRunning(null);
    }
  }

  function rememberHistory(raw: string) {
    historyRef.current = [
      raw,
      ...historyRef.current.filter((item) => item !== raw),
    ].slice(0, 500);
    storage.setItem(
      "p4deck.terminalHistory",
      JSON.stringify(historyRef.current),
    );
  }

  function history(direction: number) {
    const next = Math.max(
      -1,
      Math.min(historyRef.current.length - 1, historyIndex.current + direction),
    );
    historyIndex.current = next;
    setInput(next < 0 ? "" : historyRef.current[next]);
  }

  const tabs: Array<{ id: ToolTab; label: string; icon: ReactNode }> = [
    {
      id: "terminal",
      label: props.t.terminal,
      icon: <TerminalSquare size={14} />,
    },
    { id: "logs", label: props.t.logs, icon: <CircleAlert size={14} /> },
    {
      id: "journal",
      label: props.zh ? "操作" : "Operations",
      icon: <ListChecks size={14} />,
    },
    {
      id: "diagnostics",
      label: props.zh ? "诊断" : "Diagnostics",
      icon: <Wrench size={14} />,
    },
  ];

  return (
    <section
      className={`tool-drawer ${props.embedded ? "embedded" : ""} ${props.open ? "expanded" : "collapsed"}`}
      style={props.open && !props.embedded ? { height } : undefined}
      aria-label={props.zh ? "P4 工具与诊断" : "P4 tools and diagnostics"}
    >
      {props.open && !props.embedded && (
        <div
          className="resize-handle"
          aria-hidden="true"
          onPointerDown={(event) => {
            const startY = event.clientY;
            const startHeight = height;
            const move = (moveEvent: PointerEvent) =>
              setHeight(
                Math.max(
                  180,
                  Math.min(560, startHeight + startY - moveEvent.clientY),
                ),
              );
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
      )}
      <header className="tool-tabs">
        {!props.embedded && (
          <button
            className="drawer-toggle"
            aria-label={props.open ? props.t.close : props.t.openTools}
            onClick={() => props.onOpenChange(!props.open)}
          >
            {props.open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          </button>
        )}
        <div
          className="tool-tab-list"
          role="tablist"
          aria-label={props.zh ? "工具视图" : "Tool views"}
        >
          {tabs
            .filter(
              (tab) => !props.visibleTabs || props.visibleTabs.includes(tab.id),
            )
            .map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={props.active === tab.id}
                className={props.active === tab.id ? "active" : ""}
                onClick={() => props.onActiveChange(tab.id)}
              >
                {tab.icon}
                {tab.label}
                {tab.id === "logs" && props.unread ? (
                  <span
                    className="tool-unread-dot"
                    title={
                      props.zh
                        ? `${props.unread} 个未查看的新错误`
                        : `${props.unread} new unviewed errors`
                    }
                  >
                    <span className="sr-only">
                      {props.zh
                        ? `${props.unread} 个未查看的新错误`
                        : `${props.unread} new unviewed errors`}
                    </span>
                  </span>
                ) : null}
              </button>
            ))}
        </div>
      </header>
      {textSelection.dialog}
      {pasteDialog.request && (
        <Dialog
          title={props.zh ? "粘贴多行文本" : "Paste multiline text"}
          description={
            props.zh
              ? "只填入命令输入框，不自动执行。确认后会替换当前输入。"
              : "Fills the command input only; does not execute. Replaces the current input after confirmation."
          }
          source={pasteDialog.request.source}
          zh={props.zh}
          onRequestClose={() => pasteDialog.answer(null)}
          footer={
            <>
              <button
                data-dialog-autofocus
                onClick={() => pasteDialog.answer(null)}
              >
                {props.zh ? "取消" : "Cancel"}
              </button>
              <button
                onClick={() => pasteDialog.answer(pasteDialog.request!.text)}
              >
                {props.zh ? "仅填入输入框" : "Fill input only"}
              </button>
            </>
          }
        >
          <pre className="workflow-paste-preview">
            {pasteDialog.request.text.slice(0, 5000)}
          </pre>
          {pasteDialog.request.text.length > 5000 && (
            <DialogNotice>
              {props.zh
                ? "此处仅预览前 5,000 字符，确认将填入完整文本。"
                : "Only the first 5,000 characters are previewed; confirmation fills the full text."}
            </DialogNotice>
          )}
        </Dialog>
      )}
      {props.open && props.active === "terminal" && (
        <div className="terminal-view" role="tabpanel">
          <div
            className="terminal-output"
            ref={textSelection.surfaceRef}
            tabIndex={0}
            aria-label={props.zh ? "终端输出" : "Terminal output"}
            {...menu("U01", () => ({
              复制所选文本: copy(textSelection.selectedText()),
              全选: action(() => textSelection.selectAll(lines.join("\n"))),
              清空显示: action(() => setLines([])),
              粘贴: action(async (source) => {
                const text = await readClipboardText();
                const value = /[\r\n]/.test(text)
                  ? await pasteDialog.ask({ text, source: source ?? null })
                  : text;
                if (value !== null) setInput(value);
              }),
            }))}
          >
            {lines.map((line, index) => (
              <div key={`${index}-${line}`}>{line || " "}</div>
            ))}
          </div>
          <div className="terminal-input">
            <span>p4&gt;</span>
            <input
              value={input}
              autoFocus
              placeholder={props.t.commandPlaceholder}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void execute();
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  history(1);
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  history(-1);
                }
              }}
            />
            <button onClick={() => void execute()} disabled={Boolean(running)}>
              <Play size={14} />
              {props.t.run}
            </button>
            {running && (
              <button onClick={() => props.onCancel(running)}>
                <Ban size={14} />
                {props.t.cancel}
              </button>
            )}
            <button onClick={() => setLines([])}>
              <Eraser size={14} />
              {props.t.clear}
            </button>
          </div>
          {credentialBlocked && (
            <div className="terminal-security-notice" role="alert">
              <span>
                {props.zh
                  ? "认证秘密不能通过通用 Terminal 读取或修改。"
                  : "Authentication secrets cannot be read or changed through the generic Terminal."}
              </span>
              <button onClick={props.onOpenSettings}>
                {props.zh ? "打开连接设置" : "Open connection settings"}
              </button>
            </div>
          )}
        </div>
      )}
      {props.open && props.active === "logs" && (
        <LogView
          zh={props.zh}
          connectionKey={props.connectionKey}
          refreshKey={props.logRefreshKey}
          operationFilter={props.operationFilter}
          onOperationFilter={props.onOperationFilter}
          onOpenJournal={(id) => {
            props.onJournalOperation(id);
            props.onActiveChange("journal", id);
          }}
        />
      )}
      {props.open && props.active === "journal" && (
        <OperationJournalView
          zh={props.zh}
          connectionKey={props.connectionKey}
          focusOperationId={props.journalOperation}
          onOpenLogs={(id) => {
            props.onOperationFilter(id);
            props.onActiveChange("logs", id);
          }}
        />
      )}
      {props.open && props.active === "diagnostics" && (
        <DiagnosticsView
          zh={props.zh}
          connectionKey={props.connectionKey}
          native={props.native}
        />
      )}
    </section>
  );
}
