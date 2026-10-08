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

  it("implements the narrow submitted detail contract", async () => {
    const listed = await backend.queryChangelists({
      requestGeneration: 8,
      keyword: "",
      statuses: ["submitted"],
      users: [],
      clients: [],
      from: new Date(0).toISOString(),
      to: new Date(Date.now() + 86_400_000).toISOString(),
      hideReliableMerges: false,
      limit: 100,
    });
    const reliable = listed.changes.find(
      (change) => change.mergeClassification === "reliableMerge",
    );
    expect(reliable).toBeDefined();
    const detail = await backend.getSubmittedChangeDetail({
      changeId: reliable!.id,
      operationId: "detail-contract",
    });
    expect(detail.mergeClassification).toBe("reliableMerge");
    expect(detail.integrationEvidence[0]?.source).toBe("describeAction");
    expect(detail.files[0]?.revision).toBe(3);

    const suspected = listed.changes.find(
      (change) => change.mergeClassification === "suspectedMerge",
    )!;
    expect(
      await backend.getSubmittedChangeDetail({
        changeId: suspected.id,
        operationId: "detail-suspected",
      }),
    ).toMatchObject({
      mergeClassification: "suspectedMerge",
      inspectionStatus: "partial",
      integrationEvidence: [],
    });

    const unknown = listed.changes.find(
      (change) => change.mergeClassification === "unknown",
    )!;
    expect(
      await backend.getSubmittedChangeDetail({
        changeId: unknown.id,
        operationId: "detail-unknown",
      }),
    ).toMatchObject({
      mergeClassification: "unknown",
      inspectionStatus: "unavailable",
      integrationEvidence: [],
    });

    const unavailable = await backend.getSubmittedChangeDetail({
      changeId: -1,
      operationId: "detail-missing",
    });
    expect(unavailable.mergeClassification).toBe("unknown");
    expect(unavailable.inspectionStatus).toBe("unavailable");
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

  it("models scoped pending CL create, edit Jobs, delete, and Default round-trip moves", async () => {
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
    await backend.mutatePendingChange({
      type: "edit",
      changeId,
      description: "Edited description",
      jobs: ["ATLAS-EDITED", "ATLAS-EDITED"],
    });
    expect(
      (await backend.queryPendingChanges()).find(
        (change) => change.id === changeId,
      ),
    ).toMatchObject({
      description: "Edited description",
      jobs: ["ATLAS-EDITED"],
    });
    await expect(
      backend.mutatePendingChange({ type: "delete", changeId }),
    ).rejects.toThrow("clear Jobs");
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
    await backend.mutatePendingChange({
      type: "edit",
      changeId,
      description: "Edited description",
      jobs: [],
    });
    await backend.mutatePendingChange({ type: "delete", changeId });
    expect(
      (await backend.queryPendingChanges()).some(
        (change) => change.id === changeId,
      ),
    ).toBe(false);
  });

  it("models one-time, target-bound submit confirmation without a file-action bypass", async () => {
    await expect(
      backend.runP4({
        source: "gui",
        command: "submit",
        args: ["-c", "31798"],
        context: (await backend.runtimeInfo()).context,
        outputMode: "jsonLines",
      }),
    ).rejects.toThrow("preflight");
    await expect(
      backend.performFileAction({
        action: "submit" as import("../../shared/contracts/types").P4FileAction,
        paths: [],
        changelistId: 31798,
      }),
    ).rejects.toThrow("preflightSubmit");
    const preflight = await backend.preflightSubmit({ changeId: 31798 });
    expect(preflight.ready).toBe(true);
    expect(preflight.token).toBeTruthy();
    expect(preflight.target.changeId).toBe(31798);
    expect(preflight.fileSummary.fileCount).toBeGreaterThan(0);
    const submitted = await backend.confirmSubmit({
      token: preflight.token!,
      target: preflight.target,
      operationId: "mock-submit-contract",
    });
    expect(submitted).toMatchObject({
      outcome: "submitted",
      changeId: 31798,
      operationId: "mock-submit-contract",
    });
    const replay = await backend.confirmSubmit({
      token: preflight.token!,
      target: preflight.target,
    });
    expect(replay).toMatchObject({
      outcome: "rejected",
      failure: "tokenUnknown",
    });
  });

  it("models typed shelf and unshelve confirmation while keeping unknown resolve blocked", async () => {
    const changes = await backend.queryPendingChanges();
    const shelfSource = changes.find((change) => change.shelvedFiles.length)!;
    const shelfPath = shelfSource.shelvedFiles[0].depotPath;
    await expect(
      backend.performFileAction({ action: "shelve", paths: [shelfPath] }),
    ).rejects.toThrow("preflight");
    const unshelve = await backend.preflightUnshelve({
      sourceChangeId: shelfSource.id,
      depotPaths: [shelfPath],
      targetWorkspace: (await backend.runtimeInfo()).context.client,
      targetChangeId: 0,
    });
    expect(unshelve.mappings[0]).toMatchObject({ mapped: true });
    expect(
      await backend.confirmUnshelve({
        token: unshelve.token!,
        target: unshelve.target,
      }),
    ).toMatchObject({ outcome: "succeeded" });

    const deletion = await backend.preflightShelf({
      changeId: shelfSource.id,
      depotPaths: [shelfPath],
      mode: "delete",
    });
    expect(deletion).toMatchObject({ ready: true });
    expect(
      await backend.confirmShelf({
        token: deletion.token!,
        target: deletion.target,
        operationId: "mock-shelf-contract",
      }),
    ).toMatchObject({ outcome: "succeeded" });

    const resolve = await backend.preflightResolve({
      depotPaths: [shelfPath],
    });
    expect(resolve).toMatchObject({ ready: false });
    expect(resolve.conflicts[0]).toMatchObject({ status: "unknown" });
    expect(resolve.token).toBeUndefined();
  });

  it("rejects a mock shelf token after its source changelist drifts", async () => {
    const changes = await backend.queryPendingChanges();
    const source = changes.find(
      (change) =>
        change.id > 0 &&
        change.files.some(
          (file) =>
            !change.shelvedFiles.some(
              (shelved) => shelved.depotPath === file.depotPath,
            ),
        ),
    )!;
    const path = source.files.find(
      (file) =>
        !source.shelvedFiles.some(
          (shelved) => shelved.depotPath === file.depotPath,
        ),
    )!.depotPath;
    const preflight = await backend.preflightShelf({
      changeId: source.id,
      depotPaths: [path],
      mode: "createOrUpdate",
      replace: false,
    });
    await backend.mutatePendingChange({
      type: "edit",
      changeId: source.id,
      description: `${source.description} drift`,
      jobs: source.jobs,
    });
    expect(
      await backend.confirmShelf({
        token: preflight.token!,
        target: preflight.target,
      }),
    ).toMatchObject({ outcome: "rejected", failure: "contentChanged" });
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
    expect(discovered.message).toContain("no local executable or network");
    const loggedOut = await backend.logout({
      context: {
        server: "localhost:1666",
        user: "tester",
        client: "fixture",
      },
      confirmed: true,
    });
    expect(loggedOut).toMatchObject({
      state: "authRequired",
      recovery: "login",
    });
    expect(
      await backend.queryLoginStatus({
        server: "localhost:1666",
        user: "tester",
        client: "fixture",
      }),
    ).toMatchObject({ state: "authRequired" });
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
    expect(result.message).toContain("no password or ticket was sent");
    expect(
      await backend.queryLoginStatus({
        server: "localhost:1666",
        user: "tester",
        client: "fixture",
      }),
    ).toMatchObject({ state: "connected" });
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
