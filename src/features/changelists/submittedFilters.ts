import type { ClQuery } from "../../shared/contracts";
import { submissionKinds, type SubmissionKind } from "./submittedReport";
import { storage } from "../../shared/lib/storage";

export const SUBMITTED_FILTERS_STORAGE_KEY = "p4deck.submitted.filters";
export const SUBMITTED_FILTERS_SCHEMA_VERSION = 4;
export const SUBMITTED_PAGE_SIZE = 100;

export interface SubmittedFilterDraft {
  tags?: string[];
  keyword: string;
  users: string;
  streams: string[];
  depotPath: string;
  currentStreamOnly: boolean;
  from: string;
  to: string;
  submissionKind: SubmissionKind | "all";
}

export interface SavedSubmittedFilter {
  id: string;
  name: string;
  updatedAt: string;
  migrated?: boolean;
  filter: SubmittedFilterDraft;
}

export interface SubmittedFilterValidation {
  query?: Omit<ClQuery, "operationId" | "requestGeneration" | "cursor">;
  errors: Partial<Record<keyof SubmittedFilterDraft, string>>;
}

function toLocalDateTime(value: Date): string {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

/**
 * RFC3339 with the LOCAL offset and the local wall clock preserved, e.g.
 * `2026-10-30T22:00:00+08:00`. `toISOString()` would emit a UTC wall clock
 * (`...T14:00:00Z`), which the backend formats into a P4 date without converting
 * the offset — that shifted Submitted filters 8 hours on a +08 server.
 */
export function toLocalRfc3339(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  const offsetMinutes = -value.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function createDefaultSubmittedFilter(
  now = new Date(),
  user = "",
): SubmittedFilterDraft {
  return {
    keyword: "",
    users: user,
    tags: [],
    streams: [],
    depotPath: "",
    currentStreamOnly: false,
    from: toLocalDateTime(new Date(now.getTime() - 7 * 86_400_000)),
    to: toLocalDateTime(now),
    submissionKind: "ordinary",
  };
}

export function parseChangeNumber(value: string): number | undefined {
  const text = value.trim();
  const number = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(number) && number > 0
    ? number
    : undefined;
}

function optionalTrimmed(value: string): string | undefined {
  const result = value.trim();
  return result || undefined;
}

export function validateSubmittedFilter(
  draft: SubmittedFilterDraft,
  context: { client?: string; stream?: string } = {},
): SubmittedFilterValidation {
  const errors: SubmittedFilterValidation["errors"] = {};
  const keyword = draft.keyword.trim();
  if (byteLength(keyword) > 512 || keyword.includes("\0"))
    errors.keyword = "最多 512 字符 / Maximum 512 characters";
  const user = draft.users.trim();
  if (
    /[,;\r\n]/.test(draft.users) ||
    /\s|[\u0000-\u001f\u007f]/.test(user) ||
    byteLength(user) > 1024
  )
    errors.users = "请输入单一用户名 / Enter one username";
  const users = user ? [user] : [];
  const clients: string[] = [];
  const streams = [
    ...new Set(
      [
        ...draft.streams,
        ...(draft.currentStreamOnly && context.stream ? [context.stream] : []),
      ].map((value) => value.trim().replace(/\/+$/, "")),
    ),
  ].sort();
  if (draft.currentStreamOnly && !context.stream)
    errors.currentStreamOnly =
      "当前 Stream 不可用 / Current stream unavailable";
  if (
    streams.length > 16 ||
    streams.some(
      (stream) =>
        !stream.startsWith("//") ||
        stream.length > 1024 ||
        /[\s\0@#*]/.test(stream) ||
        stream.includes("..."),
    )
  )
    errors.streams =
      "请选择有效 Stream（最多16项） / Select valid streams (maximum 16)";
  const depotPath = optionalTrimmed(draft.depotPath);
  if (
    depotPath &&
    (!depotPath.startsWith("//") ||
      byteLength(depotPath) > 4096 ||
      /[\r\n\0@#]/.test(depotPath))
  )
    errors.depotPath =
      "请输入有效的 //depot 路径（不可含 @ 或 #） / Enter a valid //depot path without @ or #";
  if (
    depotPath &&
    streams.length &&
    !streams.some(
      (stream) =>
        depotPath === stream ||
        depotPath.startsWith(`${stream}/`) ||
        (depotPath.endsWith("...") &&
          stream.startsWith(depotPath.slice(0, -3))),
    )
  )
    errors.depotPath =
      "Depot Path 与所选 Stream 无交集 / Depot path does not intersect selected streams";
  const fromDate = new Date(draft.from);
  const toDate = new Date(draft.to);
  if (!draft.from || !Number.isFinite(fromDate.getTime()))
    errors.from = "请输入有效起始时间 / Enter a valid start time";
  if (!draft.to || !Number.isFinite(toDate.getTime()))
    errors.to = "请输入有效结束时间 / Enter a valid end time";
  if (!errors.from && !errors.to && fromDate > toDate)
    errors.to =
      "结束时间不得早于起始时间 / End time must not be before start time";
  if (
    draft.submissionKind !== "all" &&
    !submissionKinds.includes(draft.submissionKind)
  )
    errors.submissionKind = "无效提交类型 / Invalid submission type";
  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    query: {
      keyword,
      users,
      clients,
      depotPath,
      streams,
      from: toLocalRfc3339(fromDate),
      to: toLocalRfc3339(toDate),
      mergeClassifications: [],
      hideReliableMerges: false,
      pageSize: SUBMITTED_PAGE_SIZE,
    },
  };
}

function isSafeDraft(value: unknown): value is SubmittedFilterDraft {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    ["keyword", "users", "depotPath", "from", "to"].every(
      (key) =>
        typeof item[key] === "string" &&
        byteLength(item[key] as string) <= 4096,
    ) &&
    (item.tags === undefined ||
      (Array.isArray(item.tags) &&
        item.tags.every((tag) => typeof tag === "string"))) &&
    Array.isArray(item.streams) &&
    item.streams.length <= 16 &&
    item.streams.every(
      (value) => typeof value === "string" && value.length <= 1024,
    ) &&
    typeof item.currentStreamOnly === "boolean" &&
    (item.submissionKind === "all" ||
      submissionKinds.includes(item.submissionKind as SubmissionKind))
  );
}

function copyDraft(value: SubmittedFilterDraft): SubmittedFilterDraft {
  return {
    tags: [...(value.tags ?? [])],
    keyword: value.keyword,
    users: value.users,
    streams: [...value.streams],
    depotPath: value.depotPath,
    currentStreamOnly: value.currentStreamOnly,
    from: value.from,
    to: value.to,
    submissionKind: value.submissionKind,
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
      (store.version !== 1 &&
        store.version !== 2 &&
        store.version !== 3 &&
        store.version !== SUBMITTED_FILTERS_SCHEMA_VERSION) ||
      !Array.isArray(store.filters)
    )
      return [];
    // Never replay saved arbitrary client/stream names or Job filters.
    // Keep legacy user text intact: multiple users must be corrected before querying.
    const contextEntries =
      store.version === 1
        ? store.filters.map((entry) => {
            if (
              !entry ||
              typeof entry !== "object" ||
              !entry.filter ||
              typeof entry.filter !== "object" ||
              Array.isArray(entry.filter) ||
              typeof entry.filter.clients !== "string" ||
              typeof entry.filter.stream !== "string"
            )
              return undefined;
            return {
              ...entry,
              migrated: true,
              filter: {
                ...entry.filter,
                currentClientOnly: Boolean(entry.filter.clients.trim()),
                currentStreamOnly: Boolean(entry.filter.stream.trim()),
              },
            };
          })
        : store.filters;
    // Integration evidence cannot be mapped to automation identity. Remove old
    // hidden constraints; keep every unrelated field and default to all types.
    const entries =
      store.version === SUBMITTED_FILTERS_SCHEMA_VERSION
        ? contextEntries
        : contextEntries.map((entry) =>
            entry?.filter
              ? {
                  ...entry,
                  migrated: true,
                  filter: {
                    ...entry.filter,
                    streams: [],
                    submissionKind:
                      store.version === 3 ? entry.filter.submissionKind : "all",
                  },
                }
              : entry,
          );
    return entries
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
        migrated: entry.migrated === true,
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
      migrated: entry.migrated === true,
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
