// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  SUBMITTED_FILTERS_SCHEMA_VERSION,
  SUBMITTED_FILTERS_STORAGE_KEY,
  createDefaultSubmittedFilter,
  readSavedSubmittedFilters,
  validateSubmittedFilter,
  writeSavedSubmittedFilters,
  type SavedSubmittedFilter,
} from "./submittedFilters";

beforeEach(() => localStorage.clear());

it("maps every filter field while preserving OR lists and AND conditions", () => {
  const draft = {
    ...createDefaultSubmittedFilter(new Date("2026-10-09T12:00:00+08:00")),
    keyword: "  修复  ",
    users: "alice, buildbot\nalice",
    clients: "workspace-a;workspace-b",
    depotPath: " //depot/main/... ",
    stream: " //depot/main/ ",
    from: "2026-10-01T00:00",
    to: "2026-10-09T23:59",
    jobs: "JOB-1,JOB-2",
    hasJob: "yes" as const,
    mergeClassifications: [
      "normal" as const,
      "unknown" as const,
      "normal" as const,
    ],
    hideReliableMerges: true,
  };
  const result = validateSubmittedFilter(draft);
  expect(result.errors).toEqual({});
  expect(result.query).toMatchObject({
    keyword: "修复",
    users: ["alice", "buildbot"],
    clients: ["workspace-a", "workspace-b"],
    depotPath: "//depot/main/...",
    stream: "//depot/main",
    jobs: ["JOB-1", "JOB-2"],
    hasJob: true,
    mergeClassifications: ["normal", "unknown"],
    hideReliableMerges: true,
    pageSize: 100,
  });
  expect(Date.parse(result.query!.from)).toBeLessThan(
    Date.parse(result.query!.to),
  );
});

it("rejects invalid/reversed dates, excessive/invalid lists, and contradictory Job filters", () => {
  const base = createDefaultSubmittedFilter();
  expect(
    validateSubmittedFilter({ ...base, from: "", to: "not-a-date" }).errors,
  ).toMatchObject({ from: expect.any(String), to: expect.any(String) });
  expect(
    validateSubmittedFilter({
      ...base,
      from: "2026-10-10T00:00",
      to: "2026-10-09T00:00",
    }).errors.to,
  ).toBeTruthy();
  expect(
    validateSubmittedFilter({
      ...base,
      users: Array.from({ length: 17 }, (_, index) => `u${index}`).join(","),
    }).errors.users,
  ).toContain("16");
  expect(
    validateSubmittedFilter({ ...base, clients: "has whitespace" }).errors
      .clients,
  ).toBeTruthy();
  expect(
    validateSubmittedFilter({ ...base, keyword: "界".repeat(200) }).errors
      .keyword,
  ).toBeTruthy();
  expect(
    validateSubmittedFilter({
      ...base,
      jobs: "JOB-1",
      hasJob: "no",
    }).errors.hasJob,
  ).toBeTruthy();
});

it("ignores empty multi-values and validates path/stream scope", () => {
  const base = createDefaultSubmittedFilter();
  expect(
    validateSubmittedFilter({
      ...base,
      users: " ,\n; ",
      clients: "",
      jobs: "",
    }).query,
  ).toMatchObject({ users: [], clients: [], jobs: [] });
  expect(
    validateSubmittedFilter({
      ...base,
      depotPath: "//other/...",
      stream: "//depot/main",
    }).errors.depotPath,
  ).toContain("Stream");
  expect(
    validateSubmittedFilter({ ...base, depotPath: "//depot/main/...#3" }).errors
      .depotPath,
  ).toBeTruthy();
});

it("round-trips only the versioned whitelist and never persists connection secrets", () => {
  const entry: SavedSubmittedFilter = {
    id: "saved-1",
    name: "My filter",
    updatedAt: "2026-10-09T01:00:00.000Z",
    filter: {
      ...createDefaultSubmittedFilter(),
      keyword: "safe query",
      // Deliberately simulate unexpected runtime properties; the writer must whitelist.
      ...({
        ticket: "SECRET-TICKET",
        password: "SECRET-PASSWORD",
        fingerprint: "SECRET-FINGERPRINT",
      } as object),
    },
  };
  writeSavedSubmittedFilters([entry]);
  const raw = localStorage.getItem(SUBMITTED_FILTERS_STORAGE_KEY)!;
  expect(raw).toContain(`"version":${SUBMITTED_FILTERS_SCHEMA_VERSION}`);
  expect(raw).not.toContain("SECRET-TICKET");
  expect(raw).not.toContain("SECRET-PASSWORD");
  expect(raw).not.toContain("SECRET-FINGERPRINT");
  expect(readSavedSubmittedFilters()).toMatchObject([
    { id: "saved-1", name: "My filter" },
  ]);
  localStorage.setItem(
    SUBMITTED_FILTERS_STORAGE_KEY,
    JSON.stringify({
      version: SUBMITTED_FILTERS_SCHEMA_VERSION,
      filters: [
        {
          ...entry,
          filter: { ...entry.filter, password: "INJECTED-SECRET" },
        },
      ],
    }),
  );
  expect(JSON.stringify(readSavedSubmittedFilters())).not.toContain(
    "INJECTED-SECRET",
  );
});

it("safely degrades corrupted, old-version, and malformed saved schemas", () => {
  localStorage.setItem(SUBMITTED_FILTERS_STORAGE_KEY, "{broken");
  expect(readSavedSubmittedFilters()).toEqual([]);
  localStorage.setItem(
    SUBMITTED_FILTERS_STORAGE_KEY,
    JSON.stringify({ version: 0, filters: [{ password: "secret" }] }),
  );
  expect(readSavedSubmittedFilters()).toEqual([]);
  localStorage.setItem(
    SUBMITTED_FILTERS_STORAGE_KEY,
    JSON.stringify({
      version: SUBMITTED_FILTERS_SCHEMA_VERSION,
      filters: [{ id: "x", name: "x", updatedAt: "now", filter: {} }],
    }),
  );
  expect(readSavedSubmittedFilters()).toEqual([]);
});
