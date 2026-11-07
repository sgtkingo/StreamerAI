import { useEffect, useState } from "react";
import type { StreamerApi } from "../../api/client";
import { AgentBackendSettings } from "../AgentBackendSettings";
import { ServerAiSetup } from "../ServerAiSetup";

interface LocalAiStepProps {
  api: StreamerApi;
  profileId?: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

/** The same agent preference editor serves first setup and later Settings. */
export function LocalAiStep({
  api,
  profileId = "default",
  enabled,
  onEnabledChange,
}: LocalAiStepProps) {
  const [configuredModel, setConfiguredModel] = useState<string>();
  useEffect(() => {
    let mounted = true;
    if (!api.getOllamaConfig) return;
    void Promise.resolve()
      .then(() => api.getOllamaConfig(profileId))
      .then((config) => {
        if (mounted && config?.model) setConfiguredModel(config.model);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [api, profileId]);
  useEffect(() => {
    let mounted = true;
    void api
      .getAgentSelection(profileId)
      .then((selection) => {
        if (mounted)
          onEnabledChange(
            selection.mode === "mcp" ||
              (selection.mode !== "disabled" && selection.available),
          );
      })
      .catch(() => {
        if (mounted) onEnabledChange(false);
      });
    return () => {
      mounted = false;
    };
  }, [api, onEnabledChange, profileId]);

  return (
    <div className="step-copy">
      <p className="eyebrow">Choose your agent</p>
      <h1 tabIndex={-1}>
        An assistant for
        <br />
        your cinema.
      </h1>
      <p className="step-lead">
        Pick one AI connection, or continue without one. You can change this
        later in Settings. Local tools keep their own sign-in. API providers
        receive the discovery requests you send to StreamerAI.
      </p>
      <ServerAiSetup
        configuredModel={configuredModel}
        onUseLocalModel={async (model) => {
          const result = await api.connectLocalAgent({
            profileId,
            baseUrl: "http://127.0.0.1:11434",
            model,
          });
          if (!result.ok) throw new Error(result.message);
          await api.setAgentSelection({
            profileId,
            mode: "api",
            provider: "ollama",
            model,
            reasoningEffort: "low",
          });
          onEnabledChange(true);
        }}
      />
      <AgentBackendSettings
        api={api}
        profileId={profileId}
        onChanged={onEnabledChange}
        guideAtTop
      />
      <p className="privacy-line" role="status">
        {enabled
          ? "An agent is selected for this profile."
          : "Search still works without an AI agent."}
      </p>
    </div>
  );
}
