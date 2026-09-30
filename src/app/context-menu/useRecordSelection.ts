import {
  useEffect,
  useState,
  useMemo,
  type MouseEvent,
  type KeyboardEvent,
} from "react";

/** Stable keys and visible-order range selection, shared by non-file object lists. */
export function useRecordSelection<T>(
  rows: T[],
  keyOf: (row: T) => string,
  scope: string,
) {
  const [keys, setKeys] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string>();
  useEffect(() => {
    setKeys([]);
    setAnchor(undefined);
  }, [scope]);
  const selectedKeys = useMemo(() => new Set(keys), [keys]);
  const selected = rows.filter((row) => selectedKeys.has(keyOf(row)));
  const isSelected = (row: T) => selectedKeys.has(keyOf(row));
  const select = (
    row: T,
    event?: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">,
  ) => {
    const key = keyOf(row);
    if (event?.shiftKey && anchor) {
      const a = rows.findIndex((value) => keyOf(value) === anchor),
        b = rows.indexOf(row);
      if (a >= 0 && b >= 0) {
        setKeys(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(keyOf));
        return;
      }
    }
    setKeys((previous) =>
      event?.metaKey || event?.ctrlKey
        ? previous.includes(key)
          ? previous.filter((value) => value !== key)
          : [...previous, key]
        : [key],
    );
    setAnchor(key);
  };
  return {
    selected,
    isSelected,
    select,
    keyboard: (row: T, event: KeyboardEvent) => {
      // Only the row itself owns selection keys, not nested copy/action buttons.
      if (event.target !== event.currentTarget) return false;
      if (event.key !== "Enter" && event.key !== " ") return false;
      event.preventDefault();
      event.stopPropagation();
      select(row, event);
      return true;
    },
    context: (row: T) => {
      if (!isSelected(row)) select(row);
    },
    targets: (row: T) => (isSelected(row) ? selected : [row]),
    all: () => setKeys(rows.map(keyOf)),
    clear: () => setKeys([]),
  };
}
