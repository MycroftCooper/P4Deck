import { useEffect, useState } from "react";
import {
  backgroundPresets,
  backgroundTokens,
  defaultBackgroundTone,
  normalizeBackgroundTone,
} from "./background";

/**
 * Background tone control: a few coordinated presets, a custom color, and a
 * reset to the theme default. The preference applies live and is persisted by
 * `usePreferences`; light/dark readability is handled by `backgroundTokens`.
 */
export function BackgroundColorSettings({
  value,
  onChange,
  zh,
}: {
  value: string;
  onChange(value: string): void;
  zh: boolean;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const active = normalizeBackgroundTone(value);
  const validDraft = normalizeBackgroundTone(draft);
  const swatchValue = validDraft ?? active ?? backgroundPresets[0].tone;
  return (
    <div className="background-settings">
      <div className="background-settings-heading">
        <strong>{tr("背景色", "Background color")}</strong>
        <small>
          {tr(
            "默认跟随主题；选择或输入颜色后即时预览并保存，深浅主题会自动调整明暗以保持文字可读。",
            "Follows the theme by default. A chosen tone previews instantly and is saved; lightness adapts per theme so text stays readable.",
          )}
        </small>
      </div>
      <div
        className="background-swatches"
        role="group"
        aria-label={tr("背景色预设", "Background presets")}
      >
        <button
          type="button"
          className="background-swatch"
          aria-pressed={!active}
          onClick={() => onChange(defaultBackgroundTone)}
        >
          <span
            className="background-swatch-sample is-default"
            aria-hidden="true"
          />
          {tr("跟随主题", "Theme default")}
        </button>
        {backgroundPresets.map((preset) => (
          <button
            key={preset.tone}
            type="button"
            className="background-swatch"
            aria-pressed={active === preset.tone}
            title={zh ? preset.zh : preset.en}
            onClick={() => onChange(preset.tone)}
          >
            <span
              className="background-swatch-sample"
              style={{ background: preset.tone }}
              aria-hidden="true"
            />
            {zh ? preset.zh : preset.en}
          </button>
        ))}
      </div>
      <div className="background-custom">
        <label>
          {tr("自定义颜色", "Custom color")}
          <input
            type="color"
            value={swatchValue}
            aria-label={tr("自定义背景颜色", "Custom background color")}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        <label>
          {tr("颜色值（#RRGGBB）", "Color value (#RRGGBB)")}
          <input
            className="background-hex"
            value={draft}
            aria-invalid={!validDraft}
            spellCheck={false}
            maxLength={7}
            placeholder={backgroundPresets[0].tone}
            onChange={(event) => {
              setDraft(event.target.value);
              const tone = normalizeBackgroundTone(event.target.value);
              if (tone) onChange(tone);
            }}
            onBlur={() => {
              if (!normalizeBackgroundTone(draft)) setDraft(value);
            }}
          />
          {!validDraft && (
            <small role="status">
              {tr(
                "请输入六位十六进制颜色；当前背景保持上次有效值。",
                "Enter six hex digits; the last valid background stays applied.",
              )}
            </small>
          )}
        </label>
        <button
          type="button"
          className="secondary"
          disabled={!active}
          onClick={() => onChange(defaultBackgroundTone)}
        >
          {tr("恢复默认背景", "Reset background")}
        </button>
      </div>
      {active && (
        <div
          className="background-previews"
          aria-label={tr(
            "浅深色背景预览",
            "Light and dark background previews",
          )}
        >
          {[false, true].map((dark) => {
            const tokens = backgroundTokens(active, dark)!;
            return (
              <div
                key={String(dark)}
                className="background-preview"
                style={{
                  background: tokens["--bg"],
                  color: tokens["--text"],
                  borderColor: tokens["--border"],
                }}
              >
                <span>{dark ? tr("深色", "Dark") : tr("浅色", "Light")}</span>
                <span
                  className="background-preview-chrome"
                  style={{
                    background: tokens["--chrome"],
                    color: tokens["--text"],
                    borderColor: tokens["--border"],
                  }}
                >
                  {tr("工具栏", "Toolbar")}
                </span>
                <span
                  className="background-preview-panel"
                  style={{
                    background: tokens["--panel"],
                    color: tokens["--text"],
                    borderColor: tokens["--border"],
                  }}
                >
                  {tr("面板文字", "Panel text")}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
