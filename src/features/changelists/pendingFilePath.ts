import type { PendingFile, P4Context } from "../../shared/contracts";
import { plainLocalPath } from "../../shared/lib/plainPath";

/** Display mapped paths without changing the depot identity used by operations. */
export function pendingFilePath(file: PendingFile, context: P4Context): string {
  const path = plainLocalPath(file.clientPath ?? "").replace(/\\/g, "/");
  if (!path) return file.depotPath;
  const clientPrefix = `//${context.client}/`;
  if (context.client && path.startsWith(clientPrefix))
    return path.slice(clientPrefix.length) || file.depotPath;
  const root = context.cwd
    ? plainLocalPath(context.cwd).replace(/\\/g, "/").replace(/\/+$/, "")
    : undefined;
  if (
    context.cwd &&
    root !== undefined &&
    (!path.startsWith("//") || root.startsWith("//"))
  ) {
    const prefix = `${root}/`;
    // Drive-letter paths are case-insensitive; Unix and P4 paths are not.
    const windows = /^[a-z]:\//i.test(path) || path.startsWith("//");
    if (
      windows
        ? path.toLowerCase().startsWith(prefix.toLowerCase())
        : path.startsWith(prefix)
    )
      return path.slice(prefix.length) || file.depotPath;
  }
  return file.depotPath;
}
