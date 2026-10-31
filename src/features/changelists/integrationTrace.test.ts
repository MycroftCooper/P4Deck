import { expect, it } from "vitest";
import type {
  IntegrationTraceRecord,
  SubmittedChangeFile,
} from "../../shared/contracts";
import {
  acceptedIntegration,
  traceGroups,
  traceMatches,
} from "./integrationTrace";
const file: SubmittedChangeFile = {
  depotPath: "//mock/source/a",
  revision: 4,
  action: "edit",
};
const record: IntegrationTraceRecord = {
  sourcePath: file.depotPath,
  targetPath: "//mock/destination/a",
  sourceStart: 3,
  sourceEnd: 4,
  targetStart: 0,
  targetEnd: 1,
  how: "merge into",
  recordChange: 9,
};
it("matches canonical P4 escape spelling without decoding or folding path case", () => {
  const escaped = { ...file, depotPath: "//mock/source/a%2ab%2540" };
  expect(
    traceMatches(escaped, {
      ...record,
      sourcePath: "//mock/source/a%2Ab%2540",
    }),
  ).toBe(true);
  expect(
    traceMatches(escaped, { ...record, sourcePath: "//mock/source/a%2Ab%40" }),
  ).toBe(false);
  expect(
    traceMatches(escaped, {
      ...record,
      sourcePath: "//mock/SOURCE/a%2Ab%2540",
    }),
  ).toBe(false);
});
it("matches only exact source path and exclusive-start inclusive-end revisions", () => {
  expect(traceMatches(file, record)).toBe(true);
  for (const revision of [undefined, 0, 3, 5])
    expect(traceMatches({ ...file, revision }, record)).toBe(false);
  expect(traceMatches({ ...file, depotPath: "//mock/other/a" }, record)).toBe(
    false,
  );
});
it("uses normalized source and destination fields for either P4 how direction", () => {
  for (const how of ["merge into", "merge from", "copy into", "copy from"]) {
    expect(
      traceGroups([file], [{ ...record, how }], true)[0].covered.size,
    ).toBe(1);
  }
});
it("does not claim complete coverage for partial, cancelled or unfinished investigation", () => {
  expect(traceGroups([file], [record], false)[0].full).toBe(false);
  expect(traceGroups([file], [record], true)[0].full).toBe(true);
  expect(
    traceGroups([file, { ...file, revision: 5 }], [record], true)[0].full,
  ).toBe(false);
});
it("retains ignored and undo evidence without counting it as coverage or transitive evidence", () => {
  for (const how of [
    "ignored",
    "ignored by",
    "undid",
    "undone by",
    "edit from",
    "unknown into",
  ]) {
    const excluded = { ...record, how };
    expect(acceptedIntegration(excluded)).toBe(false);
    const group = traceGroups([file], [excluded], true)[0];
    expect(group.records).toEqual([excluded]);
    expect(group.covered.size).toBe(0);
    expect(group.full).toBe(false);
  }
});
it("deduplicates records and retains every source branch in the denominator", () => {
  const group = traceGroups(
    [file, { ...file, depotPath: "//mock/another-branch/a" }],
    [record, record],
    true,
  )[0];
  expect(group.records).toHaveLength(1);
  expect(group.total).toBe(2);
  expect(group.full).toBe(false);
});
