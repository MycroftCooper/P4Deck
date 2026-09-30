import { useCallback, useEffect, useRef, useState } from "react";

/** One pending request per channel; cancellation settles callers on scope change/unmount. */
export function useDialogRequest<T, R>(scope: string) {
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const mounted = useRef(true);
  const [entry, setEntry] = useState<{ scope: string; value: T }>();
  const pending = useRef<((value: R | null) => void) | undefined>(undefined);
  const answer = useCallback((value: R | null) => {
    const resolve = pending.current;
    pending.current = undefined;
    setEntry(undefined);
    resolve?.(value);
  }, []);
  useEffect(() => {
    mounted.current = true;
    setEntry(undefined);
    return () => {
      mounted.current = false;
      pending.current?.(null);
      pending.current = undefined;
    };
  }, [scope]);
  const ask = (value: T): Promise<R | null> => {
    if (!mounted.current || latestScope.current !== scope)
      return Promise.resolve(null);
    if (pending.current) return Promise.resolve(null);
    return new Promise((resolve) => {
      pending.current = resolve;
      setEntry({ scope, value });
    });
  };
  return {
    request: entry?.scope === scope ? entry.value : undefined,
    ask,
    answer,
  };
}
