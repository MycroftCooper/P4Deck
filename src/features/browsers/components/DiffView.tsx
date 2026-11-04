import { t } from "../../../shared/i18n";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Braces,
  Columns2,
  CornerDownLeft,
  FileCode2,
  Rows3,
  Search,
  UnfoldVertical,
  X,
} from "lucide-react";
import type {
  FileDiff as FileDiffInstance,
  FileDiffMetadata,
  PostRenderPhase,
} from "@pierre/diffs";
import { getFiletypeFromFileName, parsePatchFiles } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import type {
  DiffResult,
  RevisionReference,
  RuntimeInfo,
} from "../../../shared/contracts";
import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { action, copy } from "../../../app/context-menu/bindings";
import { useFullTextSelection } from "../../../app/context-menu/FullTextSelection";
import { swarmMenuAction } from "../../swarm/SwarmAction";
import {
  buildSearchLines,
  contextLineToRight,
  findDiffMatches,
  hunkAtLine,
  hunksFromMetadata,
  hunkTargetLine,
  normalizeUnifiedPatch,
  searchLinesFromMetadata,
  type DiffHunk,
  type DiffMatch,
  type DiffSideName,
} from "../diffNavigation";

type DiffTheme = "light" | "dark";
type ViewStyle = "split" | "unified";
type DiffOptions = NonNullable<
  ComponentProps<typeof FileDiff<undefined, undefined>>["options"]
>;
type ScrollInstance = FileDiffInstance & {
  getLinePosition?(
    lineNumber: number,
    side?: "additions" | "deletions",
  ): { top: number; height: number } | undefined;
};
interface SearchState {
  query: string;
  matches: DiffMatch[];
  active: number;
  byLine: Map<number, { match: DiffMatch; index: number }[]>;
}
interface MenuContext {
  side: DiffSideName;
  line: number;
  text: string;
}

const THEMES = { dark: "pierre-dark", light: "pierre-light" } as const;
const METRICS = {
  hunkLineCount: 40,
  lineHeight: 20,
  diffHeaderHeight: 0,
  hunkSeparatorHeight: 28,
  spacing: 6,
  paddingTop: 4,
  paddingBottom: 8,
};
const DIFF_STYLE: CSSProperties = {
  "--diffs-font-family":
    "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace",
  "--diffs-font-size": "12px",
  "--diffs-line-height": "20px",
  "--diffs-tab-size": "4",
  "--diffs-header-font-family": "inherit",
} as CSSProperties;

