import type { ReactNode } from "react";
import type { PageId, PanelTarget } from "../panels";
export const detachedPage = new URLSearchParams(location.search).get("panel");
export interface DockHandle {
  open(page: PageId, target?: string, newInstance?: boolean): void;
  closeAll(): void;
}
export interface DockProps {
  zh: boolean;
  pages: PageId[];
  active: PageId | null;
  selectedPath?: string;
  selectedLocalPath?: string;
  labels: Record<PageId, string>;
  render(
    page: PageId,
    target: PanelTarget,
    changeTarget: (path: string) => void,
  ): ReactNode;
  onActive(page: PageId | null): void;
  onTarget?(
    page: PageId | null,
    target: PanelTarget,
    reason?: "parameters",
  ): void;
  onPages(pages: PageId[]): void;
}
