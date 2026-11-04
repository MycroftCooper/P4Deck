import { t } from "../../shared/i18n";
import { useState } from "react";
import { CompanySubmitPreview } from "./CompanySubmitPreview";
import {
  useCompanySubmitSnapshot,
  type SnapshotReader,
} from "./useCompanySubmitSnapshot";
/** Memory-only path editor. It never plans locally, probes a file, or launches a tool. */
export function CompanySubmitPreparation({
  changeIds,
  connectionKey,
  readSnapshot,
  zh = true,
}: {
  changeIds: readonly string[];
  connectionKey: string;
  readSnapshot: SnapshotReader;
  zh?: boolean;
}) {
  const [executablePath, setExecutablePath] = useState("");
  const scope = JSON.stringify([connectionKey, changeIds]);
  const { state, refresh } = useCompanySubmitSnapshot(scope, readSnapshot);
  return (
    <section>
      <label>
        {t("companySubmit.local.absolute.exe.path")}
        <input
          value={executablePath}
          onChange={(e) => setExecutablePath(e.target.value)}
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        disabled={state.status === "loading"}
        onClick={() => void refresh()}
      >
        {t("companySubmit.refresh.connection.identity")}
      </button>
      {state.status === "loading" ? (
        <p role="status">
          {t("companySubmit.reading.host.connection.identity")}
        </p>
      ) : state.status === "error" ? (
        <p role="alert">
          {t("companySubmit.connection.identity.unavailable.real.launch")}
        </p>
      ) : (
        <CompanySubmitPreview
          request={{ changeIds, executablePath, connection: state.snapshot }}
          requestId={JSON.stringify([
            scope,
            state.snapshot.generation,
            executablePath,
          ])}
          zh={zh}
        />
      )}
      {state.status !== "ready" && (
        <button type="button" disabled>
          {t("companySubmit.launch.custom.submit.tool.disabled")}
        </button>
      )}
    </section>
  );
}
