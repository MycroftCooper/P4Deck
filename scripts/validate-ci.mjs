import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(".github", "workflows");
const files = (await readdir(directory)).filter((name) =>
  /\.ya?ml$/i.test(name),
);
const failures = [];

for (const file of files) {
  const source = await readFile(path.join(directory, file), "utf8");
  const fail = (rule) => failures.push({ file, rule });
  if (/pull_request_target\s*:/i.test(source))
    fail("pull_request_target_forbidden");
  if (/\$\{\{\s*secrets\./i.test(source))
    fail("workflow_secret_reference_forbidden");
  if (/actions\/upload-artifact@/i.test(source))
    fail("artifact_upload_forbidden");
  if (
    /\b(?:npm|pnpm|cargo)\s+publish\b|\bgh\s+release\b|\brelease:prepare\b/i.test(
      source,
    )
  )
    fail("publishing_command_forbidden");
  if (!/^permissions:\s*\r?\n\s+contents:\s*read\s*$/m.test(source))
    fail("minimum_permissions_required");
  if (/^\s+[A-Za-z-]+:\s*write\s*$/m.test(source))
    fail("write_permission_forbidden");
  if (
    !/^concurrency:\s*$/m.test(source) ||
    !/^\s+cancel-in-progress:\s*true\s*$/m.test(source)
  )
    fail("concurrency_required");
  if (!/^\s+timeout-minutes:\s*\d+\s*$/m.test(source))
    fail("job_timeout_required");
  if (
    /\b(?:eval|Invoke-Expression)\b|(?:curl|wget)[^\r\n|]*\|\s*(?:ba)?sh\b/i.test(
      source,
    )
  )
    fail("dangerous_shell_forbidden");
  for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)) {
    const reference = match[1];
    if (reference.startsWith("./")) continue;
    const revision = reference.split("@")[1] ?? "";
    if (!/^[0-9a-f]{40}$/i.test(revision))
      fail(`action_must_use_commit_sha:${reference}`);
  }
}

const result = { ok: failures.length === 0, workflows: files.length, failures };
process.stdout.write(`${JSON.stringify(result)}\n`);
if (failures.length > 0) process.exitCode = 1;
