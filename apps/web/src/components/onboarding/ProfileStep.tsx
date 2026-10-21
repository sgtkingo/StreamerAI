import type { ProfileDraft } from "../../api/client";
import { PlaybackLanguageFields } from "../PlaybackLanguageFields";
import { ThemeSelect } from "../../theme/ThemeSelect";
import { mergeAppearancePreferences } from "@streamer-ai/contracts";
import { AppearanceInfluenceFields } from "../../theme/AppearanceInfluenceFields";

const preferences = [
  "Drama",
  "Comedy",
  "Sci-fi",
  "Documentary",
  "Thriller",
  "Family",
  "Fantasy",
  "Anime",
];

interface ProfileStepProps {
  profile: ProfileDraft;
  onChange: (profile: ProfileDraft) => void;
}

export function ProfileStep({ profile, onChange }: ProfileStepProps) {
  const togglePreference = (preference: string) => {
    const next = profile.preferences.includes(preference)
      ? profile.preferences.filter((item) => item !== preference)
      : [...profile.preferences, preference];
    onChange({ ...profile, preferences: next });
  };

  return (
    <div className="step-copy">
      <p className="eyebrow">Profile 1 of 5</p>
      <h1 tabIndex={-1}>Make it yours.</h1>
      <p className="step-lead">
        A name is all we need. Preferences are optional and improve your first
        recommendations.
      </p>

      <div className="form-stack">
        <label className="field">
          <span>Display name</span>
          <input
            autoComplete="nickname"
            maxLength={40}
            placeholder="How should we call you?"
            value={profile.name}
            onChange={(event) =>
              onChange({ ...profile, name: event.target.value })
            }
          />
        </label>

        <label className="field field--compact">
          <span>Interface language</span>
          <select
            value={profile.locale}
            onChange={(event) =>
              onChange({
                ...profile,
                locale: event.target.value as ProfileDraft["locale"],
              })
            }
          >
            <option value="en">English</option>
            <option value="cs">Čeština</option>
            <option value="de">Deutsch</option>
          </select>
        </label>

        <fieldset className="preference-fieldset">
          <legend>Theme</legend>
          <p>
            Choose your atmosphere. Seasonal follows the calendar and local
            time. Preview weather and lighting here, or fine-tune and fix the
            look in Settings.
          </p>
          <ThemeSelect
            value={profile.appearance.mode}
            locale={profile.locale}
            onChange={(mode) =>
              onChange({
                ...profile,
                appearance: mergeAppearancePreferences(profile.appearance, {
                  mode,
                }),
              })
            }
          />
          <div className="theme-detail-grid theme-detail-grid--onboarding">
            <AppearanceInfluenceFields
              locale={profile.locale}
              weather={profile.appearance.weatherOverride}
              daylight={profile.appearance.daylightOverride}
              disabled={profile.appearance.mode === "cinematic"}
              onWeatherChange={(weatherOverride) =>
                onChange({
                  ...profile,
                  appearance: mergeAppearancePreferences(profile.appearance, {
                    weatherOverride,
                  }),
                })
              }
              onDaylightChange={(daylightOverride) =>
                onChange({
                  ...profile,
                  appearance: mergeAppearancePreferences(profile.appearance, {
                    daylightOverride,
                  }),
                })
              }
            />
          </div>
          <label className="theme-checkbox">
            <input
              type="checkbox"
              checked={profile.appearance.ambientMotion}
              onChange={(event) =>
                onChange({
                  ...profile,
                  appearance: {
                    ...profile.appearance,
                    ambientMotion: event.target.checked,
                  },
                })
              }
            />
            <span>Ambient motion</span>
          </label>
        </fieldset>
        <fieldset className="preference-fieldset">
          <legend>What do you enjoy?</legend>
          <p>Select any, or let StreamerAI learn naturally.</p>
          <div className="choice-grid">
            {preferences.map((preference) => (
              <label className="choice" key={preference}>
                <input
                  type="checkbox"
                  checked={profile.preferences.includes(preference)}
                  onChange={() => togglePreference(preference)}
                />
                <span>{preference}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="preference-fieldset">
          <legend>Playback languages &amp; subtitles</legend>
          <PlaybackLanguageFields
            value={profile.playback}
            onChange={(playback) => onChange({ ...profile, playback })}
          />
        </fieldset>
      </div>
    </div>
  );
}
