import { useEffect, useState } from "react";
import { activateLocale, initialLocale, messages } from "../../shared/i18n";
import { changeLocale } from "../../shared/i18n/index";
import type { Locale, ThemeMode } from "../../shared/contracts";
import {
  readUiPreferences,
  saveUiPreferences,
} from "../../features/settings/preferences";
import { storage } from "../../shared/lib/storage";
import { accentTokens } from "../../features/settings/accent";
import {
  backgroundAccentSurfaces,
  backgroundTokens,
  backgroundVariableNames,
} from "../../features/settings/background";
import { notifyFailure } from "../../shared/notice";

export function usePreferences() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = storage.getItem("p4deck.theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [ui, setUi] = useState(readUiPreferences);
  useEffect(() => {
    if (!saveUiPreferences(ui))
      notifyFailure(undefined, {
        zh: "shell.saving.appearance.preferences.failed.these.changes",
        en: "shell.saving.appearance.preferences.failed.these.changes",
      });
    document.documentElement.style.setProperty(
      "--list-font-size",
      `${ui.fontSize}px`,
    );
    document.documentElement.dataset.reducedMotion = String(ui.reducedMotion);
    document.documentElement.dataset.activityBarText = String(
      ui.activityBarText,
    );
    document.documentElement.dataset.toolbarText = String(ui.toolbarText);
    document.documentElement.style.setProperty(
      "--activity-bar-width",
      ui.activityBarText ? "124px" : "48px",
    );
  }, [ui]);
  useEffect(() => {
    document.documentElement.lang = locale;
    storage.setItem("p4deck.locale", locale);
    // Keep the non-React resolver (notices, action confirmations) in step.
    activateLocale(locale);
    changeLocale(locale);
  }, [locale]);
  useEffect(() => {
    storage.setItem("p4deck.theme", theme);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      const dark = resolved === "dark";
      document.documentElement.dataset.theme = resolved;
      const background = backgroundTokens(ui.backgroundTone, dark);
      if (background) {
        for (const [key, value] of Object.entries(background))
          document.documentElement.style.setProperty(key, value);
      } else {
        // Back to the theme surfaces: drop the inline custom-background values.
        for (const name of backgroundVariableNames)
          document.documentElement.style.removeProperty(name);
      }
      const surfaces = background
        ? backgroundAccentSurfaces(background)
        : undefined;
      for (const [key, value] of Object.entries(
        accentTokens(ui.accentColor, dark, surfaces),
      )) {
        document.documentElement.style.setProperty(key, value);
      }
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, ui.accentColor, ui.backgroundTone]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === "p4deck.ui") setUi(readUiPreferences());
      if (
        event.key === "p4deck.theme" &&
        ["light", "dark", "system"].includes(event.newValue ?? "")
      )
        setTheme(event.newValue as ThemeMode);
      if (
        event.key === "p4deck.locale" &&
        ["zh-CN", "en-US"].includes(event.newValue ?? "")
      )
        setLocale(event.newValue as Locale);
    };
    addEventListener("storage", sync);
    return () => removeEventListener("storage", sync);
  }, []);
  return {
    locale,
    setLocale,
    theme,
    setTheme,
    ui,
    setUi,
    t: messages[locale],
    zh: locale === "zh-CN",
  };
}
export type Preferences = ReturnType<typeof usePreferences>;
