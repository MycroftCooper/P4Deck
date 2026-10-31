import { createContext, useEffect, useState, type ReactNode } from "react";
export const FixedPageHeader = ({ children, description }: { children: ReactNode; description: string }) => <header><h2>合成 Branch 映射验收</h2><p>{description}</p>{children}</header>;
export const PageRefreshSlotContext = createContext(null);
export const useContentMenu = () => () => ({});
export const action = () => ({});
export const copy = () => ({});
export const useUnsavedEditor = () => () => {};
export const WorkspaceSwitcher = ({ onSettings }: { onSettings(): void }) => <div className="connection-picker"><button className="connection" onClick={onSettings}><span className="connection-client">synthetic-workspace-long-name</span><span>fixture@synthetic.invalid</span></button></div>;
const samples: Record<string, string> = {
  normal:
    '{\n  "name": "fixture",\n  "enabled": true,\n  "items": [\n    1,\n    2\n  ],\n  "label": "中文 🚀"\n}',
  long: JSON.stringify({ value: "a".repeat(10000) }),
  scroll: Array.from({length:120}, (_,i) => `  "synthetic-${i}": "${"content ".repeat(30)}"`).join("\n"),
  invalid: "{ invalid JSON :",
  empty: "",
};
export function useFilePreview() {
  const [phase, setPhase] = useState("loading");
  const sample = new URLSearchParams(location.search).get("sample") ?? "normal";
  useEffect(() => {
    const timer = setTimeout(() => setPhase(sample === "error" ? "error" : "ready"), 100);
    return () => clearTimeout(timer);
  }, [sample]);
  const content =
    samples[new URLSearchParams(location.search).get("sample") ?? "normal"] ??
    samples.normal;
  return {
    data: phase === "ready" ? {
      kind: "text" as const,
      content,
      encoding: "UTF-8",
      size: content.length,
    } : undefined,
    error: phase === "error" ? "Synthetic read failure" : "",
    loading: phase === "loading",
    reload() { setPhase("ready"); },
  };
}
