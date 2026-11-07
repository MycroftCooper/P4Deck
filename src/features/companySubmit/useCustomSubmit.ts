import {
  sameSubmitIdentity,
  type SelectedSubmitExpectation,
} from "../changelists/selectedSubmit";
import { useEffect, useRef, useState } from "react";
import type { Backend } from "../../infrastructure/backend/contract";
import {
  customSubmitRequest,
  customSubmitRoute,
  type CustomSubmitSession,
} from "./customSubmit";
import type { ConnectionSnapshot } from "./model";
import {
  customSubmitIntentOf,
  customSubmitSessionOf,
  lookupCustomSubmitReceipt,
  type CustomSubmitIntent,
} from "./customSubmitLifecycle";
import { recordFrontendOperationLog } from "../../infrastructure/backend/frontendOperationLog";
import { notifyFailure } from "../../shared/notice";
import {
  claimCustomSubmitChange,
  isCustomSubmitChangeActive,
  releaseCustomSubmitChange,
} from "./customSubmitSessions";

type Port = Pick<
  Backend,
  | "companySubmitConnectionSnapshot"
  | "listConnectionProfiles"
  | "customSubmitStart"
  | "customSubmitStatus"
>;
export type CustomSubmitView =
  | { phase: "checking" | "starting" }
  | {
      phase: "session";
      session: CustomSubmitSession;
      intent: CustomSubmitIntent;
    }
  | { phase: "error"; message: string; uncertain: boolean };

