/**
 * Ctrl+G jumps to the Submitted page's "go to CL" input. The page may not be
 * mounted yet when the command runs (the dock creates it on demand), so the
 * request is remembered until the input appears.
 */
const FOCUS_EVENT = "p4deck:focus-submitted-cl";
let pending = false;

export function requestSubmittedClFocus() {
  pending = true;
  window.dispatchEvent(new Event(FOCUS_EVENT));
}

/** Consume a pending request; `false` when no focus was asked for. */
export function takeSubmittedClFocus() {
  const requested = pending;
  pending = false;
  return requested;
}

export function onSubmittedClFocus(handler: () => void) {
  window.addEventListener(FOCUS_EVENT, handler);
  return () => window.removeEventListener(FOCUS_EVENT, handler);
}
