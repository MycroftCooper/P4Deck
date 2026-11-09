import { tFor, type MsgKey } from "../../shared/i18n";
import { FixedPageHeader } from "../../app/docking/chrome";
import {
  Archive,
  Bell,
  Cable,
  Download,
  Keyboard,
  Palette,
  RefreshCw,
  ScrollText,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ConnectionStatus,
  Locale,
  P4Context,
  RuntimeInfo,
  ThemeMode,
} from "../../shared/contracts";
import { storage } from "../../shared/lib/storage";
import { ConnectionProfilesCard } from "./ConnectionProfilesCard";
import { BackupSettingsCard } from "./BackupSettingsCard";
import { UpdateSettingsCard } from "./UpdateSettingsCard";
import { LogSettingsCard } from "./LogSettingsCard";
import {
  clampGetLatestConfirmThreshold,
  defaultUi,
  getLatestConfirmThresholdMax,
  getLatestConfirmThresholdMin,
  type UiPreferences,
} from "./preferences";
import { AccentSettings } from "./AccentSettings";
import { BackgroundColorSettings } from "./BackgroundColorSettings";
import { ShortcutSettingsCard } from "./ShortcutSettingsCard";
import { SettingsNav } from "./SettingsNav";
import { SettingsSection } from "./SettingsSection";
import {
  expandSection,
  readCollapsedSections,
  SETTINGS_COLLAPSED_KEY,
  toggleCollapsedSection,
  writeCollapsedSections,
} from "./settingsCollapse";
import { requestDesktopNotificationPermission } from "../../app/notifications/notifications";

interface Props {
  runtime: RuntimeInfo;
  onConnection(
    context: P4Context,
    connection?: ConnectionStatus,
    p4Version?: string,
  ): void;
  onRuntime(runtime: RuntimeInfo): void;
  theme: ThemeMode;
  onTheme(theme: ThemeMode): void;
  locale: Locale;
  onLocale(locale: Locale): void;
  ui: UiPreferences;
  onUi(ui: UiPreferences): void;
}

interface SettingsSectionConfig {
  id: string;
  zh: string;
  en: string;
  icon: LucideIcon;
  wide?: boolean;
}

/** Navigation order is the reading order of the settings content. */
const SECTIONS: readonly SettingsSectionConfig[] = [
  {
    id: "connection",
    zh: "settings.section.connection",
    en: "settings.section.connection",
    icon: Cable,
    wide: true,
  },
  {
    id: "backup",
    zh: "settings.section.backup",
    en: "settings.section.backup",
    icon: Archive,
  },
  {
    id: "updates",
    zh: "settings.section.updates",
    en: "settings.section.updates",
    icon: Download,
  },
  {
    id: "logs",
    zh: "settings.section.logs",
    en: "settings.section.logs",
    icon: ScrollText,
  },
  {
    id: "checkout",
    zh: "settings.section.checkout",
    en: "settings.section.checkout",
    icon: SquarePen,
  },
  {
    id: "refresh",
    zh: "settings.section.refresh",
    en: "settings.section.refresh",
    icon: RefreshCw,
  },
  {
    id: "appearance",
    zh: "settings.section.appearance",
    en: "settings.section.appearance",
    icon: Palette,
    wide: true,
  },
  {
    id: "shortcuts",
    zh: "settings.section.shortcuts",
    en: "settings.section.shortcuts",
    icon: Keyboard,
  },
] as const;
export const SETTINGS_SECTION_IDS: readonly string[] = SECTIONS.map(
  (section) => section.id,
);
/** Test/QA surface: stable ids, localized labels and ordering of the modules. */
export function settingsSectionLabels(
  zh: boolean,
): Array<{ id: string; label: string }> {
  return SECTIONS.map((section) => ({
    id: section.id,
    label: tFor(zh ? "zh-CN" : "en-US", section.zh as MsgKey),
  }));
}

