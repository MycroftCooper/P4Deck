import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceNode } from "../../shared/contracts";
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
  const revealSequence = useRef(0);
  const [reveal, setReveal] = useState<{
    id: number;
    connectionKey: string;
    path: string;
  }>();
  const consumeReveal = useCallback(
    (id: number) =>
      setReveal((current) => (current?.id === id ? undefined : current)),
    [],
  );
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
    setReveal(undefined);
  }, [connectionKey]);
  const navigate = useCallback(
    (node: WorkspaceNode) => {
      const next =
        node.kind === "directory"
          ? node.absolutePath || node.depotPath
          : parentPath(node.absolutePath || node.depotPath || "");
      setDirectory(next === root ? undefined : next);
      setReveal(
        node.absolutePath
          ? {
              id: ++revealSequence.current,
              connectionKey,
              path: node.absolutePath,
            }
          : undefined,
      );
      openFiles();
      select([node], node);
    },
    [root, openFiles, select, connectionKey],
  );
  const context = useMemo(
    () => ({ nodes: selection.nodes, select }),
    [selection.nodes, select],
  );
  return {
    reveal,
    consumeReveal,
    selectedFile: selection.primary,
    directory,
    command,
    navigate,
    context,
  };
}
