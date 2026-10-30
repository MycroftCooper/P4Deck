import { useEffect, useMemo, useRef, useState } from "react";
import { useUnsavedEditor } from "../../../app/closeGuard";
import { backend } from "../../../infrastructure/backend";
import type {
  ManualMergeSaveResult,
  ManualMergeSession,
  ManualMergeOpenRequest,
  ManualMergeValidation,
  WorkflowResult,
} from "../../../shared/contracts";
import { DialogNotice } from "../../../app/dialogs/Dialog";
import { publishWorkflowResult } from "../../changelists/workflowRefresh";
import {
  beginMergeIntent,
  lifecycleOf,
  mergeRemaining,
  mergeResolveSucceeded,
  mergeSaveCommitted,
  mergeStepOperationId,
  settleMergeIntent,
  unwrapMergeLegacy,
} from "../../actions/mergeResolveLifecycle";

interface ConflictBlock {
  id: string;
  start: number;
  end: number;
  yours: string;
  theirs: string;
}

const defaultOpenSession = (request: ManualMergeOpenRequest) =>
  backend.openManualMerge(request);
const defaultCancelOperation = (operationId: string) =>
  backend.cancelOperation(operationId);

const blocks = (value: string): ConflictBlock[] => {
  const pattern =
    /<<<<<<< P4DECK YOURS:(\d+)\r?\n([\s\S]*?)======= P4DECK\r?\n([\s\S]*?)>>>>>>> P4DECK THEIRS:\1(?:\r?\n)?/g;
  return [...value.matchAll(pattern)].map((match) => ({
    id: match[1],
    start: match.index,
    end: match.index + match[0].length,
    yours: match[2],
    theirs: match[3],
  }));
};

export const resolveManualMergeBlock = (
  value: string,
  index: number,
  kind: "yours" | "theirs" | "both",
) => {
  const block = blocks(value)[index];
  if (!block) return value;
  const replacement =
    kind === "yours"
      ? block.yours
      : kind === "theirs"
        ? block.theirs
        : `${block.yours}${block.theirs}`;
  return `${value.slice(0, block.start)}${replacement}${value.slice(block.end)}`;
};

