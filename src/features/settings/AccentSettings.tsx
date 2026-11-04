import { t } from "../../shared/i18n";
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
              {zh ? item.zh : item.en}
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
          <small role="status">
            {zh
              ? "请输入六位十六进制颜色；当前主题保持上次有效值。"
              : "Enter six hex digits; the last valid color stays applied."}
          </small>
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
              <span>
                {dark ? (t("settings.dark")) : t("settings.light")}
              </span>{" "}
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
      <small>
        {zh
          ? "立即生效并保存；浅深主题自动调整明暗以保持可读性。成功、警告和错误颜色保持独立。"
          : "Applied and saved instantly; lightness adapts for readable contrast. Success, warning and error colors remain independent."}
      </small>
    </div>
  );
}
