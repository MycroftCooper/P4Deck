export type RenamePathError =
  "empty" | "absolute" | "characters" | "segments" | "same" | "descendant";
/** Syntactic checks only. No existence, mapping, permissions or overwrite claims. */
export function checkRenamePath(
  source: string,
  target: string,
  directory: boolean,
  depot: boolean,
): RenamePathError | undefined {
  if (!target.trim()) return "empty";
  if (/[\x00-\x1f\x7f*?]/.test(target) || target.includes("..."))
    return "characters";
  const normalize = (path: string) =>
    path.replaceAll("\\", "/").replace(/\/$/, "");
  const from = normalize(source),
    to = normalize(target);
  if (
    depot
      ? !to.startsWith("//") || target.includes("\\")
      : !to.startsWith("/") && !/^[A-Za-z]:\//.test(to)
  )
    return "absolute";
  const parts = to
    .replace(/^[A-Za-z]:/, "")
    .replace(/^\/+/, "")
    .split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    (to.startsWith("//") && parts.length < 3) ||
    to === ""
  )
    return "segments";
  if (to === from) return "same";
  const windows =
    !depot && (/^[A-Za-z]:\//.test(from) || source.startsWith("\\\\"));
  const comparableFrom = windows ? from.toLowerCase() : from;
  const comparableTo = windows ? to.toLowerCase() : to;
  if (directory && comparableTo.startsWith(comparableFrom + "/"))
    return "descendant";
}