export function ManualMergeEditor({
  depotPath,
  connectionKey,
  zh,
  onFinished,
  openSession = defaultOpenSession,
  cancelOperation = defaultCancelOperation,
}: {
  depotPath: string;
  connectionKey: string;
  zh: boolean;
  onFinished?(result: WorkflowResult): void;
  openSession?(
    request: ManualMergeOpenRequest,
  ): Promise<ManualMergeSession | unknown>;
  cancelOperation?(operationId: string): Promise<unknown>;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [session, setSession] = useState<ManualMergeSession>();
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [blockIndex, setBlockIndex] = useState(0);
  const [search, setSearch] = useState("");
  const [searchFrom, setSearchFrom] = useState(0);
  const [validation, setValidation] = useState<ManualMergeValidation>();
  const [saveResult, setSaveResult] = useState<ManualMergeSaveResult>();
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  const epoch = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const operationRoot = useRef(`manual-merge-${Date.now()}-${Math.random()}`);
  const activeConnection = useRef(connectionKey);
  activeConnection.current = connectionKey;
  const result = history[historyIndex] ?? "";
  const [savedBaseline, setSavedBaseline] = useState<string>();
  useUnsavedEditor(
    !session || savedBaseline === undefined
      ? "unknown"
      : result !== savedBaseline
        ? "dirty"
        : "clean",
    `${connectionKey}:${depotPath}`,
    "manualMerge",
  );
  const conflicts = useMemo(() => blocks(result), [result]);
  const current =
    conflicts[Math.min(blockIndex, Math.max(0, conflicts.length - 1))];

  useEffect(() => {
    const currentEpoch = ++epoch.current;
    const currentOperationRoot = `manual-merge-${Date.now()}-${Math.random()}`;
    operationRoot.current = currentOperationRoot;
    setSession(undefined);
    setSavedBaseline(undefined);
    setHistory([]);
    setHistoryIndex(-1);
    setBlockIndex(0);
    setValidation(undefined);
    setSaveResult(undefined);
    setAcknowledge(false);
    setMessage("");
    setBusy(true);
    const openOperationId = mergeStepOperationId(currentOperationRoot, "open");
    beginMergeIntent({
      kind: "manualMergeSession",
      operationId: openOperationId,
      targetKey: connectionKey,
    });
    void openSession({ depotPath, operationId: openOperationId } as never)
      .then((raw: unknown) => {
        settleMergeIntent(openOperationId);
        if (
          currentEpoch !== epoch.current ||
          activeConnection.current !== connectionKey
        )
          return;
        const lifecycle = lifecycleOf(raw);
        if (
          lifecycle &&
          lifecycle.state !== "legacy" &&
          lifecycle.state !== "intent"
        ) {
          // Open is read-only intent: unknown/rejected never shows a usable session.
          setMessage(lifecycle.message);
          return;
        }
        const value =
          unwrapMergeLegacy<ManualMergeSession>(raw) ??
          (raw as ManualMergeSession);
        setSession(value);
        // Yours is the actual disk snapshot; Result may be an unsaved merge.
        setSavedBaseline(value.yours);
        setHistory([value.result]);
        setHistoryIndex(0);
        setMessage("");
      })
      .catch((cause) => {
        settleMergeIntent(openOperationId);
        if (
          currentEpoch === epoch.current &&
          activeConnection.current === connectionKey
        )
          setMessage(String(cause));
      })
      .finally(() => {
        if (
          currentEpoch === epoch.current &&
          activeConnection.current === connectionKey
        )
          setBusy(false);
      });
    return () => {
      ++epoch.current;
      void cancelOperation(currentOperationRoot);
    };
  }, [cancelOperation, connectionKey, depotPath, openSession]);

  const commit = (value: string) => {
    const next = [...history.slice(0, historyIndex + 1), value];
    let retainedCharacters = next.reduce(
      (total, item) => total + item.length,
      0,
    );
    while (next.length > 1 && retainedCharacters > 16 * 1024 * 1024) {
      retainedCharacters -= next.shift()!.length;
    }
    setHistory(next);
    setHistoryIndex(next.length - 1);
    setValidation(undefined);
    setSaveResult(undefined);
    setAcknowledge(false);
  };

  const accept = (kind: "yours" | "theirs" | "both") => {
    if (!current) return;
    commit(resolveManualMergeBlock(result, blockIndex, kind));
    setBlockIndex(Math.min(blockIndex, Math.max(0, conflicts.length - 2)));
  };

  const findNext = () => {
    if (!search || !textarea.current) return;
    let index = result
      .toLocaleLowerCase()
      .indexOf(search.toLocaleLowerCase(), searchFrom);
    if (index < 0)
      index = result.toLocaleLowerCase().indexOf(search.toLocaleLowerCase());
    if (index >= 0) {
      textarea.current.focus();
      textarea.current.setSelectionRange(index, index + search.length);
      setSearchFrom(index + Math.max(1, search.length));
    }
  };

  const navigateBlock = (next: number) => {
    const block = conflicts[next];
    if (!block) return;
    setBlockIndex(next);
    queueMicrotask(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(block.start, block.end);
    });
  };

  const validate = async () => {
    if (!session || busy) return;
    const requestEpoch = epoch.current;
    const requestConnection = connectionKey;
    const operationId = mergeStepOperationId(operationRoot.current, "validate");
    beginMergeIntent({
      kind: "manualMergeSession",
      operationId,
      targetKey: connectionKey,
    });
    setBusy(true);
    setMessage("");
    try {
      const raw: unknown = await backend.validateManualMerge({
        sessionId: session.sessionId,
        result,
        operationId,
      });
      settleMergeIntent(operationId);
      if (
        requestEpoch !== epoch.current ||
        requestConnection !== activeConnection.current
      )
        return;
      const lifecycle = lifecycleOf(raw);
      const value = unwrapMergeLegacy<ManualMergeValidation>(raw);
      if (
        lifecycle &&
        lifecycle.state !== "legacy" &&
        lifecycle.state !== "intent"
      ) {
        // Validate is read-only intent; it may never assert a saved/valid result on unknown.
        setMessage(lifecycle.message);
        return;
      }
      if (!value) {
        setMessage(
          tr("未收到可识别的校验结果", "No recognizable validation result"),
        );
        return;
      }
      setValidation(value);
      setMessage(value.message);
    } catch (cause) {
      settleMergeIntent(operationId);
      if (
        requestEpoch === epoch.current &&
        requestConnection === activeConnection.current
      )
        setMessage(String(cause));
    } finally {
      if (
        requestEpoch === epoch.current &&
        requestConnection === activeConnection.current
      )
        setBusy(false);
    }
  };

  const save = async () => {
    if (!session || !validation?.token || busy) return;
    const requestEpoch = epoch.current;
    const requestConnection = connectionKey;
    const operationId = mergeStepOperationId(operationRoot.current, "save");
    beginMergeIntent({
      kind: "manualMergeSave",
      operationId,
      targetKey: connectionKey,
    });
    setBusy(true);
    setMessage("");
    try {
      const raw: unknown = await backend.confirmManualMergeSave({
        token: validation.token,
        sessionId: session.sessionId,
        resultDigest: validation.resultDigest,
        operationId,
      });
      settleMergeIntent(operationId);
      if (
        requestEpoch !== epoch.current ||
        requestConnection !== activeConnection.current
      )
        return;
      const lifecycle = lifecycleOf(raw);
      const value = unwrapMergeLegacy<ManualMergeSaveResult>(raw);
      if (!value) {
        setMessage(tr("未收到可识别的保存结果", "No recognizable save result"));
        return;
      }
      // Save is local content write: only committed CAS digest may render "saved".
      const committed = lifecycle
        ? mergeSaveCommitted(lifecycle)
        : value.outcome === "succeeded";
      setSaveResult(
        committed
          ? value
          : { ...value, outcome: "unknown", resolveToken: undefined },
      );
      if (committed) setSavedBaseline(result);
      setValidation(undefined);
      setMessage(
        lifecycle && !committed
          ? `${lifecycle.message} · ${tr("本地保存未被权威证实", "local save is not proven")}`
          : value.message,
      );
      if (!lifecycle)
        await publishWorkflowResult(
          {
            outcome: value.outcome,
            message: value.message,
            operationIds: [value.operationId],
            files: [],
            refresh: value.refresh,
          },
          session.target,
          connectionKey,
        );
    } catch (cause) {
      settleMergeIntent(operationId);
      if (
        requestEpoch === epoch.current &&
        requestConnection === activeConnection.current
      ) {
        setValidation(undefined);
        setMessage(String(cause));
      }
    } finally {
      if (
        requestEpoch === epoch.current &&
        requestConnection === activeConnection.current
      )
        setBusy(false);
    }
  };

  const resolve = async () => {
    if (!session || !saveResult?.resolveToken || !acknowledge || busy) return;
    const requestEpoch = epoch.current;
    const requestConnection = connectionKey;
    const operationId = mergeStepOperationId(operationRoot.current, "resolve");
    beginMergeIntent({
      kind: "manualMergeResolve",
      operationId,
      targetKey: connectionKey,
    });
    setBusy(true);
    setMessage("");
    try {
      const raw: unknown = await backend.confirmManualMergeResolve({
        token: saveResult.resolveToken,
        sessionId: session.sessionId,
        resultDigest: saveResult.resultDigest,
        acknowledge: true,
        operationId,
      });
      settleMergeIntent(operationId);
      if (
        requestEpoch !== epoch.current ||
        requestConnection !== activeConnection.current
      )
        return;
      const lifecycle = lifecycleOf(raw);
      const value =
        unwrapMergeLegacy<WorkflowResult>(raw) ?? (raw as WorkflowResult);
      if (
        lifecycle &&
        lifecycle.state !== "legacy" &&
        !mergeResolveSucceeded(lifecycle)
      ) {
        // Partial/unknown must keep remaining conflicts visible; never fake success.
        const remaining = mergeRemaining(lifecycle);
        setMessage(
          `${lifecycle.message}${
            remaining.length
              ? ` · ${tr("仍有未解决/未证实", "still unresolved/unproven")}: ${remaining.map((f) => f.depotPath).join(", ")}`
              : ""
          }`,
        );
        return;
      }
      setMessage(value.message);
      onFinished?.(value);
    } catch (cause) {
      settleMergeIntent(operationId);
      if (
        requestEpoch === epoch.current &&
        requestConnection === activeConnection.current
      )
        setMessage(String(cause));
    } finally {
      if (
        requestEpoch === epoch.current &&
        requestConnection === activeConnection.current
      )
        setBusy(false);
    }
  };

  if (!session)
    return (
      <DialogNotice error={!!message}>
        {message ||
          tr("正在读取权威三方内容…", "Loading authoritative merge inputs…")}
      </DialogNotice>
    );

  return (
    <section
      className="manual-merge"
      aria-label={tr("手工合并编辑器", "Manual merge editor")}
    >
      <div className="workflow-context">
        {session.encoding}
        {session.hadBom ? " + BOM" : ""} · {session.lineEnding} · Base{" "}
        {session.baseSource.depotPath}#{session.baseSource.revision} · Theirs{" "}
        {session.theirsSource.depotPath}#{session.theirsSource.revision}
      </div>
      <div className="manual-merge-toolbar">
        <button disabled={!current || busy} onClick={() => accept("yours")}>
          {tr("采用当前块 Yours", "Accept block Yours")}
        </button>
        <button disabled={!current || busy} onClick={() => accept("theirs")}>
          {tr("采用当前块 Theirs", "Accept block Theirs")}
        </button>
        <button disabled={!current || busy} onClick={() => accept("both")}>
          {tr("采用当前块 Both", "Accept block Both")}
        </button>
        <button
          disabled={blockIndex <= 0}
          onClick={() => navigateBlock(blockIndex - 1)}
        >
          {tr("上一冲突", "Previous conflict")}
        </button>
        <button
          disabled={blockIndex >= conflicts.length - 1}
          onClick={() => navigateBlock(blockIndex + 1)}
        >
          {tr("下一冲突", "Next conflict")}
        </button>
        <span role="status">
          {tr("未解决", "Unresolved")}: {conflicts.length}
        </span>
        <button
          disabled={historyIndex <= 0 || busy}
          onClick={() => {
            setHistoryIndex((value) => value - 1);
            setValidation(undefined);
          }}
        >
          {tr("撤销", "Undo")}
        </button>
        <button
          disabled={historyIndex >= history.length - 1 || busy}
          onClick={() => {
            setHistoryIndex((value) => value + 1);
            setValidation(undefined);
          }}
        >
          {tr("重做", "Redo")}
        </button>
        <label>
          {tr("搜索结果", "Search result")}
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setSearchFrom(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") findNext();
            }}
          />
        </label>
        <button disabled={!search} onClick={findNext}>
          {tr("下一个", "Find next")}
        </button>
      </div>
      <div className="manual-merge-grid">
        {(["base", "theirs", "yours"] as const).map((role) => (
          <label key={role}>
            {role[0].toUpperCase() + role.slice(1)}
            <textarea readOnly value={session[role]} aria-label={role} />
          </label>
        ))}
        <label>
          Result
          <textarea
            ref={textarea}
            value={result}
            aria-label="Result"
            spellCheck={false}
            onChange={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "f"
              ) {
                event.preventDefault();
                (
                  event.currentTarget
                    .closest(".manual-merge")
                    ?.querySelector("input") as HTMLInputElement | null
                )?.focus();
              }
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "z"
              ) {
                event.preventDefault();
                if (event.shiftKey && historyIndex < history.length - 1)
                  setHistoryIndex((value) => value + 1);
                else if (!event.shiftKey && historyIndex > 0)
                  setHistoryIndex((value) => value - 1);
                setValidation(undefined);
              }
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "y"
              ) {
                event.preventDefault();
                if (historyIndex < history.length - 1)
                  setHistoryIndex((value) => value + 1);
                setValidation(undefined);
              }
            }}
          />
        </label>
      </div>
      <div className="manual-merge-actions">
        <button disabled={busy || !!saveResult} onClick={() => void validate()}>
          {tr("验证待保存结果", "Validate result")}
        </button>
        <button
          className="primary"
          disabled={busy || !validation?.valid || !validation.token}
          onClick={() => void save()}
        >
          {tr("确认原子保存", "Confirm atomic save")}
        </button>
        {saveResult?.resolveToken && (
          <>
            <label>
              <input
                type="checkbox"
                checked={acknowledge}
                onChange={(event) => setAcknowledge(event.target.checked)}
              />
              {tr(
                "我确认以已编辑结果标记 Resolve",
                "I confirm marking Resolve with the edited result",
              )}
            </label>
            <button
              className="primary"
              disabled={busy || !acknowledge}
              onClick={() => void resolve()}
            >
              {tr("标记为已解决并复核", "Mark resolved and verify")}
            </button>
          </>
        )}
      </div>
      {saveResult?.backupPath && (
        <p className="workflow-context">
          {tr("可恢复备份", "Recoverable backup")}: {saveResult.backupPath}
        </p>
      )}
      {message && (
        <DialogNotice error={!validation?.valid && !saveResult}>
          {message}
        </DialogNotice>
      )}
    </section>
  );
}

export const manualMergeBlocksForTest = blocks;
