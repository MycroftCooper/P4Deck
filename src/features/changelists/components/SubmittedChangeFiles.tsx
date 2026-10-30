import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { backend } from "../../../infrastructure/backend";
import type {
  RuntimeInfo,
  SubmittedChangeDetail,
} from "../../../shared/contracts";
import { RevisionFileList } from "./RevisionFileList";

export function SubmittedChangeFiles({
  changeId,
  scope,
  cache,
  runtime,
  zh,
  outerScroll,
  onHeight,
}: {
  changeId: number;
  scope: string;
  cache: Map<number, SubmittedChangeDetail>;
  runtime: RuntimeInfo;
  zh: boolean;
  outerScroll?: RefObject<HTMLDivElement | null>;
  onHeight?(height: number): void;
}) {
  const element = useRef<HTMLElement>(null);
  const reportHeight = useRef(onHeight);
  reportHeight.current = onHeight;
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      const height = node.getBoundingClientRect().height;
      if (height > 0 && Number.isFinite(height))
        reportHeight.current?.(Math.ceil(height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [scope, changeId]);
  const [detail, setDetail] = useState(() => cache.get(changeId));
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const cached = cache.get(changeId);
    setDetail(cached);
    setError("");
    if (cached) return;
    const operationId = crypto.randomUUID();
    const load = async () => {
      if (runtime.mode !== "mock" && runtime.connection.state !== "connected")
        throw new Error(zh ? "连接不可用" : "Connection unavailable");
      const result = await backend.getSubmittedChangeDetail({
        changeId,
        operationId,
      });
      if (!live) return;
      if (result.changeId !== changeId)
        throw new Error(
          zh ? "返回的 CL 与目标不符" : "Returned CL does not match the target",
        );
      if (result.inspectionStatus === "unavailable")
        throw new Error(
          result.message || (zh ? "详情不可用" : "Details unavailable"),
        );
      cache.set(changeId, result);
      setDetail(result);
    };
    void load().catch((cause) => {
      if (live) setError(String(cause));
    });
    return () => {
      live = false;
      void backend.cancelOperation(operationId).catch(() => undefined);
    };
  }, [
    changeId,
    scope,
    cache,
    attempt,
    runtime.mode,
    runtime.connection.state,
    zh,
  ]);
  return (
    <section
      ref={element}
      className="submitted-change-files"
      aria-label={`${zh ? "改动文件" : "Changed files"} · CL ${changeId}`}
    >
      {!detail && !error && (
        <p role="status">{zh ? "正在加载文件…" : "Loading files…"}</p>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            className="secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {zh ? "重试" : "Retry"}
          </button>
        </p>
      )}
      {detail && (
        <>
          <p className="submitted-files-count" role="status">
            {detail.inspectionStatus === "complete"
              ? zh
                ? `${detail.files.length} 个文件`
                : `${detail.files.length} files`
              : zh
                ? `已加载 ${detail.files.length} 个文件 · 总数未知`
                : `${detail.files.length} files loaded · total unknown`}
          </p>
          {detail.inspectionStatus !== "complete" && (
            <p role="status">
              {detail.message ||
                (zh ? "文件列表可能不完整" : "File list may be incomplete")}
            </p>
          )}
          {detail.files.length ? (
            <RevisionFileList
              files={detail.files.map((file) => ({ ...file, changeId }))}
              scope={`${scope}:${changeId}`}
              demo={runtime.mode === "mock"}
              outerScroll={outerScroll}
            />
          ) : (
            <p>
              {detail.inspectionStatus === "complete"
                ? zh
                  ? "没有可显示的文件"
                  : "No files to display"
                : zh
                  ? "尚无可显示文件，列表未完整读取"
                  : "No files loaded yet; listing is incomplete"}
            </p>
          )}
        </>
      )}
    </section>
  );
}
