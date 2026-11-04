/**
 * Localized copy for backend errors that the UI surfaces verbatim.
 *
 * The Rust side stays English-only (it has no locale), so the message text is
 * treated as a stable protocol key here: exact matches are translated, and a
 * few prefix matches cover messages that carry a dynamic file path. Anything
 * unrecognized is shown unchanged rather than hidden.
 */

interface Rule {
  /** Whole message equals `match`, or starts with it when `prefix` is set. */
  match: string;
  prefix?: boolean;
  zh: string;
  en: string;
}

const RULES: Rule[] = [
  {
    match: "Preview is restricted to the current workspace directory",
    zh: "仅可预览当前工作区目录内的文件。",
    en: "Preview is restricted to the current workspace directory.",
  },
  {
    match: "Path is outside the current workspace",
    zh: "路径不在当前工作区内。",
    en: "Path is outside the current workspace.",
  },
  {
    match: "Path is outside the current client view",
    zh: "路径不在当前客户端视图中。",
    en: "Path is outside the current client view.",
  },
  {
    match: "File is not available locally. Sync it first, then retry.",
    zh: "文件不在本地，请先获取最新（Sync）后再试。",
    en: "File is not available locally. Sync it first, then retry.",
  },
  {
    match: "Depot file is not mapped to this workspace",
    zh: "该 Depot 文件未映射到当前工作区。",
    en: "Depot file is not mapped to this workspace.",
  },
  {
    match: "Workspace Root has not been verified",
    zh: "工作区根目录尚未校验。",
    en: "Workspace Root has not been verified.",
  },
  {
    match: "Workspace Root must be an absolute path",
    zh: "工作区根目录必须是绝对路径。",
    en: "Workspace Root must be an absolute path.",
  },
  {
    match: "Select a regular file",
    zh: "请选择一个普通文件。",
    en: "Select a regular file.",
  },
  {
    match: "File is too large to preview",
    zh: "文件过大，无法预览。",
    en: "File is too large to preview.",
  },
  {
    // The opener is followed by the offending path.
    match: "The path is outside the workspace:",
    prefix: true,
    zh: "路径不在当前工作区内",
    en: "The path is outside the workspace:",
  },
];

/** Strips the `Error: ` prefix that IPC rejections serialized as text carry. */
function plain(message: string): string {
  return message.replace(/^\s*(?:Error:\s*)+/i, "").trim();
}

/** Localizes a known backend error; unknown messages pass through unchanged. */
export function localizeBackendError(message: string, zh: boolean): string {
  const text = plain(message);
  if (!text) return message;
  for (const rule of RULES) {
    if (rule.prefix) {
      if (!text.startsWith(rule.match)) continue;
      const rest = text.slice(rule.match.length).trim();
      return zh ? `${rule.zh}：${rest}` : `${rule.en} ${rest}`;
    }
    if (text !== rule.match) continue;
    return zh ? rule.zh : rule.en;
  }
  return message;
}
