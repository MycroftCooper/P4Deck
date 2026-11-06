export type DirtyCategory =
  | "connectionSettings"
  | "changelistDescription"
  | "manualMerge"
  | "customToolSettings"
  | "otherDraft";

export type CloseState = "clean" | "dirty" | "unknown";

/** One instance per renderer/window. Never stores editor contents. */
export class CloseStateRegistry {
  private ready = false;
  private uncertain = false;
  private editors = new Map<
    symbol,
    {
      state: CloseState;
      attached: boolean;
      lease: number;
      category: DirtyCategory;
      knownDirty: boolean;
    }
  >();
  private dirtyEpoch = 0;
  private resolvedEpoch = 0;
  private acceptedDirty = new Map<
    string,
    { sequence: number; epoch: number }
  >();
  dirtyVersion() {
    return this.dirtyEpoch;
  }
  private hasDirty() {
    return [...this.editors.values()].some((editor) => editor.knownDirty);
  }
  private resolved() {
    if (!this.hasDirty()) this.resolvedEpoch = this.dirtyEpoch;
  }
  resolutionFor(generation: string) {
    const dirty = this.acceptedDirty.get(generation);
    return this.snapshot() === "unknown" &&
      !this.hasDirty() &&
      dirty &&
      this.resolvedEpoch >= dirty.epoch
      ? dirty.sequence
      : undefined;
  }
  rememberAcceptedDirty(generation: string, sequence: number, epoch: number) {
    if (sequence <= (this.acceptedDirty.get(generation)?.sequence ?? 0)) return;
    this.acceptedDirty.set(generation, { sequence, epoch });
    // A save/discard can occur while the dirty acknowledgement is in flight.
    if (this.resolutionFor(generation) !== undefined) this.notify();
  }
  private listeners = new Set<() => void>();
  private sequences = new Map<string, number>();
  nextSequence(generation: string) {
    const next = (this.sequences.get(generation) ?? 0) + 1;
    if (!Number.isSafeInteger(next)) return undefined;
    this.sequences.set(generation, next);
    return next;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify() {
    this.listeners.forEach((listener) => listener());
  }
  setReady(ready: boolean) {
    this.ready = ready;
    this.notify();
  }
  markUnknown() {
    this.uncertain = true;
    this.notify();
  }
  snapshot(): CloseState {
    const states = [...this.editors.values()].map((editor) => editor.state);
    if (this.hasDirty()) return "dirty";
    return !this.ready || this.uncertain || states.includes("unknown")
      ? "unknown"
      : "clean";
  }
  dirtyCategories(): DirtyCategory[] {
    return [
      ...new Set(
        [...this.editors.values()]
          .filter((editor) => editor.knownDirty)
          .map((editor) => editor.category),
      ),
    ].sort();
  }
  attach(
    token: symbol,
    state: CloseState,
    category: DirtyCategory = "otherDraft",
  ) {
    const previous = this.editors.get(token);
    const lease = (previous?.lease ?? 0) + 1;
    const knownDirty =
      state === "dirty" || (state === "unknown" && !!previous?.knownDirty);
    if (knownDirty && !previous?.knownDirty) this.dirtyEpoch++;
    this.editors.set(token, {
      state,
      attached: true,
      lease,
      category,
      knownDirty,
    });
    if (previous?.knownDirty && !knownDirty) this.resolved();
    this.notify();
    return () => {
      const editor = this.editors.get(token);
      if (!editor || editor.lease !== lease) return;
      editor.attached = false;
      // StrictMode reattaches the same token before this microtask. A genuine
      // unexpected removal cannot silently dispose of an unsaved editor.
      queueMicrotask(() => {
        if (editor.attached || this.editors.get(token) !== editor) return;
        if (editor.state === "clean") this.editors.delete(token);
        // An unexpected unmount cannot erase an explicitly known dirty edit.
        this.notify();
      });
    };
  }
  /** Explicit save/discard may release this editor even after a scope transition. */
  clear(token: symbol) {
    const editor = this.editors.get(token);
    if (!editor) return;
    const wasDirty = editor.knownDirty;
    editor.knownDirty = false;
    if (editor.attached) editor.state = "clean";
    else this.editors.delete(token);
    if (wasDirty) this.resolved();
    this.notify();
  }
  update(token: symbol, state: CloseState, category?: DirtyCategory) {
    const editor = this.editors.get(token);
    if (
      !editor?.attached ||
      (editor.state === state && (!category || editor.category === category))
    )
      return;
    if (category) editor.category = category;
    const wasDirty = editor.knownDirty;
    if (state === "dirty" && !wasDirty) {
      editor.knownDirty = true;
      this.dirtyEpoch++;
    }
    if (state === "clean") editor.knownDirty = false;
    editor.state = state;
    if (wasDirty && !editor.knownDirty) this.resolved();
    this.notify();
  }
}

export interface CloseGuardWire {
  register(): Promise<{ generation: string }>;
  report(value: {
    generation: string;
    sequence: number;
    state: CloseState;
    probeId: string | null;
    dirtyCategories?: DirtyCategory[];
    resolvedDirtyThroughSequence?: number;
  }): Promise<{ accepted: boolean }>;
}

export function connectCloseGuard(
  registry: CloseStateRegistry,
  wire: CloseGuardWire,
) {
  let live = true,
    generation: string | undefined;
  let failed = false;
  const fail = () => {
    if (live && !failed) {
      failed = true;
      registry.markUnknown();
    }
  };
  const report = (probeId: string | null) => {
    if (!live || !generation || failed) return;
    const sequence = registry.nextSequence(generation);
    if (sequence === undefined) {
      fail();
      return;
    }
    const dirtyEpoch = registry.dirtyVersion();
    const resolvedDirtyThroughSequence = registry.resolutionFor(generation);
    const payload = {
      generation,
      sequence,
      state: registry.snapshot(),
      dirtyCategories: registry.dirtyCategories(),
      probeId,
      ...(resolvedDirtyThroughSequence === undefined
        ? {}
        : { resolvedDirtyThroughSequence }),
    };
    void wire
      .report(payload)
      .then((value) => {
        if (!value.accepted) fail();
        else if (payload.state === "dirty")
          registry.rememberAcceptedDirty(
            payload.generation,
            payload.sequence,
            dirtyEpoch,
          );
      })
      .catch(fail);
  };
  const unsubscribe = registry.subscribe(() => report(null));
  // Registration is the only host handshake: the state is pushed on every
  // registry change, so there is no inbound probe channel to subscribe to.
  void (async () => {
    try {
      const registered = await wire.register();
      if (!live) return;
      if (!/^\d+$/.test(registered.generation)) {
        fail();
        return;
      }
      generation = registered.generation;
      report(null);
    } catch {
      fail();
    }
  })();
  return () => {
    live = false;
    unsubscribe();
  };
}
