// Coalesce splitter/selection events; flush on pagehide so the latest layout survives.
export function deferredTask(task: () => void, delay = 120) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  function flush() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      task();
    }
  }
  return {
    schedule() {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        task();
      }, delay);
    },
    flush,
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
