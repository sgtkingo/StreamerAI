import type { ProfileDraft } from "../../api/client";
import { PlaybackLanguageFields } from "../PlaybackLanguageFields";

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
