export function switchFailure(cause: unknown, zh: boolean) {
  const value =
    cause && typeof cause === "object"
      ? (cause as { code?: string; message?: string })
      : undefined;
  const code = value?.code ?? String(cause).match(/(?:Error:\s*)?(\w+):/)?.[1];
  const recovery: Record<string, [string, string]> = {
    contextChanged: [
      "活动连接已变化，请刷新 Workspace 后重试。",
      "The active connection changed. Refresh workspaces and retry.",
    ],
    authenticationRequired: [
      "当前 Profile 需要登录，请到设置中完成认证后重试。",
      "The current profile requires login. Authenticate in Settings, then retry.",
    ],
    connectionFailed: [
      "目标 Workspace 验证失败，请检查 Server、Client 与 Root。",
      "Target workspace verification failed. Check its server, client, and root.",
    ],
    notFound: [
      "目标 Workspace 已不存在或不再属于当前用户，请刷新列表。",
      "The target workspace no longer exists or is not owned by this user. Refresh the list.",
    ],
  };
  const copy = code ? recovery[code] : undefined;
  return copy
    ? zh
      ? copy[0]
      : copy[1]
    : zh
      ? "切换请求未完成，请刷新后重试。"
      : "The switch request did not complete. Refresh and retry.";
}
