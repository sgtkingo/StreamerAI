import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalAiResult, StreamerApi } from "../../api/client";
import { safeErrorMessage } from "../../api/client";
import { StatusBadge, type UiStatus } from "./StatusBadge";

interface LocalAiStepProps {
  api: StreamerApi;
  profileId?: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

export function LocalAiStep({
  api,
  profileId = "default",
  enabled,
  onEnabledChange,
}: LocalAiStepProps) {
  const [status, setStatus] = useState<UiStatus>("working");
  const [result, setResult] = useState<LocalAiResult | null>(null);
  const [message, setMessage] = useState(
    "Looking for Ollama and a compatible model…",
  );
  const hasDetected = useRef(false);

  const detect = useCallback(async () => {
    setStatus("working");
    setMessage("Looking for Ollama and a compatible model…");
    try {
      const detected = await api.detectLocalAi(profileId);
      setResult(detected);
      if (detected.ok) {
        setStatus("success");
        setMessage(detected.message || "Local AI is ready.");
        onEnabledChange(true);
      } else {
        setStatus("error");
        setMessage(detected.message || "Local AI needs attention.");
      }
    } catch (error) {
      setStatus("error");
      setMessage(safeErrorMessage(error));
    }
  }, [api, onEnabledChange, profileId]);

  useEffect(() => {
    if (!hasDetected.current) {
      hasDetected.current = true;
      void detect();
    }
  }, [detect]);

  return (
    <div className="step-copy">
      <p className="eyebrow">Local intelligence</p>
      <h1 tabIndex={-1}>
        A curator that
        <br />
        stays at home.
      </h1>
      <p className="step-lead">
        Local AI organises your library and improves recommendations without
        sending viewing history to an AI provider.
      </p>

      <section className="ai-panel" aria-labelledby="ai-status-heading">
        <div className="ai-panel__visual" aria-hidden="true">
          <span
            className={
              status === "working" ? "ai-pulse ai-pulse--active" : "ai-pulse"
            }
          />
          <span>LOCAL</span>
        </div>
        <div className="ai-panel__content">
          <div className="connection-card__header">
            <div>
              <p className="eyebrow">Automatic check</p>
              <h2 id="ai-status-heading">Local AI readiness</h2>
            </div>
            <StatusBadge
              status={status}
              label={status === "success" ? "Ready" : undefined}
            />
          </div>
          <p
            className={`inline-message inline-message--${status}`}
            role={status === "error" ? "alert" : "status"}
          >
            {message}
          </p>
          {status === "success" && result && (
            <dl className="detection-details">
              <div>
                <dt>Runtime</dt>
                <dd>{result.runtime ?? "Ollama"}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{result.model ?? "Compatible model"}</dd>
              </div>
              <div>
                <dt>Privacy</dt>
                <dd>Local only</dd>
              </div>
            </dl>
          )}
          {status === "error" && (
            <div className="ai-actions">
              <button
                className="button button--secondary"
                type="button"
                onClick={detect}
              >
                Check again
              </button>
              <a
                href="https://ollama.com/download"
                target="_blank"
                rel="noreferrer"
              >
                Install Ollama <span aria-hidden="true">↗</span>
              </a>
            </div>
          )}
        </div>
      </section>

      <label className="toggle-row">
        <span>
          <strong>Use local AI when available</strong>
          <small>StreamerAI continues to work if it is offline.</small>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
        />
      </label>
    </div>
  );
}
