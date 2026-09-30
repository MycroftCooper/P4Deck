// React may unmount before an asynchronous listener registration resolves.
export function subscribeSafely(
  register: () => Promise<() => void>,
  onError: (error: unknown) => void = () => undefined,
) {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  void register()
    .then((stop) => {
      if (disposed) stop();
      else unsubscribe = stop;
    })
    .catch((error) => {
      if (!disposed) onError(error);
    });
  return () => {
    disposed = true;
    unsubscribe?.();
  };
}
