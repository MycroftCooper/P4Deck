import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { copy } from "../../../app/context-menu/bindings";
import { useRecordSelection } from "../../../app/context-menu/useRecordSelection";
import { FileStatusIcon } from "../../files/components/FileStatusIcon";
import { useMenuEnvironment } from "../../../app/context-menu/environment";

export interface RevisionFileTarget {
  depotPath: string;
  revision: number;
  changeId: number;
}
/** Explicit revision targets. Never convert them into current-working-copy mutation targets. */
export function RevisionFileList({
  files,
  scope,
  demo,
}: {
  files: RevisionFileTarget[];
  scope: string;
  demo: boolean;
}) {
  const menu = useContextMenu();
  const {
    preferences: { zh },
  } = useMenuEnvironment();
  const selection = useRecordSelection(
    files,
    (file) => `${file.depotPath}#${file.revision}`,
    scope,
  );
  return (
    <section
      className="revision-file-list"
      aria-label="已提交文件 / Submitted files"
    >
      {demo && (
        <p className="preview-note">
          菜单 UI 示例文件，不是此 CL 的真实提交清单 / Menu UI samples, not
          actual files in this CL.
        </p>
      )}
      {files.map((file) => (
        <button
          key={file.depotPath}
          className={selection.isSelected(file) ? "selected" : ""}
          aria-pressed={selection.isSelected(file)}
          onClick={(event) => selection.select(file, event)}
          {...menu(
            selection.targets(file).length > 1 ? "C11" : "C10",
            () => ({
              "复制 Depot 路径": copy(file.depotPath),
              复制精确修订标识: copy(`${file.depotPath}#${file.revision}`),
              "复制所属 CL 编号": copy(file.changeId),
              "复制 Depot 路径列表": copy(
                selection
                  .targets(file)
                  .map((f) => f.depotPath)
                  .join("\n"),
              ),
              复制精确修订标识列表: copy(
                selection
                  .targets(file)
                  .map((f) => `${f.depotPath}#${f.revision}`)
                  .join("\n"),
              ),
            }),
            {
              title: `${demo ? "UI 示例 · " : ""}${file.depotPath}#${file.revision}`,
              onOpen: () => selection.context(file),
            },
          )}
        >
          <FileStatusIcon facts={{ scope: "revision" }} zh={zh} />
          <span>{file.depotPath}</span>
          <small>#{file.revision}</small>
        </button>
      ))}
      {!files.length && <p>文件清单尚未接入 / File list not connected yet.</p>}
    </section>
  );
}
