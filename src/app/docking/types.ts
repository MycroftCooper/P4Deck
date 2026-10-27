import type { ReactNode } from "react";
import type { PageId, PanelTarget, RevisionComparison } from "../panels";
import type { PanelRuntimeBinding } from "./floatingPanels";
export const detachedPage =
  typeof location === "undefined"
    ? null
    : new URLSearchParams(location.search).get("panel");
export interface DockHandle {
  open(
    page: PageId,
    target?: string,
    newInstance?: boolean,
    comparison?: RevisionComparison,
  ): void;
  closeAll(): void;
  popoutPage(page: PageId): Promise<void>;
}
export interface DockProps {
  zh: boolean;
  pages: PageId[];
  active: PageId | null;
  selectedPath?: string;
  selectedLocalPath?: string;
  labels: Record<PageId, string>;
  runtimeBinding: PanelRuntimeBinding;
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
