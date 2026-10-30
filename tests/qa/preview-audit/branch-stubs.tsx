import type { BranchMappingQuery } from "../../../src/shared/contracts";
export const runtime = {
  mode: "mock" as const, p4Version: "synthetic", contextGeneration: 1,
  context: { server: "synthetic.invalid", user: "fixture", client: "fixture-workspace" },
  connection: { state: "connected" as const, message: "Synthetic only", recovery: "none" as const, server: "synthetic.invalid" },
};
export const backend = {
  async queryBranchMappings(query: BranchMappingQuery) {
    await new Promise(resolve => setTimeout(resolve, 80));
    return {
      requestGeneration: query.requestGeneration,
      scope: { ...runtime.context, contextGeneration: 1 },
      items: Array.from({ length: 96 }, (_, index) => ({
        name: `synthetic-branch-${String(index).padStart(3, "0")}-${"long-name-".repeat(index % 4)}`,
        owner: `owner-${index}-${"long-owner-".repeat(index % 3)}`,
        description: `Synthetic description ${index} 中文 long text\n`.repeat(1 + (index % 8)),
        options: index % 2 ? "locked" : "unlocked", update: "2026/10/28 10:00:00", access: "2026/10/28 11:00:00",
      })),
      hasMore: false, partial: false, truncated: false, simulated: true,
      stats: { scannedCount: 96, matchedCount: 96, returnedCount: 96, invalidRecordCount: 0, safetyLimit: 5000 }, operationIds: [],
    };
  },
  async cancelOperation() {},
  async getBranchMappingDetail() { throw new Error("Detail outside this list-only audit"); },
  async previewBranchMappingImpact() { throw new Error("Impact outside this list-only audit"); },
};
export const serverScope = () => "synthetic-scope";
export const snapshotKey = (...parts: unknown[]) => parts;
export const readSnapshot = () => undefined;
export const hydrateSnapshot = async () => undefined;
export const writePagedSnapshot = () => undefined;
export const isFresh = () => false;
export const useViewRefresh = () => undefined;
export const invalidateData = async () => undefined;
export const BranchMappingMutationDialog = () => null;
