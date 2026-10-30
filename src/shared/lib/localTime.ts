/** Display only: use the user's local zone without changing stored timestamps. */
export function formatLocalTime(
  value: string | number | null | undefined,
  locale?: string,
): string {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim())
  )
    return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
