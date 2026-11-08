import { useEffect, useState } from "react";
import type {
  PlaybackPreferences,
  UpdateViewerProfile,
  ViewerProfile,
} from "@streamer-ai/contracts";
import type { StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";
import { PlaybackLanguageFields } from "./PlaybackLanguageFields";
import { AudioOutputPicker } from "./AudioOutputPicker";
import { useToasts } from "./ToastProvider";
import { AppearanceSettings } from "../theme/AppearanceSettings";
import { ProfilePinSettings } from "./ProfilePin";

export type ProfilePage =
  "settings" | "preferences" | "account" | "profile" | "support" | "statistics";

interface ProfilePagesProps {
  page: ProfilePage;
  api: StreamerApi;
  profile: ViewerProfile;
  onProfileUpdated: (profile: ViewerProfile) => void;
  onRerunOnboarding: () => void;
  onSwitchAccount: () => void;
  onSignOut?: () => Promise<void>;
  onDeleteProfile: () => Promise<void>;
  onBackHome: () => void;
  onIntegrationsChanged: () => void;
}

const genres = [
  "Drama",
  "Comedy",
  "Sci-fi",
  "Documentary",
  "Thriller",
  "Family",
  "Fantasy",
  "Anime",
];

export function ProfilePages({
  page,
  api,
  profile,
  onProfileUpdated,
  onRerunOnboarding,
  onSwitchAccount,
  onBackHome,
}: ProfilePagesProps) {
  const [playback, setPlayback] = useState<PlaybackPreferences>(
    profile.playback,
  );
  const [locale, setLocale] = useState(profile.locale);
  const [selectedGenres, setSelectedGenres] = useState(profile.genres);
  const [prompt, setPrompt] = useState(profile.prompt);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const { showToast } = useToasts();

  useEffect(() => {
    if (notice) showToast(notice, "success");
  }, [notice, showToast]);

  useEffect(() => {
    if (error) showToast(error, "error");
  }, [error, showToast]);
  const save = async (patch: UpdateViewerProfile, closeOnSuccess = false) => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const updated = await api.updateProfile(profile.id, patch);
      onProfileUpdated(updated);
      if (closeOnSuccess) {
        showToast("Saved for this profile.", "success");
        onBackHome();
      } else {
        setNotice("Saved for this profile.");
      }
    } catch (reason) {
      setError(safeErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="profile-page">
      <button className="profile-page__back" type="button" onClick={onBackHome}>
        ← Home
      </button>
      <p className="eyebrow">{profile.name}'s space</p>
      <h1>
        {page === "settings"
          ? "Settings"
          : page === "preferences"
            ? "Preferences"
            : page === "account"
              ? "My account"
              : page === "profile"
                ? "Profile"
                : page === "support"
                  ? "Support"
                  : "Statistics"}
      </h1>
      {page === "settings" && (
        <div className="profile-page__sections">
          <section className="profile-page__section" id="settings-interface">
            <p className="eyebrow">01 / Interface</p>
            <h2>Language</h2>
            <label className="field field--compact">
              <span>Preferred interface language</span>
              <select
                value={locale}
                onChange={(event) =>
                  setLocale(event.target.value as ViewerProfile["locale"])
                }
              >
                <option value="en">English</option>
                <option value="cs">Čeština</option>
                <option value="de">Deutsch</option>
              </select>
            </label>
            <p className="settings-note">
              This preference is saved per profile. Full interface translation
              is coming later.
            </p>
          </section>
          <AppearanceSettings api={api} locale={profile.locale} />
          <section className="profile-page__section" id="settings-audio">
            <p className="eyebrow">02 / Audio</p>
            <h2>Playback languages</h2>
            <PlaybackLanguageFields
              value={playback}
              onChange={setPlayback}
              section="audio"
            />
            <h3>Audio output</h3>
            <AudioOutputPicker
              value={playback.audioOutputDeviceId}
              onChange={(audioOutputDeviceId) =>
                setPlayback((current) => ({ ...current, audioOutputDeviceId }))
              }
            />
          </section>
          <section className="profile-page__section" id="settings-subtitles">
            <p className="eyebrow">03 / Subtitles</p>
            <h2>Subtitle sources &amp; appearance</h2>
            <PlaybackLanguageFields
              value={playback}
              onChange={setPlayback}
              section="subtitles"
            />
            <p>
              Embedded subtitles and manual subtitle-file loading are available
              in the player. External subtitle sources will be configurable
              here.
            </p>
          </section>
          <section className="profile-page__section" id="settings-player">
            <p className="eyebrow">04 / Player</p>
            <h2>Player behaviour</h2>
            <p>
              Placeholder: default volume, skip controls and playback behaviour
              will live here.
            </p>
          </section>
          <section className="profile-page__section">
            <h2>Household services and devices</h2>
            <p>
              Server connections, cloud services, backups and device access are
              managed in household administration.
            </p>
            <a className="button button--secondary" href="/admin">
              Open household administration
            </a>
          </section>
          <div className="profile-page__actions">
            <button
              className="button button--secondary profile-page__onboarding-action"
              type="button"
              onClick={onRerunOnboarding}
            >
              Run onboarding again
            </button>
            <button
              className="button button--primary"
              disabled={saving}
              type="button"
              onClick={() => void save({ locale, playback }, true)}
            >
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </div>
      )}

      {page === "preferences" && (
        <div className="profile-page__sections">
          <section className="profile-page__section">
            <p className="eyebrow">Genres</p>
            <h2>What do you enjoy?</h2>
            <div className="choice-grid">
              {genres.map((genre) => (
                <label className="choice" key={genre}>
                  <input
                    type="checkbox"
                    checked={selectedGenres.includes(genre)}
                    onChange={() =>
                      setSelectedGenres((current) =>
                        current.includes(genre)
                          ? current.filter((item) => item !== genre)
                          : [...current, genre],
                      )
                    }
                  />
                  <span>{genre}</span>
                </label>
              ))}
            </div>
          </section>
          <section className="profile-page__section">
            <p className="eyebrow">Virtual profile</p>
            <h2>Describe your taste</h2>
            <label className="field">
              <span>Your taste prompt</span>
              <textarea
                maxLength={3000}
                rows={7}
                placeholder="I love thoughtful science fiction, clever mysteries and warm autumn films…"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <p className="settings-note">
              Saved per profile. Using this text directly in agent
              recommendations is planned.
            </p>
          </section>
          <div className="profile-page__actions">
            <button
              className="button button--primary"
              disabled={saving}
              type="button"
              onClick={() => void save({ genres: selectedGenres, prompt })}
            >
              {saving ? "Saving…" : "Save preferences"}
            </button>
          </div>
        </div>
      )}

      {page === "account" && (
        <section className="profile-page__section">
          <a className="button button--primary" href="/admin">
            Open household administration
          </a>
        </section>
      )}

      {page === "profile" && (
        <div className="profile-page__sections">
          <section className="profile-page__section">
            <p className="eyebrow">Current profile</p>
            <h2>{profile.name}</h2>
            <button
              className="button button--secondary"
              type="button"
              onClick={onSwitchAccount}
            >
              Choose another profile
            </button>
          </section>
          <ProfilePinSettings
            api={api}
            profile={profile}
            onProfileUpdated={onProfileUpdated}
          />
          <section className="profile-page__section">
            <p className="eyebrow">Portrait · planned</p>
            <h2>Profile photo</h2>
            <p>
              Placeholder: upload and crop a photo for this profile. The
              initials avatar is used for now.
            </p>
          </section>
        </div>
      )}

      {page === "support" && (
        <section className="profile-page__section">
          <a className="button button--primary" href="/admin#support">
            Open household administration
          </a>
        </section>
      )}

      {page === "statistics" && (
        <div className="profile-page__sections">
          <section className="profile-page__section">
            <p className="eyebrow">Viewing insights · planned</p>
            <h2>Your statistics</h2>
            <p>
              Placeholder: films and series watched, hours spent, favourite
              genres and viewing trends. No estimates are shown until these
              metrics are calculated from real watch data.
            </p>
            <div className="statistics-placeholders">
              <span>
                Films watched <strong>—</strong>
              </span>
              <span>
                Hours watched <strong>—</strong>
              </span>
              <span>
                Favourite genre <strong>—</strong>
              </span>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
