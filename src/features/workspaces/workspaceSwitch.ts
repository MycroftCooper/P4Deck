import { t } from "../../shared/i18n";
export function switchFailure(cause: unknown, zh: boolean) {
  const value =
    cause && typeof cause === "object"
      ? (cause as { code?: string; message?: string })
      : undefined;
  const code = value?.code ?? String(cause).match(/(?:Error:\s*)?(\w+):/)?.[1];
  const recovery: Record<string, [string, string]> = {
    contextChanged: [
      t("workspaces.the.active.connection.changed.refresh.workspaces"),
      t("workspaces.the.active.connection.changed.refresh.workspaces"),
    ],
    authenticationRequired: [
      t("workspaces.the.current.profile.requires.login.authenticate"),
      t("workspaces.the.current.profile.requires.login.authenticate"),
    ],
    connectionFailed: [
      t("workspaces.target.workspace.verification.failed.check.its"),
      t("workspaces.target.workspace.verification.failed.check.its"),
    ],
    notFound: [
      t("workspaces.the.target.workspace.no.longer.exists"),
      t("workspaces.the.target.workspace.no.longer.exists"),
    ],
  };
  const copy = code ? recovery[code] : undefined;
  return copy
    ? zh
      ? copy[0]
      : copy[1]
    : t("workspaces.the.switch.request.did.not");
}
