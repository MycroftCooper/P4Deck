import { tFor } from "../../shared/i18n";
import { backend } from "../../infrastructure/backend";
import type {
  RuntimeInfo,
  SwitchWorkspaceRequest,
} from "../../shared/contracts";

interface WorkspaceSwitchApi {
  switchWorkspace(request: SwitchWorkspaceRequest): Promise<RuntimeInfo>;
  runtimeInfo(): Promise<RuntimeInfo>;
}

export interface WorkspaceSwitchAttempt {
  /** Runtime the caller must apply, either the switch result or a resync. */
  runtime?: RuntimeInfo;
  /** Failure to report when the switch still did not happen. */
  error?: unknown;
}

function failureCode(cause: unknown) {
  const value =
    cause && typeof cause === "object"
      ? (cause as { code?: string; message?: string })
      : undefined;
  return value?.code ?? String(cause).match(/(?:Error:\s*)?(\w+):/)?.[1];
}

export function switchFailure(cause: unknown, zh: boolean) {
  const code = failureCode(cause);
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

/**
 * A switch is generation-checked, so a frontend whose runtime lags behind (a
 * missed `connection-changed`, or a switch response that landed after the
 * switcher unmounted) is rejected with `contextChanged` before the backend
 * verifies anything, and every retry keeps failing on the same stale value.
 * Re-read the authoritative runtime once and retry inside the same profile,
 * server and user; a real connection change still needs the reviewed flow.
 */
export async function switchWorkspaceWithResync(
  request: SwitchWorkspaceRequest,
  current: RuntimeInfo,
  api: WorkspaceSwitchApi = backend,
): Promise<WorkspaceSwitchAttempt> {
  try {
    return { runtime: await api.switchWorkspace(request) };
  } catch (cause) {
    if (failureCode(cause) !== "contextChanged") return { error: cause };
    let fresh: RuntimeInfo;
    try {
      fresh = await api.runtimeInfo();
    } catch {
      return { error: cause };
    }
    // The backend already holds the requested workspace: the old request lost
    // the race with a switch that did land, so only the runtime needs syncing.
    if (fresh.context.client === request.client) return { runtime: fresh };
    const sameConnection =
      fresh.activeProfileId === current.activeProfileId &&
      fresh.context.server === current.context.server &&
      fresh.context.user === current.context.user;
    if (
      !sameConnection ||
      fresh.contextGeneration === request.expectedGeneration
    )
      return { runtime: fresh, error: cause };
    try {
      return {
        runtime: await api.switchWorkspace({
          expectedGeneration: fresh.contextGeneration,
          client: request.client,
        }),
      };
    } catch (retryCause) {
      return { runtime: fresh, error: retryCause };
    }
  }
}
