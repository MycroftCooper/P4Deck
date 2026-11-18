/**
 * Context menus for the search result list.
 *
 * The S01–S05 inventory in `app/context-menu/catalog.ts` describes what a search
 * result can offer. Search results are deliberately *not* complete workspace
 * rows: the host payload carries a path (and, for CL rows, a change number) and
 * nothing else. This module therefore
 *
 *  - derives the smallest honest `WorkspaceNode` a result supports,
 *  - routes every entry through the same command channel (`execute(id, target)`)
 *    the Files/Pending tables use, so a click can never fabricate success, and
 *  - disables what the payload cannot prove (local copy, depot path, file state)
 *    with the shared, already-localised reasons instead of guessing.
 */
import { tFor, type MsgKey } from "../../shared/i18n";
import { writeClipboardText } from "../../infrastructure/clipboard";
import { backend } from "../../infrastructure/backend";
import type {
  GlobalSearchItem,
  GlobalSearchKind,
  WorkspaceNode,
} from "../../shared/contracts";
import { menuCatalog } from "../../app/context-menu/catalog";
import {
  useContextMenu,
  type MenuTriggerEvent,
} from "../../app/context-menu/ContextMenu";
import { action, copy } from "../../app/context-menu/bindings";
import { copyFieldFor, isCopyMenu } from "../../app/context-menu/copyMenu";
import { fileMenuCommands } from "../../app/context-menu/fileMenuCommands";
import type { MenuBindings } from "../../app/context-menu/model";
import type { MenuEnvironmentValue } from "../../app/context-menu/environment";
import {
  commandReason,
  type CommandId,
  type CommandTarget,
} from "../../app/shell/commandPolicy";

/** Everything the menu builders need; captured per render by the caller. */
export interface SearchMenuDeps {
  execute(id: CommandId, target: CommandTarget, source?: HTMLElement): void;
  env: MenuEnvironmentValue;
  /** Native desktop host: system actions need it. */
  native: boolean;
  /** Locale of the page, matching the menu panel's own locale. */
  zh: boolean;
  commandBusy: boolean;
  /** Open one result (the same navigation a left click performs). */
  openItem(item: GlobalSearchItem): void;
  /** Re-run the accepted query (S05 "search again"). */
  rerunSearch(): void;
  /** Re-read one result category, replacing that category's rows. */
  rerunCategory(kind: GlobalSearchKind): void;
  selectAll(): void;
  clearSelection(): void;
  /** Text of the accepted query, for "copy current query". */
  queryText(): string;
}

const text = (deps: SearchMenuDeps, key: MsgKey) =>
  tFor(deps.zh ? "zh-CN" : "en-US", key);

const lastSegment = (path: string, separators: RegExp) =>
  path.split(separators).filter(Boolean).pop() ?? path;

/**
 * Workspace-relative path with the workspace root removed, mirroring the host's
 * `plain_relative` (separator folding plus case-insensitive prefix on Windows).
 * Returns "" when the path is outside the root, so the copy entry is disabled
 * rather than printing an absolute path under a "relative path" label.
 */
export function workspaceRelativePath(
  absolutePath: string,
  cwd?: string,
): string {
  const root = (cwd ?? "").trim().replace(/[\\/]+$/, "");
  if (!root || absolutePath.length <= root.length) return "";
  const fold = (value: string) => value.replaceAll("/", "\\").toLowerCase();
  if (fold(absolutePath.slice(0, root.length)) !== fold(root)) return "";
  const separator = absolutePath[root.length];
  if (separator !== "\\" && separator !== "/") return "";
  return absolutePath.slice(root.length + 1);
}

/**
 * The node a file result can honestly claim.
 *
 * `workspaceFile` rows come from a `p4 fstat` sweep of the client view, so the
 * file is depot-controlled; whether the local copy exists is not in the payload,
 * which is exactly what the capability checks and `getLatest` are for. A
 * `depotFile` row is depot-only, which the rest of the app models as "missing
 * locally".
 */
