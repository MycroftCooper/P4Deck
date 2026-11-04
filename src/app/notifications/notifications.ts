import { t } from "../../shared/i18n";
import { useEffect, useMemo } from "react";
import { backend } from "../../infrastructure/backend";
import type { RuntimeInfo } from "../../shared/contracts";
import { subscribeSafely } from "../../shared/lib/subscription";

export interface DesktopNotice {
  key: string;
  title: string;
  body: string;
  kind: "success" | "failure" | "attention";
}

export interface NotificationPreferences {
  enabled: boolean;
  failuresOnly: boolean;
}

export interface NotificationAdapter {
  send(notice: Omit<DesktopNotice, "key" | "kind">): void | Promise<void>;
}

export function requestDesktopAttention(notice: DesktopNotice) {
  window.dispatchEvent(
    new CustomEvent<DesktopNotice>("p4deck:desktop-notice", { detail: notice }),
  );
}

export function sanitizeNotificationText(input: string): string {
  return input
    .replace(/(p4passwd|password|ticket|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[A-Za-z]:\\[^\s]+/g, "[local path]")
    .replace(/\/(?:Users|home)\/[^\s]+/g, "[local path]")
    .replace(/\/\/[^\s]+/g, "[depot path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export class NotificationCenter {
  private readonly sent = new Map<string, number>();
  constructor(
    private readonly adapter: NotificationAdapter,
    private readonly preferences: () => NotificationPreferences,
    private readonly foreground: () => boolean,
    private readonly now: () => number = Date.now,
    private readonly cooldownMs = 30_000,
  ) {}

  async notify(notice: DesktopNotice): Promise<boolean> {
    const preferences = this.preferences();
    if (!preferences.enabled || this.foreground()) return false;
    if (preferences.failuresOnly && notice.kind === "success") return false;
    const now = this.now();
    if (now - (this.sent.get(notice.key) ?? -Infinity) < this.cooldownMs)
      return false;
    try {
      await this.adapter.send({
        title: sanitizeNotificationText(notice.title),
        body: sanitizeNotificationText(notice.body),
      });
      this.sent.set(notice.key, now);
      return true;
    } catch {
      return false;
    }
  }
}

export const browserNotificationAdapter: NotificationAdapter = {
  send({ title, body }) {
    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      throw new Error("Desktop notification permission is unavailable");
    new Notification(title, { body });
  },
};

export async function requestDesktopNotificationPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export function useDesktopNotifications(
  runtime: RuntimeInfo,
  preferences: NotificationPreferences,
  zh: boolean,
) {
  const center = useMemo(
    () =>
      new NotificationCenter(
        browserNotificationAdapter,
        () => preferences,
        () => document.visibilityState === "visible" && document.hasFocus(),
      ),
    [preferences.enabled, preferences.failuresOnly],
  );
  useEffect(() => {
    const started = new Map<string, number>();
    return subscribeSafely(
      () =>
        backend.subscribeOperationEvents((event) => {
          if (event.type === "started")
            started.set(event.operationId, Date.now());
          if (event.type === "error")
            void center.notify({
              key: `${event.operationId}:failure`,
              title: t("notify.p4.operation.needs.attention"),
              body:
                event.message ||
                (t("notify.return.to.p4deck.for.details")),
              kind: "failure",
            });
          if (event.type === "completed") {
            const elapsed =
              Date.now() - (started.get(event.operationId) ?? Date.now());
            started.delete(event.operationId);
            if (elapsed >= 15_000)
              void center.notify({
                key: `${event.operationId}:completed`,
                title: t("notify.long.p4.operation.completed"),
                body:
                  event.message ||
                  (t("notify.the.operation.completed")),
                kind: "success",
              });
          }
          if (event.type === "cancelled") started.delete(event.operationId);
        }),
      () => undefined,
    );
  }, [center, zh]);
  useEffect(() => {
    const receive = (event: Event) => {
      const notice = (event as CustomEvent<DesktopNotice>).detail;
      if (notice) void center.notify(notice);
    };
    window.addEventListener("p4deck:desktop-notice", receive);
    return () => window.removeEventListener("p4deck:desktop-notice", receive);
  }, [center]);
  useEffect(() => {
    if (
      ["authRequired", "ticketExpired", "externalAuthRequired"].includes(
        runtime.connection.state,
      )
    )
      void center.notify({
        key: `auth:${runtime.activeProfileId ?? "environment"}:${runtime.contextGeneration}`,
        title: t("notify.p4.authentication.needs.attention"),
        body: runtime.connection.message,
        kind: "attention",
      });
  }, [
    center,
    runtime.activeProfileId,
    runtime.connection.message,
    runtime.connection.state,
    runtime.contextGeneration,
    zh,
  ]);
}
