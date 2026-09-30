import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceNode } from "../../shared/contracts/types";
import { parentPath } from "../../features/files/address";
import {
  reconcileSelection,
  type FileSelection,
} from "../../features/files/selectionState";
import { useCommandTarget } from "../shell/useCommandTarget";

/** Coordinates list selection and command focus; docking remains owned by Dockview. */
export function useWorkspaceSelection(
  connectionKey: string,
  root: string | undefined,
  openFiles: () => void,
) {
  const [selection, setSelection] = useState<FileSelection>({ nodes: [] });
  const [directory, setDirectory] = useState<string>();
  const command = useCommandTarget(
    connectionKey,
    root,
    selection.primary,
    selection.nodes,
  );
  const select = useCallback(
    (nodes: WorkspaceNode[], primary = nodes.at(-1)) => {
      setSelection({ nodes, primary });
      command.focus(
        primary ? { type: "file", node: primary, nodes } : { type: "none" },
      );
    },
    [command.focus],
  );
  useEffect(() => {
    const target = command.target;
    if (target.type !== "file") return;
    setSelection((current) =>
      reconcileSelection(current, target.nodes ?? [target.node], target.node),
    );
  }, [command.target]);
  useEffect(() => {
    setSelection({ nodes: [] });
    setDirectory(undefined);
  }, [connectionKey]);
  const navigate = useCallback(
    (node: WorkspaceNode) => {
      const next =
        node.kind === "directory"
          ? node.absolutePath || node.depotPath
          : parentPath(node.absolutePath || node.depotPath || "");
      setDirectory(next === root ? undefined : next);
      openFiles();
      select([node], node);
    },
    [root, openFiles, select],
  );
  const context = useMemo(
    () => ({ nodes: selection.nodes, select }),
    [selection.nodes, select],
  );
  return {
    selectedFile: selection.primary,
    directory,
    command,
    navigate,
    context,
  };
}
