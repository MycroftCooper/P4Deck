import { Languages, MonitorCog, Moon, Sun } from "lucide-react";
import type { ThemeMode } from "../../shared/contracts/types";
import type { Preferences } from "../hooks/usePreferences";
export function AppControls({ preferences }: { preferences: Preferences }) {
  const { theme, setTheme, setLocale, t, zh } = preferences;
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
          aria-label={zh ? "主题" : "Theme"}
          value={theme}
          onChange={(event) => setTheme(event.target.value as ThemeMode)}
        >
          <option value="system">{t.system}</option>
          <option value="light">{t.light}</option>
          <option value="dark">{t.dark}</option>
        </select>
      </label>
      <button
        className="icon-button"
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
