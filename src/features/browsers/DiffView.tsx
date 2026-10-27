import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  CornerDownLeft,
  Search,
  X,
} from "lucide-react";
import type {
  DiffResult,
  RevisionReference,
  RuntimeInfo,
} from "../../shared/contracts/types";
import { useContextMenu } from "../../app/context-menu/ContextMenu";
import { action, copy } from "../../app/context-menu/bindings";
import { swarmMenuAction } from "../swarm/SwarmAction";
import { buildDiffRows } from "./diffRows";
import {
  findDiffMatches,
  hunkAtRow,
  indexDiffRows,
  type DiffMatch,
  type DiffNavigation,
  type DiffSideName,
} from "./diffNavigation";
import { SplitDiff } from "./SplitDiff";

/** Local display/navigation only. FileReviewPage owns requests and cached results. */
export function DiffView({
  diff,
  path,
  loading,
  error,
  left,
  right,
  onLeftChange,
  onRightChange,
  onRefresh,
  runtime,
  zh,
}: {
  diff?: DiffResult;
  path: string;
  loading: boolean;
  error: string;
  left: RevisionReference;
  right: RevisionReference;
  onLeftChange(value: RevisionReference): void;
  onRightChange(value: RevisionReference): void;
  onRefresh(): void;
  runtime: RuntimeInfo;
  zh: boolean;
}) {
  const rows = useMemo(
    () =>
      buildDiffRows(
        diff?.unified ?? "",
        diff &&
          !diff.partial &&
          !diff.truncated &&
          diff.leftText !== undefined &&
          diff.rightText !== undefined
          ? { left: diff.leftText, right: diff.rightText }
          : undefined,
      ),
    [diff],
  );
  const index = useMemo(() => indexDiffRows(rows), [rows]);
  const [side, setSide] = useState<DiffSideName>("right");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const found = useMemo(
    () => findDiffMatches(rows, deferredQuery),
    [rows, deferredQuery],
  );
  const [matchIndex, setMatchIndex] = useState(0);
  const [activeHunk, setActiveHunk] = useState(-1);
  const [navigation, setNavigation] = useState<DiffNavigation>();
  const [lineNumber, setLineNumber] = useState("");
  const [lineError, setLineError] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const lineInput = useRef<HTMLInputElement>(null);
  const lineErrorId = useId();
  const searchedIdentity = useRef("");
  const menu = useContextMenu();
  const navigate = useCallback(
    (row: number, side: DiffSideName, align: "start" | "center" = "center") => {
      setNavigation((previous) => ({
        row,
        side,
        align,
        sequence: (previous?.sequence ?? 0) + 1,
      }));
    },
    [],
  );
  useEffect(() => {
    const identity = deferredQuery;
    const changed = searchedIdentity.current !== identity;
    searchedIdentity.current = rows.length ? identity : "";
    setActiveHunk((current) => Math.min(current, index.hunks.length - 1));
    if (!changed) {
      // Revalidation preserves search position and scroll; only a new query
      // (or the first loaded text) automatically selects the first match.
      setMatchIndex((current) =>
        Math.min(current, Math.max(0, found.matches.length - 1)),
      );
      return;
    }
    setMatchIndex(0);
    const first = found.matches[0];
    if (first) {
      navigate(first.row, first.side === "both" ? "right" : first.side);
      setActiveHunk(hunkAtRow(index.hunks, first.row));
    }
  }, [found, deferredQuery, rows.length, index, navigate]);
  const matchesByRow = useMemo(() => {
    const byRow = new Map<number, DiffMatch[]>();
    for (const match of found.matches) {
      const group = byRow.get(match.row);
      if (group) group.push(match);
      else byRow.set(match.row, [match]);
    }
    return byRow;
  }, [found]);
  const jumpHunk = (direction: number) => {
    if (!index.hunks.length) return;
    const next =
      activeHunk < 0
        ? direction < 0
          ? index.hunks.length - 1
          : 0
        : (activeHunk + direction + index.hunks.length) % index.hunks.length;
    setActiveHunk(next);
    navigate(index.hunks[next], side, "start");
  };
  const jumpMatch = (direction: number) => {
    if (!found.matches.length) return;
    const next =
      (matchIndex + direction + found.matches.length) % found.matches.length;
    setMatchIndex(next);
    const match = found.matches[next];
    setActiveHunk(hunkAtRow(index.hunks, match.row));
    navigate(match.row, match.side === "both" ? side : match.side);
  };
  const viewportChanged = useCallback(
    (row: number) => setActiveHunk(hunkAtRow(index.hunks, row)),
    [index],
  );
  const empty = !path
    ? zh
      ? "选择文件，或在上方输入路径。"
      : "Select a file or enter a path above."
    : loading && !diff
      ? zh
        ? "正在加载…"
        : "Loading…"
      : error && !diff
        ? zh
          ? "加载失败，请重试。"
          : "Loading failed. Retry."
        : diff?.identical
          ? zh
            ? "两侧内容相同"
            : "Both sides are identical"
          : zh
            ? "没有文本差异"
            : "No text differences";
  const surfaceMenu = menu("V08", () => ({
    刷新当前视图: action(onRefresh),
    复制当前目标标识: copy(path),
    "在 Swarm 中打开": swarmMenuAction(runtime, zh, {
      kind: "file",
      depotPath: path,
    }),
  }));

  return (
    <>
      {error && (
        <div role="alert" className="workspace-load-error">
          {error}
        </div>
      )}
      <section
        className="review-surface diff-view"
        aria-busy={loading}
        tabIndex={-1}
        {...surfaceMenu}
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "f"
          ) {
            event.preventDefault();
            searchInput.current?.focus();
            searchInput.current?.select();
          } else if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "g"
          ) {
            event.preventDefault();
            lineInput.current?.focus();
            lineInput.current?.select();
          } else if (
            event.altKey &&
            ["ArrowUp", "ArrowDown"].includes(event.key)
          ) {
            event.preventDefault();
            jumpHunk(event.key === "ArrowUp" ? -1 : 1);
          }
          if (!event.defaultPrevented) surfaceMenu.onKeyDown(event);
        }}
      >
        <div
          className="diff-toolbar"
          role="group"
          aria-label={zh ? "差异工具栏" : "Diff tools"}
        >
          <div className="diff-tool-group diff-hunk-tools">
            <span className="diff-hunk-count" aria-live="polite">
              {activeHunk + 1}/{index.hunks.length} {zh ? "区块" : "hunks"}
            </span>
            <button
              aria-label={zh ? "上一个区块" : "Previous hunk"}
              title={zh ? "上一个区块 (Alt+↑)" : "Previous hunk (Alt+↑)"}
              disabled={!index.hunks.length}
              onClick={() => jumpHunk(-1)}
            >
              <ArrowUp size={14} />
            </button>
            <button
              aria-label={zh ? "下一个区块" : "Next hunk"}
              title={zh ? "下一个区块 (Alt+↓)" : "Next hunk (Alt+↓)"}
              disabled={!index.hunks.length}
              onClick={() => jumpHunk(1)}
            >
              <ArrowDown size={14} />
            </button>
          </div>
          <div className="diff-tool-group diff-search-group">
            <label className="diff-search-input">
              <Search size={14} aria-hidden="true" />
              <input
                ref={searchInput}
                aria-label={zh ? "查找文本" : "Find text"}
                placeholder={zh ? "在两侧查找…" : "Find in both sides…"}
                title={
                  zh ? "在两侧查找 (Ctrl+F)" : "Find in both sides (Ctrl+F)"
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    jumpMatch(event.shiftKey ? -1 : 1);
                  } else if (event.key === "Escape") setQuery("");
                }}
              />
            </label>
            <span className="diff-match-count" role="status">
              {query
                ? `${found.matches.length ? matchIndex + 1 : 0}/${found.matches.length}${found.limited ? "+" : ""}`
                : ""}
            </span>
            <button
              aria-label={zh ? "上一个匹配" : "Previous match"}
              title={
                zh ? "上一个匹配 (Shift+Enter)" : "Previous match (Shift+Enter)"
              }
              disabled={!found.matches.length}
              onClick={() => jumpMatch(-1)}
            >
              <ArrowUp size={14} />
            </button>
            <button
              aria-label={zh ? "下一个匹配" : "Next match"}
              title={zh ? "下一个匹配 (Enter)" : "Next match (Enter)"}
              disabled={!found.matches.length}
              onClick={() => jumpMatch(1)}
            >
              <ArrowDown size={14} />
            </button>
            <button
              aria-label={zh ? "清空查找" : "Clear search"}
              title={zh ? "清空查找 (Esc)" : "Clear search (Esc)"}
              disabled={!query}
              onClick={() => {
                setQuery("");
                searchInput.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          </div>
          <form
            className="diff-tool-group diff-line-tools"
            onSubmit={(event) => {
              event.preventDefault();
              const number = Number(lineNumber);
              const row = Number.isInteger(number)
                ? index[side].get(number)
                : undefined;
              if (row === undefined) {
                setLineError(
                  zh
                    ? "行号不在当前内容中"
                    : "Line is not in the current content",
                );
                return;
              }
              setLineError("");
              setActiveHunk(hunkAtRow(index.hunks, row));
              navigate(row, side);
            }}
          >
            <select
              aria-label={zh ? "跳转目标侧" : "Jump side"}
              value={side}
              onChange={(event) => {
                setSide(event.target.value as DiffSideName);
                setLineError("");
              }}
            >
              <option value="left">{zh ? "左侧" : "Left"}</option>
              <option value="right">{zh ? "右侧" : "Right"}</option>
            </select>
            <input
              className="diff-line-input"
              ref={lineInput}
              aria-label={zh ? "跳转行号" : "Go to line"}
              aria-invalid={!!lineError}
              aria-describedby={lineError ? lineErrorId : undefined}
              placeholder={zh ? "行号" : "Line"}
              title="Ctrl+G"
              inputMode="numeric"
              value={lineNumber}
              onChange={(event) => {
                setLineNumber(event.target.value);
                setLineError("");
              }}
            />
            <button
              type="submit"
              aria-label={zh ? "跳转到目标行" : "Jump to line"}
              title={zh ? "跳转到目标行" : "Jump to line"}
              disabled={!lineNumber.trim() || !rows.length}
            >
              <CornerDownLeft size={14} />
            </button>
            {lineError && (
              <span id={lineErrorId} role="status" className="diff-line-error">
                {lineError}
              </span>
            )}
          </form>
          <div className="diff-tool-group diff-summary-tools">
            <span className="diff-stats">
              <span className="diff-additions">
                +{diff?.stats.additions ?? 0}
              </span>
              <span className="diff-deletions">
                −{diff?.stats.deletions ?? 0}
              </span>
            </span>
            {(diff?.partial || diff?.truncated) && (
              <span className="diff-partial" title={diff.reason}>
                {zh ? "部分内容" : "Partial"}
              </span>
            )}
          </div>
        </div>
        <div className="diff-reference-headers">
          <ReferenceSelector
            label={zh ? "左侧" : "Left"}
            value={left}
            resolved={diff?.left.label}
            onChange={onLeftChange}
          />
          <ReferenceSelector
            label={zh ? "右侧" : "Right"}
            value={right}
            resolved={diff?.right.label}
            onChange={onRightChange}
          />
        </div>
        {diff?.binary || diff?.unsupported ? (
          <div className="workspace-empty">
            <strong>
              {diff.reason ??
                (zh ? "无法显示文本差异" : "Text diff unavailable")}
            </strong>
            <div>
              {diff.left.label}: {diff.left.fileType ?? "unknown"} ·{" "}
              {diff.left.size ?? 0} bytes · {diff.left.digest ?? "no digest"}
            </div>
            <div>
              {diff.right.label}: {diff.right.fileType ?? "unknown"} ·{" "}
              {diff.right.size ?? 0} bytes · {diff.right.digest ?? "no digest"}
            </div>
          </div>
        ) : diff && rows.length ? (
          <SplitDiff
            diff={diff}
            rows={rows}
            runtime={runtime}
            zh={zh}
            navigation={navigation}
            matches={matchesByRow}
            activeMatch={found.matches[matchIndex]}
            onSideFocus={setSide}
            onViewportRow={viewportChanged}
          />
        ) : (
          <div
            className="workspace-empty"
            role={loading ? "status" : undefined}
          >
            {empty}
          </div>
        )}
      </section>
    </>
  );
}