function resolvedTheme(): DiffTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Display normalization: strip a leading BOM and unify CRLF/CR to LF. */
function normalizeDiffContent(text: string) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function useResolvedTheme() {
  const [theme, setTheme] = useState<DiffTheme>(resolvedTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(resolvedTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

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
  const theme = useResolvedTheme();
  const [view, setView] = useState<ViewStyle>("split");
  // Classic diff by default: hunks keep their context and every longer run of
  // unchanged lines collapses into an expandable separator. Expanding the whole
  // file is the explicit opt-in.
  const [expandAll, setExpandAll] = useState(false);
  // Incomplete texts cannot hydrate collapsed context, so the readable raw
  // patch is the default; the structured renderer stays available for compare.
  const [partialMode, setPartialMode] = useState<"patch" | "structured">(
    "patch",
  );
  const [side, setSide] = useState<DiffSideName>("right");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [matchIndex, setMatchIndex] = useState(0);
  const [activeHunk, setActiveHunk] = useState(-1);
  const [lineNumber, setLineNumber] = useState("");
  const [lineError, setLineError] = useState("");
  const lineErrorId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const lineInput = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLElement | undefined>(undefined);
  const instanceRef = useRef<ScrollInstance | undefined>(undefined);
  const searchStateRef = useRef<SearchState>({
    query: "",
    matches: [],
    active: 0,
    byLine: new Map(),
  });
  const hunksRef = useRef<DiffHunk[]>([]);
  const fullTextRef = useRef(false);
  const menuContextRef = useRef<MenuContext | undefined>(undefined);
  const menuAnchor = useRef<HTMLSpanElement>(null);
  const menu = useContextMenu();
  const textSelection = useFullTextSelection();

  const fullText: { left: string; right: string } | undefined =
    diff &&
    !diff.partial &&
    !diff.truncated &&
    diff.leftText !== undefined &&
    diff.rightText !== undefined
      ? { left: diff.leftText, right: diff.rightText }
      : undefined;
  // P4 depot text is usually LF while Windows workspace files are CRLF. The
  // renderer compares raw contents, so normalize line endings (and the BOM) for
  // display; raw text stays available for copy/select-all.
  const displayText = useMemo(
    () =>
      fullText
        ? {
            left: normalizeDiffContent(fullText.left),
            right: normalizeDiffContent(fullText.right),
          }
        : undefined,
    [fullText?.left, fullText?.right],
  );
  // A newly loaded diff always starts from the default partial presentation.
  useEffect(() => {
    setPartialMode("patch");
  }, [diff?.path, diff?.unified]);
  // The backend's `similar` patch is the single source of truth for hunks; the
  // library only parses it instead of re-diffing the full texts.
  const parsedPatch = useMemo<{
    fileDiff: FileDiffMetadata | undefined;
    failed: boolean;
  }>(() => {
    const unified = diff?.unified ?? "";
    if (!unified.trim()) return { fileDiff: undefined, failed: false };
    try {
      const fileDiff = parsePatchFiles(
        normalizeUnifiedPatch(unified, path),
        `p4deck:${path}`,
        true,
      )[0]?.files[0];
      if (fileDiff) {
        // Patch headers carry revision labels, not paths; restore the real
        // filename so language detection and the header stay correct.
        fileDiff.name = path;
        fileDiff.lang = getFiletypeFromFileName(path);
      }
      return { fileDiff, failed: fileDiff === undefined };
    } catch {
      return { fileDiff: undefined, failed: true };
    }
  }, [diff?.unified, path]);
  const fileDiff = parsedPatch.fileDiff;
  const hunks = useMemo(
    () => (fileDiff ? hunksFromMetadata(fileDiff.hunks) : []),
    [fileDiff],
  );
  const searchLines = useMemo(() => {
    if (displayText) return buildSearchLines("", displayText);
    if (fileDiff) return searchLinesFromMetadata(fileDiff);
    return buildSearchLines(diff?.unified ?? "");
  }, [diff?.unified, displayText, fileDiff]);
  // Only complete texts can hydrate collapsed context; partial/truncated
  // patches stay non-expandable.
  const loadDiffFiles = useCallback(
    async (_fileDiff: FileDiffMetadata) => {
      if (!displayText) throw new Error("Full file contents are unavailable");
      return {
        oldFile: { name: path, contents: displayText.left },
        newFile: { name: path, contents: displayText.right },
      };
    },
    [displayText, path],
  );
  const found = useMemo(
    () => findDiffMatches(searchLines, deferredQuery),
    [searchLines, deferredQuery],
  );
  const searchState = useMemo<SearchState>(() => {
    const byLine = new Map<number, { match: DiffMatch; index: number }[]>();
    found.matches.forEach((match, index) => {
      const group = byLine.get(match.line);
      if (group) group.push({ match, index });
      else byLine.set(match.line, [{ match, index }]);
    });
    return {
      query: deferredQuery,
      matches: found.matches,
      active: matchIndex,
      byLine,
    };
  }, [deferredQuery, found, matchIndex]);
  searchStateRef.current = searchState;
  hunksRef.current = hunks;
  fullTextRef.current = fullText !== undefined;

  const scrollToLine = useCallback(
    (line: number, targetSide: DiffSideName, align: "start" | "center") => {
      const node = hostRef.current;
      const instance = instanceRef.current;
      if (!node) return false;
      const selectionSide =
        targetSide === "left" ? ("deletions" as const) : ("additions" as const);
      const scrollRoot = node.closest<HTMLElement>(".diff-scroll-root");
      const position = instance?.getLinePosition?.(line, selectionSide);
      if (scrollRoot && position) {
        const rootTop = scrollRoot.getBoundingClientRect().top;
        const nodeTop =
          node.getBoundingClientRect().top - rootTop + scrollRoot.scrollTop;
        const offset =
          align === "start"
            ? 8
            : Math.max(0, (scrollRoot.clientHeight - position.height) / 2);
        scrollRoot.scrollTop = Math.max(0, nodeTop + position.top - offset);
        instance?.setSelectedLines({
          start: line,
          side: selectionSide,
          end: line,
          endSide: selectionSide,
        });
        return true;
      }
      const row = rowAt(node, line, targetSide);
      if (!row) return false;
      row.scrollIntoView({ block: "center" });
      instance?.setSelectedLines({
        start: line,
        side: selectionSide,
        end: line,
        endSide: selectionSide,
      });
      return true;
    },
    [],
  );

  const navigateTo = useCallback(
    (line: number, targetSide: DiffSideName, align: "start" | "center") => {
      const instance = instanceRef.current;
      if (!instance) return;
      let revealLine: number | undefined;
      if (hunkAtLine(hunksRef.current, targetSide, line) < 0) {
        if (!fullTextRef.current) return;
        revealLine = contextLineToRight(hunksRef.current, targetSide, line);
        if (revealLine === undefined) return;
        instance.revealLine(revealLine);
      }
      let attempts = 0;
      const attempt = () => {
        if (
          revealLine !== undefined &&
          !instance.isLineRenderable(revealLine)
        ) {
          if (attempts++ < 12) window.setTimeout(attempt, 30);
          return;
        }
        if (scrollToLine(line, targetSide, align)) return;
        if (attempts++ < 12) window.setTimeout(attempt, 30);
      };
      attempt();
    },
    [scrollToLine],
  );

  const onMenu = useCallback((event: Event) => {
    const pointer = event as MouseEvent;
    const path = pointer.composedPath?.() ?? [];
    const row = path.find(
      (item): item is HTMLElement =>
        item instanceof HTMLElement && item.hasAttribute("data-line"),
    );
    if (!row) return;
    pointer.preventDefault();
    pointer.stopPropagation();
    const clickedSide = sideOfRow(row) === "left" ? "left" : "right";
    setSide(clickedSide);
    menuContextRef.current = {
      side: clickedSide,
      line: Number(row.dataset.line),
      text: row.textContent ?? "",
    };
    menuAnchor.current?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: pointer.clientX,
        clientY: pointer.clientY,
      }),
    );
  }, []);

  const onPointerDown = useCallback((event: Event) => {
    const path = (event as PointerEvent).composedPath?.() ?? [];
    const row = path.find(
      (item): item is HTMLElement =>
        item instanceof HTMLElement && item.hasAttribute("data-line"),
    );
    if (row) setSide(sideOfRow(row) === "left" ? "left" : "right");
  }, []);

  const postRender = useCallback(
    (node: HTMLElement, instance: FileDiffInstance, phase: PostRenderPhase) => {
      hostRef.current = node;
      instanceRef.current = instance as ScrollInstance;
      const shadow = node.shadowRoot;
      if (shadow) applySearchHighlights(shadow, searchStateRef.current);
      const scrollRoot = node.closest<HTMLElement>(".diff-scroll-root");
      if (scrollRoot) {
        // Keyboard users need a focusable scroll region for the virtualizer.
        scrollRoot.tabIndex = 0;
        scrollRoot.setAttribute("role", "region");
        scrollRoot.setAttribute("aria-label", "Diff content / 差异内容");
      }
      if (phase === "unmount") {
        node.removeEventListener("contextmenu", onMenu);
        node.removeEventListener("pointerdown", onPointerDown);
        if (hostRef.current === node) hostRef.current = undefined;
        if (instanceRef.current === (instance as ScrollInstance))
          instanceRef.current = undefined;
      }
    },
    [onMenu, onPointerDown],
  );

  useEffect(() => {
    const node = hostRef.current;
    if (node?.shadowRoot)
      applySearchHighlights(node.shadowRoot, searchStateRef.current);
  }, [searchState]);

  useEffect(() => {
    setActiveHunk((current) => Math.min(current, hunks.length - 1));
    setMatchIndex(0);
    setLineError("");
  }, [hunks]);

  const jumpHunk = (direction: number) => {
    if (!hunks.length) return;
    const next =
      activeHunk < 0
        ? direction < 0
          ? hunks.length - 1
          : 0
        : (activeHunk + direction + hunks.length) % hunks.length;
    setActiveHunk(next);
    const hunk = hunks[next];
    const line = hunkTargetLine(hunk, side);
    setLineError("");
    navigateTo(line, side, "start");
  };
  const jumpMatch = (direction: number, nextSide: DiffSideName = side) => {
    if (!found.matches.length) return;
    const next =
      (matchIndex + direction + found.matches.length) % found.matches.length;
    setMatchIndex(next);
    const match = found.matches[next];
    const targetSide = match.side === "both" ? nextSide : match.side;
    const hunk = hunkAtLine(hunks, targetSide, match.line);
    if (hunk >= 0) setActiveHunk(hunk);
    navigateTo(match.line, targetSide, "center");
  };

  useEffect(() => {
    setMatchIndex(0);
    const first = found.matches[0];
    if (first) {
      const targetSide = first.side === "both" ? side : first.side;
      const hunk = hunkAtLine(hunksRef.current, targetSide, first.line);
      if (hunk >= 0) setActiveHunk(hunk);
      navigateTo(first.line, targetSide, "center");
    }
    // A new query (or newly loaded text) selects its first match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredQuery, searchLines]);

  const sideText = (targetSide: DiffSideName) => {
    if (!diff) return "";
    const full = targetSide === "left" ? diff.leftText : diff.rightText;
    if (full !== undefined) return full;
    return searchLines
      .filter((line) => line[targetSide] !== undefined)
      .map((line) => line.text)
      .join("\n");
  };
  const selectionText = () => {
    const selection = document.getSelection();
    return selection && !selection.isCollapsed ? selection.toString() : "";
  };

  const v04Menu = menu(
    "V04",
    () => {
      const current = menuContextRef.current;
      const targetSide = current?.side ?? "right";
      const reference = targetSide === "left" ? diff?.left : diff?.right;
      const label =
        targetSide === "left" ? (t("browse.left")) : t("browse.right");
      return {
        复制所选文本: copy(selectionText() || current?.text || ""),
        全选当前侧: {
          ...action(() => textSelection.selectAll(sideText(targetSide))),
          label: zh
            ? `全选${label}差异文本`
            : `Select all diff text on the ${targetSide === "left" ? "left" : "right"}`,
        },
        "复制当前侧文件/修订标识": copy(
          reference ? `${reference.depotPath} · ${reference.label}` : path,
        ),
        "在 Swarm 中打开": swarmMenuAction(runtime, zh, {
          kind: "file",
          depotPath: reference?.depotPath ?? path,
        }),
      };
    },
    { title: t("browse.diff.side.text") },
  );

  const surfaceMenu = menu("V08", () => ({
    刷新当前视图: action(onRefresh),
    复制当前目标标识: copy(path),
    "在 Swarm 中打开": swarmMenuAction(runtime, zh, {
      kind: "file",
      depotPath: path,
    }),
  }));

  const bindHost = useCallback(
    (node: HTMLElement, instance: FileDiffInstance, phase: PostRenderPhase) => {
      postRender(node, instance, phase);
      if (phase === "mount") {
        node.addEventListener("contextmenu", onMenu);
        node.addEventListener("pointerdown", onPointerDown);
      }
    },
    [postRender, onMenu, onPointerDown],
  );

  const options = useMemo<DiffOptions>(
    () => ({
      theme: THEMES,
      themeType: theme,
      diffStyle: view,
      hunkSeparators: displayText
        ? ("line-info" as const)
        : ("metadata" as const),
      // Classic context folding: ≤3 unchanged lines between hunks stay visible,
      // longer runs collapse into a line-info separator with an expand button.
      expandUnchanged: displayText ? expandAll : false,
      collapsedContextThreshold: 3,
      lineDiffType: "word-alt" as const,
      diffIndicators: "bars" as const,
      disableFileHeader: true,
      overflow: "scroll" as const,
      onPostRender: bindHost,
      ...(displayText ? { loadDiffFiles } : {}),
    }),
    [theme, view, displayText, expandAll, loadDiffFiles, bindHost],
  );

  const validateLine = (targetSide: DiffSideName, number: number) => {
    if (!Number.isSafeInteger(number) || number < 1) return false;
    if (hunkAtLine(hunks, targetSide, number) >= 0) return true;
    if (!displayText) return false;
    const text = targetSide === "left" ? displayText.left : displayText.right;
    const count = text.endsWith("\n")
      ? text.split("\n").length - 1
      : text.split("\n").length;
    return number <= count;
  };

  const goToLine = () => {
    const number = Number(lineNumber);
    if (!validateLine(side, number)) {
      setLineError(
        t("browse.line.is.not.in.the"),
      );
      return;
    }
    setLineError("");
    const hunk = hunkAtLine(hunks, side, number);
    if (hunk >= 0) setActiveHunk(hunk);
    navigateTo(number, side, "center");
  };

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

  const renderable =
    diff !== undefined &&
    !diff.binary &&
    !diff.unsupported &&
    !diff.identical &&
    diff.unified.length > 0;
  const hunkTotal = fileDiff ? hunks.length : (diff?.stats.hunks ?? 0);

  return (
    <>
      {error && (
        <div role="alert" className="workspace-load-error">
          {error}
        </div>
      )}
      <section
        ref={textSelection.surfaceRef}
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
          aria-label={t("browse.diff.tools")}
        >
          <div className="diff-tool-group diff-hunk-tools">
            <span className="diff-hunk-count" aria-live="polite">
              {activeHunk + 1}/{hunkTotal} {t("browse.hunks")}
            </span>
            <button
              aria-label={t("browse.previous.hunk")}
              title={t("browse.previous.hunk.alt")}
              disabled={!hunks.length}
              onClick={() => jumpHunk(-1)}
            >
              <ArrowUp size={14} />
            </button>
            <button
              aria-label={t("browse.next.hunk")}
              title={t("browse.next.hunk.alt")}
              disabled={!hunks.length}
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
                aria-label={t("browse.find.text")}
                placeholder={t("browse.find.in.both.sides")}
                title={
                  t("browse.find.in.both.sides.ctrl")
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
              aria-label={t("browse.previous.match")}
              title={
                t("browse.previous.match.shift.enter")
              }
              disabled={!found.matches.length}
              onClick={() => jumpMatch(-1)}
            >
              <ArrowUp size={14} />
            </button>
            <button
              aria-label={t("browse.next.match")}
              title={t("browse.next.match.enter")}
              disabled={!found.matches.length}
              onClick={() => jumpMatch(1)}
            >
              <ArrowDown size={14} />
            </button>
            <button
              aria-label={t("browse.clear.search")}
              title={t("browse.clear.search.esc")}
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
              goToLine();
            }}
          >
            <select
              aria-label={t("browse.jump.side")}
              value={side}
              onChange={(event) => {
                setSide(event.target.value as DiffSideName);
                setLineError("");
              }}
            >
              <option value="left">{t("browse.left")}</option>
              <option value="right">{t("browse.right")}</option>
            </select>
            <input
              className="diff-line-input"
              ref={lineInput}
              aria-label={t("browse.go.to.line")}
              aria-invalid={!!lineError}
              aria-describedby={lineError ? lineErrorId : undefined}
              placeholder={t("browse.line")}
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
              aria-label={t("browse.jump.to.line")}
              title={t("browse.jump.to.line")}
              disabled={!lineNumber.trim() || !renderable}
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
                {t("browse.partial.2")}
              </span>
            )}
            {displayText && (
              <button
                className="diff-expand-all-toggle"
                aria-label={t("browse.expand.all")}
                title={
                  zh
                    ? "展开全部未改动内容"
                    : "Expand all unchanged context in this file"
                }
                aria-pressed={expandAll}
                disabled={!renderable}
                onClick={() => setExpandAll((value) => !value)}
              >
                <UnfoldVertical size={14} />
              </button>
            )}
            {!displayText && fileDiff && (
              <button
                className="diff-structured-toggle"
                aria-label={
                  partialMode === "patch"
                    ? zh
                      ? "结构化视图"
                      : "Structured view"
                    : zh
                      ? "原始补丁视图"
                      : "Raw patch view"
                }
                title={
                  partialMode === "patch"
                    ? zh
                      ? "切换到结构化视图"
                      : "Switch to the structured view"
                    : zh
                      ? "切换到原始补丁视图"
                      : "Switch to the raw patch view"
                }
                aria-pressed={partialMode === "structured"}
                disabled={!renderable}
                onClick={() =>
                  setPartialMode((value) =>
                    value === "patch" ? "structured" : "patch",
                  )
                }
              >
                {partialMode === "patch" ? (
                  <Braces size={14} />
                ) : (
                  <FileCode2 size={14} />
                )}
              </button>
            )}
            <div
              className="diff-view-toggle"
              role="group"
              aria-label={t("browse.diff.view")}
            >
              <button
                aria-label={t("browse.side.by.side.view")}
                title={t("browse.side.by.side.view")}
                aria-pressed={view === "split"}
                disabled={!renderable}
                onClick={() => setView("split")}
              >
                <Columns2 size={14} />
              </button>
              <button
                aria-label={t("browse.unified.view")}
                title={t("browse.unified.view")}
                aria-pressed={view === "unified"}
                disabled={!renderable}
                onClick={() => setView("unified")}
              >
                <Rows3 size={14} />
              </button>
            </div>
          </div>
        </div>
        <div className="diff-reference-headers">
          <ReferenceSelector
            label={t("browse.left")}
            value={left}
            resolved={diff?.left.label}
            filePath={diff?.left.depotPath}
            onChange={onLeftChange}
          />
          <ReferenceSelector
            label={t("browse.right")}
            value={right}
            resolved={diff?.right.label}
            filePath={diff?.right.depotPath}
            onChange={onRightChange}
          />
        </div>
        {diff?.binary || diff?.unsupported ? (
          <div className="workspace-empty">
            <strong>
              {diff.reason ??
                (t("browse.text.diff.unavailable"))}
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
        ) : renderable && diff ? (
          <div
            className="diff-body"
            role="region"
            aria-label={t("browse.diff.output")}
            {...v04Menu}
          >
            {fileDiff ? (
              !displayText && partialMode === "patch" ? (
                <div className="diff-fallback diff-patch-view">
                  <p
                    className="diff-fallback-note diff-patch-view-note"
                    role="note"
                  >
                    {zh
                      ? "文件文本不完整，以下为完整原始补丁（含后端 3 行上下文）；折叠上下文无法展开。"
                      : "File text is incomplete. Showing the full raw patch with the backend's three context lines; collapsed context cannot be expanded."}
                  </p>
                  <pre className="diff-patch-fallback">{diff.unified}</pre>
                </div>
              ) : (
                <Virtualizer
                  className="diff-scroll-root"
                  style={{ flex: 1, minHeight: 0 }}
                >
                  <FileDiff
                    className="diff-renderer"
                    style={DIFF_STYLE}
                    fileDiff={fileDiff}
                    metrics={METRICS}
                    options={options}
                  />
                </Virtualizer>
              )
            ) : (
              <div className="diff-fallback" role="alert">
                <p className="diff-fallback-note">
                  {zh
                    ? "结构化差异解析失败，以下为原始 patch 预览。"
                    : "Could not parse the structured diff. Raw patch preview below."}
                </p>
                <pre className="diff-patch-fallback">{diff.unified}</pre>
              </div>
            )}
          </div>
        ) : (
          <div
            className="workspace-empty"
            role={loading ? "status" : undefined}
          >
            {empty}
          </div>
        )}
        <span
          ref={menuAnchor}
          className="diff-menu-anchor"
          aria-hidden="true"
          {...v04Menu}
        />
        {textSelection.dialog}
      </section>
    </>
  );
}

