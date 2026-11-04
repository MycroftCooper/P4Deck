import { t } from "../../../shared/i18n";
import { useState } from "react";
import { Dialog } from "../../../app/dialogs/Dialog";
import type { PendingChange } from "../../../shared/contracts";

export interface CheckoutDestination {
  changelistId: number;
  alwaysUseDefault: boolean;
}

export function CheckoutChangelistDialog({
  changes,
  client,
  count,
  recursive,
  source,
  zh,
  onClose,
}: {
  changes: Pick<PendingChange, "id" | "description">[];
  client: string;
  count: number;
  recursive: boolean;
  source: HTMLElement | null;
  zh: boolean;
  onClose(value: CheckoutDestination | null): void;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [snapshot] = useState(() =>
    changes
      .filter((change) => change.id > 0)
      .map(({ id, description }) => ({ id, description })),
  );
  const [selected, setSelected] = useState(0);
  const [alwaysUseDefault, setAlwaysUseDefault] = useState(false);
  const changelistId = alwaysUseDefault ? 0 : selected;
  const description =
    changelistId === 0
      ? t("files.default.pending.changelist")
      : (snapshot.find((change) => change.id === changelistId)?.description ??
        "");
  return (
    <Dialog
      title={t("files.select.checkout.changelist")}
      source={source}
      zh={zh}
      onRequestClose={() => onClose(null)}
      footer={
        <>
          <button onClick={() => onClose(null)}>{t("files.cancel")}</button>
          <button
            className="primary"
            onClick={() => onClose({ changelistId, alwaysUseDefault })}
          >
            {t("files.check.out")}
          </button>
        </>
      }
    >
      <div className="workflow-context">
        {client} · {count} {t("files.targets")}
        {recursive
          ? t("files.includes.files.in.selected.folders")
          : ""}
      </div>
      <label>
        {t("files.target.changelist")}
        <select
          autoFocus
          data-dialog-autofocus
          value={changelistId}
          disabled={alwaysUseDefault}
          onChange={(event) => setSelected(Number(event.target.value))}
        >
          <option value={0}>Default</option>
          {snapshot.map((change) => (
            <option key={change.id} value={change.id}>
              CL {change.id} · {change.description.split(/\r?\n/)[0]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("files.changelist.description")}
        <textarea readOnly rows={4} value={description} />
      </label>
      <label className="workflow-checkbox">
        <input
          type="checkbox"
          checked={alwaysUseDefault}
          onChange={(event) => setAlwaysUseDefault(event.target.checked)}
        />
        {tr(
          "不再询问，始终使用默认 CL",
          "Don't ask again; always use Default CL",
        )}
      </label>
    </Dialog>
  );
}
