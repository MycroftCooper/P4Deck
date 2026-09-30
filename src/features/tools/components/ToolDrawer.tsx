import { storage } from "../../../shared/lib/storage";
import { readTerminalHistory, readToolHeight } from "../terminalPreferences";
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Ban,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  Eraser,
  Play,
  TerminalSquare,
} from "lucide-react";
import type {
  LogEntry,
  OperationEvent,
  OperationResult,
  P4Context,
} from "../../../shared/contracts/types";
import type { messages } from "../../../shared/i18n";
import { tokenize } from "../../../shared/lib/tokenize";

import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { action, copy } from "../../../app/context-menu/bindings";
import { readClipboardText } from "../../../infrastructure/clipboard";
import { useFullTextSelection } from "../../../app/context-menu/FullTextSelection";
import { useRecordSelection } from "../../../app/context-menu/useRecordSelection";
import { Dialog, DialogNotice } from "../../../app/dialogs/Dialog";
import { useDialogRequest } from "../../../app/dialogs/useDialogRequest";
type CopyText = (typeof messages)[keyof typeof messages];

interface Props {
  t: CopyText;
  open: boolean;
  active: "terminal" | "logs";
  logs: LogEntry[];
  operationFilter?: string;
  onOperationFilter(id?: string): void;
  unread: number;
  context: P4Context;
  operationEvents: OperationEvent[];
  onOpenChange(open: boolean): void;
  onActiveChange(tab: "terminal" | "logs"): void;
  onRun(input: string, operationId: string): Promise<OperationResult>;
  onCancel(operationId: string): void;
  onRefreshLogs(): Promise<unknown>;
}

