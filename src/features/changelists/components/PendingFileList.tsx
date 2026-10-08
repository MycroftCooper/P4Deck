import { FileStatusIcon } from "../../files/components/FileStatusIcon";
import { useMenuEnvironment } from "../../../app/context-menu/environment";
import { useMemo } from "react";
import type {
  PendingFile,
  WorkspaceNode,
} from "../../../shared/contracts/types";
import { useFileMenu } from "../../../app/context-menu/useFileMenu";
import { useContextMenu } from "../../../app/context-menu/ContextMenu";
import { useRecordSelection } from "../../../app/context-menu/useRecordSelection";
import { copy, action } from "../../../app/context-menu/bindings";
import { useCommandFocus } from "../../../app/shell/CommandContext";

export function PendingFileList({
  files,
  changeId,
  shelf = false,
  refresh,
  onMove,
  onShelf,
}: {
  files: PendingFile[];
  changeId: number;
  shelf?: boolean;
  refresh(): void;
  onMove?(paths: string[]): void;
  onShelf?(mode: "shelve" | "delete" | "unshelve", paths: string[]): void;
}) {
  const nodes = useMemo(
    () =>
      files.map((file): WorkspaceNode => ({
        id: file.depotPath,
        name: file.depotPath.split("/").pop()!,
        depotPath: file.depotPath,
        absolutePath: "",
        relativePath: file.depotPath,
        kind: "file",
        state: file.state ?? "controlled",
        changelistId: changeId,
      })),
    [files, changeId],
  );
  const selection = useRecordSelection(
    nodes,
    (node) => node.id,
    `${changeId}:${shelf}`,
  );
  const fileMenu = useFileMenu();
  const menu = useContextMenu();
  const focus = useCommandFocus();
  const {
    preferences: { zh },
  } = useMenuEnvironment();
  return (
    <>
      {nodes.map((node, index) => (
        <div
          key={node.id}
          className={`pending-file ${shelf ? "shelf" : ""} ${selection.isSelected(node) ? "selected" : ""}`}
          tabIndex={0}
          role="button"
          aria-pressed={selection.isSelected(node)}
          onKeyDownCapture={(event) => {
            if (selection.keyboard(node, event) && !shelf)
              focus({ type: "file", node });
          }}
          onClick={(event) => {
            selection.select(node, event);
            if (!shelf) focus({ type: "file", node });
          }}
          {...(shelf
            ? menu(
                selection.targets(node).length > 1 ? "C08" : "C07",
                () => ({
                  ...Object.fromEntries(
                    ["删除此搁置文件…", "删除所选搁置文件…"].map((label) => [
                      label,
                      action(
                        () =>
                          onShelf?.(
                            "delete",
                            selection.targets(node).map((n) => n.depotPath!),
                          ),
                        onShelf ? undefined : "入口尚未接通 / Not connected",
                      ),
                    ]),
                  ),
                  ...Object.fromEntries(
                    ["Unshelve 此文件…", "Unshelve 所选搁置文件…"].map(
                      (label) => [
                        label,
                        action(
                          () =>
                            onShelf?.(
                              "unshelve",
                              selection.targets(node).map((n) => n.depotPath!),
                            ),
                          onShelf ? undefined : "入口尚未接通 / Not connected",
                        ),
                      ],
                    ),
                  ),
                  "复制 Depot 路径": copy(node.depotPath),
                  复制搁置来源标识: copy(`${node.depotPath}@=${changeId}`),
                  "复制 Depot 路径列表": copy(
                    selection
                      .targets(node)
                      .map((n) => n.depotPath)
                      .join("\n"),
                  ),
                  复制搁置来源标识列表: copy(
                    selection
                      .targets(node)
                      .map((n) => `${n.depotPath}@=${changeId}`)
                      .join("\n"),
                  ),
                  刷新: action(refresh),
                }),
                { onOpen: () => selection.context(node) },
              )
            : fileMenu(selection.targets(node), node, {
                object: selection.targets(node).length > 1 ? "C05" : "C04",
                refresh,
                bindings: {
                  ...Object.fromEntries(
                    ["搁置此文件…", "搁置所选文件…"].map((label) => [
                      label,
                      action(
                        () =>
                          onShelf?.(
                            "shelve",
                            selection.targets(node).map((n) => n.depotPath!),
                          ),
                        onShelf ? undefined : "入口尚未接通 / Not connected",
                      ),
                    ]),
                  ),
                  ...(onMove
                    ? {
                        "移到 CL…": action(() =>
                          onMove(
                            selection.targets(node).map((n) => n.depotPath!),
                          ),
                        ),
                      }
                    : {}),
                },
                onOpen: () => {
                  selection.context(node);
                  focus({ type: "file", node, nodes: selection.targets(node) });
                },
              }))}
        >
          <FileStatusIcon
            facts={{ ...files[index], scope: shelf ? "shelf" : "workspace" }}
            zh={zh}
          />
          <span>{node.depotPath}</span>
          <em>{files[index].action}</em>
        </div>
      ))}
    </>
  );
}
