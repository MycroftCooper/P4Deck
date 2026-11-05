import { t } from "../../shared/i18n";
import type { P4Context } from "../../shared/contracts";

/** Clipboard input is data, never a shell command or a P4 filespec. */
export function cleanAddress(text: string): string {
  let value = text.replace(/^[\s\uFEFF\u200B]+|[\s\uFEFF\u200B]+$/g, "");
  if (/^["'“‘]/.test(value)) {
    const pairs: Record<string, string> = {
      '"': '"',
      "'": "'",
      "“": "”",
      "‘": "’",
    };
    if (value.endsWith(pairs[value[0]])) value = value.slice(1, -1);
  }
  if (!value || /[\r\n\x00-\x1f]/.test(value))
    throw new Error(t("files.address.enterOnePath"));
  if (/^file:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.search || url.hash) throw new Error(t("files.address.encodeUrl"));
    value = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== "localhost")
      value = `\\\\${url.hostname}${value.replaceAll("/", "\\")}`;
    else if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    throw new Error(t("files.address.filePathsOnly"));
  }
  if (/[\x00-\x1f]/.test(value))
    throw new Error(t("files.address.controlCharacter"));
  if (value.startsWith("//") && /[#@*]|\.\.\./.test(value))
    throw new Error(t("files.address.exactDepotPath"));
  return value;
}

export function parentPath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return "";
  if (slash === 0) return "/";
  if (slash === 1 && normalized.startsWith("//")) return "//";
  if (slash === 2 && normalized[1] === ":") return normalized.slice(0, 3);
  return normalized.slice(0, slash);
}

/** Compare filesystem paths without Windows' extended-length prefix. Depot paths stay case-sensitive. */
export function pathKey(path: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path);
  const normalized = path
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/\/$/, "");
  return windows ? normalized.toLowerCase() : normalized;
}

type WorkspaceAddressContext = Pick<P4Context, "cwd" | "client">;

/** Only shorten a verified local/client path, never infer a depot mapping. */
export function workspaceRelativePath(
  path: string,
  context: WorkspaceAddressContext,
): string | undefined {
  const normalized = path
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/");
  const clientPrefix = `//${context.client}/`;
  if (context.client && normalized.startsWith(clientPrefix))
    return normalized.slice(clientPrefix.length);
  // A forward-slash // path is a P4 identity, even on a UNC workspace.
  if (path.startsWith("//")) return;
  if (!context.cwd) return;
  const root = context.cwd
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  if (normalized.startsWith("//") && !root.startsWith("//")) return;
  const windows = /^[a-z]:\//i.test(normalized) || normalized.startsWith("//");
  const value = windows ? normalized.toLowerCase() : normalized;
  const prefix = windows ? root.toLowerCase() : root;
  if (value.startsWith(`${prefix}/`)) return normalized.slice(root.length + 1);
  if (value === prefix) return "";
}

/** Resolve pasted address syntax locally. Depot mappings remain server-owned. */
export function completeFileAddress(
  input: string,
  context: WorkspaceAddressContext,
): string {
  const cleaned = cleanAddress(input)
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "");
  let unc = cleaned.startsWith("\\\\");
  let path = cleaned.replaceAll("\\", "/");
  // Validate again after slash normalization, including mixed-slash depot paths.
  if (!unc) cleanAddress(path);
  const clientPrefix = `//${context.client}/`;
  if (!unc && context.client && path.startsWith(clientPrefix) && context.cwd) {
    path = `${context.cwd.replace(/[\\/]+$/, "")}/${path.slice(clientPrefix.length)}`;
    unc = path.startsWith("\\\\");
    path = path.replaceAll("\\", "/");
  } else if (
    !unc &&
    !/^[a-z]:\//i.test(path) &&
    (!path.startsWith("/") ||
      (cleaned.startsWith("\\") && !path.startsWith("//")))
  ) {
    if (!context.cwd)
      throw new Error(t("files.address.configureWorkspaceRoot"));
    path = `${context.cwd.replace(/[\\/]+$/, "")}/${path.replace(/^\/+/, "")}`;
    unc = path.startsWith("\\\\");
    path = path.replaceAll("\\", "/");
  }
  const prefix = path.startsWith("//")
    ? "//"
    : path.startsWith("/")
      ? "/"
      : /^[a-z]:\//i.test(path)
        ? path.slice(0, 3)
        : "";
  const segments: string[] = [];
  for (const part of path.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  const formatted = prefix + segments.join("/");
  return unc ? formatted.replaceAll("/", "\\") : formatted;
}