export function SettingsPage({
  runtime,
  onConnection,
  onRuntime,
  theme,
  onTheme,
  locale,
  onLocale,
  ui,
  onUi,
}: Props) {
  const zh = locale === "zh-CN";
  const refreshMinutes = ui.autoRefresh ? ui.autoRefreshMinutes : 0;
  const [refreshDraft, setRefreshDraft] = useState(String(refreshMinutes));
  useEffect(() => setRefreshDraft(String(refreshMinutes)), [refreshMinutes]);
  const confirmThreshold =
    ui.getLatestConfirmThreshold ?? defaultUi.getLatestConfirmThreshold;
  const [confirmThresholdDraft, setConfirmThresholdDraft] = useState(
    String(confirmThreshold),
  );
  useEffect(
    () => setConfirmThresholdDraft(String(confirmThreshold)),
    [confirmThreshold],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    readCollapsedSections(
      storage.getItem(SETTINGS_COLLAPSED_KEY),
      SETTINGS_SECTION_IDS,
    ),
  );
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);
  const navRef = useRef<HTMLElement | null>(null);
  // Scroll spy: highlight the section nearest the top of the scroll viewport.
  useEffect(() => {
    const elements = SECTIONS.map((section) =>
      document.getElementById(`settings-section-${section.id}`),
    ).filter((element): element is HTMLElement => element !== null);
    if (!elements.length || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0]?.target.getAttribute("data-settings-section");
        if (id) setActiveId(id);
      },
      { rootMargin: "-12% 0px -70% 0px", threshold: 0 },
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);
  const persistCollapsed = (next: Set<string>) => {
    writeCollapsedSections(next, SETTINGS_SECTION_IDS);
    return next;
  };
  const toggle = (id: string) =>
    setCollapsed((current) =>
      persistCollapsed(toggleCollapsedSection(current, id)),
    );
  const goTo = (id: string) => {
    setActiveId(id);
    // Jumping to a collapsed module expands it so its content is readable.
    setCollapsed((current) => {
      const next = expandSection(current, id);
      return next.size === current.size ? current : persistCollapsed(next);
    });
    document
      .getElementById(`settings-section-${id}`)
      ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    // Keep keyboard users on the navigation control they just activated.
    navRef.current
      ?.querySelector<HTMLButtonElement>(`[data-settings-nav="${id}"]`)
      ?.focus();
  };
  const navItems = SECTIONS.map((config) => {
    const Icon = config.icon;
    return {
      id: config.id,
      label: tFor(zh ? "zh-CN" : "en-US", config.zh as MsgKey),
      icon: <Icon size={16} aria-hidden="true" />,
    };
  });
  const section = (id: string) => SECTIONS.find((item) => item.id === id)!;
  const propsFor = (id: string) => {
    const config = section(id);
    const Icon = config.icon;
    return {
      id,
      title: tFor(zh ? "zh-CN" : "en-US", config.zh as MsgKey),
      icon: <Icon size={18} aria-hidden="true" />,
      expanded: !collapsed.has(id),
      onToggle: () => toggle(id),
      zh,
      wide: config.wide,
    };
  };
  return (
    <section className="settings-page">
      <FixedPageHeader
        description={tFor(
          zh ? "zh-CN" : "en-US",
          "settings.global.preferences.saved.connections.switch.only",
        )}
      ></FixedPageHeader>
      <div className="settings-layout">
        <div
          className="settings-nav-shell"
          ref={(node) => {
            navRef.current = node;
          }}
        >
          <SettingsNav
            items={navItems}
            activeId={activeId}
            onSelect={goTo}
            label={tFor(zh ? "zh-CN" : "en-US", "settings.settings.sections")}
          />
        </div>
        <div className="settings-content">
          <SettingsSection {...propsFor("connection")}>
            <ConnectionProfilesCard
              runtime={runtime}
              onConnection={onConnection}
              onRuntime={onRuntime}
              locale={locale}
            />
          </SettingsSection>
          <SettingsSection {...propsFor("backup")}>
            <BackupSettingsCard zh={zh} native={runtime.mode === "tauri"} />
          </SettingsSection>
          <SettingsSection {...propsFor("updates")}>
            <UpdateSettingsCard zh={zh} native={runtime.mode === "tauri"} />
          </SettingsSection>
          <SettingsSection {...propsFor("logs")}>
            <LogSettingsCard zh={zh} native={runtime.mode === "tauri"} />
          </SettingsSection>
          <SettingsSection {...propsFor("checkout")}>
            <div className="settings-card">
              <div className="settings-grid">
                <label>
                  {tFor(
                    zh ? "zh-CN" : "en-US",
                    "settings.always.check.out.to.default.cl",
                  )}
                  <select
                    value={String(ui.checkoutUseDefault)}
                    onChange={(event) =>
                      onUi({
                        ...ui,
                        checkoutUseDefault: event.target.value === "true",
                      })
                    }
                  >
                    <option value="false">
                      {tFor(
                        zh ? "zh-CN" : "en-US",
                        "settings.off.ask.when.multiple.cls.exist",
                      )}
                    </option>
                    <option value="true">
                      {tFor(
                        zh ? "zh-CN" : "en-US",
                        "settings.on.always.use.default",
                      )}
                    </option>
                  </select>
                </label>
              </div>
              <p>
                {tFor(
                  zh ? "zh-CN" : "en-US",
                  "settings.when.off.choose.a.destination.before",
                )}
              </p>
            </div>
          </SettingsSection>
          <SettingsSection {...propsFor("refresh")}>
            <div className="settings-card">
              <div className="settings-grid refresh-settings-grid">
                <label>
                  <span className="settings-field-label">
                    {tFor(
                      zh ? "zh-CN" : "en-US",
                      "settings.auto.refresh.interval.minutes",
                    )}
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={refreshDraft}
                    aria-describedby="refresh-interval-help"
                    onChange={(event) => {
                      setRefreshDraft(event.target.value);
                      const minutes = event.target.valueAsNumber;
                      if (Number.isSafeInteger(minutes) && minutes >= 0)
                        onUi({
                          ...ui,
                          autoRefreshMinutes: minutes,
                          autoRefresh: minutes > 0,
                        });
                    }}
                    onBlur={() => setRefreshDraft(String(refreshMinutes))}
                  />
                  <small id="refresh-interval-help">
                    {tFor(
                      zh ? "zh-CN" : "en-US",
                      "settings.default.5.minutes.set.to.0",
                    )}
                  </small>
                </label>
                <label>
                  <span className="settings-field-label">
                    {tFor(
                      zh ? "zh-CN" : "en-US",
                      "settings.get.latest.confirmation.threshold.changed.files",
                    )}
                  </span>
                  <input
                    type="number"
                    min={getLatestConfirmThresholdMin}
                    max={getLatestConfirmThresholdMax}
                    step={1}
                    aria-label={tFor(
                      zh ? "zh-CN" : "en-US",
                      "settings.get.latest.confirmation.threshold",
                    )}
                    aria-describedby="get-latest-threshold-help"
                    value={confirmThresholdDraft}
                    onChange={(event) => {
                      setConfirmThresholdDraft(event.target.value);
                      const value = event.target.valueAsNumber;
                      if (!Number.isSafeInteger(value)) return;
                      const clamped = clampGetLatestConfirmThreshold(value);
                      if (clamped !== confirmThreshold)
                        onUi({ ...ui, getLatestConfirmThreshold: clamped });
                    }}
                    onBlur={() => {
                      const clamped = clampGetLatestConfirmThreshold(
                        Number(confirmThresholdDraft),
                      );
                      setConfirmThresholdDraft(String(clamped));
                      if (clamped !== confirmThreshold)
                        onUi({ ...ui, getLatestConfirmThreshold: clamped });
                    }}
                  />
                  <small id="get-latest-threshold-help">
                    {tFor(
                      zh ? "zh-CN" : "en-US",
                      "settings.default.latest.asks",
                    )}
                  </small>
                </label>
                <label>
                  <span className="settings-field-label">
                    <Bell size={14} aria-hidden="true" />
                    {tFor(
                      zh ? "zh-CN" : "en-US",
                      "settings.desktop.notifications",
                    )}
                  </span>
                  <select
                    value={String(ui.desktopNotifications)}
                    onChange={(event) => {
                      const enabled = event.target.value === "true";
                      if (!enabled) {
                        onUi({ ...ui, desktopNotifications: false });
                        return;
                      }
                      void requestDesktopNotificationPermission().then(
                        (granted) =>
                          onUi({ ...ui, desktopNotifications: granted }),
                      );
                    }}
                  >
                    <option value="false">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.off")}
                    </option>
                    <option value="true">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.on")}
                    </option>
                  </select>
                </label>
                <label>
                  <span className="settings-field-label">
                    {tFor(
                      zh ? "zh-CN" : "en-US",
                      "settings.notification.scope",
                    )}
                  </span>
                  <select
                    value={String(ui.notifyOnlyFailures)}
                    disabled={!ui.desktopNotifications}
                    onChange={(event) =>
                      onUi({
                        ...ui,
                        notifyOnlyFailures: event.target.value === "true",
                      })
                    }
                  >
                    <option value="false">
                      {tFor(
                        zh ? "zh-CN" : "en-US",
                        "settings.long.operations.and.attention",
                      )}
                    </option>
                    <option value="true">
                      {tFor(
                        zh ? "zh-CN" : "en-US",
                        "settings.failures.and.attention.only",
                      )}
                    </option>
                  </select>
                </label>
              </div>
              <p>
                {tFor(
                  zh ? "zh-CN" : "en-US",
                  "settings.automatic.refresh.retries.only.idempotent.reads",
                )}
              </p>
            </div>
          </SettingsSection>
          <SettingsSection {...propsFor("appearance")}>
            <div className="settings-card">
              <AccentSettings
                value={ui.accentColor}
                onChange={(accentColor) => onUi({ ...ui, accentColor })}
                zh={zh}
              />
              <BackgroundColorSettings
                value={ui.backgroundTone}
                onChange={(backgroundTone) => onUi({ ...ui, backgroundTone })}
                zh={zh}
              />
              <div className="settings-grid">
                <label>
                  {tFor(zh ? "zh-CN" : "en-US", "settings.theme")}
                  <select
                    value={theme}
                    onChange={(event) =>
                      onTheme(event.target.value as ThemeMode)
                    }
                  >
                    <option value="system">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.system")}
                    </option>
                    <option value="light">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.light.2")}
                    </option>
                    <option value="dark">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.dark.2")}
                    </option>
                  </select>
                </label>
                <label>
                  {tFor(zh ? "zh-CN" : "en-US", "settings.language")}
                  <select
                    value={locale}
                    onChange={(event) => onLocale(event.target.value as Locale)}
                  >
                    {/* i18n-exempt: a language endonym is shown in its own language, not translated copy. */}
                    <option value="zh-CN">简体中文</option>
                    <option value="en-US">English</option>
                  </select>
                </label>
                <label>
                  {tFor(zh ? "zh-CN" : "en-US", "settings.file.list.density")}
                  <select
                    value={String(ui.compact)}
                    onChange={(event) =>
                      onUi({ ...ui, compact: event.target.value === "true" })
                    }
                  >
                    <option value="false">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.comfortable")}
                    </option>
                    <option value="true">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.compact")}
                    </option>
                  </select>
                </label>
                <label>
                  {tFor(zh ? "zh-CN" : "en-US", "settings.sidebar.width")}
                  <select
                    value={ui.sidebarWidth}
                    onChange={(event) =>
                      onUi({
                        ...ui,
                        sidebarWidth: Number(event.target.value),
                      })
                    }
                  >
                    {![200, 240, 280, 320].includes(ui.sidebarWidth) && (
                      <option value={ui.sidebarWidth}>
                        {ui.sidebarWidth} px
                      </option>
                    )}
                    {[200, 240, 280, 320].map((value) => (
                      <option key={value} value={value}>
                        {value} px
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {tFor(zh ? "zh-CN" : "en-US", "settings.list.font.size")}
                  <select
                    value={ui.fontSize}
                    onChange={(event) =>
                      onUi({ ...ui, fontSize: Number(event.target.value) })
                    }
                  >
                    {[11, 12, 13, 14].map((value) => (
                      <option key={value} value={value}>
                        {value} px
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {tFor(zh ? "zh-CN" : "en-US", "settings.reduce.motion")}
                  <select
                    value={String(ui.reducedMotion)}
                    onChange={(event) =>
                      onUi({
                        ...ui,
                        reducedMotion: event.target.value === "true",
                      })
                    }
                  >
                    <option value="false">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.off")}
                    </option>
                    <option value="true">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.on")}
                    </option>
                  </select>
                </label>
                <label>
                  {tFor(
                    zh ? "zh-CN" : "en-US",
                    "settings.show.activity.bar.labels",
                  )}
                  <select
                    value={String(ui.activityBarText)}
                    onChange={(event) =>
                      onUi({
                        ...ui,
                        activityBarText: event.target.value === "true",
                      })
                    }
                  >
                    <option value="true">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.on")}
                    </option>
                    <option value="false">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.off")}
                    </option>
                  </select>
                </label>
                <label>
                  {tFor(zh ? "zh-CN" : "en-US", "settings.show.toolbar.labels")}
                  <select
                    value={String(ui.toolbarText)}
                    onChange={(event) =>
                      onUi({
                        ...ui,
                        toolbarText: event.target.value === "true",
                      })
                    }
                  >
                    <option value="true">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.on")}
                    </option>
                    <option value="false">
                      {tFor(zh ? "zh-CN" : "en-US", "settings.off")}
                    </option>
                  </select>
                </label>
              </div>
              <div className="settings-actions">
                <button
                  className="secondary"
                  onClick={() => {
                    onUi(defaultUi);
                    onTheme("system");
                  }}
                >
                  {tFor(zh ? "zh-CN" : "en-US", "settings.reset.appearance")}
                </button>
              </div>
            </div>
          </SettingsSection>
          <SettingsSection {...propsFor("shortcuts")}>
            <ShortcutSettingsCard zh={zh} />
          </SettingsSection>
        </div>
      </div>
    </section>
  );
}
