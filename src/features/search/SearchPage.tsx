import { useId, useState, useEffect } from "react";
import {
  ArrowRight,
  Search,
  File,
  Hash,
  Info,
  FolderSearch,
  X,
} from "lucide-react";
import { changelistNumber } from "./searchInput";

import { useMenuEnvironment } from "../../app/context-menu/environment";
import { useRecordSelection } from "../../app/context-menu/useRecordSelection";
import { useContextMenu } from "../../app/context-menu/ContextMenu";
import { action, copy } from "../../app/context-menu/bindings";
/** UI-only: no backend import and no server requests on typing or submit. */
export function SearchPage({ zh, client }: { zh: boolean; client: string }) {
  const menu = useContextMenu();
  const {searchDirectory} = useMenuEnvironment();
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [mode, setMode] = useState<"files" | "cl">("files");
  const tabId = useId();
  const [queries, setQueries] = useState({ files: "", cl: "" });
  const query = queries[mode];
  const setQuery = (value: string) =>
    setQueries((previous) => ({ ...previous, [mode]: value }));
  const [scope, setScope] = useState("workspace");
  const [path, setPath] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { if (searchDirectory) { setMode("files"); setScope("depot"); setPath(searchDirectory); setNotice(tr("已填入目录范围；搜索服务尚未接通。", "Directory scope filled; search service is not connected.")); } }, [searchDirectory]);
  const [demo, setDemo] = useState(false);
  const [previewMenus, setPreviewMenus] = useState(false);
  const [selection, setSelection] = useState<string>();
  const number = mode === "cl" ? changelistNumber(query) : undefined;
  const valid = mode === "cl" ? !!number : !!query.trim();
  const submit = (target?: string) => {
    setDemo(false);
    setSelection(undefined);
    setNotice(
      target
        ? tr(
            `已识别 CL #${target}。查询尚未接入，未请求服务器或打开详情。`,
            `Recognized CL #${target}. Search is not connected; no server request was made.`,
          )
        : tr(
            `搜索条件已就绪：“${query.trim()}”。查询尚未接入，未请求 P4 服务器。`,
            `Search ready: “${query.trim()}”. Search is not connected; no P4 request was made.`,
          ),
    );
  };
  const rows =
    mode === "files"
      ? [
          "Source/render.ts",
          "Assets/Textures/preview.png",
          "Config/project.json",
        ]
      : [
          "#12345 · Update rendering pipeline",
          "#12346 · Refresh project configuration",
          "#12347 · Import preview assets",
        ];
  const resultSelection = useRecordSelection(rows, row => row, mode + ":" + demo);
  return (
    <main className="search-page">
      <header className="search-heading">
        <div>
          <span className="search-eyebrow">P4DECK / SEARCH</span>
          <h1>{tr("搜索", "Search")}</h1>
          <p>
            {tr(
              "按文件名或路径搜索文件，按 CL 编号搜索变更列表。",
              "Search files by name or path, or changelists by CL number.",
            )}
          </p>
        </div>
        <span className="search-ui-badge">
          {tr("仅 UI 预览", "UI preview")}
        </span>
      </header>
      <div className="search-ui-note">
        <Info size={15} />
        <span>
          {tr(
            "此页暂未连接 P4 查询。可以体验输入、筛选与示例结果，所有操作均不访问服务器。",
            "Not connected to P4 yet. Inputs, filters and sample results are interactive; no server requests are made.",
          )}
        </span>
      </div>
      <section className="search-card">
        <div
          className="search-modes"
          role="tablist"
          aria-label={tr("搜索类型", "Search type")}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? "files"
                : event.key === "End"
                  ? "cl"
                  : mode === "files"
                    ? "cl"
                    : "files";
            setMode(next);
            setDemo(false);
            setNotice("");
            setSelection(undefined);
            event.currentTarget
              .querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)
              ?.focus();
          }}
        >
          <button
            role="tab"
            id={`${tabId}-files`}
            data-mode="files"
            aria-controls={`${tabId}-panel`}
            aria-selected={mode === "files"}
            tabIndex={mode === "files" ? 0 : -1}
            onClick={() => {
              setMode("files");
              setDemo(false);
              setNotice("");
              setSelection(undefined);
            }}
          >
            <File size={15} />
            {tr("搜索文件", "Search files")}
          </button>
          <button
            role="tab"
            id={`${tabId}-cl`}
            data-mode="cl"
            aria-controls={`${tabId}-panel`}
            aria-selected={mode === "cl"}
            tabIndex={mode === "cl" ? 0 : -1}
            onClick={() => {
              setMode("cl");
              setDemo(false);
              setNotice("");
              setSelection(undefined);
            }}
          >
            <Hash size={15} />
            {tr("搜索 CL", "Search CL")}
          </button>
        </div>
        <form
          role="tabpanel"
          id={`${tabId}-panel`}
          aria-labelledby={`${tabId}-${mode}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) submit(number);
          }}
        >
          <div className="search-input-row">
            <Search size={18} />
            <input
              aria-label={
                mode === "files"
                  ? tr("搜索内容", "Search query")
                  : tr("CL 编号", "CL number")
              }
              aria-invalid={mode === "cl" && !!query.trim() && !number}
              aria-describedby={mode === "cl" ? `${tabId}-help` : undefined}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setNotice("");
              }}
              placeholder={
                mode === "files"
                  ? tr("输入文件名或路径…", "File name or path…")
                  : tr(
                      "输入 CL 编号，例如 12345 或 CL 12345",
                      "CL number, e.g. 12345 or CL 12345",
                    )
              }
            />
            {query && (
              <button
                type="button"
                className="search-clear"
                aria-label={tr("清空搜索", "Clear search")}
                onClick={() => {
                  setQuery("");
                  setNotice("");
                }}
              >
                <X size={14} />
              </button>
            )}
            <button className="search-primary" disabled={!valid}>
              {tr("搜索", "Search")}
              <ArrowRight size={14} />
            </button>
          </div>
          {mode === "files" ? (
            <div className="search-filters">
              <label>
                {tr("搜索范围", "Scope")}
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="workspace">
                    {tr("当前工作区", "Current workspace")}
                  </option>
                  <option value="depot">
                    {tr("指定目录路径", "Directory path")}
                  </option>
                </select>
              </label>
              {scope === "workspace" ? (
                <span title={client}>{client}</span>
              ) : (
                <input
                  aria-label="Directory path"
                  placeholder="//depot/project/..."
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
              )}
              <span>
                {tr(
                  "最多 100 条 · 按 Enter 搜索",
                  "Up to 100 results · Enter to search",
                )}
              </span>
            </div>
          ) : (
            <p className="search-cl-help" id={`${tabId}-help`}>
              {query.trim() && !number
                ? tr(
                    "请输入有效的正整数 CL 编号",
                    "Enter a valid positive CL number",
                  )
                : tr(
                    "仅支持 CL 编号，不支持描述或用户关键词。按 Enter 搜索。",
                    "CL numbers only; descriptions and user keywords are not supported. Press Enter to search.",
                  )}
            </p>
          )}
        </form>
      </section>
      {notice && (
        <div className="search-ui-note" role="status">
          <Info size={15} />
          {notice}
        </div>
      )}
      <section
        className="search-card search-results"
        tabIndex={0}
        {...menu("S05", () => ({
          复制当前查询条件: copy(JSON.stringify({ mode, query, scope, path })),
          清除选择: action(() => {setSelection(undefined); resultSelection.clear();}),
          全选结果: action(resultSelection.all, demo ? undefined : "当前没有结果 / No results"),
        }))}
        aria-label={tr("搜索结果", "Search results")}
      >
        <div className="search-results-heading">
          <h2>{tr("搜索结果", "Results")}</h2>
          <button
            onClick={() => {
              setDemo(!demo);
              setSelection(undefined);
            }}
          >
            {demo
              ? tr("隐藏示例", "Hide samples")
              : tr("查看示例结果", "Show sample results")}
          </button>
        </div>
        {demo ? (
          <>
            <p className="search-sample-note">
              {tr(
                "以下为静态示例，不是真实查询结果，与输入条件无关。",
                "Static samples, not actual search results. Unrelated to your query.",
              )}
            </p>
            <label className="search-menu-preview"><input type="checkbox" checked={previewMenus} onChange={event => setPreviewMenus(event.target.checked)} />{tr("预览正式结果菜单（示例条目不执行真实操作）", "Preview result menus (samples do not execute real actions)")}</label>
            <div className="search-sample-list">
              {rows.map((row) => (
                <button
                  key={row}
                  {...menu(
                    previewMenus ? mode === "cl" ? "S03" : resultSelection.targets(row).length > 1 ? "S02" : "S01" : "S04",
                    () => ({
                      "复制 › 文件名": copy(row.split("/").pop()), "复制 › 相对路径": copy(row), "复制 › 文件名列表": copy(resultSelection.targets(row).map(r => r.split("/").pop()).join("\n")), "复制 › 相对路径列表": copy(resultSelection.targets(row).join("\n")), "复制 CL 编号": copy(mode === "cl" ? row.split(" · ")[0] : undefined), "复制描述": copy(mode === "cl" ? row.split(" · ")[1] : undefined),
                      "复制展示的文件路径或 CL 编号": copy(
                        mode === "cl" ? row.split(" · ")[0] : row,
                      ),
                      查看演示说明: action(() =>
                        setNotice(
                          tr(
                            "静态演示数据，不执行真实文件或 P4 操作。",
                            "Static samples; no real file or P4 actions.",
                          ),
                        ),
                      ),
                    }),
                    {title: tr("示例 · 不执行真实操作", "Sample · No real actions"), onOpen: () => {setSelection(row); resultSelection.context(row);}},
                  )}
                  onClick={event => {setSelection(row); resultSelection.select(row, event);}}
                  aria-pressed={resultSelection.isSelected(row)}
                >
                  {mode === "files" ? <File size={16} /> : <Hash size={16} />}
                  <span>{row}</span>
                  <small>{tr("示例", "Sample")}</small>
                </button>
              ))}
            </div>
            {selection && (
              <div className="search-selection">
                <strong>{selection}</strong>
                <span>
                  {tr(
                    "结果详情占位 · 定位、预览与真实 CL 详情将在接入后可用。",
                    "Detail placeholder · Locate, preview and live CL details are not connected yet.",
                  )}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="search-empty">
            <FolderSearch size={32} />
            <h3>
              {notice
                ? tr("等待接入搜索服务", "Search service not connected")
                : tr("从文件名或 CL 开始", "Start with a file or CL")}
            </h3>
            <p>
              {tr(
                "输入条件后按 Enter。也可查看示例，预览结果列表的交互。",
                "Enter a query and press Enter, or explore sample results.",
              )}
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
