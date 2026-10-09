import { describe, expect, it } from "vitest";
import { tokenize } from "../../shared/lib/tokenize";
import { inspectTerminalCommand } from "./terminalSecurity";

describe("terminal credential boundary", () => {
  it.each([
    "tickets",
    "PASSWD",
    "p4 login",
    "p4 login2",
    "p4 LoGoUt",
    "trust -y",
    "-p ssl:localhost:1666 tickets",
    "--port ssl:localhost:1666 logout",
    "set",
    "configure show",
    "info -P sentinel",
    "info -Psentinel",
    "info P4PASSWD=sentinel",
    "info P4TICKETS=C:\\sentinel-ticket",
    "info Authorization: Bearer sentinel",
    'info "p4tickets=C:\\\\safe path\\tickets"',
  ])("blocks and hides %s", (raw) => {
    const decision = inspectTerminalCommand(raw, tokenize(raw));
    expect(decision.blocked).toBe(true);
    expect(decision.sensitive).toBe(true);
    expect(decision.display).not.toContain("sentinel");
    expect(decision.display).not.toContain("safe path");
  });

  it.each(["lock //depot/main/a.txt", "p4 unlock //depot/main/a.txt"])(
    "routes %s to the dedicated lock workflow without treating paths as secrets",
    (raw) => {
      expect(inspectTerminalCommand(raw, tokenize(raw))).toEqual({
        blocked: true,
        sensitive: false,
        display: raw,
        reason: "lockWorkflow",
      });
    },
  );

  it.each(["info", "files //depot/main/...", "changes -m 20"])(
    "keeps normal command behavior for %s",
    (raw) => {
      expect(inspectTerminalCommand(raw, tokenize(raw))).toEqual({
        blocked: false,
        sensitive: false,
        display: raw,
      });
    },
  );

  it("does not hide ordinary ticket words or digest-shaped values without credential context", () => {
    const raw = "files //depot/ticket/... 0123456789abcdef0123456789abcdef";
    expect(inspectTerminalCommand(raw, tokenize(raw))).toEqual({
      blocked: false,
      sensitive: false,
      display: raw,
    });
  });
});