function ReferenceSelector({
  label,
  value,
  resolved,
  onChange,
}: {
  label: string;
  value: RevisionReference;
  resolved?: string;
  onChange(value: RevisionReference): void;
}) {
  return (
    <header className="diff-pane-header">
      <span>{label}</span>
      <select
        aria-label={`${label} reference`}
        value={value.kind}
        onChange={(event) => {
          const kind = event.target.value as RevisionReference["kind"];
          onChange(
            kind === "revision"
              ? { kind, revision: 1 }
              : kind === "shelf"
                ? { kind, changeId: 1 }
                : { kind },
          );
        }}
      >
        {(["workspace", "have", "head", "revision", "shelf"] as const).map(
          (kind) => (
            <option value={kind} key={kind}>
              {kind === value.kind && resolved
                ? resolved
                : {
                    workspace: "Workspace",
                    have: "Have",
                    head: "Head",
                    revision: "Revision",
                    shelf: "Shelf",
                  }[kind]}
            </option>
          ),
        )}
      </select>
      {(value.kind === "revision" || value.kind === "shelf") && (
        <input
          aria-label={`${label} ${value.kind === "revision" ? "revision number" : "shelf changelist"}`}
          type="number"
          min={1}
          step={1}
          value={value.kind === "revision" ? value.revision : value.changeId}
          onChange={(event) => {
            const number = Math.max(1, Number(event.target.value) || 1);
            onChange(
              value.kind === "revision"
                ? { kind: "revision", revision: number }
                : { kind: "shelf", changeId: number },
            );
          }}
        />
      )}
    </header>
  );
}
