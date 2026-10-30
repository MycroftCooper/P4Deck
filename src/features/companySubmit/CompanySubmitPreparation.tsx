import { useState } from "react";
import { CompanySubmitPreview } from "./CompanySubmitPreview";
import {
  useCompanySubmitSnapshot,
  type SnapshotReader,
} from "./useCompanySubmitSnapshot";
/** Memory-only path editor. It never plans locally, probes a file, or launches a tool. */
export function CompanySubmitPreparation({
  changeIds,
  connectionKey,
  readSnapshot,
  zh = true,
}: {
  changeIds: readonly string[];
  connectionKey: string;
  readSnapshot: SnapshotReader;
  zh?: boolean;
}) {
  const [executablePath, setExecutablePath] = useState("");
  const scope = JSON.stringify([connectionKey, changeIds]);
  const { state, refresh } = useCompanySubmitSnapshot(scope, readSnapshot);
  return (
    <section>
      <label>
        {zh ? "自定义提交工具本机 .exe 绝对路径" : "Local absolute .exe path"}
        <input
          value={executablePath}
          onChange={(e) => setExecutablePath(e.target.value)}
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        disabled={state.status === "loading"}
        onClick={() => void refresh()}
      >
        {zh ? "重新读取连接身份" : "Refresh connection identity"}
      </button>
      {state.status === "loading" ? (
        <p role="status">
          {zh ? "正在读取宿主连接身份…" : "Reading host connection identity…"}
        </p>
      ) : state.status === "error" ? (
        <p role="alert">
          {zh
            ? "无法取得有效连接身份，真实启动保持禁用。"
            : "Connection identity unavailable; real launch remains disabled."}
        </p>
      ) : (
        <CompanySubmitPreview
          request={{ changeIds, executablePath, connection: state.snapshot }}
          requestId={JSON.stringify([
            scope,
            state.snapshot.generation,
            executablePath,
          ])}
          zh={zh}
        />
      )}
      {state.status !== "ready" && (
        <button type="button" disabled>
          {zh
            ? "启动自定义提交工具（禁用）"
            : "Launch custom submit tool (disabled)"}
        </button>
      )}
    </section>
  );
}
