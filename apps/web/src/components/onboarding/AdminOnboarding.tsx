import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StreamerApi } from "../../api/client";
import { safeErrorMessage } from "../../api/client";
import { Brand } from "../Brand";
import { IntegrationManager } from "../IntegrationManager";
import { LocalAiStep } from "./LocalAiStep";
import { StatusBadge } from "./StatusBadge";

const steps = [
  "Welcome",
  "Household",
  "Services",
  "AI agent",
  "Backups",
  "Devices",
  "Finish",
] as const;
const FINISH = steps.length - 1;
const STEP_STORAGE_KEY = "streamerai.adminOnboardingStep";

interface AdminOnboardingProps {
  api: StreamerApi;
  /** Any profile of the household; shared services are stored per household. */
  profileId: string;
  householdName: string;
  /** Administration editors reused as steps, so both stay identical. */
  household: ReactNode;
  backups: ReactNode;
  devices: ReactNode;
  /** Called after the server records the onboarding as complete. */
  onComplete: (destination: "admin" | "player") => void;
}

interface Summary {
  services: string[];
  agent: string | null;
  backups: string | null;
}

function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0)
    return minutes === 1440 ? "daily" : `every ${minutes / 1440} days`;
  if (minutes % 60 === 0)
    return minutes === 60 ? "hourly" : `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}

/** First-run household setup for the owner: everything every profile shares. */
export function AdminOnboarding({
  api,
  profileId,
  householdName,
  household,
  backups,
  devices,
  onComplete,
}: AdminOnboardingProps) {
  // Survives administration reloads (e.g. after pairing a device) in this tab.
  const [step, setStepState] = useState(() => {
    try {
      const saved = Number(sessionStorage.getItem(STEP_STORAGE_KEY));
      return Number.isInteger(saved) && saved > 0 && saved <= FINISH
        ? saved
        : 0;
    } catch {
      return 0;
    }
  });
  const setStep = (next: number) => {
    setStepState(next);
    try {
      sessionStorage.setItem(STEP_STORAGE_KEY, String(next));
    } catch {
      // The step is a convenience; setup works without storage.
    }
  };
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState("");
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    contentRef.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [step]);

  useEffect(() => {
    if (step !== FINISH) return;
    let active = true;
    // Each lookup is optional for the summary; one failure must not hide the rest.
    const attempt = <T,>(load: () => Promise<T>): Promise<T> =>
      Promise.resolve().then(load);
    void Promise.allSettled([
      attempt(() => api.getIntegrations(profileId)),
      attempt(() => api.getAgentSelection(profileId)),
      attempt(() => api.getBackupSchedule?.() ?? Promise.resolve(null)),
    ]).then(([integrations, agent, schedule]) => {
      if (!active) return;
      setSummary({
        services:
          integrations.status === "fulfilled"
            ? integrations.value.items
                .filter(
                  (item) =>
                    item.configured &&
                    !item.planned &&
                    item.category !== "inference" &&
                    item.category !== "sync",
                )
                .map((item) => item.name)
            : [],
        agent:
          agent.status === "fulfilled" &&
          agent.value.mode !== "disabled" &&
          (agent.value.mode === "mcp" || agent.value.available)
            ? (agent.value.effectiveModel ??
              agent.value.model ??
              agent.value.provider)
            : null,
        backups:
          schedule.status === "fulfilled" && schedule.value?.enabled
            ? `Encrypted, ${intervalLabel(schedule.value.intervalMinutes)}`
            : null,
      });
    });
    return () => {
      active = false;
    };
  }, [api, profileId, step]);

  const complete = async (destination: "admin" | "player") => {
    if (completing) return;
    setCompleting(true);
    setError("");
    try {
      await api.setAdminOnboarding?.("complete");
      try {
        sessionStorage.removeItem(STEP_STORAGE_KEY);
      } catch {
        // Nothing to clean up without storage.
      }
      onComplete(destination);
    } catch (reason) {
      setError(safeErrorMessage(reason));
      setCompleting(false);
    }
  };

  return (
    <div className="onboarding-shell admin-onboarding">
      <header className="onboarding-header">
        <Brand />
        <nav className="onboarding-header__actions" aria-label="Setup actions">
          <button
            className="text-button"
            type="button"
            onClick={() => setStep(FINISH)}
            disabled={step === FINISH || completing}
          >
            Finish later
          </button>
        </nav>
      </header>

      <div className="onboarding-layout">
        <aside className="progress-panel">
          <p className="eyebrow">Household setup</p>
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
            Shared by every profile
            <br />
            Managed on this server
          </p>
        </aside>

        <main className="onboarding-main" ref={contentRef}>
          {step === 0 && (
            <div className="step-copy step-copy--welcome">
              <p className="eyebrow">Household administration</p>
              <h1 tabIndex={-1}>
                Your home server.
                <br />
                Ready to set up.
              </h1>
              <p className="step-lead">
                In a few steps you choose what the whole household shares:
                streaming services, the AI agent, backups and the screens that
                watch from this server.
              </p>
              <div className="trust-note">
                <span className="trust-icon" aria-hidden="true">
                  ⌂
                </span>
                <div>
                  <strong>Set it up once for everyone.</strong>
                  <p>
                    Services and the AI agent apply to every profile. Each
                    profile keeps its own Library, history and preferences.
                    Credentials stay on this server and are never saved in the
                    browser.
                  </p>
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="step-copy">
              <p className="eyebrow">Your household</p>
              <h1 tabIndex={-1}>Name your household.</h1>
              <p className="step-lead">
                The name appears in the apps on your TV and computers when they
                look for this server.
              </p>
              {household}
            </div>
          )}

          {step === 2 && (
            <div className="step-copy">
              <p className="eyebrow">Bring your services</p>
              <h1 tabIndex={-1}>
                Connect once.
                <br />
                Every profile benefits.
              </h1>
              <p className="step-lead">
                Choose the databases, video sources and subtitle services the
                household uses. You can change them later in Administration →
                Services.
              </p>
              <IntegrationManager
                api={api}
                context="onboarding"
                profileId={profileId}
              />
              <p className="privacy-line">
                <span aria-hidden="true">◆</span> Credentials are verified by
                your home server and are never saved in browser storage.
              </p>
            </div>
          )}

          {step === 3 && (
            <LocalAiStep
              api={api}
              profileId={profileId}
              enabled={agentEnabled}
              onEnabledChange={setAgentEnabled}
              household
            />
          )}

          {step === 4 && (
            <div className="step-copy">
              <p className="eyebrow">Peace of mind</p>
              <h1 tabIndex={-1}>Keep your household safe.</h1>
              <p className="step-lead">
                Backups protect profiles, viewing data and service connections
                with your Master PIN. Keep the Master PIN somewhere safe: a
                backup cannot be opened without it.
              </p>
              {backups}
            </div>
          )}

          {step === 5 && (
            <div className="step-copy">
              <p className="eyebrow">Bring your screens</p>
              <h1 tabIndex={-1}>
                Watch on every
                <br />
                screen at home.
              </h1>
              <p className="step-lead">
                Install the StreamerAI app on a TV, phone or another computer.
                It finds this server on your network and shows a six-digit code
                to enter here. You can pair more devices later in Administration
                → Devices.
              </p>
              {devices}
            </div>
          )}

          {step === FINISH && (
            <div className="step-copy step-copy--finish">
              <p className="eyebrow">All set</p>
              <h1 tabIndex={-1}>{householdName} is ready.</h1>
              <p className="step-lead">
                Next, open the player to create your profile. Everyone else can
                add their own profile from the apps.
              </p>
              <dl className="setup-summary">
                <div>
                  <dt>Services</dt>
                  <dd>
                    {summary === null
                      ? "Checking…"
                      : summary.services.length
                        ? summary.services.join(", ")
                        : "Connect later in Administration"}
                  </dd>
                  <StatusBadge
                    status={
                      summary === null
                        ? "working"
                        : summary.services.length
                          ? "success"
                          : "idle"
                    }
                    label={
                      summary === null
                        ? undefined
                        : summary.services.length
                          ? "Ready"
                          : "Optional"
                    }
                  />
                </div>
                <div>
                  <dt>AI agent</dt>
                  <dd>
                    {summary === null
                      ? "Checking…"
                      : (summary.agent ?? "Search works without one")}
                  </dd>
                  <StatusBadge
                    status={
                      summary === null
                        ? "working"
                        : summary.agent
                          ? "success"
                          : "idle"
                    }
                    label={
                      summary === null
                        ? undefined
                        : summary.agent
                          ? "Ready"
                          : "Optional"
                    }
                  />
                </div>
                <div>
                  <dt>Backups</dt>
                  <dd>
                    {summary === null
                      ? "Checking…"
                      : (summary.backups ?? "Automatic backups are off")}
                  </dd>
                  <StatusBadge
                    status={
                      summary === null
                        ? "working"
                        : summary.backups
                          ? "success"
                          : "error"
                    }
                    label={
                      summary === null
                        ? undefined
                        : summary.backups
                          ? "On"
                          : "Off"
                    }
                  />
                </div>
              </dl>
              {error && (
                <p
                  className="inline-message inline-message--error"
                  role="alert"
                >
                  {error}
                </p>
              )}
            </div>
          )}

          <div className="step-actions">
            {step > 0 && (
              <button
                className="button button--ghost"
                type="button"
                onClick={() => setStep(step - 1)}
                disabled={completing}
              >
                Back
              </button>
            )}
            {step === FINISH && (
              <button
                className="button button--secondary"
                type="button"
                onClick={() => void complete("admin")}
                disabled={completing}
              >
                Go to administration
              </button>
            )}
            <button
              className="button button--primary"
              type="button"
              disabled={completing}
              onClick={() =>
                step === FINISH ? void complete("player") : setStep(step + 1)
              }
            >
              {step === FINISH
                ? completing
                  ? "Opening…"
                  : "Open the player"
                : step === 0
                  ? "Start setup"
                  : "Continue"}
              {!completing && <span aria-hidden="true">→</span>}
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
