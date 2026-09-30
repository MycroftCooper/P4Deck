export type RevisionMode = "head" | "revision" | "change" | "date";
/** Strict UI selector builder, never free-form command text. Dates use server time. */
export function revisionSelector(
  mode: RevisionMode,
  value: string,
): string | undefined {
  const text = value.trim();
  if (mode === "head") return "#head";
  if (mode === "revision" || mode === "change") {
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) return;
    return `${mode === "revision" ? "#" : "@"}${text}`;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  )
    return;
  return `@${match[1]}/${match[2]}/${match[3]}`;
}
