import { t } from "../../shared/i18n";
import { Dialog } from "../../app/dialogs/Dialog";
import { backend } from "../../infrastructure/backend";
import { CompanySubmitPreparation } from "./CompanySubmitPreparation";
export function CompanySubmitDialog({
  changeId,
  connectionKey,
  source,
  zh,
  onClose,
}: {
  changeId: string;
  connectionKey: string;
  source: HTMLElement | null;
  zh: boolean;
  onClose(): void;
}) {
  return (
    <Dialog
      title={
        zh
          ? `自定义提交工具预览 · CL ${changeId}`
          : `Custom submit tool preview · CL ${changeId}`
      }
      source={source}
      zh={zh}
      onRequestClose={onClose}
      footer={<button onClick={onClose}>{t("companySubmit.close")}</button>}
    >
      <CompanySubmitPreparation
        changeIds={[changeId]}
        connectionKey={connectionKey}
        readSnapshot={backend.companySubmitConnectionSnapshot}
        zh={zh}
      />
    </Dialog>
  );
}
