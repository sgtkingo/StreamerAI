import { useCallback, useEffect, useState } from "react";
import { useToasts } from "./ToastProvider";

interface AiSetupStatus {
  runtime: "ready" | "installed-not-running" | "missing" | "unavailable";
  runtimeVersion: string | null;
  model: { name: string; present: boolean };
  installedModels: string[];
  download: {
    state: "idle" | "downloading" | "ready" | "error";
    error: string | null;
  };
  resources: {
    memoryBytes: number;
    freeDiskBytes: number | null;
    recommendedMemoryBytes: number;
    estimatedModelBytes: number;
    recommendedFreeDiskBytes: number;
    diskSpaceScope?: "model-store" | "unknown";
  };
}
async function request<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/server/ai-setup${path}`, {
    method: input === undefined ? "GET" : "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers:
      input === undefined ? undefined : { "content-type": "application/json" },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  if (!response.ok)
    throw new Error(
      response.status === 403 || response.status === 404
        ? "SETUP_NOT_AVAILABLE"
        : "Local AI setup could not complete. Check free disk space and the Ollama service, then try again.",
    );
  return response.json() as Promise<T>;
}
const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/** Installation always happens on the server; ordinary clients only need a browser. */
export function ServerAiSetup({
  configuredModel,
  onUseLocalModel,
}: {
  configuredModel?: string;
  onUseLocalModel?: (model: string) => Promise<void>;
}) {
  const [status, setStatus] = useState<AiSetupStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { showToast } = useToasts();
  const [selectedModel, setSelectedModel] = useState("");
  const [offerRecommended, setOfferRecommended] = useState(false);
  const refresh = useCallback(async () => {
    const value = await request<AiSetupStatus>("");
    setStatus(value);
    return value;
  }, []);
  useEffect(() => {
    let active = true;
    void request<AiSetupStatus>("")
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (status?.download.state !== "downloading") return;
    const timer = setInterval(() => {
      void refresh().catch(() =>
        setError(
          "The model status cannot be checked right now. The server may still be downloading.",
        ),
      );
    }, 2500);
    return () => clearInterval(timer);
  }, [status?.download.state, refresh]);
  useEffect(() => {
    if (!status) return;
    const available = status.installedModels ?? [];
    setSelectedModel((current) =>
      available.includes(current)
        ? current
        : configuredModel && available.includes(configuredModel)
          ? configuredModel
          : available.includes(status.model.name)
            ? status.model.name
            : (available[0] ?? ""),
    );
  }, [status, configuredModel]);
  if (!status) return null;
  const act = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Local AI setup is unavailable.",
      );
    } finally {
      setBusy(false);
    }
  };
  const missingRuntime = status.runtime !== "ready";
  const existingModel = (status.installedModels ?? []).includes(selectedModel);
  return (
    <section
      className="deployment-card"
      aria-labelledby="server-ai-setup-title"
    >
      <p className="eyebrow">Local AI on your server</p>
      <h2 id="server-ai-setup-title">Prepare Ollama and a local model</h2>
      <p>
        Your other devices only need a browser. Ollama and the model run on the
        StreamerAI server.
      </p>
      <p role="status">
        {status.runtime === "ready"
          ? `Ollama ${status.runtimeVersion ?? ""} is running.`
          : status.runtime === "installed-not-running"
            ? "Ollama was found, but its local service is not reachable."
            : status.runtime === "unavailable"
              ? "The local Ollama service needs attention."
              : "Ollama was not found on the server."}{" "}
        {existingModel
          ? `${selectedModel} is already installed and can be reused.`
          : `Recommended model: ${status.model.name}.`}
      </p>
      {!missingRuntime && (status.installedModels ?? []).length > 0 && (
        <label className="field">
          <span>Installed local model</span>
          <select
            value={selectedModel}
            onChange={(event) => setSelectedModel(event.target.value)}
          >
            {status.installedModels.map((model) => (
              <option value={model} key={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
      )}
      {missingRuntime && (
        <>
          <button
            className="button button--secondary"
            type="button"
            onClick={() => setShowInstall(!showInstall)}
          >
            {status.runtime === "installed-not-running"
              ? "How to start existing Ollama"
              : status.runtime === "unavailable"
                ? "Open local AI setup instructions"
                : "How to install Ollama on the server"}
          </button>
          {showInstall && (
            <div className="deployment-card">
              <p>
                On the server computer, open <strong>Configure local AI</strong>{" "}
                from Start menu → StreamerAI on Windows, or{" "}
                <strong>StreamerAI Local AI Setup</strong> from the applications
                menu on Linux. The setup application can start an existing
                Ollama installation or offer to install it if missing. Review
                and confirm the model download there.
              </p>
              <p>
                Then return here and choose Check again. No terminal commands
                are needed, and nothing is installed on this browser's device.
              </p>
            </div>
          )}
        </>
      )}
      {!missingRuntime &&
        existingModel &&
        !status.model.present &&
        !offerRecommended && (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => setOfferRecommended(true)}
          >
            Offer the recommended model instead
          </button>
        )}
      {!missingRuntime &&
        !status.model.present &&
        (!existingModel || offerRecommended) &&
        status.download.state !== "downloading" && (
          <>
            <p>
              The recommended model download is approximately{" "}
              {(status.resources.estimatedModelBytes / 1_000_000_000).toFixed(
                1,
              )}{" "}
              GB. Keep at least {gib(status.resources.recommendedFreeDiskBytes)}{" "}
              GiB free for local AI setup. Downloads use the server's internet
              connection.
            </p>
            {status.resources.freeDiskBytes === null && (
              <p className="settings-note">
                Free space in Ollama's model folder could not be verified. The
                local server installer can check the actual folder before
                installing.
              </p>
            )}
            <label>
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />{" "}
              Download the recommended model on this server.
            </label>
            <div className="deployment-actions">
              <button
                className="button button--secondary"
                disabled={busy || !consent}
                type="button"
                onClick={() =>
                  void act(async () => {
                    await request("/model", {
                      confirm: "download-recommended-local-model",
                    });
                    await refresh();
                  })
                }
              >
                {busy ? "Preparing…" : "Download local model"}
              </button>
            </div>
          </>
        )}
      {status.download.state === "downloading" && (
        <p role="status">
          Downloading the model on the server… This may take several minutes.
          You can continue without AI and return later.
        </p>
      )}
      {status.download.state === "error" && (
        <p role="alert">
          The model download did not finish. Check the server's connection and
          disk space, then retry.
        </p>
      )}
      {status.resources.memoryBytes <
        status.resources.recommendedMemoryBytes && (
        <p className="settings-note">
          This server has less than{" "}
          {gib(status.resources.recommendedMemoryBytes)} GiB RAM. Local AI may
          be slow; you can continue without it.
        </p>
      )}
      <div className="deployment-actions">
        <button
          className="button button--secondary"
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await refresh();
            })
          }
        >
          Check again
        </button>
        {existingModel && onUseLocalModel && (
          <button
            className="button button--secondary"
            type="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await onUseLocalModel(selectedModel);
                showToast("Local AI is ready for this profile.", "success");
              })
            }
          >
            {busy ? "Verifying…" : "Use this local model"}
          </button>
        )}
      </div>
      <p className="settings-note">
        You can finish setup without AI. Existing installations and models are
        reused; no runtime or model is downloaded without confirmation.
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
