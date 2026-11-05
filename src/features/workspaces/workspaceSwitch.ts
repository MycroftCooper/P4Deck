import { tFor } from "../../shared/i18n";
export function switchFailure(cause: unknown, zh: boolean) {
  const value =
    cause && typeof cause === "object"
      ? (cause as { code?: string; message?: string })
      : undefined;
  const code = value?.code ?? String(cause).match(/(?:Error:\s*)?(\w+):/)?.[1];
  const recovery: Record<string, string> = {
    contextChanged:
      "workspaces.the.active.connection.changed.refresh.workspaces",
    authenticationRequired:
      "workspaces.the.current.profile.requires.login.authenticate",
    connectionFailed: "workspaces.target.failed.check",
    notFound: "workspaces.the.target.workspace.no.longer.exists",
  };
  const key = code ? recovery[code] : undefined;
  return tFor(
    zh ? "zh-CN" : "en-US",
    (key ?? "workspaces.the.request.did") as never,
  );
}
