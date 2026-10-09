import { describe, expect, it } from "vitest";
import { backend, tokenize } from ".";
import type { ClQuery } from "../../shared/contracts/types";

function submittedQuery(overrides: Partial<ClQuery> = {}): ClQuery {
  return {
    operationId: crypto.randomUUID(),
    requestGeneration: 1,
    keyword: "",
    users: [],
    clients: [],
    from: new Date(0).toISOString(),
    to: new Date(Date.now() + 86_400_000).toISOString(),
    jobs: [],
    mergeClassifications: [],
    hideReliableMerges: false,
    pageSize: 25,
    ...overrides,
  };
}

describe("controlled P4 terminal", () => {
  it("provides revisioned profile CRUD and real mock workspace switching", async () => {
    const initial = await backend.listConnectionProfiles();
    const primaryId = initial.activeProfileId!;
    const created = await backend.createConnectionProfile({
      expectedRevision: initial.revision,
      name: `Secondary ${initial.revision}`,
      context: {
        ...(await backend.runtimeInfo()).context,
        client: `secondary-${initial.revision}`,
        cwd: `/workspace/secondary-${initial.revision}`,
      },
    });
    const secondary = created.profiles.find(
      (profile) => profile.id !== primaryId,
    )!;
    await expect(
      backend.updateConnectionProfile({
        expectedRevision: initial.revision,
        id: secondary.id,
        name: secondary.name,
        context: secondary.context,
      }),
    ).rejects.toThrow("revisionConflict");

    const activated = await backend.setActiveConnectionProfile({
      expectedRevision: created.revision,
      id: secondary.id,
    });
    expect(activated.context.client).toBe(secondary.context.client);
    expect(activated.contextGeneration).toBeGreaterThan(1);
    expect((await backend.getActiveConnectionProfile())?.id).toBe(secondary.id);

    const profiles = await backend.listConnectionProfiles();
    const returned = await backend.setActiveConnectionProfile({
      expectedRevision: profiles.revision,
      id: primaryId,
    });
    const beforeFailure = await backend.listConnectionProfiles();
    const withFailure = await backend.createConnectionProfile({
      expectedRevision: beforeFailure.revision,
      name: `Unavailable ${beforeFailure.revision}`,
      context: {
        ...returned.context,
        server: "fail:1666",
        client: `unavailable-${beforeFailure.revision}`,
      },
    });
    const unavailable = withFailure.profiles.find(
      (profile) => profile.name === `Unavailable ${beforeFailure.revision}`,
    )!;
    await expect(
      backend.setActiveConnectionProfile({
        expectedRevision: withFailure.revision,
        id: unavailable.id,
      }),
    ).rejects.toThrow("connectionFailed");
    expect((await backend.runtimeInfo()).activeProfileId).toBe(primaryId);
    await backend.deleteConnectionProfile({
      expectedRevision: withFailure.revision,
      id: unavailable.id,
    });
    const switched = await backend.switchWorkspace({
      expectedGeneration: returned.contextGeneration,
      client: "atlas-dev-fm",
    });
    expect(switched.context).toMatchObject({
      client: "atlas-dev-fm",
      cwd: "/workspace/atlas-dev",
    });
    await expect(
      backend.switchWorkspace({
        expectedGeneration: returned.contextGeneration,
        client: "tools-fm",
      }),
    ).rejects.toThrow("contextChanged");

    const afterSwitch = await backend.listConnectionProfiles();
    const cleaned = await backend.deleteConnectionProfile({
      expectedRevision: afterSwitch.revision,
      id: secondary.id,
    });
    expect(
      cleaned.profiles.some((profile) => profile.id === secondary.id),
    ).toBe(false);
  });

  it("provides explicitly simulated, stable global search pages", async () => {
    const query = {
      operationId: "mock-global-1",
      requestGeneration: 41,
      text: "Atlas",
      kinds: [
        "submittedChange" as const,
        "pendingChange" as const,
        "workspaceFile" as const,
        "depotFile" as const,
        "job" as const,
      ],
      pageSize: 7,
    };
    const first = await backend.globalSearch(query);
    expect(first.simulated).toBe(true);
    expect(first.normalizedQuery).toBe("Atlas");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = await backend.globalSearch({
      ...query,
      operationId: "mock-global-2",
      requestGeneration: 42,
      cursor: first.nextCursor,
    });
    const firstIds = new Set(
      first.groups.flatMap((group) => group.items.map((item) => item.identity)),
    );
    expect(
      second.groups
        .flatMap((group) => group.items)
        .some((item) => firstIds.has(item.identity)),
    ).toBe(false);
    await expect(
      backend.globalSearch({
        ...query,
        text: "changed",
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("does not match");
  });

  it("validates Unicode, whitespace, control and special-character searches", async () => {
    const unicode = await backend.globalSearch({
      operationId: "mock-global-unicode",
      requestGeneration: 43,
      text: "  UNICODE-你好  ",
      kinds: ["job"],
      pageSize: 10,
    });
    expect(unicode.normalizedQuery).toBe("UNICODE-你好");
    expect(unicode.groups[0]?.items[0]?.target).toEqual({
      type: "job",
      jobId: "UNICODE-你好",
    });
    await expect(
      backend.globalSearch({
        operationId: "mock-global-control",
        requestGeneration: 44,
        text: "bad\nquery",
        kinds: [],
        pageSize: 10,
      }),
    ).rejects.toThrow("control");
    await expect(
      backend.globalSearch({
        operationId: "mock-global-unicode-control",
        requestGeneration: 45,
        text: "bad\u0085query",
        kinds: [],
        pageSize: 10,
      }),
    ).rejects.toThrow("control");
  });

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

  it("rejects credential commands before the mock runner and never returns their sentinel", async () => {
    const sentinel = "P4DECK_SECRET_mock_4b81";
    for (const request of [
      { command: "tickets", args: [] },
      { command: "-p", args: ["ssl:test:1666", "passwd"] },
      { command: "info", args: ["-P", sentinel] },
      { command: "info", args: [`P4PASSWD=${sentinel}`] },
      { command: "info", args: ["Authorization:", "Bearer", sentinel] },
    ]) {
      let message = "";
      try {
        await backend.runP4({
          operationId: crypto.randomUUID(),
          source: "terminal",
          ...request,
          context: (await backend.runtimeInfo()).context,
          outputMode: "text",
        });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("blocked in Terminal");
      expect(message).not.toContain(sentinel);
    }
  });

  it("returns generation-tagged virtual-list data", async () => {
    const result = await backend.queryChangelists({
      operationId: "submitted-page-1",
      requestGeneration: 7,
      keyword: "",
      users: [],
      clients: [],
      stream: "//atlas/main",
      from: new Date(Date.now() - 31 * 86_400_000).toISOString(),
      to: new Date().toISOString(),
      jobs: [],
      mergeClassifications: [],
      hideReliableMerges: false,
      pageSize: 100,
    });
    expect(result.requestGeneration).toBe(7);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThanOrEqual(100);
  });

  it("paginates submitted queries with bound cursors and combined filters", async () => {
    const base = submittedQuery({ pageSize: 7, requestGeneration: 70 });
    const first = await backend.queryChangelists(base);
    expect(first.items).toHaveLength(7);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const second = await backend.queryChangelists({
      ...base,
      operationId: crypto.randomUUID(),
      requestGeneration: 71,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(7);
    expect(second.items[0].id).toBeLessThan(first.items.at(-1)!.id);
    expect(
      second.items.some((item) =>
        first.items.some((firstItem) => firstItem.id === item.id),
      ),
    ).toBe(false);

    const combined = await backend.queryChangelists(
      submittedQuery({
        keyword: "merge",
        users: ["buildbot"],
        clients: ["atlas-main-bruno"],
        stream: "//atlas/main",
        jobs: ["ATLAS-1187"],
        hasJob: true,
        mergeClassifications: ["reliableMerge"],
      }),
    );
    expect(combined.items.map((item) => item.id)).toContain(31655);

    await expect(
      backend.queryChangelists({
        ...base,
        keyword: "changed",
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("does not match");
    await expect(
      backend.queryChangelists(submittedQuery({ cursor: "not-a-cursor" })),
    ).rejects.toThrow("does not match");

    const runtime = await backend.runtimeInfo();
    await backend.saveConnection(runtime.context);
    await expect(
      backend.queryChangelists({
        ...base,
        operationId: crypto.randomUUID(),
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("does not match");
  });

  it("implements the narrow submitted detail contract", async () => {
    const listed = await backend.queryChangelists({
      operationId: "submitted-detail-list",
      requestGeneration: 8,
      keyword: "",
      users: [],
      clients: [],
      from: new Date(0).toISOString(),
      to: new Date(Date.now() + 86_400_000).toISOString(),
      jobs: [],
      mergeClassifications: [],
      hideReliableMerges: false,
      pageSize: 100,
    });
    const reliable = listed.items.find(
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

    const suspected = listed.items.find(
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

    const unknown = listed.items.find(
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
    expect(files.items.length).toBeGreaterThan(100);
    const located = await backend.resolvePath({
      input: files.items[3].relativePath,
    });
    expect(located.found).toBe(true);
    const runtime = await backend.runtimeInfo();
    const scope = {
      server: runtime.context.server,
      user: runtime.context.user,
      client: runtime.context.client,
      workspace: runtime.context.cwd ?? "",
      activeProfileId: runtime.activeProfileId,
      contextGeneration: runtime.contextGeneration,
      fileIdentity: files.items[3].depotPath!,
    };
    expect(
      (await backend.getFileHistory({ scope, pageSize: 100 })).items.length,
    ).toBeGreaterThan(0);
    expect(
      (await backend.getRevisionGraph({ scope, revisionLimit: 100 })).nodes
        .length,
    ).toBeGreaterThan(1);
    expect((await backend.queryPendingChanges()).length).toBeGreaterThan(1);
    await expect(
      backend.openLocalPath({
        path: files.items[3].absolutePath,
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
    const journal = (await backend.queryOperationJournal({ limit: 500 }))
      .records;
    expect(journal.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(journal)).not.toContain("single-use-secret");
    const policy = await backend.setLogPolicy({
      autoExpandWarning: false,
      autoExpandError: true,
      retentionDays: 999,
      maxMib: 999,
    });
    expect(policy.retentionDays).toBe(30);
    expect(policy.maxMib).toBe(50);
    await expect(backend.exportDiagnostics({})).resolves.toMatchObject({
      simulated: true,
      sizeBytes: 0,
    });
  });
});
