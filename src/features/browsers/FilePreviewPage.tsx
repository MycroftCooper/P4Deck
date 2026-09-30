import { useEffect, useMemo, useRef, useState } from "react";
import { useFilePreview } from "./useFilePreview";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileText, Image, Minus, Plus, RefreshCw } from "lucide-react";
import type { RuntimeInfo } from "../../shared/contracts/types";

import { useContentMenu } from "../../app/context-menu/useContentMenu";
import { action, copy } from "../../app/context-menu/bindings";
import { useFullTextSelection } from "../../app/context-menu/FullTextSelection";
export function FilePreviewPage({
  target,
  locked,
  onTargetChange,
  runtime,
  zh,
}: {
  target: string;
  locked: boolean;
  onTargetChange(path: string): void;
  runtime: RuntimeInfo;
  zh: boolean;
}) {
  const menu = useContentMenu();
  const textSelection = useFullTextSelection();
  const tr = (a: string, b: string) => (zh ? a : b);
  const [path, setPath] = useState(target),
    [zoom, setZoom] = useState<number | null>(null),
    [imageError, setImageError] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const { data, error, loading, reload } = useFilePreview(target, runtime);
  useEffect(() => {
    if (loading) setImageError(false);
  }, [loading]);
  useEffect(() => {
    setPath(target);
    setZoom(null);
    setImageError(false);
    scroll.current?.scrollTo(0, 0);
  }, [target]);
  const lines = useMemo(
    () =>
      data?.kind === "text"
        ? data.content.replace(/\r\n?/g, "\n").split("\n")
        : [],
    [data],
  );
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 24,
    overscan: 10,
  });
  return (
    <main className="file-preview-page" ref={textSelection.surfaceRef}>
      <header className="preview-heading">
        <div>
          <span className="workspace-eyebrow">WORKSPACE / PREVIEW</span>
          <h1>{tr("文件预览", "File preview")}</h1>
          <p>
            {tr(
              "本地当前内容 · 只读 · 文本 / 图片",
              "Local working copy · Read-only · Text / images",
            )}
          </p>
        </div>
        <button
          className="secondary"
          disabled={!target || loading}
          onClick={reload}
        >
          <RefreshCw size={14} />
          {tr("刷新", "Refresh")}
        </button>
      </header>
      <form
        className="history-path"
        onSubmit={(e) => {
          e.preventDefault();
          if (locked || !path.trim()) return;
          if (path.trim() === target) reload();
          else onTargetChange(path.trim());
        }}
      >
        <input
          aria-label={tr("预览文件路径", "Preview file path")}
          disabled={locked}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={tr(
            "本地路径，或已同步文件的 Depot 路径",
            "Local path, or depot path of a synced file",
          )}
        />
        <button disabled={locked || !path.trim()}>{tr("查看", "Load")}</button>
      </form>
      {runtime.mode === "mock" && (
        <div className="preview-note">
          {tr(
            "浏览器演示：显示模拟内容，不读取本地文件。可输入 demo.png 查看图片示例。",
            "Browser demo: simulated content, no local files accessed. Enter demo.png for an image sample.",
          )}
        </div>
      )}
      <div className="preview-toolbar">
        {data?.kind === "image" ? (
          <>
            <Image size={14} />
            <span>
              {data.width} × {data.height}
            </span>
            <button
              aria-label={tr("缩小图片", "Zoom out")}
              onClick={() => setZoom((n) => Math.max(0.1, (n ?? 1) / 1.25))}
            >
              <Minus size={14} />
            </button>
            <button onClick={() => setZoom(1)}>
              {zoom === null ? tr("适应", "Fit") : `${Math.round(zoom * 100)}%`}
            </button>
            <button
              aria-label={tr("放大图片", "Zoom in")}
              onClick={() => setZoom((n) => Math.min(4, (n ?? 1) * 1.25))}
            >
              <Plus size={14} />
            </button>
            <button onClick={() => setZoom(null)}>
              {tr("适应窗口", "Fit to window")}
            </button>
          </>
        ) : (
          <>
            <FileText size={14} />
            <span>{data?.encoding ?? "—"}</span>
            <span>
              {lines.length} {tr("行", "lines")}
            </span>
          </>
        )}
        <span className="spacer" />
        <span>{data ? `${(data.size / 1024).toFixed(1)} KiB` : ""}</span>
      </div>
      <section
        className="preview-body"
        aria-busy={loading}
        tabIndex={0}
        {...menu(
          error || imageError || !data
            ? "V07"
            : data.kind === "image"
              ? "V06"
              : "V05",
          target,
          () => ({
            重新加载: action(reload, target ? undefined : "没有预览目标"),
            复制已知路径: copy(target),
            复制所选文本: copy(textSelection.selectedText()),
            全选: action(() =>
              textSelection.selectAll(
                data?.kind === "text" ? data.content : "",
              ),
            ),
            适应窗口: action(() => setZoom(null)),
            原始尺寸: action(() => setZoom(1)),
          }),
        )}
      >
        {error ? (
          <div role="alert" className="preview-empty">
            {tr("无法预览", "Preview unavailable")}
            <p>{error}</p>
          </div>
        ) : !target ? (
          <div className="preview-empty">
            {tr(
              "选择文件后点击“预览”，或双击文件。",
              "Select Preview or double-click a file.",
            )}
          </div>
        ) : loading && !data ? (
          <div role="status" className="preview-empty">
            {tr("正在读取…", "Reading…")}
          </div>
        ) : data?.kind === "text" ? (
          <div className="preview-text" ref={scroll}>
            <div
              className="virtual-spacer"
              style={{ height: virtual.getTotalSize() }}
            >
              {virtual.getVirtualItems().map((row) => (
                <div
                  className="preview-line"
                  key={row.index}
                  style={{
                    transform: `translateY(${row.start}px)`,
                    height: row.size,
                  }}
                >
                  <span>{row.index + 1}</span>
                  <code>
                    {lines[row.index].slice(0, 4000) || " "}
                    {lines[row.index].length > 4000
                      ? tr(
                          " … [此行过长，已截断显示]",
                          " … [long line truncated]",
                        )
                      : ""}
                  </code>
                </div>
              ))}
            </div>
          </div>
        ) : data?.kind === "image" ? (
          imageError ? (
            <div role="alert" className="preview-empty">
              {tr(
                "图片损坏或当前系统不支持此格式。",
                "Invalid image or unsupported system decoder.",
              )}
            </div>
          ) : (
            <div className={`preview-image ${zoom === null ? "fit" : ""}`}>
              <img
                key={data.content}
                src={data.content}
                alt={target.split(/[\\/]/).pop() ?? target}
                decoding="async"
                onError={() => setImageError(true)}
                style={
                  zoom === null
                    ? undefined
                    : {
                        width: (data.width ?? 1) * zoom,
                        height: (data.height ?? 1) * zoom,
                      }
                }
              />
            </div>
          )
        ) : null}
      </section>
      {textSelection.dialog}
      <footer className="preview-footer">
        {tr(
          "文本 ≤ 2 MiB · 图片 ≤ 8 MiB / 2000 万像素 · 不自动下载服务器文件",
          "Text ≤ 2 MiB · Images ≤ 8 MiB / 20 MP · No automatic depot downloads",
        )}
      </footer>
    </main>
  );
}
