import { t } from "../../../shared/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useUnsavedEditor } from "../../../app/closeGuard";
import { backend } from "../../../infrastructure/backend";
import { messages } from "../../../shared/i18n";
import type {
  ExternalMergeToolInfo,
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
  const copy = messages[zh ? "zh-CN" : "en-US"];
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
  const [externalTool, setExternalTool] = useState<ExternalMergeToolInfo>();
  const [externalBusy, setExternalBusy] = useState(false);
  const [externalNotice, setExternalNotice] = useState<{
    text: string;
    error: boolean;
  }>();
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
    setExternalTool(undefined);
    setExternalBusy(false);
    setExternalNotice(undefined);
    setBusy(true);
    // Detection only inspects the filesystem; it never starts P4Merge.
    void backend
      .detectExternalMergeTool()
      .then((info) => {
        if (
          currentEpoch === epoch.current &&
          activeConnection.current === connectionKey
        )
          setExternalTool(info);
      })
      .catch(() => {
        if (
          currentEpoch === epoch.current &&
          activeConnection.current === connectionKey
        )
          setExternalTool({ available: false });
      });
    const openOperationId = crypto.randomUUID();
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
    if (!session || busy || externalBusy) return;
    const requestEpoch = epoch.current;
    const requestConnection = connectionKey;
    const operationId = crypto.randomUUID();
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
        setMessage(t("files.no.recognizable.validation.result"));
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
    if (!session || !validation?.token || busy || externalBusy) return;
    const requestEpoch = epoch.current;
    const requestConnection = connectionKey;
    const operationId = crypto.randomUUID();
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
        setMessage(t("files.no.recognizable.save.result"));
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
          ? `${lifecycle.message} · ${t("files.local.save.is.not.proven")}`
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
    if (
      !session ||
      !saveResult?.resolveToken ||
      !acknowledge ||
      busy ||
      externalBusy
    )
      return;
    const requestEpoch = epoch.current;
    const requestConnection = connectionKey;
    const operationId = crypto.randomUUID();
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
              ? ` · ${t("files.still.unresolved.unproven")}: ${remaining.map((f) => f.depotPath).join(", ")}`
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

  const runExternalMergeTool = async () => {
    if (!session || busy || externalBusy || !externalTool?.available) return;
    const requestEpoch = epoch.current;
    const requestConnection = connectionKey;
    setExternalBusy(true);
    setExternalNotice({ text: copy.externalMergeRunning, error: false });
    try {
      const value = await backend.runExternalMerge({
        sessionId: session.sessionId,
        result,
      });
      if (
        requestEpoch !== epoch.current ||
        requestConnection !== activeConnection.current
      )
        return;
      // P4Merge only supplies a candidate: fill Result, never validate/save.
      if (value.status === "completed" && value.result !== undefined) {
        commit(value.result);
        setExternalNotice({ text: copy.externalMergeCompleted, error: false });
      } else if (value.status === "unchanged") {
        setExternalNotice({ text: copy.externalMergeUnchanged, error: false });
      } else if (value.status === "timeout") {
        setExternalNotice({
          text: value.reason ?? copy.externalMergeTimeout,
          error: true,
        });
      } else if (value.status === "notInstalled") {
        setExternalNotice({
          text: value.reason ?? copy.externalMergeNotInstalled,
          error: true,
        });
      } else if (value.status === "cancelled") {
        setExternalNotice({
          text: value.reason ?? copy.externalMergeCancelled,
          error: true,
        });
      } else {
        const detail = value.reason ?? copy.externalMergeFailed;
        const exit =
          value.exitCode === undefined ? "" : ` · exit ${value.exitCode}`;
        setExternalNotice({
          text: `${copy.externalMergeFailed}: ${detail}${exit}`,
          error: true,
        });
      }
    } catch (cause) {
      if (
        requestEpoch === epoch.current &&
        requestConnection === activeConnection.current
      )
        setExternalNotice({ text: String(cause), error: true });
    } finally {
      if (
        requestEpoch === epoch.current &&
        requestConnection === activeConnection.current
      )
        setExternalBusy(false);
    }
  };

  if (!session)
    return (
      <DialogNotice error={!!message}>
        {message || t("files.loading.authoritative.merge.inputs")}
      </DialogNotice>
    );

  return (
    <section
      className="manual-merge"
      aria-label={t("files.manual.merge.editor")}
    >
      <div className="workflow-context">
        {session.encoding}
        {session.hadBom ? " + BOM" : ""} · {session.lineEnding} · Base{" "}
        {session.baseSource.depotPath}#{session.baseSource.revision} · Theirs{" "}
        {session.theirsSource.depotPath}#{session.theirsSource.revision}
      </div>
      <div className="manual-merge-toolbar">
        <button
          disabled={!current || busy || externalBusy}
          onClick={() => accept("yours")}
        >
          {t("files.accept.block.yours")}
        </button>
        <button
          disabled={!current || busy || externalBusy}
          onClick={() => accept("theirs")}
        >
          {t("files.accept.block.theirs")}
        </button>
        <button
          disabled={!current || busy || externalBusy}
          onClick={() => accept("both")}
        >
          {t("files.accept.block.both")}
        </button>
        <button
          disabled={blockIndex <= 0}
          onClick={() => navigateBlock(blockIndex - 1)}
        >
          {t("files.previous.conflict")}
        </button>
        <button
          disabled={blockIndex >= conflicts.length - 1}
          onClick={() => navigateBlock(blockIndex + 1)}
        >
          {t("files.next.conflict")}
        </button>
        <span role="status">
          {t("files.unresolved")}: {conflicts.length}
        </span>
        <button
          disabled={historyIndex <= 0 || busy || externalBusy}
          onClick={() => {
            setHistoryIndex((value) => value - 1);
            setValidation(undefined);
          }}
        >
          {t("files.undo")}
        </button>
        <button
          disabled={historyIndex >= history.length - 1 || busy || externalBusy}
          onClick={() => {
            setHistoryIndex((value) => value + 1);
            setValidation(undefined);
          }}
        >
          {t("files.redo")}
        </button>
        <label>
          {t("files.search.result")}
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
          {t("files.find.next")}
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
            readOnly={externalBusy}
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
        <button
          disabled={busy || externalBusy || !externalTool?.available}
          title={
            externalTool?.available
              ? (externalTool.executable ?? copy.externalMerge)
              : (externalTool?.reason ?? copy.externalMergeUnavailable)
          }
          onClick={() => void runExternalMergeTool()}
        >
          {externalBusy ? copy.externalMergeRunning : copy.externalMerge}
        </button>
        {!externalTool && (
          <span className="manual-merge-external-hint">
            {copy.externalMergeDetecting}
          </span>
        )}
        {externalTool && !externalTool.available && (
          <span className="manual-merge-external-hint">
            {externalTool.reason ?? copy.externalMergeUnavailable}
          </span>
        )}
        {externalTool?.available && externalTool.reason && (
          <span className="manual-merge-external-hint">
            {externalTool.reason}
          </span>
        )}
        <button
          disabled={busy || externalBusy || !!saveResult}
          onClick={() => void validate()}
        >
          {t("files.validate.result")}
        </button>
        <button
          className="primary"
          disabled={
            busy || externalBusy || !validation?.valid || !validation.token
          }
          onClick={() => void save()}
        >
          {t("files.confirm.atomic.save")}
        </button>
        {saveResult?.resolveToken && (
          <>
            <label>
              <input
                type="checkbox"
                checked={acknowledge}
                onChange={(event) => setAcknowledge(event.target.checked)}
              />
              {t("files.i.confirm.marking.resolve.with.the")}
            </label>
            <button
              className="primary"
              disabled={busy || externalBusy || !acknowledge}
              onClick={() => void resolve()}
            >
              {t("files.mark.resolved.and.verify")}
            </button>
          </>
        )}
      </div>
      {externalNotice && (
        <DialogNotice error={externalNotice.error}>
          {externalNotice.text}
        </DialogNotice>
      )}
      {saveResult?.backupPath && (
        <p className="workflow-context">
          {t("files.recoverable.backup")}: {saveResult.backupPath}
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
