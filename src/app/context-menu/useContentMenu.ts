import { useContextMenu } from "./ContextMenu";
import { action, copy } from "./bindings";
import { useMenuEnvironment } from "./environment";
import { resolveAddress } from "../../features/files/resolveAddress";
import { backend } from "../../infrastructure/backend";
import type { MenuBindings } from "./model";
import type { MenuObjectId } from "./catalog";

/** Content menus retain the page target, never the workspace's latest selection. */
export function useContentMenu() {
  const menu = useContextMenu(),
    env = useMenuEnvironment();
  return (
    object: MenuObjectId,
    path: string,
    extra: () => MenuBindings = () => ({}),
  ) =>
    menu(
      object,
      () => ({
        复制文件路径: copy(path),
        复制当前目标标识: copy(path),
        ...extra(),
        系统中定位: {
          reason:
            env.runtime.mode === "mock"
              ? "请在桌面应用中使用 / Desktop app required"
              : "正在检查本地路径 / Checking local path",
        },
        "其他软件打开…": {
          reason:
            env.runtime.mode === "mock"
              ? "请在桌面应用中使用 / Desktop app required"
              : "正在检查本地路径 / Checking local path",
        },
      }),
      {
        title: path.split(/[\\/]/).pop() || "内容 / Content",
        resolve: async () => {
          if (!path || env.runtime.mode !== "tauri") return {};
          const node = await resolveAddress(
            path,
            env.connectionKey,
            env.runtime.context.cwd,
          );
          const caps = await backend.localPathCapabilities(node.absolutePath);
          return {
            系统中定位: action(
              () =>
                backend.openLocalPath({
                  path: node.absolutePath,
                  mode: "reveal",
                }),
              caps.reveal ? undefined : "本地文件不存在或不在工作区内",
            ),
            "其他软件打开…": action(
              () =>
                backend.openLocalPath({
                  path: node.absolutePath,
                  mode: "openWith",
                }),
              caps.openWith ? undefined : "没有可用的本地文件",
            ),
          };
        },
      },
    );
}
