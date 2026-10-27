// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  SUBMITTED_FILTERS_SCHEMA_VERSION,
  SUBMITTED_FILTERS_STORAGE_KEY,
  createDefaultSubmittedFilter,
  parseChangeNumber,
  readSavedSubmittedFilters,
  validateSubmittedFilter,
  writeSavedSubmittedFilters,
  type SavedSubmittedFilter,
} from "./submittedFilters";

beforeEach(() => localStorage.clear());

it("queries one user and only the current context, omitting Job parameters", () => {
  const draft = {
    ...createDefaultSubmittedFilter(),
    users: " alice ",
    currentStreamOnly: true,
  };
  const result = validateSubmittedFilter(draft, {
    client: "workspace",
    stream: "//depot/main",
  });
  expect(result.errors).toEqual({});
  expect(result.query).toMatchObject({
    users: ["alice"],
    clients: [],
    streams: ["//depot/main"],
  });
  expect(result.query).not.toHaveProperty("jobs");
  expect(result.query).not.toHaveProperty("hasJob");
  expect(
    validateSubmittedFilter(draft, { client: "new", stream: "//depot/new" })
      .query,
  ).toMatchObject({ clients: [], streams: ["//depot/new"] });
  expect(validateSubmittedFilter(draft).query).toBeUndefined();
});
it.each(["a,b", "a;b", "a\nb", "a b", "a\r"])(
  "rejects combined or invalid usernames: %s",
  (users) => {
    expect(
      validateSubmittedFilter({ ...createDefaultSubmittedFilter(), users })
        .query,
    ).toBeUndefined();
  },
);
it("retains date and path validation and defaults to no context restriction", () => {
  const draft = createDefaultSubmittedFilter();
  expect(validateSubmittedFilter(draft).query).toMatchObject({
    users: [],
    clients: [],
  });
  expect(
    validateSubmittedFilter({ ...draft, from: "", to: "bad" }).query,
  ).toBeUndefined();
  expect(
    validateSubmittedFilter({ ...draft, from: "2026-10-10", to: "2026-10-09" })
      .query,
  ).toBeUndefined();
  expect(
    validateSubmittedFilter({ ...draft, depotPath: "//depot/...#3" }).query,
  ).toBeUndefined();
  expect(
    validateSubmittedFilter(
      { ...draft, depotPath: "//other/...", currentStreamOnly: true },
      { stream: "//depot/main" },
    ).query,
  ).toBeUndefined();
});
it("migrates legacy filters without replaying multiusers, arbitrary context or Jobs", () => {
  localStorage.setItem(
    SUBMITTED_FILTERS_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      filters: [
        {
          id: "old",
          name: "Old",
          updatedAt: "now",
          filter: {
            ...createDefaultSubmittedFilter(),
            users: "a,b",
            clients: "old-a,old-b",
            stream: "//old/main",
            jobs: "JOB-1",
            hasJob: "yes",
          },
        },
      ],
    }),
  );
  const [saved] = readSavedSubmittedFilters();
  expect(saved.migrated).toBe(true);
  expect(saved.filter).toMatchObject({
    users: "a,b",
    currentStreamOnly: true,
  });
  expect(saved.filter).not.toHaveProperty("jobs");
  expect(saved.filter).not.toHaveProperty("clients");
  expect(
    validateSubmittedFilter(saved.filter, {
      client: "new",
      stream: "//new/main",
    }).query,
  ).toBeUndefined();
  writeSavedSubmittedFilters([saved]);
  expect(localStorage.getItem(SUBMITTED_FILTERS_STORAGE_KEY)).not.toContain(
    "old-a",
  );
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

it.each(["", "0", "-1", "1.2", "1e3", "9007199254740992"])(
  "rejects invalid CL %s",
  (value) => expect(parseChangeNumber(value)).toBeUndefined(),
);
it("accepts a positive integer CL", () =>
  expect(parseChangeNumber(" 12345 ")).toBe(12345));

it("isolates malformed legacy entries without losing valid saved filters", () => {
  const valid = {
    id: "good",
    name: "Preserve me",
    updatedAt: "now",
    filter: {
      ...createDefaultSubmittedFilter(),
      users: "alice",
      clients: "old-workspace",
      stream: "//old/main",
    },
  };
  localStorage.setItem(
    SUBMITTED_FILTERS_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      filters: [
        {
          ...valid,
          id: "bad-client",
          filter: { ...valid.filter, clients: 42 },
        },
        { ...valid, id: "bad-stream", filter: { ...valid.filter, stream: {} } },
        { ...valid, id: "bad-filter", filter: [] },
        valid,
      ],
    }),
  );
  const before = localStorage.getItem(SUBMITTED_FILTERS_STORAGE_KEY);
  const saved = readSavedSubmittedFilters();
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    id: "good",
    name: "Preserve me",
    filter: {
      users: "alice",
      currentStreamOnly: true,
    },
  });
  expect(localStorage.getItem(SUBMITTED_FILTERS_STORAGE_KEY)).toBe(before);
  expect(
    validateSubmittedFilter(saved[0].filter, {
      client: "current",
      stream: "//current/main",
    }).query,
  ).toMatchObject({
    users: ["alice"],
    clients: [],
    streams: ["//current/main"],
  });
});

