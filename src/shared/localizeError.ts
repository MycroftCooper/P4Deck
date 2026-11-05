import { tFor } from "./i18n/t";
import type { MsgKey } from "./i18n/catalog.zh";
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
    zh: "common.preview.is.restricted.to.the.current",
    en: "common.preview.is.restricted.to.the.current",
  },
  {
    match: "Path is outside the current workspace",
    zh: "common.path.is.outside.the.current.workspace",
    en: "common.path.is.outside.the.current.workspace",
  },
  {
    match: "Path is outside the current client view",
    zh: "common.path.is.outside.the.current.client",
    en: "common.path.is.outside.the.current.client",
  },
  {
    match: "File is not available locally. Sync it first, then retry.",
    zh: "common.file.is.not.available.locally.sync",
    en: "common.file.is.not.available.locally.sync",
  },
  {
    match: "Depot file is not mapped to this workspace",
    zh: "common.depot.file.is.not.mapped.to",
    en: "common.depot.file.is.not.mapped.to",
  },
  {
    match: "Workspace Root has not been verified",
    zh: "common.workspace.root.has.not.been.verified",
    en: "common.workspace.root.has.not.been.verified",
  },
  {
    match: "Workspace Root must be an absolute path",
    zh: "common.workspace.root.must.be.an.absolute",
    en: "common.workspace.root.must.be.an.absolute",
  },
  {
    match: "Select a regular file",
    zh: "common.select.a.regular.file",
    en: "common.select.a.regular.file",
  },
  {
    match: "File is too large to preview",
    zh: "common.file.is.too.large.to.preview",
    en: "common.file.is.too.large.to.preview",
  },
  {
    // The opener is followed by the offending path.
    match: "The path is outside the workspace:",
    prefix: true,
    zh: "common.the.path.is.outside.the.workspace",
    en: "common.the.path.is.outside.the.workspace",
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
      // The prefix rule appends the offending path; the separator differs per
      // language, so it stays here rather than in the catalog.
      return zh
        ? `${tFor("zh-CN", rule.zh as MsgKey)}：${rest}`
        : `${tFor("en-US", rule.zh as MsgKey)} ${rest}`;
    }
    if (text !== rule.match) continue;
    return tFor(zh ? "zh-CN" : "en-US", rule.zh as MsgKey);
  }
  return message;
}
