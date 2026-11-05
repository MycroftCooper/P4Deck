import { tFor } from "../../shared/i18n";
import { getLocale } from "../../shared/i18n/t";
import type {
  IntegrationTraceBatch,
  IntegrationTraceRecord,
  SubmittedChangeFile,
} from "../../shared/contracts";
// P4 may print the hex letter in %2A differently; do not decode %2540 or fold path case.
export const tracePathKey = (path: string) => path.replace(/%2a/gi, "%2A");
export const traceFileKey = (file: SubmittedChangeFile) =>
  `${tracePathKey(file.depotPath)}#${file.revision ?? "?"}`;
export function checkedTraceBatch(
  value: IntegrationTraceBatch,
): IntegrationTraceBatch {
  if (
    !value ||
    !Array.isArray(value.records) ||
    typeof value.incomplete !== "boolean" ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((item) => typeof item === "string") ||
    !Number.isFinite(value.readAt) ||
    !value.records.every(
      (record) =>
        record &&
        typeof record.sourcePath === "string" &&
        typeof record.targetPath === "string" &&
        typeof record.how === "string" &&
        [
          record.sourceStart,
          record.sourceEnd,
          record.targetStart,
          record.targetEnd,
          record.recordChange,
        ].every(Number.isSafeInteger) &&
        record.sourceStart >= 0 &&
        record.sourceEnd > record.sourceStart &&
        record.targetStart >= 0 &&
        record.targetEnd > record.targetStart &&
        record.recordChange > 0,
    )
  )
    throw new Error(
      // The host protocol is English-only; resolve for the caller's locale.
      tFor(getLocale(), "pending.integrationTraceIncompatible"),
    );
  return value;
}
export function traceMatches(
  file: SubmittedChangeFile,
  record: IntegrationTraceRecord,
) {
  return (
    Number.isSafeInteger(file.revision) &&
    file.revision! > 0 &&
    tracePathKey(file.depotPath) === tracePathKey(record.sourcePath) &&
    record.sourceStart < file.revision! &&
    file.revision! <= record.sourceEnd
  );
}
export function acceptedIntegration(record: IntegrationTraceRecord) {
  return /^(branch|copy|merge|delete|add|moved) (into|from)$/.test(record.how);
}
export function traceGroups(
  files: SubmittedChangeFile[],
  records: IntegrationTraceRecord[],
  complete: boolean,
) {
  const groups = new Map<
    number,
    { change: number; records: IntegrationTraceRecord[]; covered: Set<string> }
  >();
  for (const record of records) {
    const matched = files.filter((file) => traceMatches(file, record));
    if (!matched.length) continue;
    let group = groups.get(record.recordChange);
    if (!group) {
      group = { change: record.recordChange, records: [], covered: new Set() };
      groups.set(record.recordChange, group);
    }
    if (
      !group.records.some(
        (existing) => JSON.stringify(existing) === JSON.stringify(record),
      )
    )
      group.records.push(record);
    if (acceptedIntegration(record))
      matched.forEach((file) => group!.covered.add(traceFileKey(file)));
  }
  const total = new Set(files.map(traceFileKey)).size;
  return [...groups.values()]
    .sort((a, b) => b.change - a.change)
    .map((group) => ({
      ...group,
      total,
      full: complete && total > 0 && group.covered.size === total,
    }));
}
