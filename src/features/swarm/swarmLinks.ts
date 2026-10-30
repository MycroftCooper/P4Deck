import { isTauri } from "@tauri-apps/api/core";
import { backend } from "../../infrastructure/backend";
import type { OpenSwarmLinkRequest, RuntimeInfo } from "../../shared/contracts";

export type SwarmLinkTarget =
  | {
      kind: "submittedChange" | "pendingChange" | "shelf";
      changeId: number;
    }
  | { kind: "file"; depotPath: string; revision?: number };

export type SwarmLinkResult =
  | { enabled: true; url: string }
  | {
      enabled: false;
      code: "notConfigured" | "invalidConfig" | "unsupported";
      reason: string;
    };

export interface SwarmOpenAdapter {
  open(url: string, request: OpenSwarmLinkRequest): Promise<void> | void;
}

const controls = /[\u0000-\u001f\u007f]/u;
const encodedControls = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu;
const encodedPathSyntax = /%(?:2e|2f|5c)/iu;

export function normalizeSwarmBaseUrl(input: string): string {
  if (
    input !== input.trim() ||
    controls.test(input) ||
    input.includes("\\") ||
    encodedControls.test(input) ||
    encodedPathSyntax.test(input) ||
    input.length > 2048
  )
    throw new Error("invalid Swarm URL");
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("invalid Swarm URL");
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url.toString();
}

function strictSegment(value: string) {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return value === "." || value === ".."
    ? encoded.replaceAll(".", "%2E")
    : encoded;
}

function changeId(value: number) {
  return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
}

function depotRoute(path: string) {
  if (controls.test(path) || !path.startsWith("//")) return;
  const segments = path.slice(2).split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    return;
  try {
    return segments.map(strictSegment).join("/");
  } catch {
    return;
  }
}

export function buildSwarmLink(
  baseUrl: string | undefined,
  target: SwarmLinkTarget,
): SwarmLinkResult {
  if (!baseUrl)
    return {
      enabled: false,
      code: "notConfigured",
      reason: "Configure a Swarm base URL for the active profile in Settings.",
    };
  let base: string;
  try {
    base = normalizeSwarmBaseUrl(baseUrl);
  } catch {
    return {
      enabled: false,
      code: "invalidConfig",
      reason: "The active profile has an invalid Swarm base URL.",
    };
  }
  if (target.kind !== "file") {
    const id = changeId(target.changeId);
    if (!id)
      return {
        enabled: false,
        code: "unsupported",
        reason:
          target.kind === "pendingChange"
            ? "Default or unnumbered changelists do not have a stable Swarm URL."
            : "A positive changelist number is required.",
      };
    return { enabled: true, url: `${base}changes/${id}` };
  }
  const route = depotRoute(target.depotPath);
  if (!route)
    return {
      enabled: false,
      code: "unsupported",
      reason: "Swarm file links require a complete depot path.",
    };
  if (
    target.revision !== undefined &&
    (!Number.isSafeInteger(target.revision) || target.revision < 1)
  )
    return {
      enabled: false,
      code: "unsupported",
      reason:
        "An exact Swarm revision link requires a positive revision number.",
    };
  return {
    enabled: true,
    url: `${base}files/${route}${target.revision ? `?v=${target.revision}` : ""}`,
  };
}

const defaultAdapter: SwarmOpenAdapter = {
  async open(url, request) {
    if (isTauri()) {
      await backend.openSwarmLink(request);
      return;
    }
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
  },
};

export async function openSwarmLink(
  runtime: RuntimeInfo,
  target: SwarmLinkTarget,
  adapter: SwarmOpenAdapter = defaultAdapter,
) {
  const result = buildSwarmLink(runtime.context.swarmBaseUrl, target);
  if (!result.enabled) throw new Error(result.reason);
  const request: OpenSwarmLinkRequest = {
    url: result.url,
    expectedProfileId: runtime.activeProfileId,
    expectedContextGeneration: runtime.contextGeneration,
  };
  await adapter.open(result.url, request);
  return request;
}
