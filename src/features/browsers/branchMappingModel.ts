import type {
  BranchMappingDraft,
  BranchMappingPage,
  BranchViewLine,
  BranchViewModifier,
} from "../../shared/contracts/types";

/** Validate persisted list rows before rendering or merging another page. */
export function isBranchMappingSnapshot(
  value: unknown,
): value is BranchMappingPage {
  const page = value as BranchMappingPage | undefined;
  return (
    !!page &&
    Number.isSafeInteger(page.requestGeneration) &&
    !!page.scope &&
    Number.isSafeInteger(page.scope.contextGeneration) &&
    ["server", "user", "client"].every(
      (field) =>
        typeof page.scope[field as keyof typeof page.scope] === "string",
    ) &&
    Array.isArray(page.items) &&
    page.items.every(
      (item) =>
        !!item &&
        typeof item.name === "string" &&
        ["owner", "update", "access", "description", "options"].every(
          (field) =>
            item[field as keyof typeof item] === undefined ||
            typeof item[field as keyof typeof item] === "string",
        ),
    ) &&
    Array.isArray(page.operationIds) &&
    page.operationIds.every((id) => typeof id === "string") &&
    [page.hasMore, page.partial, page.truncated, page.simulated].every(
      (flag) => typeof flag === "boolean",
    ) &&
    !!page.stats &&
    [
      "scannedCount",
      "matchedCount",
      "returnedCount",
      "invalidRecordCount",
      "safetyLimit",
    ].every((field) =>
      Number.isFinite(page.stats[field as keyof typeof page.stats]),
    )
  );
}

export interface BranchViewLineIssue {
  index: number;
  messages: string[];
}

const editableModifiers = new Set<BranchViewModifier>([
  "map",
  "exclude",
  "overlay",
]);

function wildcardSignature(value: string) {
  return [...value.matchAll(/\.\.\.|\*/g)].map(([match]) => match).join("|");
}

function hasInvalidDoubleDot(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    if (value.slice(index, index + 3) === "...") {
      index += 2;
      continue;
    }
    if (value.slice(index, index + 2) === "..") return true;
  }
  return false;
}

function identityIssue(value: string) {
  return (
    !value ||
    value.trim() !== value ||
    [...value].length > 128 ||
    value.startsWith("-") ||
    /[\s:*%@#/\\"]|\p{Cc}/u.test(value)
  );
}

function pathIssue(value: string) {
  if (!value) return "Path is required.";
  if (
    !value.startsWith("//") ||
    new TextEncoder().encode(value).length > 1024 ||
    value.trim() !== value ||
    /[@#%"\\]|\p{Cc}/u.test(value) ||
    hasInvalidDoubleDot(value)
  )
    return "Use a literal depot pattern beginning with //; @, #, %, quotes, backslashes, controls, and surrounding whitespace are not allowed.";
  return "";
}

export function validateBranchView(
  view: BranchViewLine[],
): BranchViewLineIssue[] {
  const seen = new Map<string, number>();
  return view.flatMap((line, index) => {
    const messages: string[] = [];
    if (!editableModifiers.has(line.modifier))
      messages.push("Unknown or non-round-trippable lines cannot be edited.");
    if (line.comment || line.unknown)
      messages.push("Comment or unknown text cannot be safely round-tripped.");
    const source = line.source ?? "";
    const target = line.target ?? "";
    const sourceIssue = pathIssue(source);
    const targetIssue = pathIssue(target);
    if (sourceIssue) messages.push(`Source: ${sourceIssue}`);
    if (targetIssue) messages.push(`Target: ${targetIssue}`);
    if (
      !sourceIssue &&
      !targetIssue &&
      wildcardSignature(source) !== wildcardSignature(target)
    )
      messages.push("Source and target wildcard signatures must match.");
    if (source) {
      const key = source.replace(/[A-Z]/g, (character) =>
        character.toLowerCase(),
      );
      const previous = seen.get(key);
      if (previous !== undefined)
        messages.push(`Source conflicts with line ${previous + 1}.`);
      else seen.set(key, index);
    }
    return messages.length ? [{ index, messages }] : [];
  });
}

export function validateBranchDraft(draft: BranchMappingDraft): string[] {
  const messages: string[] = [];
  if (identityIssue(draft.name))
    messages.push(
      "Name must be a literal identifier of at most 128 characters.",
    );
  if (identityIssue(draft.owner)) messages.push("Owner is invalid.");
  if (
    [...draft.description].length > 4096 ||
    [...draft.description].some(
      (character) =>
        /\p{Cc}/u.test(character) && character !== "\n" && character !== "\t",
    )
  )
    messages.push(
      "Description must be at most 4096 characters and use LF line endings.",
    );
  if (!draft.view.length || draft.view.length > 512)
    messages.push("View must contain between 1 and 512 ordered lines.");
  return messages;
}

export function mergeBranchMappingPages(
  current: BranchMappingPage,
  page: BranchMappingPage,
): BranchMappingPage {
  const items = new Map(current.items.map((item) => [item.name, item]));
  for (const item of page.items)
    if (!items.has(item.name)) items.set(item.name, item);
  return {
    ...page,
    items: [...items.values()],
    partial: current.partial || page.partial,
    truncated: current.truncated || page.truncated,
    stats: { ...page.stats, returnedCount: items.size },
    operationIds: [...new Set([...current.operationIds, ...page.operationIds])],
    simulated: current.simulated || page.simulated,
  };
}

export function branchMappingError(cause: unknown): {
  code?: string;
  message: string;
} {
  if (cause && typeof cause === "object") {
    const value = cause as { code?: unknown; message?: unknown };
    return {
      code: typeof value.code === "string" ? value.code : undefined,
      message:
        typeof value.message === "string" ? value.message : String(cause),
    };
  }
  return { message: String(cause) };
}
