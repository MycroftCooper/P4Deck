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

export function submittedDescriptionParts(
  description: string,
): { text: string; tag?: string }[] {
  const parts: { text: string; tag?: string }[] = [];
  let end = 0;
  for (const match of description.matchAll(/\[([^\[\]\r\n]*)\]/g)) {
    const tag = match[1].trim();
    if (!tag) continue;
    if (match.index > end)
      parts.push({ text: description.slice(end, match.index) });
    parts.push({ text: match[0], tag });
    end = match.index + match[0].length;
  }
  if (end < description.length) parts.push({ text: description.slice(end) });
  return parts;
}
