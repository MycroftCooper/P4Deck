const STATUSES = new Set(["passed", "failed", "skipped"]);

function invalidProtocol(reason, exitCode, required) {
  return {
    status: "failed",
    accepted: false,
    required,
    exitCode,
    reason,
  };
}

export function classifyStepResult({
  exitCode,
  required = true,
  protocol = "exit-code",
  protocolResult,
}) {
  if (protocol === "exit-code") {
    return {
      status: exitCode === 0 ? "passed" : "failed",
      accepted: exitCode === 0,
      required,
      exitCode,
      reason: exitCode === 0 ? "completed" : "nonzero-exit",
    };
  }

  if (protocol !== "p4d-e2e-v1") {
    return invalidProtocol("unknown-result-protocol", exitCode, required);
  }
  if (
    protocolResult?.schemaVersion !== 1 ||
    protocolResult?.suite !== "localhost-p4d-e2e" ||
    !STATUSES.has(protocolResult?.status)
  ) {
    return invalidProtocol("invalid-result-protocol", exitCode, required);
  }
  if (exitCode !== 0) {
    return invalidProtocol(
      protocolResult.reason || "nonzero-exit",
      exitCode,
      required,
    );
  }

  const status = protocolResult.status;
  return {
    status,
    accepted: status === "passed" || (status === "skipped" && !required),
    required,
    exitCode,
    reason: protocolResult.reason,
  };
}

export function summarySucceeded(results, expectedStepCount) {
  return (
    results.length === expectedStepCount &&
    results.every((result) => result.accepted)
  );
}
