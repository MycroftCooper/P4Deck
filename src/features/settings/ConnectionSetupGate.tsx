import { t } from "../../shared/i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { requestGuardedClose } from "../../app/closeGuard";
import { backend } from "../../infrastructure/backend";
import type { ConnectionProfiles, RuntimeInfo } from "../../shared/contracts";
import type { Preferences } from "../../app/hooks/usePreferences";
import type { useRuntime } from "../../app/hooks/useRuntime";
import { ConnectionProfilesCard } from "./ConnectionProfilesCard";
import { AppControls } from "../../app/shell/AppControls";
import { WindowControls } from "../../app/shell/WindowControls";
import { contextIdentity } from "./connectionWizard";

export function activeSetupKey(
  runtime: RuntimeInfo,
  profiles: ConnectionProfiles,
) {
  const profile = profiles.profiles.find(
    (p) =>
      p.id === runtime.activeProfileId && p.id === profiles.activeProfileId,
  );
  if (
    !profile ||
    ![
      profile.context.server,
      profile.context.user,
      profile.context.client,
    ].every((v) => v.trim())
  )
    return "";
  return contextIdentity(profile.context) === contextIdentity(runtime.context)
    ? `${profile.id}:${contextIdentity(profile.context)}`
    : "";
}

/** Only the existing Settings workflow can activate a new connection. */
export function ConnectionSetupGate({
  state,
  preferences,
  children,
}: {
  state: ReturnType<typeof useRuntime>;
  preferences: Preferences;
  children: ReactNode;
}) {
  const { runtime } = state;
  const zh = preferences.zh;
  const binding = JSON.stringify([
    runtime.activeProfileId,
    runtime.contextGeneration,
    runtime.context,
  ]);
  const [snapshot, setSnapshot] = useState<{
    binding: string;
    profiles: ConnectionProfiles;
  }>();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [retry, setRetry] = useState(0);
  // Frameless main window only: tests/embedded pages lack Tauri window metadata.
  const mainWindowDrag = (() => {
    if (!isTauri()) return undefined;
    try {
      return getCurrentWindow().label === "main" ? "deep" : undefined;
    } catch {
      return undefined;
    }
  })();
  const known = useRef(new Set<string>());
  const initialized = useRef(false);
  useEffect(() => {
    if (runtime.p4Version === "loading") return;
    let live = true;
    setError("");
    void backend
      .listConnectionProfiles()
      .then((profiles) => {
        if (!live) return;
        const key = activeSetupKey(runtime, profiles);
        // Existing persisted active profiles predate this guide. Do not block
        // their offline use; new profiles must pass the existing activation check.
        if (!initialized.current && key) known.current.add(key);
        initialized.current = true;
        setSnapshot({ binding, profiles });
      })
      .catch((cause) => {
        if (live) setError(String(cause));
      });
    return () => {
      live = false;
    };
  }, [binding, runtime.p4Version, retry]);
  const ready =
    runtime.p4Version !== "loading" && snapshot?.binding === binding;
  const key = ready ? activeSetupKey(runtime, snapshot.profiles) : "";
  if (
    key &&
    (known.current.has(key) || runtime.connection.state === "connected")
  ) {
    known.current.add(key);
    return children;
  }
  const displayError = error || state.error;
  const loading = !ready && !displayError;
  return (
    <section
      className="connection-setup"
      style={{ height: "100%", overflow: "auto", padding: 20, paddingTop: 0 }}
    >
      <header
        className="connection-setup-bar"
        data-tauri-drag-region={mainWindowDrag}
      >
        <h1 data-tauri-drag-region={mainWindowDrag}>
          P4Deck · {t("settings.connection.setup")}
        </h1>
        <div
          className="connection-setup-actions"
          data-tauri-drag-region="false"
        >
          <AppControls preferences={preferences} />
          {isTauri() && (
            <button
              onClick={() =>
                void requestGuardedClose("application").catch(console.error)
              }
            >
              {t("settings.exit.application")}
            </button>
          )}
        </div>
        {mainWindowDrag && <WindowControls zh={zh} />}
      </header>
      {displayError && (
        <div role="alert">
          {displayError}
          <button onClick={() => setRetry((n) => n + 1)}>
            {t("settings.reload.profiles")}
          </button>
        </div>
      )}
      {loading ? (
        <p role="status">{t("settings.loading.connection.profiles")}</p>
      ) : editing ? (
        <>
          <p role="status">{t("settings.save.a.connection.then.activate")}</p>
          <ConnectionProfilesCard
            runtime={runtime}
            onRuntime={state.applyRuntime}
            onConnection={state.applyConnection}
            locale={preferences.locale}
          />
        </>
      ) : (
        <SetupPrompt zh={zh} onConfigure={() => setEditing(true)} />
      )}
    </section>
  );
}

function SetupPrompt({
  zh: _zh,
  onConfigure,
}: {
  zh: boolean;
  onConfigure(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const configureRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    configureRef.current?.focus();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="workflow-dialog"
      aria-labelledby="connection-setup-title"
      aria-describedby="connection-setup-description"
      onCancel={(event) => event.preventDefault()}
    >
      <header className="workflow-dialog-heading">
        <h2 id="connection-setup-title">{t("settings.set.up.p4.to.get")}</h2>
      </header>
      <div className="workflow-dialog-body">
        <p id="connection-setup-description">
          {t("settings.no.p4.connection.is.active")}
        </p>
      </div>
      <footer className="workflow-dialog-footer">
        {isTauri() && (
          <button
            onClick={() =>
              void requestGuardedClose("application").catch(console.error)
            }
          >
            {t("settings.exit.application")}
          </button>
        )}
        <button ref={configureRef} autoFocus onClick={onConfigure}>
          {t("settings.configure.p4")}
        </button>
      </footer>
    </dialog>
  );
}
