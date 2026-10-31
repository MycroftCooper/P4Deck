import { createContext, useContext } from "react";
import type { RuntimeInfo, WorkspaceNode } from "../../shared/contracts";
import type { FilePageId, PageId } from "../panels";
import type { Preferences } from "../hooks/usePreferences";

export interface MenuEnvironmentValue {
  runtime: RuntimeInfo;
  connectionKey: string;
  commandBusy: boolean;
  openPage(page: PageId): void;
  searchDirectory?: string;
  searchInDirectory(path: string): void;
  navigate(node: WorkspaceNode): void;
  getOperationContext?(): { connectionKey: string; runtime: RuntimeInfo };
  reportOperationError?(
    event: import("../../infrastructure/backend/frontendOperationLog").FrontendOperationLog,
  ): void;
  openFilePage(page: FilePageId, node: WorkspaceNode, fresh?: boolean): void;
  preferences: Preferences;
}
export const MenuEnvironment = createContext<MenuEnvironmentValue | null>(null);
export function useMenuEnvironment() {
  const value = useContext(MenuEnvironment);
  if (!value) throw new Error("Menu environment is missing");
  return value;
}
