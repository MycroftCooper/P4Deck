import type { PendingChangeSort } from "../../shared/contracts/types";
import { storage } from "../../shared/lib/storage";

const KEY = "p4deck.pending-filter.v1";

export interface PendingFilterState {
  keyword: string;
  sort: PendingChangeSort;
}

export function readPendingFilterState(): PendingFilterState {
  try {
    const value = JSON.parse(
      storage.getItem(KEY) ?? "null",
    ) as Partial<PendingFilterState>;
    if (
      !value ||
      typeof value.keyword !== "string" ||
      value.keyword.length > 4_096 ||
      (value.sort !== "newest" && value.sort !== "oldest")
    )
      throw new Error("invalid saved pending filter");
    return { keyword: value.keyword, sort: value.sort };
  } catch {
    return { keyword: "", sort: "newest" };
  }
}

export function writePendingFilterState(value: PendingFilterState): void {
  storage.setItem(
    KEY,
    JSON.stringify({
      keyword: value.keyword.slice(0, 4_096),
      sort: value.sort,
    }),
  );
}