export function ToolDrawer(props: Props) {
  const pasteDialog = useDialogRequest<
    { text: string; source: HTMLElement | null },
    string
  >(JSON.stringify(props.context));
  const zh = props.t.files === "文件";
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<string[]>([
    "P4Deck controlled terminal — only p4 commands are allowed.",
  ]);
  const [running, setRunning] = useState<string | null>(null);
  const [height, setHeight] = useState(() =>
    readToolHeight(storage.getItem("p4deck.toolHeight")),
  );
  const historyRef = useRef<string[]>(
    readTerminalHistory(storage.getItem("p4deck.terminalHistory")),
  );
  const historyIndex = useRef(-1);
  const logScrollRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const textSelection = useFullTextSelection();
  const [hiddenLogs, setHiddenLogs] = useState<Set<string>>(new Set());
  const displayedLogs = props.logs.filter((log) => !hiddenLogs.has(log.id));
  const selection = useRecordSelection(
    displayedLogs,
    (log) => log.id,
    JSON.stringify(props.context),
  );
  const logVirtualizer = useVirtualizer({
    count: displayedLogs.length,
    getScrollElement: () => logScrollRef.current,
    estimateSize: () => 45,
    overscan: 8,
  });

  useEffect(
    () => storage.setItem("p4deck.toolHeight", String(height)),
    [height],
  );
  const streamedCount = useRef(0);
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
    const raw = input.trim();
    if (!raw || running) return;
    const parts = tokenize(raw);
    if (parts[0]?.toLowerCase() === "p4") parts.shift();
    if (!parts.length) return;
    const sensitive = parts.some(
      (part) =>
        ["login", "passwd"].includes(part.toLowerCase()) || part === "-P",
    );
    if (!sensitive) {
      historyRef.current = [
        raw,
        ...historyRef.current.filter((item) => item !== raw),
      ].slice(0, 500);
      storage.setItem(
        "p4deck.terminalHistory",
        JSON.stringify(historyRef.current),
      );
    }
    setLines((value) => [...value, `p4> ${raw}`]);
    setInput("");
    const temporaryId = crypto.randomUUID();
    streamedCount.current = 0;
    setRunning(temporaryId);
    try {
      const result = await props.onRun(raw, temporaryId);
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
      setLines((value) => [...value, `error: ${String(error)}`]);
    } finally {
      setRunning(null);
    }
  }

  function history(direction: number) {
    const next = Math.max(
      -1,
      Math.min(historyRef.current.length - 1, historyIndex.current + direction),
    );
    historyIndex.current = next;
    setInput(next < 0 ? "" : historyRef.current[next]);
  }

  return (
    <section
      className={`tool-drawer ${props.open ? "expanded" : "collapsed"}`}
      style={props.open ? { height } : undefined}
      aria-label="P4 tools"
    >
      {props.open ? (
        <div
          className="resize-handle"
          onPointerDown={(event) => {
            const startY = event.clientY,
              startHeight = height;
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
      ) : null}
      <header
        className="tool-tabs"
        tabIndex={0}
        {...menu("T06", () => ({
          "折叠/展开工具栏": action(() => props.onOpenChange(!props.open)),
          切到命令行: action(() => props.onActiveChange("terminal")),
          切到日志: action(() => props.onActiveChange("logs")),
        }))}
      >
        <button
          className="drawer-toggle"
          aria-label={props.open ? props.t.close : props.t.openTools}
          onClick={() => props.onOpenChange(!props.open)}
        >
          {props.open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
        <button
          className={props.active === "terminal" ? "active" : ""}
          onClick={() => props.onActiveChange("terminal")}
        >
          <TerminalSquare size={14} />
          {props.t.terminal}
        </button>
        <button
          className={props.active === "logs" ? "active" : ""}
          onClick={() => props.onActiveChange("logs")}
        >
          <CircleAlert size={14} />
          {props.t.logs}
          {props.unread ? <b>{props.unread}</b> : null}
        </button>
      </header>
      {textSelection.dialog}
      {pasteDialog.request && (
        <Dialog
          title={zh ? "粘贴多行文本" : "Paste multiline text"}
          description={
            zh
              ? "只填入命令输入框，不自动执行。确认后会替换当前输入。"
              : "Fills the command input only; does not execute. Replaces the current input after confirmation."
          }
          source={pasteDialog.request.source}
          zh={zh}
          onRequestClose={() => pasteDialog.answer(null)}
          footer={
            <>
              <button
                data-dialog-autofocus
                onClick={() => pasteDialog.answer(null)}
              >
                {zh ? "取消" : "Cancel"}
              </button>
              <button
                onClick={() => pasteDialog.answer(pasteDialog.request!.text)}
              >
                {zh ? "仅填入输入框" : "Fill input only"}
              </button>
            </>
          }
        >
          <pre className="workflow-paste-preview">
            {pasteDialog.request.text.slice(0, 5000)}
          </pre>
          {pasteDialog.request.text.length > 5000 && (
            <DialogNotice>
              {zh
                ? "此处仅预览前 5,000 字符，确认将填入完整文本。"
                : "Only the first 5,000 characters are previewed; confirmation fills the full text."}
            </DialogNotice>
          )}
        </Dialog>
      )}
      {props.open && props.active === "terminal" ? (
        <div className="terminal-view">
          <div
            className="terminal-output"
            ref={textSelection.surfaceRef}
            tabIndex={0}
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
            {running ? (
              <button onClick={() => props.onCancel(running)}>
                <Ban size={14} />
                {props.t.cancel}
              </button>
            ) : null}
            <button onClick={() => setLines([])}>
              <Eraser size={14} />
              {props.t.clear}
            </button>
          </div>
        </div>
      ) : props.open ? (
        <div
          ref={logScrollRef}
          className="log-scroll"
          tabIndex={0}
          {...menu("U04", () => ({
            刷新: action(async () => {
              setHiddenLogs(new Set());
              await props.onRefreshLogs();
            }),
            全选当前筛选结果: action(selection.all),
            清除选择: action(selection.clear),
            清空显示: action(() =>
              setHiddenLogs(new Set(props.logs.map((log) => log.id))),
            ),
          }))}
        >
          {props.operationFilter && (
            <div className="log-filter">
              {props.operationFilter}
              <button onClick={() => props.onOperationFilter(undefined)}>
                清除筛选 / Clear filter
              </button>
            </div>
          )}
          {!displayedLogs.length ? (
            <div className="empty-state">{props.t.noLogs}</div>
          ) : null}
          <div
            className="virtual-spacer"
            style={{ height: logVirtualizer.getTotalSize() }}
          >
            {logVirtualizer.getVirtualItems().map((row) => {
              const log = displayedLogs[row.index];
              return (
                <div
                  key={log.id}
                  className={`log-row ${log.level} ${selection.isSelected(log) ? "selected" : ""}`}
                  tabIndex={0}
                  onKeyDownCapture={(event) => selection.keyboard(log, event)}
                  onClick={(event) => selection.select(log, event)}
                  {...menu(
                    selection.targets(log).length > 1 ? "U03" : "U02",
                    () => ({
                      按此操作筛选: action(() =>
                        props.onOperationFilter(log.operationId),
                      ),
                      复制消息: copy(log.message),
                      复制详细信息: copy(
                        `${log.timestamp}\n${log.command}\n${log.message}`,
                      ),
                      复制所选日志: copy(
                        selection
                          .targets(log)
                          .map(
                            (value) =>
                              `${value.timestamp}\n${value.command}\n${value.message}`,
                          )
                          .join("\n\n"),
                      ),
                    }),
                    { onOpen: () => selection.context(log) },
                  )}
                  style={{
                    transform: `translateY(${row.start}px)`,
                    height: row.size,
                  }}
                >
                  <time>{new Date(log.timestamp).toLocaleTimeString()}</time>
                  <strong>{log.level.toUpperCase()}</strong>
                  <code>{log.command}</code>
                  <span>{log.message}</span>
                  {log.repeatCount > 1 ? <b>×{log.repeatCount}</b> : null}
                  <button
                    aria-label="Copy"
                    onClick={() =>
                      navigator.clipboard.writeText(
                        `${log.command}\n${log.message}`,
                      )
                    }
                  >
                    <Copy size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