it("migrates v2 integration constraints to all submission types without losing unrelated filters", () => {
  const filter = {
    ...createDefaultSubmittedFilter(),
    keyword: "keep",
    users: "alice",
    mergeClassifications: ["reliableMerge"],
    hideReliableMerges: true,
  };
  localStorage.setItem(
    SUBMITTED_FILTERS_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      filters: [{ id: "legacy", name: "Saved", updatedAt: "now", filter }],
    }),
  );
  const [entry] = readSavedSubmittedFilters();
  expect(entry.filter).toMatchObject({
    keyword: "keep",
    users: "alice",
    submissionKind: "all",
  });
  expect(entry.filter).not.toHaveProperty("mergeClassifications");
  expect(entry.filter).not.toHaveProperty("hideReliableMerges");
  expect(
    validateSubmittedFilter(entry.filter, { client: "current" }).query,
  ).toMatchObject({
    users: ["alice"],
    clients: [],
    mergeClassifications: [],
    hideReliableMerges: false,
  });
});
it.each(["all", "ordinary", "ciMerge", "autoGenerated"] as const)(
  "persists %s without replaying injected integration filters",
  (submissionKind) => {
    const filter = {
      ...createDefaultSubmittedFilter(),
      submissionKind,
      mergeClassifications: ["reliableMerge"],
      hideReliableMerges: true,
    };
    writeSavedSubmittedFilters([
      { id: "kind", name: "Kind", updatedAt: "now", filter },
    ]);
    const [saved] = readSavedSubmittedFilters();
    expect(saved.filter.submissionKind).toBe(submissionKind);
    expect(validateSubmittedFilter(saved.filter).query).toMatchObject({
      mergeClassifications: [],
      hideReliableMerges: false,
    });
    expect(localStorage.getItem(SUBMITTED_FILTERS_STORAGE_KEY)).not.toContain(
      "hideReliableMerges",
    );
    expect(createDefaultSubmittedFilter().submissionKind).toBe("all");
  },
);

it("unions current and explicit streams, deduplicates, clears and persists selections", () => {
  const filter = {
    ...createDefaultSubmittedFilter(),
    currentStreamOnly: true,
    streams: ["//d/main/", "//d/dev", "//d/main"],
  };
  expect(
    validateSubmittedFilter(filter, { stream: "//d/main" }).query,
  ).toMatchObject({ clients: [], streams: ["//d/dev", "//d/main"] });
  expect(
    validateSubmittedFilter(filter, { stream: "//new/current" }).query?.streams,
  ).toContain("//new/current");
  expect(validateSubmittedFilter(filter).query).toBeUndefined();
  writeSavedSubmittedFilters([
    { id: "multi", name: "Multi", updatedAt: "now", filter },
  ]);
  expect(readSavedSubmittedFilters()[0].filter).toEqual(filter);
  expect(
    validateSubmittedFilter(createDefaultSubmittedFilter()).query,
  ).toMatchObject({ clients: [], streams: [] });
});
it("migrates v3 current Stream while removing the hidden Client condition", () => {
  localStorage.setItem(
    SUBMITTED_FILTERS_STORAGE_KEY,
    JSON.stringify({
      version: 3,
      filters: [
        {
          id: "v3",
          name: "Keep",
          updatedAt: "now",
          filter: {
            ...createDefaultSubmittedFilter(),
            currentClientOnly: true,
            currentStreamOnly: true,
            users: "alice",
            submissionKind: "ciMerge",
          },
        },
      ],
    }),
  );
  const [saved] = readSavedSubmittedFilters();
  expect(saved.filter).not.toHaveProperty("currentClientOnly");
  expect(saved.filter).toMatchObject({
    streams: [],
    currentStreamOnly: true,
    users: "alice",
    submissionKind: "ciMerge",
  });
  expect(
    validateSubmittedFilter(saved.filter, {
      client: "old",
      stream: "//new/current",
    }).query,
  ).toMatchObject({ clients: [], streams: ["//new/current"] });
});
