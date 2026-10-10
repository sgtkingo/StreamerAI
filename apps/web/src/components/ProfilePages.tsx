import { useCallback, useEffect, useRef, useState } from "react";
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
import { IntegrationManager } from "./IntegrationManager";

export type ProfilePage = "settings" | "preferences" | "account" | "statistics";

interface ProfilePagesProps {
  page: ProfilePage;
  api: StreamerApi;
  profile: ViewerProfile;
  onProfileUpdated: (profile: ViewerProfile) => void;
  onRerunOnboarding: () => void;
  onSwitchAccount: () => void;
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
];

export function ProfilePages({
  page,
  api,
  profile,
  onProfileUpdated,
  onRerunOnboarding,
  onSwitchAccount,
  onDeleteProfile,
  onBackHome,
  onIntegrationsChanged,
}: ProfilePagesProps) {
  const [playback, setPlayback] = useState<PlaybackPreferences>(
    profile.playback,
  );
  const [locale, setLocale] = useState(profile.locale);
  const [selectedGenres, setSelectedGenres] = useState(profile.genres);
  const [prompt, setPrompt] = useState(profile.prompt);
  const [saving, setSaving] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToasts();

  const dismissDeleteConfirmation = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setDeleteConfirmationOpen(false);
  }, []);

  useEffect(() => {
    if (notice) showToast(notice, "success");
  }, [notice, showToast]);

  useEffect(() => {
    if (error) showToast(error, "error");
  }, [error, showToast]);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!deleteConfirmationOpen) return;

    const dialog = deleteDialogRef.current;
    const cancelButton = dialog?.querySelector<HTMLButtonElement>(
      ".profile-delete-dialog__cancel",
    );
    cancelButton?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (deleting) return;
        event.preventDefault();
        dismissDeleteConfirmation();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const buttons = Array.from(
        dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
      );
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [deleteConfirmationOpen, deleting, dismissDeleteConfirmation]);

  const save = async (patch: UpdateViewerProfile) => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const updated = await api.updateProfile(profile.id, patch);
      onProfileUpdated(updated);
      setNotice("Saved for this profile.");
    } catch (reason) {
      setError(safeErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const forgetProfile = async () => {
    setDeleting(true);
    setError("");
    try {
      await onDeleteProfile();
    } catch (reason) {
      setError(safeErrorMessage(reason));
      setDeleting(false);
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
              : "Statistics"}
      </h1>
      {page === "settings" && (
        <div className="profile-page__sections">
          <section className="profile-page__section" id="settings-language">
            <p className="eyebrow">01 / Language</p>
            <h2>Interface language</h2>
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
          <section className="profile-page__section" id="settings-integrations">
            <p className="eyebrow">05 / Integrations</p>
            <h2>Connected services</h2>
            <p>
              Manage your movie databases, streaming sources and subtitle
              services in one place.
            </p>
            <IntegrationManager
              api={api}
              context="settings"
              onConnectionChange={onIntegrationsChanged}
            />
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
              className="button button--logout"
              type="button"
              disabled={deleting || saving}
              onClick={() => setDeleteConfirmationOpen(true)}
            >
              {deleting ? "Deleting profile…" : "Forget and delete profile"}
            </button>
            <button
              className="button button--primary"
              disabled={saving}
              type="button"
              onClick={() => void save({ locale, playback })}
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
        <div className="profile-page__sections">
          <section className="profile-page__section">
            <p className="eyebrow">Account · planned</p>
            <h2>Login and password</h2>
            <p>
              Placeholder: changing account login and password needs a real
              authentication layer. No password or fake sign-out is stored here
              yet.
            </p>
          </section>
          <section className="profile-page__section">
            <p className="eyebrow">Portrait · planned</p>
            <h2>Profile photo</h2>
            <p>
              Placeholder: upload and crop a photo for this profile. The
              initials avatar is used for now.
            </p>
          </section>
          <button
            className="button button--secondary"
            type="button"
            onClick={onSwitchAccount}
          >
            Choose another profile
          </button>
        </div>
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

      {deleteConfirmationOpen && page === "settings" && (
        <div
          className="profile-delete-backdrop"
          onMouseDown={(event) => {
            if (!deleting && event.target === event.currentTarget) {
              dismissDeleteConfirmation();
            }
          }}
        >
          <div
            aria-describedby="profile-delete-description"
            aria-labelledby="profile-delete-title"
            aria-modal="true"
            className="profile-delete-dialog"
            ref={deleteDialogRef}
            role="alertdialog"
          >
            <p className="eyebrow">Permanent action</p>
            <h2 id="profile-delete-title">Forget and delete profile?</h2>
            <p id="profile-delete-description">
              This will permanently delete {profile.name}'s profile and its
              local data, and free its profile medallion. This action cannot be
              undone.
            </p>
            <div className="profile-delete-dialog__actions">
              <button
                className="button button--secondary profile-delete-dialog__cancel"
                type="button"
                disabled={deleting}
                onClick={dismissDeleteConfirmation}
              >
                Cancel
              </button>
              <button
                className="button button--logout"
                type="button"
                disabled={deleting}
                onClick={() => void forgetProfile()}
              >
                {deleting ? "Deleting profile…" : "Forget and delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
