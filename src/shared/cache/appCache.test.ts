// The cache rules live in `CACHE_POLICY`; a literal in the client or a missing
// per-domain default silently stops applying them, which is how the review cache
// ended up evicting content-addressed diffs three times too early.
import { expect, it } from "vitest";
import { appCache } from "./appCache";
import { CACHE_POLICY } from "./policy";

it("takes its defaults from the policy table instead of a literal", () => {
  const defaults = appCache.getDefaultOptions().queries;
  expect(defaults?.staleTime).toBe(CACHE_POLICY.snapshot.staleTime);
  expect(defaults?.gcTime).toBe(CACHE_POLICY.snapshot.gcTime);
});

it("applies one default per documented freshness class that uses a prefix", () => {
  for (const [prefix, policy] of [
    ["snapshot", CACHE_POLICY.snapshot],
    ["target", CACHE_POLICY.target],
    ["local", CACHE_POLICY.local],
  ] as const) {
    const defaults = appCache.getQueryDefaults([prefix]);
    expect(defaults?.staleTime, prefix).toBe(policy.staleTime);
    expect(defaults?.gcTime, prefix).toBe(policy.gcTime);
  }
});

it("keeps the immutable lifetime for a content-addressed review key", () => {
  const key = ["target", "review", "owner-under-test"];
  appCache.setQueryDefaults(key, { gcTime: CACHE_POLICY.immutable.gcTime });
  expect(appCache.getQueryDefaults(key)?.gcTime).toBe(
    CACHE_POLICY.immutable.gcTime,
  );
  // The shorter target default still governs unrelated target queries.
  expect(appCache.getQueryDefaults(["target"])?.gcTime).toBe(
    CACHE_POLICY.target.gcTime,
  );
});
