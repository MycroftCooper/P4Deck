import { describe, expect, it, vi } from "vitest";
import type { RuntimeInfo } from "../../shared/contracts";
import {
  buildSwarmLink,
  normalizeSwarmBaseUrl,
  openSwarmLink,
} from "./swarmLinks";

const runtime = (profile = "one", generation = 4): RuntimeInfo => ({
  mode: "mock",
  p4Version: "mock",
  activeProfileId: profile,
  contextGeneration: generation,
  context: {
    server: "p4:1666",
    user: "user",
    client: "client",
    swarmBaseUrl: `https://${profile}.example/swarm/`,
  },
  connection: {
    state: "connected",
    message: "ok",
    recovery: "none",
    server: "p4:1666",
  },
});

describe("SwarmLinkBuilder", () => {
  it("normalizes an http(s) base URL and preserves a deployment subpath", () => {
    expect(normalizeSwarmBaseUrl("https://swarm.example/team")).toBe(
      "https://swarm.example/team/",
    );
    expect(normalizeSwarmBaseUrl("http://localhost:8080/")).toBe(
      "http://localhost:8080/",
    );
  });

  it.each([
    "javascript:alert(1)",
    "file:///tmp/a",
    "data:text/plain,x",
    "https://user:secret@swarm.example/",
    "https://swarm.example/?token=secret",
    "https://swarm.example/#fragment",
    "https://swarm.example/\r\n",
    "https://swarm.example/%0d%0aheader",
    "https://swarm.example/%2e%2e/other",
    "https://swarm.example/team%2fother",
    " https://swarm.example/",
    "https:\\swarm.example",
  ])("rejects malicious or ambiguous base URL %s", (value) => {
    expect(() => normalizeSwarmBaseUrl(value)).toThrow();
  });

  it.each([
    ["submittedChange", 12],
    ["pendingChange", 13],
    ["shelf", 14],
  ] as const)("maps %s changelists to the documented route", (kind, id) => {
    expect(buildSwarmLink("https://swarm/", { kind, changeId: id })).toEqual({
      enabled: true,
      url: `https://swarm/changes/${id}`,
    });
  });

  it("strictly encodes special and Unicode depot path segments", () => {
    expect(
      buildSwarmLink("https://swarm/root", {
        kind: "file",
        depotPath: "//de pot/项目/a #%'()!.txt",
        revision: 8,
      }),
    ).toEqual({
      enabled: true,
      url: "https://swarm/root/files/de%20pot/%E9%A1%B9%E7%9B%AE/a%20%23%25%27%28%29%21.txt?v=8",
    });
  });

  it("disables missing config, default CL, local paths, and invalid revisions", () => {
    expect(
      buildSwarmLink(undefined, { kind: "shelf", changeId: 1 }),
    ).toMatchObject({
      enabled: false,
      code: "notConfigured",
    });
    expect(
      buildSwarmLink("https://swarm", { kind: "pendingChange", changeId: 0 }),
    ).toMatchObject({ enabled: false, code: "unsupported" });
    expect(
      buildSwarmLink("https://swarm", { kind: "file", depotPath: "C:/a" }),
    ).toMatchObject({ enabled: false, code: "unsupported" });
    expect(
      buildSwarmLink("https://swarm", {
        kind: "file",
        depotPath: `//depot/${String.fromCharCode(0xd800)}`,
      }),
    ).toMatchObject({ enabled: false, code: "unsupported" });
    expect(
      buildSwarmLink("https://swarm", {
        kind: "file",
        depotPath: "//depot/a",
        revision: 0,
      }),
    ).toMatchObject({ enabled: false, code: "unsupported" });
  });

  it("binds every open request to the selected profile and generation", async () => {
    const open = vi.fn();
    const first = await openSwarmLink(
      runtime("one", 4),
      { kind: "submittedChange", changeId: 99 },
      { open },
    );
    const second = await openSwarmLink(
      runtime("two", 8),
      { kind: "file", depotPath: "//depot/a", revision: 2 },
      { open },
    );
    expect(first).toMatchObject({
      expectedProfileId: "one",
      expectedContextGeneration: 4,
    });
    expect(second).toMatchObject({
      expectedProfileId: "two",
      expectedContextGeneration: 8,
    });
    expect(open).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(open.mock.calls)).not.toContain("secret");
  });

  it("uses an independent panel's runtime instead of a stale main-window binding", async () => {
    const open = vi.fn();
    await openSwarmLink(
      runtime("detached-panel", 12),
      { kind: "submittedChange", changeId: 55 },
      { open },
    );
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "https://detached-panel.example/swarm/changes/55",
      expect.objectContaining({
        expectedProfileId: "detached-panel",
        expectedContextGeneration: 12,
      }),
    );
  });
});
