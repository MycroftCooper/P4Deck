import type {
  ClQuery,
  MergeClassification,
} from "../../shared/contracts/types";
import { storage } from "../../shared/lib/storage";

export const SUBMITTED_FILTERS_STORAGE_KEY = "p4deck.submitted.filters";
export const SUBMITTED_FILTERS_SCHEMA_VERSION = 1;
export const SUBMITTED_PAGE_SIZE = 100;

export interface SubmittedFilterDraft {
  keyword: string;
  users: string;
  clients: string;
  depotPath: string;
  stream: string;
  from: string;
  to: string;
  jobs: string;
  hasJob: "any" | "yes" | "no";
  mergeClassifications: MergeClassification[];
  hideReliableMerges: boolean;
}

export interface SavedSubmittedFilter {
  id: string;
  name: string;
  updatedAt: string;
  filter: SubmittedFilterDraft;
}

export interface SubmittedFilterValidation {
  query?: Omit<ClQuery, "operationId" | "requestGeneration" | "cursor">;
  errors: Partial<Record<keyof SubmittedFilterDraft, string>>;
}

const mergeClassifications: readonly MergeClassification[] = [
  "normal",
  "reliableMerge",
  "suspectedMerge",
  "unknown",
];

function toLocalDateTime(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function createDefaultSubmittedFilter(
  now = new Date(),
): SubmittedFilterDraft {
  return {
    keyword: "",
    users: "",
    clients: "",
    depotPath: "",
    stream: "",
    from: toLocalDateTime(new Date(now.getTime() - 30 * 86_400_000)),
    to: toLocalDateTime(now),
    jobs: "",
    hasJob: "any",
    mergeClassifications: [],
    hideReliableMerges: false,
  };
}

function parseTokens(
  value: string,
  field: "users" | "clients" | "jobs",
  errors: SubmittedFilterValidation["errors"],
): string[] {
  const values = [
    ...new Set(
      value
        .split(/[\n,;]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (values.length > 16) {
    errors[field] = "最多 16 项 / Maximum 16 values";
    return [];
  }
  if (
    values.some(
      (item) =>
        byteLength(item) > 1024 ||
        /\s/.test(item) ||
        [...item].some((character) => /[\u0000-\u001f\u007f]/.test(character)),
    )
  ) {
    errors[field] =
      "每项不得包含空白/控制字符，且不超过 1024 字符 / No whitespace or control characters; 1024 characters maximum";
    return [];
  }
  return values;
}

function optionalTrimmed(value: string): string | undefined {
  const result = value.trim();
  return result || undefined;
}

export function validateSubmittedFilter(
  draft: SubmittedFilterDraft,
): SubmittedFilterValidation {
  const errors: SubmittedFilterValidation["errors"] = {};
  const keyword = draft.keyword.trim();
  if (byteLength(keyword) > 512 || keyword.includes("\0"))
    errors.keyword = "最多 512 字符 / Maximum 512 characters";
  const users = parseTokens(draft.users, "users", errors);
  const clients = parseTokens(draft.clients, "clients", errors);
  const jobs = parseTokens(draft.jobs, "jobs", errors);
  const depotPath = optionalTrimmed(draft.depotPath);
  const stream = optionalTrimmed(draft.stream)?.replace(/\/+$/, "");
  if (
    depotPath &&
    (!depotPath.startsWith("//") ||
      byteLength(depotPath) > 4096 ||
      /[\r\n\0@#]/.test(depotPath))
  )
    errors.depotPath =
      "请输入有效的 //depot 路径（不可含 @ 或 #） / Enter a valid //depot path without @ or #";
  if (
    stream &&
    (!stream.startsWith("//") ||
      byteLength(stream) > 1024 ||
      /[\r\n\0@#*]/.test(stream))
  )
    errors.stream = "请输入有效的 Stream 路径 / Enter a valid Stream path";
  if (
    depotPath &&
    stream &&
    depotPath !== stream &&
    !depotPath.startsWith(`${stream}/`)
  )
    errors.depotPath =
      "Depot Path 必须位于所选 Stream 内 / Depot path must be inside the selected stream";
  const fromDate = new Date(draft.from);
  const toDate = new Date(draft.to);
  if (!draft.from || !Number.isFinite(fromDate.getTime()))
    errors.from = "请输入有效起始时间 / Enter a valid start time";
  if (!draft.to || !Number.isFinite(toDate.getTime()))
    errors.to = "请输入有效结束时间 / Enter a valid end time";
  if (!errors.from && !errors.to && fromDate > toDate)
    errors.to =
      "结束时间不得早于起始时间 / End time must not be before start time";
  if (jobs.length && draft.hasJob === "no")
    errors.hasJob =
      "指定 Job 时不能选择“无 Job” / Job values cannot be combined with No job";
  if (
    draft.mergeClassifications.some(
      (value) => !mergeClassifications.includes(value),
    )
  )
    errors.mergeClassifications = "无效分类 / Invalid classification";
  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    query: {
      keyword,
      users,
      clients,
      depotPath,
      stream,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      jobs,
      hasJob: draft.hasJob === "any" ? undefined : draft.hasJob === "yes",
      mergeClassifications: [...new Set(draft.mergeClassifications)],
      hideReliableMerges: draft.hideReliableMerges,
      pageSize: SUBMITTED_PAGE_SIZE,
    },
  };
}

function isSafeDraft(value: unknown): value is SubmittedFilterDraft {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    [
      "keyword",
      "users",
      "clients",
      "depotPath",
      "stream",
      "from",
      "to",
      "jobs",
    ].every(
      (key) =>
        typeof item[key] === "string" &&
        byteLength(item[key] as string) <= 4096,
    ) &&
    ["any", "yes", "no"].includes(String(item.hasJob)) &&
    Array.isArray(item.mergeClassifications) &&
    item.mergeClassifications.length <= mergeClassifications.length &&
    item.mergeClassifications.every(
      (entry) =>
        typeof entry === "string" &&
        mergeClassifications.includes(entry as MergeClassification),
    ) &&
    typeof item.hideReliableMerges === "boolean"
  );
}

function copyDraft(value: SubmittedFilterDraft): SubmittedFilterDraft {
  return {
    keyword: value.keyword,
    users: value.users,
    clients: value.clients,
    depotPath: value.depotPath,
    stream: value.stream,
    from: value.from,
    to: value.to,
    jobs: value.jobs,
    hasJob: value.hasJob,
    mergeClassifications: [...value.mergeClassifications],
    hideReliableMerges: value.hideReliableMerges,
  };
}

export function readSavedSubmittedFilters(): SavedSubmittedFilter[] {
  try {
    const value = JSON.parse(
      storage.getItem(SUBMITTED_FILTERS_STORAGE_KEY) ?? "null",
    ) as unknown;
    if (!value || typeof value !== "object") return [];
    const store = value as { version?: unknown; filters?: unknown };
    if (
      store.version !== SUBMITTED_FILTERS_SCHEMA_VERSION ||
      !Array.isArray(store.filters)
    )
      return [];
    return store.filters
      .filter((entry): entry is SavedSubmittedFilter => {
        if (!entry || typeof entry !== "object") return false;
        const item = entry as Partial<SavedSubmittedFilter>;
        return (
          typeof item.id === "string" &&
          item.id.length > 0 &&
          item.id.length <= 128 &&
          typeof item.name === "string" &&
          item.name.trim().length > 0 &&
          item.name.length <= 80 &&
          typeof item.updatedAt === "string" &&
          isSafeDraft(item.filter)
        );
      })
      .map((entry) => ({
        id: entry.id,
        name: entry.name.trim(),
        updatedAt: entry.updatedAt,
        filter: copyDraft(entry.filter),
      }));
  } catch {
    return [];
  }
}

export function writeSavedSubmittedFilters(
  filters: SavedSubmittedFilter[],
): void {
  const safe = filters
    .filter((entry) => isSafeDraft(entry.filter))
    .slice(0, 50)
    .map((entry) => ({
      id: entry.id.slice(0, 128),
      name: entry.name.trim().slice(0, 80),
      updatedAt: entry.updatedAt,
      filter: copyDraft(entry.filter),
    }));
  storage.setItem(
    SUBMITTED_FILTERS_STORAGE_KEY,
    JSON.stringify({
      version: SUBMITTED_FILTERS_SCHEMA_VERSION,
      filters: safe,
    }),
  );
}
