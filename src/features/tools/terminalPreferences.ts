import { tokenize } from "../../shared/lib/tokenize";
import { inspectTerminalCommand } from "./terminalSecurity";
import type { ToolTab } from "./components/ToolDrawer";

export function readTerminalHistory(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value)
      ? value
          .filter((entry): entry is string => typeof entry === "string")
          .filter(
            (entry) =>
              !inspectTerminalCommand(entry, tokenize(entry)).sensitive,
          )
          .slice(0, 500)
      : [];
  } catch {
    return [];
  }
}
export function readToolHeight(raw: string | null): number {
  const value = Number(raw ?? 260);
  return Number.isFinite(value) ? Math.min(560, Math.max(180, value)) : 260;
}
export function readToolTab(raw: string | null): ToolTab {
  return ["terminal", "logs", "journal", "diagnostics"].includes(raw ?? "")
    ? (raw as ToolTab)
    : "terminal";
}