function sideOfRow(row: HTMLElement): DiffSideName | "both" {
  const code = row.closest("code");
  if (code?.hasAttribute("data-deletions")) return "left";
  if (code?.hasAttribute("data-additions")) return "right";
  const type = row.getAttribute("data-line-type");
  if (type === "change-deletion") return "left";
  if (type === "change-addition") return "right";
  return "both";
}

function rowAt(node: HTMLElement, line: number, side: DiffSideName) {
  const rows = node.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]");
  for (const row of rows ?? []) {
    if (Number(row.dataset.line) !== line) continue;
    const rowSide = sideOfRow(row);
    if (rowSide === side || rowSide === "both") return row;
  }
  return undefined;
}

function applySearchHighlights(shadow: ShadowRoot, state: SearchState) {
  for (const mark of shadow.querySelectorAll("mark[data-p4d-match]"))
    mark.replaceWith(...mark.childNodes);
  let style = shadow.querySelector<HTMLStyleElement>("style[data-p4d-search]");
  if (!style) {
    style = document.createElement("style");
    style.dataset.p4dSearch = "";
    shadow.append(style);
  }
  if (!state.query) {
    style.textContent = "";
    return;
  }
  style.textContent =
    "mark[data-p4d-match]{background:color-mix(in srgb, var(--warning) 45%, transparent);color:inherit;border-radius:2px}" +
    "mark[data-p4d-active]{background:color-mix(in srgb, var(--accent) 65%, transparent);color:inherit;outline:1px solid var(--accent)}";
  const rows = shadow.querySelectorAll<HTMLElement>("[data-line]");
  for (const row of rows) {
    const line = Number(row.dataset.line);
    const candidates = state.byLine.get(line);
    if (!candidates?.length) continue;
    const rowSide = sideOfRow(row);
    for (const { match, index } of [...candidates].sort(
      (a, b) => b.match.start - a.match.start,
    )) {
      if (match.side !== "both" && match.side !== rowSide) continue;
      markRange(row, match.start, match.length, index === state.active);
    }
  }
}