/** Called only from the existing explicit submit action. Never retries or falls back on error. */
export function useCustomSubmit(scope: string, port: Port) {
  const [view, setView] = useState<CustomSubmitView>();
  const [visible, setVisible] = useState(false);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const sequence = useRef(0);
  const session = useRef<CustomSubmitSession | undefined>(undefined);
  const requestedId = useRef<string | undefined>(undefined);
  // No modal: terminal/uncertain outcomes are reported once to the frontend operation log.
  const report = (outcome: "failed" | "unknown") => {
    const id = requestedId.current ?? crypto.randomUUID();
    void recordFrontendOperationLog({
      eventId: `${id}-${outcome}`,
      operationId: id,
      action: "customSubmit",
      phase: "execute",
      outcome,
      code: outcome === "unknown" ? "uncertainOutcome" : "operationFailed",
      targetCount: 1,
    });
  };
  useEffect(() => {
    sequence.current++;
    // Host occupancy persists across connection changes; the next click must ask the host.
    session.current = undefined;
    requestedId.current = undefined;
    setView(undefined);
    setVisible(false);
  }, [scope]);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );

  async function handle(
    changeIds: readonly string[],
    expected?: SelectedSubmitExpectation,
  ): Promise<boolean> {
    const epoch = ++sequence.current;
    const current = () =>
      sequence.current === epoch && latestScope.current === scope;
    let invoked = false;
    let dispatchConnection: ConnectionSnapshot | undefined;
    let dispatchChangeId: string | undefined;
    try {
      const connection = await port.companySubmitConnectionSnapshot();
      dispatchConnection = connection;
      if (!current()) return true;
      const profiles = await port.listConnectionProfiles();
      if (!current()) return true;
      if (expected) {
        const active = profiles.profiles.find(
          (profile) => profile.id === profiles.activeProfileId,
        );
        if (
          !sameSubmitIdentity(connection, expected.connection) ||
          (active?.context.customSubmitExecutablePath ?? "") !==
            expected.customSubmitExecutablePath
        )
          throw new Error(
            "Connection or submit configuration changed; confirm again",
          );
      }
      const route = customSubmitRoute(profiles, connection, changeIds);
      if (route.kind === "native") {
        setView(undefined);
        return false;
      }
      if (isCustomSubmitChangeActive(scope, route.changeId)) {
        notifyFailure("duplicateChange", {
          zh: "companySubmit.a.custom.submit.tool.is.already",
          en: "companySubmit.a.custom.submit.tool.is.already",
        });
        return true;
      }
      dispatchChangeId = route.changeId;
      setVisible(true);
      setView({ phase: "starting" });
      const request = customSubmitRequest(
        route.changeId,
        connection,
        crypto.randomUUID(),
      );
      requestedId.current = request.requestId;
      claimCustomSubmitChange(scope, route.changeId, request.requestId);
      invoked = true;
      const raw: unknown = await port.customSubmitStart(request);
      if (!current()) return true;
      const result = customSubmitSessionOf(raw);
      if (
        !result ||
        result.requestId !== request.requestId ||
        result.changeId !== request.changeId
      )
        throw new Error("responseMismatch");
      // Intent only: started => running, notStarted => rejected (positive not-launched evidence).
      const intent = customSubmitIntentOf(raw);
      session.current = result;
      if (intent === "rejected") {
        releaseCustomSubmitChange(scope, route.changeId, request.requestId);
      }
      if (intent === "unknown") report("unknown");
      // A notStarted result is positive not-launched evidence; tell the user why nothing opened.
      if (result.state === "notStarted") {
        notifyFailure(result.reason ?? undefined, {
          zh: "companySubmit.the.tool.did",
          en: "companySubmit.the.tool.did",
        });
      }
      setView({ phase: "session", session: result, intent });
    } catch (error) {
      if (!current()) return true;
      if (invoked && requestedId.current && dispatchConnection) {
        // Same-requestId receipt recovery only; never a new id / automatic relaunch.
        try {
          const found = await lookupCustomSubmitReceipt(
            requestedId.current,
            dispatchConnection,
          );
          if (found.kind === "found") {
            const receipt = found.receipt.result;
            const recovered = customSubmitSessionOf(receipt);
            if (recovered) {
              const intent = customSubmitIntentOf(receipt);
              session.current = recovered;
              if (
                intent === "rejected" &&
                dispatchChangeId &&
                requestedId.current
              )
                releaseCustomSubmitChange(
                  scope,
                  dispatchChangeId,
                  requestedId.current,
                );
              setView({ phase: "session", session: recovered, intent });
              return true;
            }
          }
        } catch {
          /* A failed lookup is not permission to relaunch. */
        }
      }
      if (!invoked && dispatchChangeId && requestedId.current)
        releaseCustomSubmitChange(scope, dispatchChangeId, requestedId.current);
      report(invoked ? "unknown" : "failed");
      notifyFailure(error instanceof Error ? error.message : String(error), {
        zh: "companySubmit.custom.submit.failed",
        en: "companySubmit.custom.submit.failed",
      });
      setVisible(true);
      setView({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
        uncertain: invoked,
      });
    }
    return true;
  }

  async function refresh() {
    const epoch = sequence.current;
    try {
      const raw: unknown = await port.customSubmitStatus();
      if (epoch !== sequence.current || latestScope.current !== scope || !raw)
        return;
      const result = customSubmitSessionOf(raw);
      if (!result) return;
      if (!requestedId.current || requestedId.current !== result.requestId)
        return;
      const intent = customSubmitIntentOf(raw);
      session.current = result;
      if (intent === "rejected")
        releaseCustomSubmitChange(scope, result.changeId, result.requestId);
      if (intent === "unknown") report("unknown");
      // A notStarted result is positive not-launched evidence; tell the user why nothing opened.
      if (result.state === "notStarted") {
        notifyFailure(result.reason ?? undefined, {
          zh: "companySubmit.the.tool.did",
          en: "companySubmit.the.tool.did",
        });
      }
      setView({ phase: "session", session: result, intent });
    } catch (error) {
      if (epoch === sequence.current && latestScope.current === scope)
        setView({ phase: "error", message: String(error), uncertain: true });
    }
  }
  return { view, visible, handle, refresh, dismiss: () => setVisible(false) };
}
