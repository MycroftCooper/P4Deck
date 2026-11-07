import { t as translate } from "../../shared/i18n";
import { Languages, MonitorCog, Moon, Sun } from "lucide-react";
import type { ThemeMode } from "../../shared/contracts";
import type { Preferences } from "../hooks/usePreferences";
export function AppControls({ preferences }: { preferences: Preferences }) {
  const { theme, setTheme, setLocale, t } = preferences;
  const themeIcon =
    theme === "light" ? (
      <Sun size={16} />
    ) : theme === "dark" ? (
      <Moon size={16} />
    ) : (
      <MonitorCog size={16} />
    );
  return (
    <div className="preference-controls">
      <label className="theme-picker">
        {themeIcon}
        <select
          aria-label={translate("shell.theme")}
          value={theme}
          onChange={(event) => setTheme(event.target.value as ThemeMode)}
        >
          <option value="system">{t.system}</option>
          <option value="light">{t.light}</option>
          <option value="dark">{t.dark}</option>
        </select>
      </label>
      <button
        type="button"
        className="icon-button"
        aria-label={t.language}
        title={t.language}
        onClick={() =>
          setLocale((value) => (value === "zh-CN" ? "en-US" : "zh-CN"))
        }
      >
        <Languages size={17} />
      </button>
    </div>
  );
}