export function searchResultNode(
  item: GlobalSearchItem,
  cwd?: string,
): WorkspaceNode | undefined {
  const target = item.target;
  if (target.type === "workspaceFile") {
    const absolutePath = target.absolutePath;
    if (!absolutePath) return undefined;
    return {
      id: absolutePath,
      name: lastSegment(absolutePath, /[\\/]/),
      kind: "file",
      absolutePath,
      relativePath: workspaceRelativePath(absolutePath, cwd),
      state: "controlled",
    };
  }
  if (target.type === "depotFile") {
    const depotPath = target.depotPath;
    if (!depotPath) return undefined;
    return {
      id: depotPath,
      name: lastSegment(depotPath, /\//),
      kind: "file",
      absolutePath: "",
      relativePath: "",
      depotPath,
      state: "missing",
    };
  }
  return undefined;
}

export function isFileSearchResult(item: GlobalSearchItem) {
  return item.kind === "workspaceFile" || item.kind === "depotFile";
}

/** Selected file rows as nodes, in list order and without duplicates. */
export function fileResultNodes(
  items: readonly GlobalSearchItem[],
  cwd?: string,
): WorkspaceNode[] {
  const nodes: WorkspaceNode[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const node = searchResultNode(item, cwd);
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  return nodes;
}

/** Numbered changelist a CL row addresses (submitted, pending or shelved). */
export function changelistSearchResultId(
  item: GlobalSearchItem,
): number | undefined {
  const target = item.target;
  if (
    target.type === "submittedChange" ||
    target.type === "pendingChange" ||
    target.type === "shelf"
  )
    return Number.isSafeInteger(target.changeId) ? target.changeId : undefined;
  return undefined;
}

/** `//a/b/c` -> `//a/b`; the mainline's parent is empty. */
export function parentStreamPath(streamPath: string) {
  const trimmed = streamPath.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  if (cut <= 1) return "";
  return trimmed.slice(0, cut);
}

/**
 * The description of one result's changelist.
 *
 * A search row carries the description only inside a prose summary together with
 * the owner and client, so it is re-read from the same authoritative source the
 * CL pages use instead of being split out of display text.
 */
export async function changelistDescription(
  item: GlobalSearchItem,
  zh: boolean,
): Promise<string> {
  const changeId = changelistSearchResultId(item);
  const missing = () =>
    new Error(
      tFor(zh ? "zh-CN" : "en-US", "search.menu.change.description.missing"),
    );
  if (changeId === undefined) throw missing();
  const operationId = `search-copy-description-${crypto.randomUUID()}`;
  if (item.kind === "submittedChange") {
    const detail = await backend.getSubmittedChangeDetail({
      changeId,
      operationId,
    });
    if (detail.description.trim()) return detail.description;
    throw detail.message ? new Error(detail.message) : missing();
  }
  if (item.kind === "pendingChange") {
    const page = await backend.queryPendingChanges({
      operationId,
      requestGeneration: 1,
      // The Pending query matches the CL number, so one page covers this row.
      keyword: String(changeId),
      sort: "newest",
      pageSize: 100,
    });
    const change = [
      ...(page.defaultChange ? [page.defaultChange] : []),
      ...page.items,
    ].find((value) => value.id === changeId);
    if (change?.description.trim()) return change.description;
    throw missing();
  }
  if (item.kind === "shelf") {
    const detail = await backend.getShelfDetail({
      changeId,
      requestGeneration: 1,
      pageSize: 1,
    });
    if (detail.description.trim()) return detail.description;
    throw missing();
  }
  throw missing();
}

/** Every file entry of S01/S02, plus the entries that are not command-bound. */
export function fileResultBindings(
  nodes: WorkspaceNode[],
  primary: WorkspaceNode,
  deps: SearchMenuDeps,
): MenuBindings {
  const object = nodes.length > 1 ? "S02" : "S01";
  const target: CommandTarget = { type: "file", node: primary, nodes };
  const reason = (id: CommandId) =>
    commandReason(id, target, deps.commandBusy, deps.native, deps.zh);
  const bindings: MenuBindings = {};
  for (const entry of menuCatalog[object].items) {
    const id = fileMenuCommands[entry.label];
    if (id)
      bindings[entry.label] = action(
        (source) => deps.execute(id, target, source),
        reason(id),
      );
    if (isCopyMenu(entry.label)) {
      const values = nodes.map((node) => node[copyFieldFor(entry.label)]);
      bindings[entry.label] = values.every(Boolean)
        ? copy(values.join("\n"))
        : { reason: text(deps, "contextMenu.some.targets.have.no.such.path") };
    }
  }
  // Both preview entries open the same page; the tab variant must not reuse the
  // current preview panel.
  bindings["在新页签中预览"] = action(
    () => deps.env.openFilePage("preview", primary, true),
    reason("preview"),
  );
  bindings["在所在目录显示"] = action(
    () => deps.env.navigate(primary),
    primary.absolutePath || primary.depotPath
      ? undefined
      : text(deps, "contextMenu.target.path.is.unknown"),
  );
  bindings["在工作区中定位"] = action(
    () => deps.env.navigate(primary),
    primary.absolutePath
      ? undefined
      : text(deps, "contextMenu.no.workspace.mapping"),
  );
  bindings["在 Depot 中定位"] = action(
    () =>
      deps.env.navigate({
        ...primary,
        absolutePath: "",
        relativePath: primary.depotPath ?? "",
      }),
    primary.depotPath ? undefined : text(deps, "contextMenu.no.depot.path"),
  );
  bindings["刷新状态"] = action((source) =>
    deps.execute("refresh", target, source),
  );
  return bindings;
}

/** S03: read-only CL entry points; the full action set stays in the CL pages. */
export function changelistResultBindings(
  item: GlobalSearchItem,
  deps: SearchMenuDeps,
): MenuBindings {
  const changeId = changelistSearchResultId(item);
  return {
    "打开 CL 详情": action(() => deps.openItem(item)),
    "复制 CL 编号": copy(changeId),
    复制描述: action(async () =>
      writeClipboardText(await changelistDescription(item, deps.zh)),
    ),
    刷新此结果: action(() => deps.rerunCategory(item.kind)),
  };
}

/** W04: the search list also shows stream rows; they keep the Streams menu. */
export function streamResultBindings(
  item: GlobalSearchItem,
  deps: SearchMenuDeps,
): MenuBindings {
  const stream = item.target.type === "stream" ? item.target.streamPath : "";
  return {
    查看详情: action(() => deps.openItem(item)),
    "复制 Stream 路径": copy(stream),
    复制名称: copy(item.title),
    "复制父 Stream 路径": copy(parentStreamPath(stream)),
    刷新: action(() => deps.rerunCategory(item.kind)),
  };
}

/** S05: the results blank area. */
export function blankResultBindings(deps: SearchMenuDeps): MenuBindings {
  return {
    复制当前查询条件: copy(deps.queryText()),
    全选结果: action(() => deps.selectAll()),
    清除选择: action(() => deps.clearSelection()),
    重新执行搜索: action(() => deps.rerunSearch()),
  };
}

const selectedTitle = (count: number, deps: SearchMenuDeps) =>
  `${count} ${text(deps, "contextMenu.selected")}`;

/** Props a result row spreads to become right-clickable and Shift+F10 reachable. */
export type RowMenuProps = {
  "data-menu-object": string;
  onContextMenu(event: MenuTriggerEvent): void;
  onKeyDown(
    event: MenuTriggerEvent & {
      key: string;
      shiftKey: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
    },
  ): void;
};

/**
 * Binds the inventory objects to the row menus. `menu()` is not a hook: it only
 * derives event handlers from the surrounding provider, so it can be called from
 * inside the row render like the Files and Pending tables do.
 */
export function useSearchMenus() {
  const menu = useContextMenu();
  return {
    fileRow(
      nodes: WorkspaceNode[],
      primary: WorkspaceNode,
      deps: SearchMenuDeps,
      onOpen: () => void,
    ) {
      return menu(
        nodes.length > 1 ? "S02" : "S01",
        () => fileResultBindings(nodes, primary, deps),
        {
          title:
            nodes.length > 1 ? selectedTitle(nodes.length, deps) : primary.name,
          onOpen,
        },
      );
    },
    changelistRow(item: GlobalSearchItem, deps: SearchMenuDeps) {
      return menu("S03", () => changelistResultBindings(item, deps), {
        title: item.title,
      });
    },
    streamRow(item: GlobalSearchItem, deps: SearchMenuDeps) {
      return menu("W04", () => streamResultBindings(item, deps), {
        title: item.title,
      });
    },
    blankArea(deps: SearchMenuDeps) {
      return menu("S05", () => blankResultBindings(deps), {
        title: text(deps, "search.results"),
      });
    },
  };
}
