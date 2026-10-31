import { notifyManager } from "@tanstack/react-query";
import { beforeEach } from "vitest";
import { appCache } from "./shared/cache/appCache";

// Tests flush React work with act(), which drains microtasks but not timers.
// Deliver cached query results on a microtask so they land inside act().
notifyManager.setScheduler(queueMicrotask);

// Views share one process-wide data cache; each test starts without snapshots.
beforeEach(() => {
  appCache.clear();
});

// jsdom has no layout engine or observer APIs. The shadow-DOM diff renderer
// (virtualizer, scroll syncing) only needs these to exist, not to measure.
// Guard everything so node-environment suites can import this file too.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    configurable: true,
    value: ResizeObserverMock,
  });
}
if (!("IntersectionObserver" in globalThis)) {
  class IntersectionObserverMock {
    root = null;
    rootMargin = "";
    thresholds = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", {
    writable: true,
    configurable: true,
    value: IntersectionObserverMock,
  });
}
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
  });
}
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView)
  Element.prototype.scrollIntoView = function scrollIntoView() {};
// Constructable stylesheets back the diff web component's shadow styles.
if (
  typeof CSSStyleSheet !== "undefined" &&
  !("replaceSync" in CSSStyleSheet.prototype)
)
  Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", {
    writable: true,
    configurable: true,
    value(cssText: string) {
      (this as CSSStyleSheet & { p4deckCSS?: string }).p4deckCSS = cssText;
    },
  });
