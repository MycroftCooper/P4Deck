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
        {zh ? "主题强调色" : "Accent color"}
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
            {zh ? "自定义" : "Custom"}
          </option>
        </select>
      </label>
      <label>
        {zh ? "自定义颜色" : "Custom color"}
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <label>
        {zh ? "颜色值（#RRGGBB）" : "Color value (#RRGGBB)"}
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
        aria-label={zh ? "浅深色即时预览" : "Live light and dark previews"}
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
                {dark ? (zh ? "深色" : "Dark") : zh ? "浅色" : "Light"}
              </span>{" "}
              <span style={{ color: tokens["--accent"] }}>
                {zh ? "强调文字" : "Accent text"}
              </span>{" "}
              <span
                style={{
                  background: tokens["--accent"],
                  color: tokens["--on-accent"],
                  padding: "2px 6px",
                  borderRadius: 4,
                }}
              >
                {zh ? "按钮" : "Button"}
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
