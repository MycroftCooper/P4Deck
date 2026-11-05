import { t, tFor, type MsgKey } from "../../shared/i18n";
import { useEffect, useState } from "react";
import { accentPresets, accentTokens, normalizeAccent } from "./accent";

export function AccentSettings({
  value,
  onChange,
  zh,
}: {
  value: string;
  onChange(value: string): void;
  zh: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = normalizeAccent(draft);
  const preset = accentPresets.some((item) => item.color === value)
    ? value
    : "custom";
  return (
    <div className="accent-settings">
      <label>
        {t("settings.accent.color")}
        <select
          value={preset}
          onChange={(event) => {
            if (event.target.value !== "custom") onChange(event.target.value);
          }}
        >
          {accentPresets.map((item) => (
            <option key={item.color} value={item.color}>
              {tFor(zh ? "zh-CN" : "en-US", item.zh as MsgKey)}
            </option>
          ))}
          <option value="custom" disabled>
            {t("settings.custom")}
          </option>
        </select>
      </label>
      <label>
        {t("settings.custom.color")}
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <label>
        {t("settings.color.value.rrggbb")}
        <input
          value={draft}
          aria-invalid={!valid}
          spellCheck={false}
          maxLength={7}
          onChange={(event) => {
            setDraft(event.target.value);
            const color = normalizeAccent(event.target.value);
            if (color) onChange(color);
          }}
        />
        {!valid && (
          <small role="status">{t("settings.enter.six.hex.digits.the")}</small>
        )}
      </label>
      <div
        className="accent-previews"
        aria-label={t("settings.live.light.and.dark.previews")}
      >
        {[false, true].map((dark) => {
          const tokens = accentTokens(value, dark);
          return (
            <div
              key={String(dark)}
              style={{
                background: dark ? "#1b211e" : "#ffffff",
                color: dark ? "#edf3ef" : "#22312a",
                padding: 8,
                borderRadius: 4,
              }}
            >
              <span>{dark ? t("settings.dark") : t("settings.light")}</span>{" "}
              <span style={{ color: tokens["--accent"] }}>
                {t("settings.accent.text")}
              </span>{" "}
              <span
                style={{
                  background: tokens["--accent"],
                  color: tokens["--on-accent"],
                  padding: "2px 6px",
                  borderRadius: 4,
                }}
              >
                {t("settings.button")}
              </span>
            </div>
          );
        })}
      </div>
      <small>{t("settings.applied.and.saved.instantly.lightness")}</small>
    </div>
  );
}
