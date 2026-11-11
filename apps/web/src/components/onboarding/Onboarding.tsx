import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  SetupProfileSchema,
  type ViewerProfile,
} from "@streamer-ai/contracts";
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
import { MasterPinSetup } from "../MasterPinSetup";
import { useTheme } from "../../theme/ThemeProvider";
import { discardUpdateDraft, useUpdateDraft } from "../updateDraft";
import {
  UpdateSaveError,
  useUpdateSave,
  useUpdatePending,
} from "../updateSave";

const steps = [
  "Welcome",
  "Profile",
  "Connections",
  "AI agent",
  "Finish",
] as const;

interface OnboardingProps {
  api: StreamerApi;
  onComplete: (profile: ProfileDraft) => void;
  existingProfile?: ViewerProfile;
  onCancel?: () => void;
  onSignIn?: () => Promise<void>;
  allowRestore?: boolean;
  onRestored?: () => void | Promise<void>;
  masterPinRequired?: boolean;
  onMasterPinCreated?: () => void;
  profileOnly?: boolean;
}

export function Onboarding({
  api,
  onComplete,
  existingProfile,
  onCancel,
  onSignIn,
  allowRestore = false,
  onRestored,
  masterPinRequired = false,
  onMasterPinCreated,
  profileOnly = false,
}: OnboardingProps) {
  const { previewAppearance, rememberAppearance } = useTheme();
  const profileId = existingProfile?.id ?? "default";
  const [step, setStep] = useState(0);
  const [masterPinReady, setMasterPinReady] = useState(false);
  const [creatingMasterPin, setCreatingMasterPin] = useState(false);
  const [afterMasterStep, setAfterMasterStep] = useState(1);
  const [profile, setProfile] = useState<ProfileDraft>({
    name: existingProfile?.name ?? "",
    locale: existingProfile?.locale ?? "en",
    preferences: existingProfile?.genres ?? [],
    playback: existingProfile?.playback ?? DEFAULT_PLAYBACK_PREFERENCES,
    appearance: existingProfile?.appearance ?? DEFAULT_APPEARANCE_PREFERENCES,
  });
  const [tmdbState, setTmdbState] = useState<ConnectionState>("not-configured");
  const [webshareState, setWebshareState] =
    useState<ConnectionState>("not-configured");
  const [localAiEnabled, setLocalAiEnabled] = useState(false);
  const [services, setServices] = useState<string[]>([]);
  const [pinRequested, setPinRequested] = useState(false);
  const [pin, setPin] = useState("");
  const [pinConfirmation, setPinConfirmation] = useState("");
  const savedPin = useRef<string | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);
  const [finishError, setFinishError] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const draftScope = `onboarding:${profileId}`;
  useUpdateDraft(
    draftScope,
    { step, profile, localAiEnabled },
    Boolean(profile.name || step),
    (value) => {
      if (!value || typeof value !== "object") return;
      const draft = value as Record<string, unknown>;
      const rawProfile = draft.profile;
      if (!rawProfile || typeof rawProfile !== "object") return;
      const name = (rawProfile as Record<string, unknown>).name;
      if (typeof name !== "string") return;
      const parsed = SetupProfileSchema.safeParse({
        ...rawProfile,
        name: name || "Viewer",
      });
      if (!parsed.success) return;
      setProfile({ ...parsed.data, name });
      if (typeof draft.step === "number" && draft.step >= 0 && draft.step <= 4)
        setStep(draft.step);
      if (typeof draft.localAiEnabled === "boolean")
        setLocalAiEnabled(draft.localAiEnabled);
    },
  );

  useEffect(() => {
    previewAppearance(profile.appearance);
    return () => previewAppearance(null);
  }, [profile.appearance, previewAppearance]);

  useEffect(() => {
    let active = true;
    api
      .getSetupStatus(profileId)
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
  }, [api, profileId]);

  useEffect(() => {
    if (step !== 4) return;
    let active = true;
    const loadServices = async () => {
      const [integrations, account, profileSync] = await Promise.allSettled([
        api.getIntegrations?.(profileId),
        api.getAccount?.(),
        api.getProfileSync?.(profileId),
      ]);
      if (!active) return;
      const names = new Set<string>();
      if (integrations.status === "fulfilled" && integrations.value) {
        for (const item of integrations.value.items) {
          if (
            item.configured &&
            !item.planned &&
            item.category !== "inference" &&
            item.category !== "sync" &&
            item.id !== "tmdb" &&
            item.id !== "webshare"
          )
            names.add(item.name);
        }
      }
      if (tmdbState === "connected") names.add("TMDB");
      if (webshareState === "connected") names.add("Webshare");
      if (
        account.status === "fulfilled" &&
        account.value?.sync?.configured &&
        !(profileSync.status === "fulfilled" && profileSync.value?.paused)
      )
        names.add("Cloud Sync");
      setServices([...names]);
    };
    void loadServices();
    return () => {
      active = false;
    };
  }, [api, profileId, step, tmdbState, webshareState]);

  useEffect(() => {
    const heading = contentRef.current?.querySelector<HTMLElement>("h1");
    heading?.focus();
  }, [step, creatingMasterPin]);

  const enterStep = (target: number) => {
    if (masterPinRequired && !masterPinReady) {
      setAfterMasterStep(target);
      setCreatingMasterPin(true);
    } else setStep(target);
  };

  const next = async () => {
    if (masterPinRequired && !masterPinReady) {
      enterStep(step === 0 ? 1 : step);
      return;
    }
    if (step === 1 && !profile.name.trim()) return;
    if (profileOnly && step === 1) {
      setStep(4);
      return;
    }
    if (step < steps.length - 1) {
      setStep((current) => current + 1);
      return;
    }

    setIsCompleting(true);
    setFinishError("");
    try {
      const desiredPin = pinRequested ? pin : null;
      if (api.setProfilePin && desiredPin !== savedPin.current) {
        await api.setProfilePin(
          profileId,
          desiredPin,
          savedPin.current ?? undefined,
        );
        savedPin.current = desiredPin;
      }
      await api.completeSetup({
        profile: { ...profile, name: profile.name.trim() || "Viewer" },
        localAiEnabled,
        profileId,
      });
      rememberAppearance(profile.appearance);
      await discardUpdateDraft(draftScope);
      onComplete(profile);
      return true;
    } catch (error) {
      setFinishError(safeErrorMessage(error));
      return false;
    } finally {
      setIsCompleting(false);
    }
  };

  const canContinue =
    (step !== 1 || Boolean(profile.name.trim())) &&
    (step !== 4 ||
      !pinRequested ||
      (/^\d{4}$/.test(pin) && pin === pinConfirmation));

  useUpdatePending(isCompleting || signingIn);
  useUpdateSave(Boolean(pin || pinConfirmation), async () => {
    if (isCompleting || step !== 4 || !canContinue || !profile.name.trim())
      throw new UpdateSaveError(
        "Complete the matching profile PINs and profile name before updating.",
      );
    if (!(await next()))
      throw new UpdateSaveError(
        "Profile setup could not be saved. Check its details before updating.",
      );
  });

  const returnToSignIn = async () => {
    if (!onSignIn || signingIn) return;
    setSigningIn(true);
    setSignInError("");
    try {
      await onSignIn();
    } catch (error) {
      setSignInError(safeErrorMessage(error));
      setSigningIn(false);
    }
  };

  return (
    <div className="onboarding-shell">
      <header className="onboarding-header">
        <Brand />
        <nav className="onboarding-header__actions" aria-label="Setup actions">
          {onSignIn && (
            <button
              className="text-button"
              type="button"
              onClick={() => void returnToSignIn()}
              disabled={signingIn || isCompleting}
            >
              Sign in
            </button>
          )}
          {onCancel ? (
            <button
              className="text-button"
              type="button"
              onClick={onCancel}
              disabled={signingIn || isCompleting}
            >
              Exit setup
            </button>
          ) : (
            <button
              className="text-button"
              type="button"
              onClick={() => enterStep(4)}
              disabled={step === 4 || signingIn || isCompleting}
            >
              Finish later
            </button>
          )}
        </nav>
      </header>

      {signInError && (
        <p className="onboarding-sign-in-error" role="alert">
          Could not return to sign in. {signInError}
        </p>
      )}

      <div className="onboarding-layout">
        <aside className="progress-panel">
          <p className="eyebrow">Setup</p>
          <ol aria-label="Setup progress">
            {steps.map((label, index) =>
              profileOnly && (index === 2 || index === 3) ? null : (
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
              ),
            )}
          </ol>
          <p className="progress-privacy">
            Home-server setup
            <br />
            No browser secrets
          </p>
        </aside>

        <main className="onboarding-main" ref={contentRef}>
          {creatingMasterPin ? (
            <MasterPinSetup
              onSave={async (pin) => {
                if (!api.setupMasterPin)
                  throw new Error("Master PIN setup is unavailable.");
                await api.setupMasterPin(pin, pin);
                setMasterPinReady(true);
                setCreatingMasterPin(false);
                onMasterPinCreated?.();
                setStep(afterMasterStep);
              }}
            />
          ) : (
            step === 0 && (
              <WelcomeStep
                allowRestore={allowRestore}
                onRestored={onRestored}
              />
            )
          )}
          {step === 1 && (
            <ProfileStep profile={profile} onChange={setProfile} />
          )}
          {step === 2 && !profileOnly && (
            <ConnectionsStep
              api={api}
              profileId={profileId}
              initialTmdbState={tmdbState}
              initialWebshareState={webshareState}
              onTmdbConnected={() => setTmdbState("connected")}
              onWebshareConnected={() => setWebshareState("connected")}
              onTmdbDisconnected={() => setTmdbState("not-configured")}
              onWebshareDisconnected={() => setWebshareState("not-configured")}
            />
          )}
          {step === 3 && !profileOnly && (
            <LocalAiStep
              api={api}
              profileId={profileId}
              enabled={localAiEnabled}
              onEnabledChange={setLocalAiEnabled}
            />
          )}
          {step === 4 && (
            <FinishStep
              profile={profile}
              services={services}
              localAiEnabled={localAiEnabled}
              error={finishError}
              pinAvailable={!!api.setProfilePin && !existingProfile?.pinEnabled}
              pinRequested={pinRequested}
              onPinRequestedChange={setPinRequested}
              pin={pin}
              onPinChange={setPin}
              pinConfirmation={pinConfirmation}
              onPinConfirmationChange={setPinConfirmation}
              disabled={isCompleting}
            />
          )}

          <div className="step-actions">
            {(step > 0 || creatingMasterPin) && (
              <button
                className="button button--ghost"
                type="button"
                onClick={() =>
                  creatingMasterPin
                    ? setCreatingMasterPin(false)
                    : setStep((current) =>
                        profileOnly && current === 4 ? 1 : current - 1,
                      )
                }
                disabled={signingIn || isCompleting}
              >
                Back
              </button>
            )}
            {!creatingMasterPin && (
              <button
                className="button button--primary"
                type="button"
                onClick={next}
                disabled={!canContinue || isCompleting || signingIn}
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
            )}
          </div>
          {step === 1 && !canContinue && (
            <p className="action-hint">Enter a display name to continue.</p>
          )}
        </main>
      </div>
    </div>
  );
}
