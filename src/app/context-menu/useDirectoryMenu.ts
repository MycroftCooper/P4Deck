import { t } from "../../shared/i18n";
import { useContextMenu } from "./ContextMenu";
import { useMenuEnvironment } from "./environment";
import { action, copy } from "./bindings";
import { backend } from "../../infrastructure/backend";
import { resolveAddress } from "../../features/files/resolveAddress";
import { workspaceCache } from "../../features/files/workspaceQueries";

export function useDirectoryMenu(
  path: string | undefined,
  refresh: () => void | Promise<unknown>,
  selectAll: () => void,
  clear: () => void,
) {
  const menu = useContextMenu(),
    env = useMenuEnvironment();
  const directory = path ?? env.runtime.context.cwd ?? "";
  return menu(
    "F09",
    () => ({
      刷新当前列表: action(refresh),
      全选当前筛选结果: action(selectAll),
      清除选择: action(clear),
      复制当前目录路径: copy(directory),
      在当前目录搜索: action(
        () => env.searchInDirectory(directory),
        directory ? undefined : t("contextMenu.noCurrentDirectory"),
      ),
      系统中定位当前目录: {
        reason:
          env.runtime.mode === "tauri"
            ? t("shell.checking.folder")
            : t("shell.desktop.app.required"),
      },
    }),
    {
      resolve: async () => {
        if (!directory || env.runtime.mode !== "tauri") return {};
        const node = await resolveAddress(
          directory,
          env.connectionKey,
          env.runtime.context.cwd,
        );
        const caps = await workspaceCache.fetchQuery({
          queryKey: [
            "local-path-capabilities",
            env.connectionKey,
            node.absolutePath,
          ],
          queryFn: () => backend.localPathCapabilities(node.absolutePath),
          staleTime: 1000,
        });
        return {
          系统中定位当前目录: action(
            () =>
              backend.openLocalPath({
                path: node.absolutePath,
                mode: "reveal",
              }),
            caps.reveal ? undefined : t("contextMenu.localDirectoryMissing"),
          ),
        };
      },
    },
  );
}
