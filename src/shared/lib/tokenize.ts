export function tokenize(input: string): string[] {
  const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) => token.replace(/^("|')|("|')$/g, ""));
}
