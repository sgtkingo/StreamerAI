import { useEffect, useRef, useState } from "react";
import type { ViewerProfile } from "@streamer-ai/contracts";
import { Brand } from "./Brand";
import { useToasts } from "./ToastProvider";
import { useTheme } from "../theme/ThemeProvider";
import { ThemeSelect } from "../theme/ThemeSelect";

interface ProfileChooserProps {
  profiles: ViewerProfile[];
  onSelect: (profile: ViewerProfile) => void;
  onCreate: (name: string) => Promise<void>;
  error?: string;
  onRetry?: () => void;
}

export function ProfileChooser({
  profiles,
  onSelect,
  onCreate,
  error,
  onRetry,
}: ProfileChooserProps) {
  const theme = useTheme();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [createError, setCreateError] = useState("");
  const { showToast } = useToasts();
  const retryRef = useRef(onRetry);
  const lastErrorToastRef = useRef("");
  retryRef.current = onRetry;

  useEffect(() => {
    if (!error) {
      lastErrorToastRef.current = "";
      return;
    }
    if (lastErrorToastRef.current === error) return;
    lastErrorToastRef.current = error;
    showToast(error, "error", {
      action: retryRef.current
        ? { label: "Try again", onClick: () => retryRef.current?.() }
        : undefined,
    });
  }, [error, showToast]);

  useEffect(() => {
    if (createError) {
      showToast(createError, "error");
    }
  }, [createError, showToast]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    setCreateError("");
    try {
      await onCreate(name.trim());
      setAdding(false);
      setName("");
    } catch (reason) {
      setCreateError(
        reason instanceof Error
          ? reason.message
          : "Profile could not be created.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="profile-chooser">
      <div className="profile-chooser__header">
        <Brand />
        <ThemeSelect
          compact
          selection="primary"
          value={theme.appearance.mode}
          onChange={(mode) =>
            theme.setThemeFamily(mode === "cinematic" ? "cinematic" : "auto")
          }
        />
      </div>
      {theme.storageError && (
        <p className="settings-note" role="alert">
          {theme.storageError}
        </p>
      )}
      <div className="profile-chooser__content">
        <p className="eyebrow">Your private cinema</p>
        <h1>Who's watching?</h1>
        <p>
          Choose a profile to keep its discoveries, Library and watch history
          separate.
        </p>
        <div className="profile-chooser__grid" aria-label="Choose a profile">
          {Array.from({ length: 5 }, (_, index) => {
            const profile = profiles[index];
            if (profile)
              return (
                <button
                  className="profile-medallion"
                  type="button"
                  key={profile.id}
                  onClick={() => onSelect(profile)}
                >
                  <span className="profile-medallion__portrait">
                    {profile.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span>{profile.name}</span>
                  {!profile.onboardingComplete && <small>Finish setup</small>}
                </button>
              );
            if (index === profiles.length)
              return (
                <button
                  className="profile-medallion profile-medallion--add"
                  type="button"
                  key="add"
                  onClick={() => setAdding(true)}
                >
                  <span
                    className="profile-medallion__portrait"
                    aria-hidden="true"
                  >
                    +
                  </span>
                  <span>Add profile</span>
                </button>
              );
            return (
              <div
                className="profile-medallion profile-medallion--empty"
                key={index}
                aria-hidden="true"
              >
                <span className="profile-medallion__portrait">·</span>
                <span>Available</span>
              </div>
            );
          })}
        </div>
        <small>
          {profiles.length} of 5 profiles · Profiles are not password-protected
          yet.
        </small>
      </div>
      {adding && (
        <div className="profile-chooser__overlay" role="presentation">
          <form
            className="profile-chooser__form"
            onSubmit={(event) => void create(event)}
            aria-label="Create profile"
            role="dialog"
            aria-modal="true"
            onKeyDown={(event) => {
              if (event.key === "Escape") setAdding(false);
            }}
          >
            <h2>Add a profile</h2>
            <p>Give this viewer a name, then complete their setup.</p>
            <label className="field">
              <span>Profile name</span>
              <input
                autoFocus
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="profile-chooser__actions">
              <button
                className="button button--ghost"
                type="button"
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
              <button
                className="button button--primary"
                type="submit"
                disabled={!name.trim() || pending}
              >
                {pending ? "Creating…" : "Create profile"}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
