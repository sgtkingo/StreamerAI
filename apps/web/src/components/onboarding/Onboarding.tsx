import { useEffect, useRef, useState } from "react";
import type { ViewerProfile } from "@streamer-ai/contracts";
import type {
  ConnectionState,
  ProfileDraft,
  StreamerApi,
} from "../../api/client";
import { safeErrorMessage } from "../../api/client";
import { DEFAULT_PLAYBACK_PREFERENCES } from "../../playback-preferences";
import { Brand } from "../Brand";
import { ConnectionsStep } from "./ConnectionsStep";
import { FinishStep } from "./FinishStep";
import { LocalAiStep } from "./LocalAiStep";
import { ProfileStep } from "./ProfileStep";
import { WelcomeStep } from "./WelcomeStep";

const steps = [
  "Welcome",
  "Profile",
  "Connections",
  "Local AI",
  "Finish",
] as const;

interface OnboardingProps {
  api: StreamerApi;
  onComplete: (profile: ProfileDraft) => void;
  existingProfile?: ViewerProfile;
  onCancel?: () => void;
}

export function Onboarding({
  api,
  onComplete,
  existingProfile,
  onCancel,
}: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<ProfileDraft>({
    name: existingProfile?.name ?? "",
    locale: existingProfile?.locale ?? "en",
    preferences: existingProfile?.genres ?? [],
    playback: existingProfile?.playback ?? DEFAULT_PLAYBACK_PREFERENCES,
  });
  const [tmdbState, setTmdbState] = useState<ConnectionState>("not-configured");
  const [webshareState, setWebshareState] =
    useState<ConnectionState>("not-configured");
  const [localAiEnabled, setLocalAiEnabled] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [finishError, setFinishError] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    api
      .getSetupStatus()
      .then((status) => {
        if (active) {
          setTmdbState(status.tmdb);
          setWebshareState(status.webshare);
          if (status.localAi === "connected") setLocalAiEnabled(true);
        }
      })
      .catch(() => {
        // Setup remains fully usable while the server starts; actions show explicit errors.
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    const heading = contentRef.current?.querySelector<HTMLElement>("h1");
    heading?.focus();
  }, [step]);

  const next = async () => {
    if (step === 1 && !profile.name.trim()) return;
    if (step < steps.length - 1) {
      setStep((current) => current + 1);
      return;
    }

    setIsCompleting(true);
    setFinishError("");
    try {
      await api.completeSetup({
        profile: { ...profile, name: profile.name.trim() || "Viewer" },
        localAiEnabled,
        ...(existingProfile ? { profileId: existingProfile.id } : {}),
      });
      onComplete(profile);
    } catch (error) {
      setFinishError(safeErrorMessage(error));
    } finally {
      setIsCompleting(false);
    }
  };

  const canContinue = step !== 1 || Boolean(profile.name.trim());

  return (
    <div className="onboarding-shell">
      <header className="onboarding-header">
        <Brand />
        {onCancel ? (
          <button className="text-button" type="button" onClick={onCancel}>
            Exit setup
          </button>
        ) : (
          <button
            className="text-button"
            type="button"
            onClick={() => setStep(4)}
            disabled={step === 4}
          >
            Finish later
          </button>
        )}
      </header>

      <div className="onboarding-layout">
        <aside className="progress-panel">
          <p className="eyebrow">Setup</p>
          <ol aria-label="Setup progress">
            {steps.map((label, index) => (
              <li
                key={label}
                className={
                  index === step
                    ? "is-current"
                    : index < step
                      ? "is-complete"
                      : ""
                }
                aria-current={index === step ? "step" : undefined}
              >
                <span aria-hidden="true">
                  {index < step ? "✓" : String(index + 1).padStart(2, "0")}
                </span>
                {label}
              </li>
            ))}
          </ol>
          <p className="progress-privacy">
            Home-server setup
            <br />
            No browser secrets
          </p>
        </aside>

        <main className="onboarding-main" ref={contentRef}>
          {step === 0 && <WelcomeStep />}
          {step === 1 && (
            <ProfileStep profile={profile} onChange={setProfile} />
          )}
          {step === 2 && (
            <ConnectionsStep
              api={api}
              initialTmdbState={tmdbState}
              initialWebshareState={webshareState}
              onTmdbConnected={() => setTmdbState("connected")}
              onWebshareConnected={() => setWebshareState("connected")}
              onTmdbDisconnected={() => setTmdbState("not-configured")}
              onWebshareDisconnected={() => setWebshareState("not-configured")}
            />
          )}
          {step === 3 && (
            <LocalAiStep
              api={api}
              enabled={localAiEnabled}
              onEnabledChange={setLocalAiEnabled}
            />
          )}
          {step === 4 && (
            <FinishStep
              profile={profile}
              tmdbConnected={tmdbState === "connected"}
              localAiEnabled={localAiEnabled}
              error={finishError}
            />
          )}

          <div className="step-actions">
            {step > 0 && (
              <button
                className="button button--ghost"
                type="button"
                onClick={() => setStep((current) => current - 1)}
              >
                Back
              </button>
            )}
            <button
              className="button button--primary"
              type="button"
              onClick={next}
              disabled={!canContinue || isCompleting}
            >
              {step === steps.length - 1
                ? isCompleting
                  ? "Opening…"
                  : "Enter StreamerAI"
                : step === 0
                  ? "Start setup"
                  : "Continue"}
              {!isCompleting && <span aria-hidden="true">→</span>}
            </button>
          </div>
          {step === 1 && !canContinue && (
            <p className="action-hint">Enter a display name to continue.</p>
          )}
        </main>
      </div>
    </div>
  );
}
