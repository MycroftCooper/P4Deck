import {
  useEffect,
  useRef,
  useState,
  useMemo,
  type MouseEvent,
  type KeyboardEvent,
} from "react";

/** Stable keys and visible-order ranges. A finite maximum enables a FIFO selection queue. */
export function useRecordSelection<T>(
  rows: T[],
  keyOf: (row: T) => string,
  scope: string,
  maximum = Infinity,
) {
  const [keys, setKeys] = useState<string[]>([]);
  const [keysScope, setKeysScope] = useState(scope);
  const keysRef = useRef<string[]>([]);
  const anchorRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    keysRef.current = [];
    anchorRef.current = undefined;
    setKeys([]);
    setKeysScope(scope);
  }, [scope]);
  const selectedKeys = useMemo(
    () => new Set(keysScope === scope ? keys : []),
    [keys, keysScope, scope],
  );
  const rowsForKeys = (nextKeys: string[]) => {
    if (Number.isFinite(maximum)) {
      const byKey = new Map(rows.map((row) => [keyOf(row), row]));
      return nextKeys
        .filter((key) => byKey.has(key))
        .map((key) => byKey.get(key)!);
    }
    const nextSelected = new Set(nextKeys);
    return rows.filter((row) => nextSelected.has(keyOf(row)));
  };
  const selected = rowsForKeys(keysScope === scope ? keys : []);
  const isSelected = (row: T) => selectedKeys.has(keyOf(row));
  const liveKeys = Number.isFinite(maximum)
    ? JSON.stringify(rows.map(keyOf))
    : "";
  useEffect(() => {
    if (!Number.isFinite(maximum)) return;
    const valid = new Set<string>(JSON.parse(liveKeys));
    const next = keysRef.current
      .filter((key) => valid.has(key))
      .slice(-maximum);
    if (next.length !== keysRef.current.length) {
      keysRef.current = next;
      setKeys(next);
      if (anchorRef.current && !valid.has(anchorRef.current))
        anchorRef.current = undefined;
    }
  }, [liveKeys, maximum]);
  const commit = (nextKeys: string[], nextAnchor: string | undefined) => {
    const valid = Number.isFinite(maximum)
      ? new Set(rows.map(keyOf))
      : undefined;
    if (Number.isFinite(maximum)) {
      const queue: string[] = [];
      for (const key of nextKeys) {
        if (!valid!.has(key) || queue.includes(key)) continue;
        queue.push(key);
        if (queue.length > maximum) queue.shift();
      }
      nextKeys = queue;
    } else {
      nextKeys = [...new Set(nextKeys)];
    }

    setKeysScope(scope);
    keysRef.current = nextKeys;
    anchorRef.current = nextAnchor;
    setKeys(nextKeys);
    return rowsForKeys(nextKeys);
  };
  const selectTargets = (
    row: T,
    event?: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">,
  ) => {
    const key = keyOf(row);
    const currentAnchor = anchorRef.current;
    if (event?.shiftKey && currentAnchor) {
      const a = rows.findIndex((value) => keyOf(value) === currentAnchor),
        b = rows.indexOf(row);
      if (a >= 0 && b >= 0) {
        return commit(
          [
            ...(Number.isFinite(maximum) ? keysRef.current : []),
            ...rows.slice(Math.min(a, b), Math.max(a, b) + 1).map(keyOf),
          ],
          currentAnchor,
        );
      }
    }
    const previous = keysRef.current;
    return commit(
      Number.isFinite(maximum) || event?.metaKey || event?.ctrlKey
        ? previous.includes(key)
          ? previous.filter((value) => value !== key)
          : [...previous, key]
        : [key],
      key,
    );
  };
  const keyboardTargets = (row: T, event: KeyboardEvent) => {
    // Only the row itself owns selection keys, not nested copy/action buttons.
    if (event.target !== event.currentTarget) return false;
    if (event.key !== "Enter" && event.key !== " ") return false;
    event.preventDefault();
    event.stopPropagation();
    return selectTargets(row, event);
  };
  const contextTargets = (row: T) => {
    const key = keyOf(row);
    if (keysRef.current.includes(key)) return rowsForKeys(keysRef.current);
    return commit(
      Number.isFinite(maximum) ? [...keysRef.current, key] : [key],
      key,
    );
  };
  return {
    selected,
    isSelected,
    select: (
      row: T,
      event?: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">,
    ) => {
      selectTargets(row, event);
    },
    selectTargets,
    keyboard: (row: T, event: KeyboardEvent) =>
      keyboardTargets(row, event) !== false,
    keyboardTargets,
    context: (row: T) => {
      contextTargets(row);
    },
    contextTargets,
    targets: (row: T) => (isSelected(row) ? selected : [row]),
    all: () => {
      commit(
        Number.isFinite(maximum)
          ? [...keysRef.current, ...rows.map(keyOf)]
          : rows.map(keyOf),
        undefined,
      );
    },
    clear: () => {
      commit([], undefined);
    },
  };
}
