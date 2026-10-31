/** Frontend selection only; not a host operation or success contract. */
export interface SelectedOpenedFile {
  depotPath: string;
  originalChangeId: number;
}
export interface OpenedFileSelection {
  /** Exact connection identity/generation and workspace key supplied by the caller. */
  scope: string;
  files: readonly SelectedOpenedFile[];
  anchor?: string;
}
export function emptyOpenedSelection(scope: string): OpenedFileSelection {
  return { scope, files: [] };
}
function unique(files: readonly SelectedOpenedFile[]): SelectedOpenedFile[] {
  return [
    ...new Map(files.map((file) => [file.depotPath, { ...file }])).values(),
  ];
}
export function selectOpenedFile(
  previous: OpenedFileSelection,
  scope: string,
  visible: readonly SelectedOpenedFile[],
  path: string,
  gesture: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    context?: boolean;
  } = {},
): OpenedFileSelection {
  const state =
    previous.scope === scope ? previous : emptyOpenedSelection(scope);
  const rows = unique(visible);
  const index = rows.findIndex((file) => file.depotPath === path);
  if (index < 0) return state; // Never synthesize an unloaded/filtered target.
  const target = rows[index];
  if (gesture.context && state.files.some((file) => file.depotPath === path))
    return state;
  const additive = !!(gesture.ctrlKey || gesture.metaKey);
  const anchor = rows.findIndex((file) => file.depotPath === state.anchor);
  if (gesture.shiftKey && anchor >= 0) {
    const range = rows.slice(
      Math.min(anchor, index),
      Math.max(anchor, index) + 1,
    );
    return {
      scope,
      anchor: state.anchor,
      files: unique(additive ? [...state.files, ...range] : range),
    };
  }
  const exists = state.files.some((file) => file.depotPath === path);
  return {
    scope,
    anchor: path,
    files:
      additive && !gesture.context
        ? exists
          ? state.files.filter((file) => file.depotPath !== path)
          : unique([...state.files, target])
        : [{ ...target }],
  };
}

/** Freeze the preview so later row mutations cannot change the confirmed list. */
export function snapshotOpenedSelection(
  state: OpenedFileSelection,
): OpenedFileSelection {
  return { ...state, files: unique(state.files) };
}
