import { useContext } from "react";
import { CommandExecutionContext } from "../shell/CommandContext";
import {
  commandReason,
  type CommandId,
  type CommandTarget,
} from "../shell/commandPolicy";
import type {
  LocalPathCapabilities,
  WorkspaceNode,
} from "../../shared/contracts/types";
import { backend } from "../../infrastructure/backend";
import { workspaceCache } from "../../features/files/workspaceQueries";
import { resolveSelection } from "../../features/files/resolveSelection";
import { menuCatalog, type MenuObjectId } from "./catalog";
import { useContextMenu } from "./ContextMenu";
import { useMenuEnvironment } from "./environment";
import { action, copy } from "./bindings";
import type { MenuBindings } from "./model";

const commands: Record<string, CommandId> = {
  "移到 CL…": "moveFiles",
  "搁置所选文件…": "shelve",
  "搁置此文件…": "shelve",
  "解决冲突…": "resolve",
  "重命名/移动…": "rename",
  "重命名/移动目录…": "rename",
  "获取整个工作区最新版本…": "getLatest",
  "获取整个工作区指定版本…": "getRevision",
  "签出整个工作区适用文件…": "checkout",
  "标记删除整个工作区受控文件…": "delete",
  "还原整个工作区…": "revert",
  "获取映射范围最新版本…": "getLatest",
  "获取映射范围指定版本…": "getRevision",
  "签出映射范围适用文件…": "checkout",
  "标记删除映射范围受控文件…": "delete",
  "还原映射范围文件…": "revert",
  文件预览: "preview",
  获取最新: "getLatest",
  "获取指定版本…": "getRevision",
  "签出…": "checkout",
  "添加到 P4…": "add",
  "标记删除…": "delete",
  "还原…": "revert",
  "还原此文件…": "revert",
  "与 have 版本比较": "diff",
  文件历史: "history",
  修订图: "revgraph",
  "其他软件打开…": "openWith",
  系统中定位: "reveal",
  "获取最新…": "getLatest",
  "获取最新（递归）…": "getLatest",
  "获取最新（含递归）…": "getLatest",
  "获取指定版本（递归）…": "getRevision",
  "获取指定版本（含递归）…": "getRevision",
  "签出（递归）…": "checkout",
  "签出（含递归）…": "checkout",
  "添加未跟踪文件（递归）…": "add",
  "添加未跟踪文件（含递归）…": "add",
  "标记删除（递归）…": "delete",
  "标记删除（含递归）…": "delete",
  "还原（递归）…": "revert",
  "还原（含递归）…": "revert",
  "标记删除所选文件…": "delete",
  "还原所选文件…": "revert",
};

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
            ? "整个工作区（配置根目录） / Entire configured workspace"
            : undefined,
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
            reason:
              "尚未确认此 Depot 在当前工作区的映射范围 / Workspace mapping scope not verified",
          };
        if (item.label.startsWith("复制 › ")) {
          const field = /文件名|目录名|名称/.test(item.label)
            ? "name"
            : /Depot/.test(item.label)
              ? "depotPath"
              : /相对/.test(item.label)
                ? "relativePath"
                : "absolutePath";
          const values = resolved.map((n) => n[field]);
          bindings[item.label] = values.every(Boolean)
            ? copy(values.join("\n"))
            : { reason: "部分目标没有此路径 / Some targets have no such path" };
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
            : "目标路径尚未确定 / Target path is unknown",
        );
      bindings["在工作区中定位"] = action(
        () => env.navigate(node),
        node.absolutePath ? undefined : "尚无工作区映射 / No workspace mapping",
      );
      bindings["在 Depot 中定位"] = action(
        () =>
          env.navigate({
            ...node,
            absolutePath: "",
            relativePath: node.depotPath!,
          }),
        node.depotPath ? undefined : "没有 Depot 路径 / No depot path",
      );
      for (const label of ["在此目录搜索", "在工作区中搜索", "在此 Depot 搜索"])
        bindings[label] = action(
          () => env.searchInDirectory(node.depotPath || node.absolutePath),
          node.depotPath || node.absolutePath ? undefined : "没有目录路径",
        );
      return { ...bindings, ...options.bindings };
    };
    return menu(
      object,
      () =>
        makeBindings(nodes, env.runtime.mode === "tauri" ? null : undefined),
      {
        title:
          nodes.length > 1
            ? `${nodes.length} ${env.preferences.zh ? "项已选择" : "selected"} · ${nodes.filter((n) => n.kind === "file").length} ${env.preferences.zh ? "文件" : "files"} / ${nodes.filter((n) => n.kind === "directory").length} ${env.preferences.zh ? "目录" : "folders"}`
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
