import { t, tFor, type MsgKey } from "../../shared/i18n";
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
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const active = normalizeBackgroundTone(value);
  const validDraft = normalizeBackgroundTone(draft);
  const swatchValue = validDraft ?? active ?? backgroundPresets[0].tone;
  return (
    <div className="background-settings">
      <div className="background-settings-heading">
        <strong>{t("settings.background.color")}</strong>
        <small>{t("settings.follows.by.default")}</small>
      </div>
      <div
        className="background-swatches"
        role="group"
        aria-label={t("settings.background.presets")}
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
          {t("settings.theme.default")}
        </button>
        {backgroundPresets.map((preset) => (
          <button
            key={preset.tone}
            type="button"
            className="background-swatch"
            aria-pressed={active === preset.tone}
            title={tFor(zh ? "zh-CN" : "en-US", preset.zh as MsgKey)}
            onClick={() => onChange(preset.tone)}
          >
            <span
              className="background-swatch-sample"
              style={{ background: preset.tone }}
              aria-hidden="true"
            />
            {tFor(zh ? "zh-CN" : "en-US", preset.zh as MsgKey)}
          </button>
        ))}
      </div>
      <div className="background-custom">
        <label>
          {t("settings.custom.color")}
          <input
            type="color"
            value={swatchValue}
            aria-label={t("settings.custom.background.color")}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        <label>
          {t("settings.color.value.rrggbb")}
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
              {t("settings.enter.six.hex.digits.the.last")}
            </small>
          )}
        </label>
        <button
          type="button"
          className="secondary"
          disabled={!active}
          onClick={() => onChange(defaultBackgroundTone)}
        >
          {t("settings.reset.background")}
        </button>
      </div>
      {active && (
        <div
          className="background-previews"
          aria-label={t("settings.light.and.dark.background.previews")}
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
                <span>{dark ? t("settings.dark") : t("settings.light")}</span>
                <span
                  className="background-preview-chrome"
                  style={{
                    background: tokens["--chrome"],
                    color: tokens["--text"],
                    borderColor: tokens["--border"],
                  }}
                >
                  {t("settings.toolbar")}
                </span>
                <span
                  className="background-preview-panel"
                  style={{
                    background: tokens["--panel"],
                    color: tokens["--text"],
                    borderColor: tokens["--border"],
                  }}
                >
                  {t("settings.panel.text")}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
