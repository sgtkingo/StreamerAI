import type { PlaybackPreferences } from "@streamer-ai/contracts";

export const MEDIA_LANGUAGES = [
  ["cs", "Čeština (CZ)"],
  ["en", "English (ENG)"],
  ["sk", "Slovenčina (SK)"],
  ["de", "Deutsch (DE)"],
  ["fr", "Français (FR)"],
  ["es", "Español (ES)"],
  ["it", "Italiano (IT)"],
  ["pl", "Polski (PL)"],
  ["ja", "日本語 (JA)"],
] as const;

interface PlaybackLanguageFieldsProps {
  value: PlaybackPreferences;
  onChange: (next: PlaybackPreferences) => void;
  section?: "all" | "audio" | "subtitles";
}

function languageOptions(includeOff = false) {
  return (
    <>
      {includeOff && <option value="off">Off</option>}
      {MEDIA_LANGUAGES.map(([code, label]) => (
        <option key={code} value={code}>
          {label}
        </option>
      ))}
    </>
  );
}

export function PlaybackLanguageFields({
  value,
  onChange,
  section = "all",
}: PlaybackLanguageFieldsProps) {
  return (
    <div className="playback-language-fields">
      {(section === "all" || section === "audio") && (
        <div className="settings-field-grid">
          <label className="field field--compact">
            <span>Primary audio language</span>
            <select
              value={value.primaryAudioLanguage}
              onChange={(event) => {
                const primaryAudioLanguage = event.target
                  .value as PlaybackPreferences["primaryAudioLanguage"];
                onChange({
                  ...value,
                  primaryAudioLanguage,
                  secondaryAudioSubtitleLanguage:
                    value.secondaryAudioSubtitleLanguage ===
                    value.primaryAudioLanguage
                      ? primaryAudioLanguage
                      : value.secondaryAudioSubtitleLanguage,
                });
              }}
            >
              {languageOptions()}
            </select>
          </label>
          <label className="field field--compact">
            <span>Secondary audio language</span>
            <select
              value={value.secondaryAudioLanguage}
              onChange={(event) =>
                onChange({
                  ...value,
                  secondaryAudioLanguage: event.target
                    .value as PlaybackPreferences["secondaryAudioLanguage"],
                })
              }
            >
              {languageOptions()}
            </select>
          </label>
        </div>
      )}
      {(section === "all" || section === "subtitles") && (
        <>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={value.autoFindSubtitles}
              onChange={(event) =>
                onChange({ ...value, autoFindSubtitles: event.target.checked })
              }
            />
            <span>Automatically find subtitles</span>
          </label>
          <p className="settings-note">
            Embedded subtitle tracks can be selected automatically. External
            subtitle lookup is planned; this switch saves your preference for
            it.
          </p>
          <div className="settings-field-grid">
            <label className="field field--compact">
              <span>Subtitles with primary audio</span>
              <select
                disabled={!value.autoFindSubtitles}
                value={value.primaryAudioSubtitleLanguage}
                onChange={(event) =>
                  onChange({
                    ...value,
                    primaryAudioSubtitleLanguage: event.target
                      .value as PlaybackPreferences["primaryAudioSubtitleLanguage"],
                  })
                }
              >
                {languageOptions(true)}
              </select>
            </label>
            <label className="field field--compact">
              <span>Subtitles with secondary audio</span>
              <select
                disabled={!value.autoFindSubtitles}
                value={value.secondaryAudioSubtitleLanguage}
                onChange={(event) =>
                  onChange({
                    ...value,
                    secondaryAudioSubtitleLanguage: event.target
                      .value as PlaybackPreferences["secondaryAudioSubtitleLanguage"],
                  })
                }
              >
                {languageOptions(true)}
              </select>
            </label>
          </div>
          <div className="settings-field-grid">
            <label className="field field--compact">
              <span>Subtitle size</span>
              <select
                value={value.subtitleSizePercent}
                onChange={(event) =>
                  onChange({
                    ...value,
                    subtitleSizePercent: Number(event.target.value),
                  })
                }
              >
                {[75, 100, 125, 150, 175, 200].map((size) => (
                  <option key={size} value={size}>
                    {size}%
                  </option>
                ))}
              </select>
            </label>
            <label className="field field--compact">
              <span>Subtitle font</span>
              <select
                value={value.subtitleFont}
                onChange={(event) =>
                  onChange({
                    ...value,
                    subtitleFont: event.target
                      .value as PlaybackPreferences["subtitleFont"],
                  })
                }
              >
                <option value="sans">Sans-serif</option>
                <option value="serif">Serif</option>
                <option value="mono">Monospace</option>
              </select>
            </label>
            <label className="field field--compact">
              <span>Subtitle color</span>
              <input
                type="color"
                value={value.subtitleColor}
                onChange={(event) =>
                  onChange({ ...value, subtitleColor: event.target.value })
                }
              />
            </label>
          </div>
        </>
      )}
    </div>
  );
}
