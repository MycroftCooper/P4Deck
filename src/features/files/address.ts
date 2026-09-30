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
    throw new Error("请输入单个文件或目录地址 / Enter one file or folder path");
  if (/^file:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.search || url.hash)
      throw new Error(
        "file URL 中的 # 和 ? 必须转义 / Encode # and ? in file URLs",
      );
    value = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== "localhost")
      value = `\\\\${url.hostname}${value.replaceAll("/", "\\")}`;
    else if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    throw new Error("只支持文件地址，不支持网页或命令 / File paths only");
  }
  if (/[\x00-\x1f]/.test(value))
    throw new Error("地址包含控制字符 / Invalid control character");
  if (value.startsWith("//") && /[#@*]|\.\.\./.test(value))
    throw new Error(
      "请输入具体 depot 路径，不要附带修订号或通配符 / Use an exact depot path",
    );
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