function markRange(
  row: HTMLElement,
  start: number,
  length: number,
  active: boolean,
) {
  const from = locateOffset(row, start, false);
  const to = locateOffset(row, start + length, true);
  if (!from || !to) return;
  const range = document.createRange();
  range.setStart(from[0], from[1]);
  range.setEnd(to[0], to[1]);
  if (range.collapsed) return;
  const mark = document.createElement("mark");
  mark.dataset.p4dMatch = "";
  if (active) mark.dataset.p4dActive = "";
  mark.append(range.extractContents());
  range.insertNode(mark);
}

function locateOffset(
  row: HTMLElement,
  offset: number,
  atEnd: boolean,
): [Text, number] | undefined {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode() as Text | null;
  let last: Text | undefined;
  while (node) {
    last = node;
    const length = node.data.length;
    if (remaining < length || (remaining === length && !atEnd))
      return [node, remaining];
    if (remaining === length && atEnd) return [node, length];
    remaining -= length;
    node = walker.nextNode() as Text | null;
  }
  return last && atEnd ? [last, last.data.length] : undefined;
}

function ReferenceSelector({
  label,
  value,
  resolved,
  filePath,
  onChange,
}: {
  label: string;
  value: RevisionReference;
  resolved?: string;
  filePath?: string;
  onChange(value: RevisionReference): void;
}) {
  return (
    <header className="diff-pane-header" title={filePath}>
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
