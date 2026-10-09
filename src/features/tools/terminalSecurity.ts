const CONTROLLED_COMMANDS = new Set([
  "login",
  "login2",
  "logout",
  "trust",
  "tickets",
  "passwd",
  "set",
  "configure",
]);

const SECRET_ASSIGNMENT =
  /^(?:p4passwd|p4tickets|password|passwd|ticket|authorization)\s*=/i;
const SECRET_LONG_OPTION = /^--(?:password|ticket|tickets)(?:=|$)/i;

export interface TerminalSecurityDecision {
  blocked: boolean;
  sensitive: boolean;
  display: string;
}

export function inspectTerminalCommand(
  raw: string,
  parsed: readonly string[],
): TerminalSecurityDecision {
  const tokens = [...parsed];
  if (tokens[0]?.toLowerCase() === "p4") tokens.shift();
  const secretArgument = tokens.some(
    (token) =>
      token === "-P" ||
      (token.startsWith("-P") && token.length > 2) ||
      SECRET_LONG_OPTION.test(unquote(token)) ||
      SECRET_ASSIGNMENT.test(unquote(token)),
  );
  const command = effectiveCommand(tokens);
  const credentialMaterial =
    /\b(?:p4passwd|p4tickets|password|passwd|ticket|authorization)\b\s*[:=]\s*\S+/i.test(
      raw,
    ) ||
    /\bticket\s+value(?:\s*[:=]|\s+)\S+/i.test(raw) ||
    /\bbearer\s+\S+/i.test(raw);
  const blocked =
    secretArgument ||
    credentialMaterial ||
    Boolean(command && CONTROLLED_COMMANDS.has(command));
  const sensitive = blocked;
  return {
    blocked,
    sensitive,
    display: sensitive ? "[credential-sensitive command hidden]" : raw,
  };
}

function effectiveCommand(tokens: readonly string[]): string | undefined {
  let index = 0;
  while (index < tokens.length) {
    const token = unquote(tokens[index] ?? "");
    if (!token) {
      index += 1;
      continue;
    }
    if (!token.startsWith("-") && !token.includes("=")) {
      return token.toLowerCase();
    }
    if (takesValue(token) && !hasAttachedValue(token)) index += 2;
    else index += 1;
  }
  return undefined;
}

function takesValue(token: string): boolean {
  return [
    "-p",
    "-u",
    "-c",
    "-C",
    "-d",
    "-H",
    "-L",
    "-P",
    "-x",
    "--port",
    "--user",
    "--client",
    "--charset",
    "--directory",
    "--host",
    "--password",
    "--tickets",
  ].includes(token);
}

function hasAttachedValue(token: string): boolean {
  return (
    (token.startsWith("-P") && token.length > 2) ||
    /^--(?:password|tickets)=/i.test(token)
  );
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
