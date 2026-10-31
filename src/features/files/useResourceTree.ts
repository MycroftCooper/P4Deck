import { useEffect, useState } from "react";
import { useQueries, type QueryKey } from "@tanstack/react-query";
import type { DepotNode, WorkspaceListing } from "../../shared/contracts";
import { hydrateSnapshot, persistId } from "../../shared/cache/snapshots";
import { depotNodeAsWorkspaceNode } from "./fileListModel";
import {
  depotQuery,
  isDepotNodeList,
  isWorkspaceListing,
  localWorkspaceQuery,
  mergeWorkspaceListings,
  refreshWorkspaceDirectory,
  workspaceCache,
  workspaceQuery,
} from "./workspaceQueries";
import {
  expandedResourcePaths,
  flattenResourceTree,
  type ResourceFolder,
  type ResourceTreeMode,
} from "./resourceTree";

export function useResourceTree(
  connectionKey: string,
  mode: ResourceTreeMode,
  enabled: boolean,
  filter: string,
  statusReady = enabled,
) {
  const [state, setState] = useState({
    connectionKey,
    workspace: new Set<string>(),
    depot: new Set<string>(),
  });
  const [cacheState, setCacheState] = useState({
    owner: "",
    keys: new Set<string>(),
  });
  const expanded =
    state.connectionKey === connectionKey ? state[mode] : new Set<string>();
  const owner = `${mode}\0${connectionKey}`;
  const paths = expandedResourcePaths(mode, expanded, (path) => {
    if (mode === "workspace")
      return (
        workspaceCache.getQueryData<WorkspaceListing>(
          workspaceQuery(connectionKey, path || undefined).queryKey,
        )?.items ??
        workspaceCache.getQueryData<WorkspaceListing>(
          localWorkspaceQuery(connectionKey, path || undefined).queryKey,
        )?.items ??
        []
      );
    return (
      workspaceCache.getQueryData<DepotNode[]>(
        depotQuery(connectionKey, path || undefined).queryKey,
      ) || []
    ).map(depotNodeAsWorkspaceNode);
  });
  const pathSignature = paths.join("\0");
  const cacheTargets = (
    path: string,
  ): Array<{
    key: QueryKey;
    validate: (value: unknown) => value is unknown;
  }> =>
    mode === "workspace"
      ? [
          {
            key: localWorkspaceQuery(connectionKey, path || undefined).queryKey,
            validate: isWorkspaceListing,
          },
          {
            key: workspaceQuery(connectionKey, path || undefined).queryKey,
            validate: isWorkspaceListing,
          },
        ]
      : [
          {
            key: depotQuery(connectionKey, path || undefined).queryKey,
            validate: isDepotNodeList,
          },
        ];
  const cacheReady = (path: string, kind?: "local" | "status") =>
    cacheTargets(path)
      .filter((_target, index) => {
        if (mode === "depot" || !kind) return true;
        return kind === "local" ? index === 0 : index === 1;
      })
      .every(
        (target) =>
          workspaceCache.getQueryData(target.key) !== undefined ||
          (cacheState.owner === owner &&
            cacheState.keys.has(persistId(target.key))),
      );
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const missing = paths
      .flatMap((path) => cacheTargets(path))
      .filter(
        (target) =>
          workspaceCache.getQueryData(target.key) === undefined &&
          !(
            cacheState.owner === owner &&
            cacheState.keys.has(persistId(target.key))
          ),
      );
    if (!missing.length) return;
    void Promise.all(
      missing.map((target) =>
        hydrateSnapshot(target.key, target.validate, { revalidate: true }),
      ),
    ).then(() => {
      if (!live) return;
      setCacheState((old) => {
        const current =
          old.owner === owner ? old : { owner, keys: new Set<string>() };
        const keys = new Set(current.keys);
        for (const target of missing) keys.add(persistId(target.key));
        return keys.size === current.keys.size ? current : { owner, keys };
      });
    });
    return () => {
      live = false;
    };
  }, [cacheState.keys, cacheState.owner, enabled, owner, pathSignature]);
  const directories = useQueries(
    {
      queries:
        mode === "workspace"
          ? paths.map((path) => ({
              ...localWorkspaceQuery(connectionKey, path || undefined),
              enabled: enabled && cacheReady(path, "local"),
              placeholderData: workspaceCache.getQueryData<WorkspaceListing>(
                localWorkspaceQuery(connectionKey, path || undefined).queryKey,
              ),
            }))
          : [],
    },
    workspaceCache,
  );
  const workspace = useQueries(
    {
      queries:
        mode === "workspace"
          ? paths.map((path) => ({
              ...workspaceQuery(connectionKey, path || undefined),
              enabled: enabled && statusReady && cacheReady(path, "status"),
              placeholderData: workspaceCache.getQueryData<WorkspaceListing>(
                workspaceQuery(connectionKey, path || undefined).queryKey,
              ),
            }))
          : [],
    },
    workspaceCache,
  );
  const depot = useQueries(
    {
      queries:
        mode === "depot"
          ? paths.map((path) => ({
              ...depotQuery(connectionKey, path || undefined),
              enabled: enabled && cacheReady(path),
              placeholderData: workspaceCache.getQueryData<DepotNode[]>(
                depotQuery(connectionKey, path || undefined).queryKey,
              ),
            }))
          : [],
    },
    workspaceCache,
  );
  const folders = new Map<string, ResourceFolder>(
    paths.map((path, index) => {
      const local = workspace[index];
      const directory = directories[index];
      const data = mergeWorkspaceListings(directory?.data, local?.data);
      const remote = depot[index];
      const query = mode === "workspace" ? local : remote;
      const hasData =
        mode === "workspace" ? data !== undefined : remote?.data !== undefined;
      const warnings: string[] = [];
      if (hasData && query?.error)
        warnings.push(`Background refresh failed: ${String(query.error)}`);
      if (hasData && directory?.error)
        warnings.push(
          `Local directory refresh failed: ${String(directory.error)}`,
        );
      if (mode === "workspace" && local?.data) {
        if (local.data.completeness !== "complete")
          warnings.push(
            local.data.errors.map((error) => error.message).join(" · ") ||
              "Partial status evidence",
          );
        const localWarnings = directory?.data?.errors
          .map((error) => error.message)
          .join(" · ");
        if (localWarnings) warnings.push(localWarnings);
      }
      return [
        path,
        {
          items:
            mode === "workspace"
              ? data?.items || []
              : (remote?.data || []).map(depotNodeAsWorkspaceNode),
          loaded: hasData,
          loading:
            !hasData &&
            (!!query?.isFetching ||
              !!directory?.isFetching ||
              (enabled &&
                (!cacheReady(path, "local") ||
                  (statusReady && !cacheReady(path, "status"))))),
          error: hasData
            ? undefined
            : query?.error || directory?.error
              ? String(query?.error ?? directory?.error)
              : undefined,
          warning:
            [...new Set(warnings.filter(Boolean))].join(" · ") || undefined,
        },
      ];
    }),
  );
  const toggle = (path: string, open?: boolean) =>
    setState((old) => {
      const current =
        old.connectionKey === connectionKey
          ? old
          : {
              connectionKey,
              workspace: new Set<string>(),
              depot: new Set<string>(),
            };
      const next = new Set(current[mode]);
      if (open ?? !next.has(path)) next.add(path);
      else next.delete(path);
      return { ...current, [mode]: next };
    });
  const refresh = async (path?: string) => {
    const targets = path === undefined ? paths : [path];
    await Promise.all(
      targets.map((target) =>
        mode === "workspace"
          ? refreshWorkspaceDirectory(
              connectionKey,
              target || undefined,
              statusReady,
            )
          : workspaceCache.fetchQuery({
              ...depotQuery(connectionKey, target || undefined),
              staleTime: 0,
            }),
      ),
    );
  };
  return {
    expanded,
    folders,
    toggle,
    refresh,
    root: folders.get("")!,
    rows: flattenResourceTree(mode, expanded, folders, filter),
  };
}
