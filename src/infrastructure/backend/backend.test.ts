import { describe, expect, it } from "vitest";
import { backend, tokenize } from ".";

describe("controlled P4 terminal", () => {
  it("previews mock text and images and rejects unsupported files", async () => {
    const text = await backend.getFilePreview("/workspace/atlas/render.ts");
    expect(text.kind).toBe("text");
    expect(text.content).toContain("simulated");
    const image = await backend.getFilePreview("/workspace/atlas/demo.png");
    expect(image.kind).toBe("image");
    expect(image.content).toMatch(/^data:image\/png;base64,/);
    expect(image.width).toBe(320);
    await expect(backend.getFilePreview("asset.uasset")).rejects.toThrow(
      "Unsupported",
    );
  });
  it("tokenizes quoted P4 arguments without invoking a shell", () => {
    expect(tokenize('changes -u "Jane Doe" //depot/main/...')).toEqual([
      "changes",
      "-u",
      "Jane Doe",
      "//depot/main/...",
    ]);
  });

  it("returns generation-tagged virtual-list data", async () => {
    const result = await backend.queryChangelists({
      requestGeneration: 7,
      keyword: "",
      statuses: [],
      users: [],
      clients: [],
      stream: "//atlas/main",
      from: new Date(Date.now() - 31 * 86_400_000).toISOString(),
      to: new Date().toISOString(),
      hideReliableMerges: false,
      limit: 100,
    });
    expect(result.requestGeneration).toBe(7);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.length).toBeLessThanOrEqual(100);
  });

  it("implements the object workbench contract in browser mock", async () => {
    const files = await backend.listWorkspaceChildren();
    expect(files.length).toBeGreaterThan(100);
    const located = await backend.resolvePath({ input: files[3].relativePath });
    expect(located.found).toBe(true);
    expect(
      (await backend.getFileHistory(files[3].depotPath!)).length,
    ).toBeGreaterThan(0);
    expect(
      (await backend.getRevisionGraph(files[3].depotPath!)).nodes.length,
    ).toBeGreaterThan(1);
    expect((await backend.queryPendingChanges()).length).toBeGreaterThan(1);
    await expect(
      backend.openLocalPath({
        path: files[3].absolutePath,
        mode: "reveal",
      }),
    ).rejects.toThrow("desktop app");
  });

  it("models scoped pending CL reads and the unconnected write contract", async () => {
    const initial = await backend.queryPendingChanges();
    const defaultChange = initial.find((change) => change.id === 0)!;
    expect(defaultChange.user).toBeTruthy();
    expect(defaultChange.client).toBeTruthy();
    expect(
      initial.find((change) => change.shelvedFiles.length)?.shelvedFiles[0]
        .state,
    ).toBeUndefined();

    const operationId = crypto.randomUUID();
    const created = await backend.mutatePendingChange({
      operationId,
      type: "create",
      description: "Line one\nJobs:\nChange: remains description",
      jobs: ["ATLAS-TEST"],
    });
    expect(created.operation.operationId).toBe(operationId);
    expect(created.createdChangeId).toBeGreaterThan(0);
    const changeId = created.createdChangeId!;
    const path = defaultChange.files[0].depotPath;
    await backend.mutatePendingChange({
      type: "moveFiles",
      targetChangeId: changeId,
      depotPaths: [path],
    });
    expect(
      (await backend.queryPendingChanges())
        .find((change) => change.id === changeId)
        ?.files.map((file) => file.depotPath),
    ).toContain(path);
    await backend.mutatePendingChange({
      type: "moveFiles",
      targetChangeId: 0,
      depotPaths: [path],
    });
    await backend.mutatePendingChange({ type: "delete", changeId });
    expect(
      (await backend.queryPendingChanges()).some(
        (change) => change.id === changeId,
      ),
    ).toBe(false);
  });

  it("streams monotonic action progress before resolving", async () => {
    const operationId = crypto.randomUUID();
    const progress: number[] = [];
    const unsubscribe = await backend.subscribeOperationEvents((event) => {
      if (event.operationId === operationId && event.progress != null) {
        progress.push(event.progress);
      }
    });
    try {
      await backend.performFileAction({
        operationId,
        action: "checkout",
        paths: ["/workspace/atlas/render.ts"],
        states: ["controlled"],
      });
    } finally {
      unsubscribe();
    }
    expect(progress).toEqual([0, 2, 55, 100]);
  });

  it("exposes structured connection APIs without returning the password", async () => {
    const discovered = await backend.discoverP4Cli({});
    expect(discovered.state).toBe("notTested");
    const result = await backend.login({
      context: {
        server: "localhost:1666",
        user: "tester",
        client: "fixture",
      },
      password: "single-use-secret",
      confirmed: true,
    });
    expect(result.state).toBe("connected");
    expect(JSON.stringify(result)).not.toContain("single-use-secret");
  });

  it("keeps observability contracts bounded in the browser mock", async () => {
    const cache = await backend.statusCacheDiagnostics();
    expect(cache.entries).toBe(0);
    expect(JSON.stringify(cache)).not.toContain("/workspace");
    expect(
      (await backend.queryOperationJournal({ limit: 500 })).records,
    ).toEqual([]);
    const policy = await backend.setLogPolicy({
      autoExpandWarning: false,
      autoExpandError: true,
      retentionDays: 999,
      maxMib: 999,
    });
    expect(policy.retentionDays).toBe(30);
    expect(policy.maxMib).toBe(50);
    await expect(backend.exportDiagnostics({})).rejects.toThrow("desktop app");
  });
});
