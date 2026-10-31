/** Derived from the untouched description; never sent to P4. */
export function submittedTags(description: string): string[] {
  return [
    ...new Set(
      Array.from(description.matchAll(/\[([^\[\]\r\n]*)\]/g), (match) =>
        match[1].trim(),
      ).filter(Boolean),
    ),
  ];
}
export function matchesSubmittedTags(
  description: string,
  selected: readonly string[],
): boolean {
  return (
    selected.length === 0 ||
    submittedTags(description).some((tag) => selected.includes(tag))
  );
}

/**
 * Display-only split: `[...]` hand-written tags plus `vxdx`-style build/version
 * markers (case-insensitive, e.g. v2d0 / V1D7). The source text is preserved;
 * `submittedTags`/filtering intentionally ignores the version markers.
 */
const DESCRIPTION_TAG_PATTERN =
  /\[([^\[\]\r\n]*)\]|(?<![0-9a-z])v[0-9]+[a-z][0-9]+(?![0-9a-z])/gi;

export function submittedDescriptionParts(
  description: string,
): { text: string; tag?: string }[] {
  const parts: { text: string; tag?: string }[] = [];
  let end = 0;
  for (const match of description.matchAll(DESCRIPTION_TAG_PATTERN)) {
    const bracketed = match[1];
    const tag = bracketed === undefined ? match[0] : bracketed.trim();
    // Empty `[]` stays literal, exactly like before the version-marker support.
    if (!tag) continue;
    if (match.index > end)
      parts.push({ text: description.slice(end, match.index) });
    parts.push({ text: match[0], tag });
    end = match.index + match[0].length;
  }
  if (end < description.length) parts.push({ text: description.slice(end) });
  return parts;
}
