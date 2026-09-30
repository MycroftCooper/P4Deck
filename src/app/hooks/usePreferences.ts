import { useEffect, useState } from "react";
import { initialLocale, messages } from "../../shared/i18n";
import type { Locale, ThemeMode } from "../../shared/contracts/types";
import { readUiPreferences } from "../../features/settings/preferences";
import { storage } from "../../shared/lib/storage";

export function usePreferences() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = storage.getItem("p4deck.theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [ui, setUi] = useState(readUiPreferences);
  useEffect(() => {
    storage.setItem("p4deck.ui", JSON.stringify(ui));
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
  }, [locale]);
  useEffect(() => {
    storage.setItem("p4deck.theme", theme);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
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
