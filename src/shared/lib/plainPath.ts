/**
 * Strip the Windows verbatim prefix (`\\?\`) that the host may still report for
 * legacy values. Ordinary paths are returned unchanged.
 */
export function plainLocalPath(value: string): string {
  const match = /^[\\/]{2}\?[\\/]/.exec(value);
  if (!match) return value;
  const rest = value.slice(4);
  return /^unc[\\/]/i.test(rest) ? `\\\\${rest.slice(4)}` : rest;
}
