import type { PendingChangeSort } from "../../shared/contracts";
import { storage } from "../../shared/lib/storage";

const KEY = "p4deck.pending-filter.v1";

export function sortPendingChanges<T extends { id: number }>(
  items: T[],
  sort: PendingChangeSort,
): T[] {
  return [...items].sort((left, right) => {
    if (left.id === right.id) return 0;
    if (left.id === 0) return -1;
    if (right.id === 0) return 1;
    return sort === "newest" ? right.id - left.id : left.id - right.id;
  });
}

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
