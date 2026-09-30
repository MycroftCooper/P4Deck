export function changelistNumber(text: string): string | undefined {
  const match = text.trim().match(/^(?:CL\s*#?\s*|#)?([1-9]\d*)$/i);
  return match?.[1];
}
