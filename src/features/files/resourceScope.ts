/** Tree navigation and the configured workspace root are separate identities. */
export function resourceScope(
  mode: "workspace" | "depot",
  directory?: string,
  cwd?: string,
) {
  const current =
    mode === "workspace"
      ? directory?.startsWith("//")
        ? undefined
        : directory
      : directory?.startsWith("//")
        ? directory
        : "";
  return {
    current,
    root: cwd ?? "",
    depot: mode === "depot" ? current : undefined,
  };
}
