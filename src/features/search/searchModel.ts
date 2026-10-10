import type {
  GlobalSearchItem,
  GlobalSearchKind,
} from "../../shared/contracts/types";

export const GLOBAL_SEARCH_KINDS: readonly GlobalSearchKind[] = [
  "submittedChange",
  "pendingChange",
  "workspaceFile",
  "depotFile",
  "job",
  "stream",
  "shelf",
];

export const GLOBAL_SEARCH_PAGE_SIZE = 50;
export const GLOBAL_SEARCH_MAX_CHARACTERS = 128;

export type SearchValidation =
  | { valid: true; text: string }
  | { valid: false; reason: "empty" | "control" | "tooLong" };

/** Mirrors the Rust boundary: Unicode whitespace is collapsed and limits count code points. */
export function validateSearchText(value: string): SearchValidation {
  if ([...value].some((character) => /\p{Cc}/u.test(character)))
    return { valid: false, reason: "control" };
  const text = value.trim().replace(/\s+/gu, " ");
  if (!text) return { valid: false, reason: "empty" };
  if ([...text].length > GLOBAL_SEARCH_MAX_CHARACTERS)
    return { valid: false, reason: "tooLong" };
  return { valid: true, text };
}

export function mergeSearchItems(
  current: GlobalSearchItem[],
  incoming: GlobalSearchItem[],
): GlobalSearchItem[] {
  const identities = new Set(current.map((item) => item.identity));
  return [
    ...current,
    ...incoming.filter((item) => {
      if (identities.has(item.identity)) return false;
      identities.add(item.identity);
      return true;
    }),
  ];
}

export function itemsFromGroups(
  groups: Array<{ items: GlobalSearchItem[] }>,
): GlobalSearchItem[] {
  return groups.flatMap((group) => group.items);
}

export interface TextSegment {
  text: string;
  highlighted: boolean;
}

/** Applies trusted UTF-16 offsets with string slicing; callers render text nodes, never HTML. */
export function highlightedSegments(
  value: string,
  field: string,
  highlights: GlobalSearchItem["highlights"],
): TextSegment[] {
  const ranges = highlights
    .filter(
      (highlight) =>
        highlight.field === field &&
        Number.isInteger(highlight.start) &&
        Number.isInteger(highlight.end) &&
        highlight.start >= 0 &&
        highlight.end > highlight.start &&
        highlight.start < value.length,
    )
    .map((highlight) => ({
      start: highlight.start,
      end: Math.min(highlight.end, value.length),
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .reduce<Array<{ start: number; end: number }>>((merged, range) => {
      const prior = merged.at(-1);
      if (prior && range.start <= prior.end)
        prior.end = Math.max(prior.end, range.end);
      else merged.push(range);
      return merged;
    }, []);
  if (!ranges.length) return [{ text: value, highlighted: false }];
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor)
      segments.push({
        text: value.slice(cursor, range.start),
        highlighted: false,
      });
    segments.push({
      text: value.slice(range.start, range.end),
      highlighted: true,
    });
    cursor = range.end;
  }
  if (cursor < value.length)
    segments.push({ text: value.slice(cursor), highlighted: false });
  return segments;
}

export function errorMessage(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(cause);
}
