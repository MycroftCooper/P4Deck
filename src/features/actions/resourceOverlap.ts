const key = (path: string) => {
  const normalized = path.replaceAll("\\", "/");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
};
export function resourcesOverlap(a: string, b: string) {
  const left = key(a),
    right = key(b);
  return (
    left === right ||
    (left.endsWith("/...") && right.startsWith(left.slice(0, -3))) ||
    (right.endsWith("/...") && left.startsWith(right.slice(0, -3)))
  );
}
export function hasResourceConflict(
  blocked: ReadonlySet<string>,
  paths: readonly string[],
) {
  return paths.some((path) =>
    [...blocked].some((other) => resourcesOverlap(path, other)),
  );
}
