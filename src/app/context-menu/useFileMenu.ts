import { t as translate } from "../../shared/i18n";
import { copyFieldFor, isCopyMenu } from "./copyMenu";
import { fileMenuCommands } from "./fileMenuCommands";
import { useContext } from "react";
import { CommandExecutionContext } from "../shell/CommandContext";
import { commandReason, type CommandTarget } from "../shell/commandPolicy";
import type {
  LocalPathCapabilities,
  WorkspaceNode,
} from "../../shared/contracts";
import { backend } from "../../infrastructure/backend";
import { workspaceCache } from "../../features/files/workspaceQueries";
import {
  resolveSelection,
  canOfferResolve,
} from "../../features/files/resolveSelection";
import { menuCatalog, type MenuObjectId } from "./catalog";
import { useContextMenu } from "./ContextMenu";
import { useMenuEnvironment } from "./environment";
import { action, copy } from "./bindings";
import type { MenuBindings } from "./model";

const commands = fileMenuCommands;

export function useFileMenu() {
  const menu = useContextMenu();
  const env = useMenuEnvironment();
  const execute = useContext(CommandExecutionContext);
  return (
    nodes: WorkspaceNode[],
    primary: WorkspaceNode,
    options: {
      depot?: boolean;
      object?: MenuObjectId;
      onOpen?: () => void;
      refresh?: () => void | Promise<unknown>;
      bindings?: MenuBindings;
      wholeChangelistId?: number;
    } = {},
  ) => {
    const object =
      options.object ??
      (nodes.length > 1
        ? nodes.some((n) => n.kind === "directory")
          ? "F08"
          : "F07"
        : primary.kind === "directory"
          ? options.depot
            ? primary.depotPath?.split("/").filter(Boolean).length === 1
              ? "F06"
              : "F04"
            : "F03"
          : options.depot
            ? "F02"
            : "F01");
    const makeBindings = (
      resolved: WorkspaceNode[],
      capabilities?: LocalPathCapabilities | null,
    ) => {
      const node =
        resolved.find(
          (n) =>
            n.id === primary.id ||
            (n.depotPath && n.depotPath === primary.depotPath),
        ) ?? resolved[0];
      const target: CommandTarget = {
        type: "file",
        node,
        nodes: resolved,
        scopeLabel:
          object === "F05"
            ? translate("contextMenu.entire.configured.workspace")
            : undefined,
        ...(options.wholeChangelistId !== undefined
          ? { wholeChangelistId: options.wholeChangelistId }
          : {}),
      };
      const bindings: MenuBindings = {};
      bindings["复制工作区根路径"] = copy(node.absolutePath);
      bindings["复制 Depot 路径"] = copy(node.depotPath);
      for (const item of menuCatalog[object].items) {
        const id = commands[item.label];
        if (id)
          bindings[item.label] = action(
            (source) => execute(id, target, source),
            commandReason(
              id,
              target,
              env.commandBusy,
              env.runtime.mode === "tauri",
              env.preferences.zh,
              capabilities,
            ),
          );
        if (
          object === "F06" &&
          id &&
          ["getLatest", "getRevision", "checkout", "delete", "revert"].includes(
            id,
          )
        )
          bindings[item.label] = {
            reason: translate(
              "contextMenu.workspace.mapping.scope.not.verified",
            ),
          };
        if (isCopyMenu(item.label)) {
          const field = copyFieldFor(item.label);
          const values = resolved.map((n) => n[field]);
          bindings[item.label] = values.every(Boolean)
            ? copy(values.join("\n"))
            : {
                reason: translate("contextMenu.some.targets.have.no.such.path"),
              };
        }
      }
      for (const label of ["刷新状态", "刷新目录", "刷新"])
        bindings[label] = action(
          options.refresh ?? (() => execute("refresh", target)),
        );
      bindings["在新页签中预览"] = action(
        () => env.openFilePage("preview", node, true),
        commandReason(
          "preview",
          target,
          env.commandBusy,
          env.runtime.mode === "tauri",
          env.preferences.zh,
        ),
      );
      for (const label of [
        "浏览此目录",
        "浏览此 Depot",
        "在文件页中显示",
        "在所在目录显示",
      ])
        bindings[label] = action(
          () => env.navigate(node),
          node.absolutePath || node.depotPath
            ? undefined
            : translate("contextMenu.target.path.is.unknown"),
        );
      bindings["在工作区中定位"] = action(
        () => env.navigate(node),
        node.absolutePath
          ? undefined
          : translate("contextMenu.no.workspace.mapping"),
      );
      bindings["在 Depot 中定位"] = action(
        () =>
          env.navigate({
            ...node,
            absolutePath: "",
            relativePath: node.depotPath!,
          }),
        node.depotPath ? undefined : translate("contextMenu.no.depot.path"),
      );
      for (const label of ["在此目录搜索", "在工作区中搜索", "在此 Depot 搜索"])
        bindings[label] = action(
          () => env.searchInDirectory(node.depotPath || node.absolutePath),
          node.depotPath || node.absolutePath
            ? undefined
            : translate("contextMenu.noDirectoryPath"),
        );
      const merged = { ...bindings, ...options.bindings };
      // Unresolved files resolve normally; already resolved (not yet submitted)
      // files re-resolve with `p4 resolve -f`. Only a truly clean selection
      // hides the entry instead of offering an always-failing action.
      const resolveItem = merged["解决冲突…"];
      if (!canOfferResolve(resolved)) {
        merged["解决冲突…"] = { ...(resolveItem ?? {}), hidden: true };
      } else if (resolveItem && !resolveItem.reason) {
        merged["解决冲突…"] = {
          ...resolveItem,
          emphasis: "primary",
        };
      }
      return merged;
    };
    return menu(
      object,
      () =>
        makeBindings(nodes, env.runtime.mode === "tauri" ? null : undefined),
      {
        title:
          nodes.length > 1
            ? `${nodes.length} ${translate("contextMenu.selected")} · ${nodes.filter((n) => n.kind === "file").length} ${translate("contextMenu.files")} / ${nodes.filter((n) => n.kind === "directory").length} ${translate("contextMenu.folders")}`
            : primary.name,
        onOpen: options.onOpen,
        resolve: async () => {
          const resolved = await resolveSelection(
            nodes,
            env.connectionKey,
            env.runtime.context.cwd,
          );
          const path = resolved.length === 1 ? resolved[0].absolutePath : "";
          const capabilities =
            env.runtime.mode === "tauri" && path
              ? await workspaceCache.fetchQuery({
                  queryKey: [
                    "local-path-capabilities",
                    env.connectionKey,
                    path,
                  ],
                  queryFn: () => backend.localPathCapabilities(path),
                  staleTime: 1000,
                })
              : { reveal: false, openWith: false };
          return makeBindings(resolved, capabilities);
        },
      },
    );
  };
}
