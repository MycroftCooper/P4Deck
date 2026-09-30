import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceNode } from "../../shared/contracts/types";
import { resolveSelection } from "../../features/files/resolveSelection";
import { nodeKey } from "../../features/files/selection";
import { resolveAddress } from "../../features/files/resolveAddress";
import { isMultiPage, type PageId, type PanelTarget } from "../panels";
import type { CommandTarget } from "./commandPolicy";

export function useCommandTarget(
  connection: string,
  root: string | undefined,
  selected?: WorkspaceNode,
  selection: WorkspaceNode[] = [],
) {
  const [target, setTarget] = useState<CommandTarget>({ type: "none" });
  const [error, setError] = useState("");
  const serial = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const focus = useCallback(
    (value: CommandTarget) => {
      const generation = ++serial.current;
      setError("");
      setTarget(value);
      if (
        value.type === "file" &&
        (value.nodes ?? [value.node]).some(
          (n) => !n.absolutePath && n.depotPath,
        )
      ) {
        void resolveSelection(value.nodes ?? [value.node], connection, root)
          .then((nodes) => {
            if (generation === serial.current)
              setTarget({
                type: "file",
                node:
                  nodes.find((n) => nodeKey(n) === nodeKey(value.node)) ??
                  nodes.at(-1)!,
                nodes,
              });
          })
          .catch((cause) => {
            if (generation === serial.current) setError(String(cause));
          });
      }
    },
    [connection, root],
  );
  const lastConnection = useRef(connection);
  useEffect(() => {
    if (lastConnection.current !== connection) {
      lastConnection.current = connection;
      focus({ type: "none" });
    }
  }, [connection, focus]);
  useEffect(
    () => () => {
      serial.current++;
    },
    [],
  );
  const onTarget = useCallback(
    (page: PageId | null, params: PanelTarget, reason?: "parameters") => {
      const node = selectedRef.current;
      if (
        reason === "parameters" &&
        selectionRef.current.length > 1 &&
        node &&
        [node.absolutePath, node.depotPath].includes(params.target)
      )
        return;
      if (page === "files") {
        focus(
          node
            ? { type: "file", node, nodes: selectionRef.current }
            : { type: "none" },
        );
        return;
      }
      focus({ type: "none" });
      if (!page || !isMultiPage(page) || !params.target) return;
      if (node && [node.absolutePath, node.depotPath].includes(params.target)) {
        focus({ type: "file", node });
        return;
      }
      const generation = serial.current;
      void resolveAddress(params.target, connection, root)
        .then((node) => {
          if (generation === serial.current) setTarget({ type: "file", node });
        })
        .catch((cause) => {
          if (generation === serial.current) setError(String(cause));
        });
    },
    [connection, root, focus],
  );
  return { target, focus, onTarget, targetError: error };
}
