import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AgentBackend,
  AgentModelCatalog,
  AgentModelOption,
  AgentReasoningEffort,
  AgentSelection,
  LocalAgentCapability,
  StreamerApi,
} from "../api/client";
import { safeErrorMessage } from "../api/client";
import { InfoTip } from "./InfoTip";

type LocalProvider = "ollama" | "custom";
type RemoteProvider = Exclude<AgentBackend, LocalAgentCapability["provider"]>;
type Side = "local" | "external";
type Transport = "api" | "mcp";
type GuideLocalState =
  | "idle"
  | "scanning"
  | "ready"
  | "missing-runtime"
  | "missing-model"
  | "needs-attention"
  | "downloading"
  | "error";
const localProviders: LocalProvider[] = ["ollama", "custom"];
const remoteProviders: { id: RemoteProvider; name: string }[] = [
  { id: "openai", name: "OpenAI / ChatGPT" },
  { id: "anthropic", name: "Anthropic / Claude" },
  { id: "gemini", name: "Gemini" },
  { id: "grok", name: "Grok" },
  { id: "kimi", name: "Kimi" },
  { id: "deepseek", name: "DeepSeek" },
];
const effortLabels: Record<AgentReasoningEffort, string> = {
  none: "No reasoning",
  low: "Light",
  medium: "Balanced",
  high: "High reasoning",
};
function resolveModel(catalog: AgentModelCatalog | null, model: string) {
  const id = model || catalog?.recommendedModel;
  return catalog?.models.find((item) => item.id === id);
}
function selectionEffort(selection: AgentSelection) {
  const effective = selection.effectiveReasoningEffort;
  return effective && effective !== "minimal"
    ? effective
    : selection.reasoningEffort;
}

function ContextSettings({
  value,
  onChange,
  maximum,
  effective,
}: {
  value: string;
  onChange: (value: string) => void;
  maximum?: number;
  effective?: number;
}) {
  return (
    <label className="field">
      <span>Context window (tokens)</span>
      <input
        aria-label="Context window (tokens)"
        type="number"
        min={2048}
        max={Math.min(maximum ?? 131072, 131072)}
        step={1}
        placeholder="Automatic"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <small>
        Allowed: 2048–{Math.min(maximum ?? 131072, 131072)} tokens. Leave empty
        for Automatic
        {effective ? ` (${effective} tokens currently)` : ""}.
        {maximum
          ? ` Model maximum: ${maximum} tokens.`
          : " Model maximum is not reported."}{" "}
        Larger windows use more memory. Includes instructions, history,
        reasoning and the answer.
      </small>
    </label>
  );
}
function localMode(_provider: LocalProvider): AgentSelection["mode"] {
  return "api";
}
function isLocal(selection: AgentSelection) {
  return (
    selection.mode === "api" &&
    localProviders.includes(selection.provider as LocalProvider)
  );
}
function isEnabled(selection: AgentSelection) {
  return (
    selection.mode === "mcp" ||
    (selection.mode !== "disabled" && selection.available)
  );
}
function Mark({ active }: { active: boolean }) {
  return active ? (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
      <path
        d="m4 10 4 4 8-8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="10" r="2" fill="currentColor" />
    </svg>
  );
}

function GuideTarget({ active }: { active: boolean }) {
  return (
    <span
      className={`agent-backend__guide-target ${active ? "is-scanning" : ""}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 48 48" fill="none">
        <circle
          cx="24"
          cy="24"
          r="20"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <circle
          cx="24"
          cy="24"
          r="12"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <circle cx="24" cy="24" r="4" fill="currentColor" />
        <path
          d="M24 1v9M24 38v9M1 24h9M38 24h9"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

function ModelSettings({
  label,
  model,
  catalog,
  loading,
  error,
  onChange,
  onRefresh,
}: {
  label: string;
  model: string;
  catalog: AgentModelCatalog | null;
  loading: boolean;
  error: string;
  onChange: (model: string) => void;
  onRefresh: () => void;
}) {
  const models = catalog?.models ?? [];
  const selected = resolveModel(catalog, model);
  return (
    <div className="agent-backend__model-settings">
      <label className="field">
        <span>{label} model</span>
        <select
          value={model}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Automatic</option>
          {model && !selected && <option value={model}>{model}</option>}
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <p className="integration-block__hint" role="status">
        {loading
          ? "Checking available models…"
          : model
            ? selected
              ? `Selected model: ${selected.label}`
              : `Selected model: ${model} (availability unverified)`
            : catalog?.recommendedModel
              ? `Automatic model: ${catalog.recommendedModel}${catalog.status === "available" ? "" : " (availability unverified)"}`
              : (catalog?.message ??
                "Model availability has not been checked.")}
      </p>
      {selected && (
        <p className="integration-block__hint">
          Supported thinking: {selected.reasoningEfforts.join(", ")}.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        className="button button--ghost"
        type="button"
        disabled={loading}
        onClick={onRefresh}
      >
        Refresh models
      </button>
    </div>
  );
}

export function AgentBackendSettings({
  api,
  profileId,
  onChanged,
  guideAtTop = false,
}: {
  api: StreamerApi;
  profileId: string;
  onChanged?: (available: boolean) => void;
  guideAtTop?: boolean;
}) {
  const [current, setCurrent] = useState<AgentSelection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [side, setSide] = useState<Side>("local");
  const [localProvider, setLocalProvider] = useState<LocalProvider>("ollama");
  const [remoteProvider, setRemoteProvider] =
    useState<RemoteProvider>("openai");
  const [transport, setTransport] = useState<Transport>("api");
  const [effort, setEffort] = useState<AgentReasoningEffort>("low");
  const [contextTokens, setContextTokens] = useState("");
  const [localModel, setLocalModel] = useState("");
  const [externalModel, setExternalModel] = useState("");
  const [localSettingsOpen, setLocalSettingsOpen] = useState(false);
  const [externalSettingsOpen, setExternalSettingsOpen] = useState(false);
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null);
  const [apiKeyInvalid, setApiKeyInvalid] = useState(false);
  const apiKeyFieldRef = useRef<HTMLLabelElement | null>(null);
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const [capabilities, setCapabilities] = useState<
    LocalAgentCapability[] | null
  >(null);
  const [discoveredModels, setDiscoveredModels] = useState<Record<
    LocalProvider,
    AgentModelOption[]
  > | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [ollamaModel, setOllamaModel] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideStep, setGuideStep] = useState(0);
  const [guideSide, setGuideSide] = useState<Side>("local");
  const [guideTransport, setGuideTransport] = useState<Transport>("api");
  const [guidePriority, setGuidePriority] = useState<
    "speed" | "balanced" | "quality"
  >("speed");
  const [guideLocalState, setGuideLocalState] =
    useState<GuideLocalState>("idle");
  const [guideLocalMessage, setGuideLocalMessage] = useState("");
  const [guideReadyProvider, setGuideReadyProvider] =
    useState<LocalProvider | null>(null);
  const [guideModelName, setGuideModelName] = useState("");
  const [guideLocalModels, setGuideLocalModels] = useState<AgentModelOption[]>(
    [],
  );
  const [guideRuntimeAvailable, setGuideRuntimeAvailable] = useState(false);
  const [guideCanDownload, setGuideCanDownload] = useState(false);
  const [guideModelCandidate, setGuideModelCandidate] = useState("");
  const [guideCustomOpen, setGuideCustomOpen] = useState(false);
  const [guideConfigurationOpen, setGuideConfigurationOpen] = useState(false);
  const [guideConfigurationDirty, setGuideConfigurationDirty] = useState(false);
  const [guideCustomBusy, setGuideCustomBusy] = useState(false);
  const [guideApiProvider, setGuideApiProvider] =
    useState<RemoteProvider>("openai");
  const [guideApiKey, setGuideApiKey] = useState("");
  const [guideSavedKey, setGuideSavedKey] = useState<boolean | null>(null);
  const [guideKeyInvalid, setGuideKeyInvalid] = useState(false);
  const [guideKeyError, setGuideKeyError] = useState("");
  const guideDialogRef = useRef<HTMLDivElement | null>(null);
  const guideApiKeyRef = useRef<HTMLInputElement | null>(null);
  const guideApiKeyFieldRef = useRef<HTMLLabelElement | null>(null);
  const guideScanRunRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [turnOffComplete, setTurnOffComplete] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const provider: AgentBackend =
    side === "local" ? localProvider : remoteProvider;
  const mcp = side === "external" && transport === "mcp";
  const activeLocal = !!current && isLocal(current);
  const draftLocalActive = activeLocal && current.provider === localProvider;
  const activeExternal =
    !!current && !isLocal(current) && current.mode !== "disabled";
  const draftExternalActive =
    activeExternal &&
    (current.mode === "mcp"
      ? transport === "mcp"
      : transport === "api" && current.provider === remoteProvider);
  const model = side === "local" ? localModel : externalModel;
  const activeCatalog = catalog?.provider === provider ? catalog : null;
  const models = activeCatalog?.models ?? [];
  const chosenModel = resolveModel(activeCatalog, model);
  const allowedLevels =
    provider === "custom"
      ? (["none"] as AgentReasoningEffort[])
      : chosenModel
        ? chosenModel.reasoningEfforts
        : [];
  const selectedEffort =
    mcp || allowedLevels.includes(effort)
      ? effort
      : (allowedLevels[0] ?? effort);
  const guideAllowedLevels: AgentReasoningEffort[] =
    guideReadyProvider === "custom"
      ? ["none"]
      : (discoveredModels?.ollama.find((item) => item.id === guideModelName)
          ?.reasoningEfforts ?? []);
  const guideSelectedEffort = guideAllowedLevels.includes(effort)
    ? effort
    : (guideAllowedLevels[0] ?? "none");

  useEffect(() => {
    let mounted = true;
    setLoaded(false);
    void api
      .getAgentSelection(profileId)
      .then((status) => {
        if (!mounted) return;
        setCurrent(status);
        setContextTokens(status.contextTokens?.toString() ?? "");
        setLoaded(true);
        if (isLocal(status)) {
          setSide("local");
          setLocalProvider(status.provider as LocalProvider);
        } else if (status.mode === "mcp") {
          setSide("external");
          setTransport("mcp");
        } else if (status.mode === "local") {
          setSide("external");
        } else if (status.mode === "api") {
          setSide("external");
          setTransport("api");
          setRemoteProvider(status.provider as RemoteProvider);
        }
        setEffort(selectionEffort(status) ?? "low");
        setLocalModel(isLocal(status) ? (status.model ?? "") : "");
        setExternalModel(
          !isLocal(status) && status.mode === "api" ? (status.model ?? "") : "",
        );
      })
      .catch((cause: unknown) => {
        if (mounted) {
          setError(safeErrorMessage(cause));
          setLoaded(true);
        }
      });
    return () => {
      mounted = false;
    };
  }, [api, profileId]);

  useEffect(() => {
    if (!loaded || mcp) return;
    let mounted = true;
    setCatalog((previous) =>
      previous?.provider === provider ? previous : null,
    );
    setModelError("");
    setLoadingModels(true);
    void api
      .getAgentModels(provider, profileId, effort)
      .then((result) => {
        if (mounted) setCatalog(result);
      })
      .catch((cause: unknown) => {
        if (mounted) setModelError(safeErrorMessage(cause));
      })
      .finally(() => {
        if (mounted) setLoadingModels(false);
      });
    return () => {
      mounted = false;
    };
  }, [api, effort, loaded, mcp, profileId, provider]);

  useEffect(() => {
    if (!loaded || side !== "external" || mcp) return;
    let mounted = true;
    setKeyConfigured(null);
    void api
      .getAgentApiKeyStatus(remoteProvider, profileId)
      .then((result) => {
        if (mounted) setKeyConfigured(result.configured);
      })
      .catch((cause: unknown) => {
        if (mounted) setError(safeErrorMessage(cause));
      });
    return () => {
      mounted = false;
    };
  }, [api, loaded, mcp, profileId, remoteProvider, side]);

  useEffect(() => {
    if (!loaded) return;
    let mounted = true;
    void api
      .getOllamaConfig(profileId)
      .then(({ model: configured, baseUrl }) => {
        if (mounted) {
          setOllamaModel(configured);
          setOllamaUrl(baseUrl ?? "");
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [api, loaded, profileId]);

  useEffect(() => {
    if (!loaded) return;
    let mounted = true;
    void api
      .getCustomLocalAgent(profileId)
      .then((config) => {
        if (!mounted) return;
        setCustomUrl(config.baseUrl);
        setCustomModel(config.model);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [api, loaded, profileId]);

  useEffect(() => {
    if (
      !guideOpen ||
      guideStep !== 1 ||
      guideSide !== "external" ||
      guideTransport !== "api"
    )
      return;
    let mounted = true;
    setGuideSavedKey(null);
    setGuideKeyError("");
    void api
      .getAgentApiKeyStatus(guideApiProvider, profileId)
      .then((result) => {
        if (mounted) setGuideSavedKey(result.configured);
      })
      .catch(() => {
        if (mounted) {
          setGuideSavedKey(false);
          setGuideKeyError(
            "Could not check the saved key. Enter a new key to continue.",
          );
        }
      });
    return () => {
      mounted = false;
    };
  }, [
    api,
    guideApiProvider,
    guideOpen,
    guideSide,
    guideStep,
    guideTransport,
    profileId,
  ]);

  useEffect(() => {
    if (!guideOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    guideDialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setGuideOpen(false);
        return;
      }
      if (event.key !== "Tab" || !guideDialogRef.current) return;
      const focusable = Array.from(
        guideDialogRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]",
        ),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [guideOpen]);

  useEffect(() => {
    if (!guideOpen) guideScanRunRef.current += 1;
  }, [guideOpen]);

  const discover = async () => {
    setDiscovering(true);
    setError("");
    try {
      const result = await api.getLocalAgentCapabilities(profileId);
      const [ollamaCatalog, customCatalog] = await Promise.all([
        api.getAgentModels("ollama", profileId, effort),
        api.getAgentModels("custom", profileId, "none"),
      ]);
      const local = result.providers.filter((item) =>
        localProviders.includes(item.provider as LocalProvider),
      );
      setCapabilities(local);
      const foundModels = {
        ollama:
          ollamaCatalog.status === "available" ? ollamaCatalog.models : [],
        custom:
          customCatalog.status === "available" ? customCatalog.models : [],
      };
      setDiscoveredModels(foundModels);
      if (side === "local")
        setCatalog(localProvider === "custom" ? customCatalog : ollamaCatalog);
      return { providers: local, models: foundModels, failed: false };
    } catch (cause) {
      setError(safeErrorMessage(cause));
      return {
        providers: [],
        models: { ollama: [], custom: [] },
        failed: true,
      };
    } finally {
      setDiscovering(false);
    }
  };
  const refreshModels = async (target: Side) => {
    setLoadingModels(true);
    setModelError("");
    try {
      const targetProvider =
        target === "local" ? localProvider : remoteProvider;
      setCatalog(await api.getAgentModels(targetProvider, profileId, effort));
    } catch (cause) {
      setModelError(safeErrorMessage(cause));
    } finally {
      setLoadingModels(false);
    }
  };

  const requestApiKey = () => {
    setApiKeyInvalid(true);
    const field = apiKeyFieldRef.current;
    if (field) {
      field.classList.remove("is-shaking");
      void field.offsetWidth;
      field.classList.add("is-shaking");
    }
    apiKeyInputRef.current?.focus();
  };

  const apply = async (
    choice: {
      side: Side;
      local: LocalProvider;
      remote: RemoteProvider;
      transport: Transport;
      effort: AgentReasoningEffort;
      model?: string;
    },
    key = apiKey,
    onMissingKey = requestApiKey,
  ) => {
    if (
      choice.transport !== "mcp" &&
      contextTokens !== "" &&
      (!Number.isInteger(Number(contextTokens)) ||
        Number(contextTokens) < 2048 ||
        Number(contextTokens) > 131072)
    ) {
      setError(
        "Context size must be an integer between 2048 and 131072 tokens.",
      );
      return false;
    }
    if (
      choice.side === "external" &&
      choice.transport === "api" &&
      !key.trim()
    ) {
      try {
        const configured = (
          await api.getAgentApiKeyStatus(choice.remote, profileId)
        ).configured;
        setKeyConfigured(configured);
        if (!configured) {
          onMissingKey();
          return false;
        }
      } catch (cause) {
        setError(safeErrorMessage(cause));
        return false;
      }
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (
        choice.side === "external" &&
        choice.transport === "api" &&
        key.trim()
      ) {
        await api.saveAgentApiKey({
          profileId,
          provider: choice.remote,
          apiKey: key.trim(),
        });
        setKeyConfigured(true);
      }
      const mode: AgentSelection["mode"] =
        choice.side === "local"
          ? localMode(choice.local)
          : choice.transport === "mcp"
            ? "mcp"
            : "api";
      const selectedProvider: AgentBackend =
        mode === "mcp"
          ? "ollama"
          : choice.side === "local"
            ? choice.local
            : choice.remote;
      const result = await api.setAgentSelection({
        profileId,
        mode,
        provider: selectedProvider,
        reasoningEffort: choice.effort,
        ...(mode !== "mcp" && contextTokens !== ""
          ? { contextTokens: Number(contextTokens) }
          : {}),
        ...(choice.model && mode !== "mcp" ? { model: choice.model } : {}),
      });
      if (result.code === "CREDENTIAL_REQUIRED") {
        setKeyConfigured(false);
        onMissingKey();
        return false;
      }
      setCurrent(result);
      setContextTokens(result.contextTokens?.toString() ?? "");
      setTurnOffComplete(false);
      setSide(choice.side);
      setLocalProvider(choice.local);
      setRemoteProvider(choice.remote);
      setTransport(choice.transport);
      setEffort(selectionEffort(result) ?? choice.effort);
      if (choice.side === "local") setLocalModel(choice.model ?? "");
      else if (choice.transport === "api") setExternalModel(choice.model ?? "");
      setApiKey("");
      onChanged?.(isEnabled(result));
      setNotice("Agent preference saved.");
      return true;
    } catch (cause) {
      const message = safeErrorMessage(cause);
      if (
        /configure\s+an?\s+.+?\s+api key for this profile\.?/i.test(message)
      ) {
        setKeyConfigured(false);
        onMissingKey();
      } else {
        setError(message);
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  const saveDraft = () =>
    apply({
      side,
      local: localProvider,
      remote: remoteProvider,
      transport,
      effort: selectedEffort,
      ...(model ? { model } : {}),
    });
  const chooseSide = (value: Side) => {
    if (value === side) return;
    setSide(value);
    if (value === "local") setExternalSettingsOpen(false);
    else setLocalSettingsOpen(false);
    setError("");
  };
  const removeKey = async () => {
    setBusy(true);
    setError("");
    try {
      await api.deleteAgentApiKey({ profileId, provider: remoteProvider });
      setKeyConfigured(false);
      const selection = await api.getAgentSelection(profileId);
      setCurrent(selection);
      onChanged?.(isEnabled(selection));
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const disableAgent = async () => {
    setBusy(true);
    setError("");
    setTurnOffComplete(false);
    try {
      const status = await api.setAgentSelection({
        profileId,
        mode: "disabled",
        provider: "ollama",
        reasoningEffort: "low",
      });
      setCurrent(status);
      setTurnOffComplete(true);
      onChanged?.(false);
      setNotice("Agent turned off.");
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const connectOllama = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.connectLocalAgent({
        profileId,
        model: ollamaModel.trim(),
        baseUrl: ollamaUrl.trim(),
      });
      if (!result.ok) throw new Error(result.message);
      setNotice("Ollama connected.");
      await discover();
      const selection = await api.getAgentSelection(profileId);
      setCurrent(selection);
      onChanged?.(isEnabled(selection));
      setLocalSettingsOpen(false);
      return true;
    } catch (cause) {
      setError(safeErrorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const connectCustom = async () => {
    setBusy(true);
    setError("");
    try {
      const config = await api.saveCustomLocalAgent({
        profileId,
        baseUrl: customUrl.trim(),
        model: customModel.trim(),
      });
      setCustomUrl(config.baseUrl);
      setCustomModel(config.model);
      setLocalModel(config.model);
      setNotice("Custom local agent settings saved.");
      await discover();
      return true;
    } catch (cause) {
      setError(safeErrorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const autoLocal = async () => {
    const found = capabilities ?? (await discover()).providers;
    const best = localProviders
      .map((id) => found.find((item) => item.provider === id))
      .find((item) => item?.ready);
    if (!best) {
      setError(
        "No local provider is ready. Configure Ollama or Custom in Local Settings, then Discover.",
      );
      return;
    }
    setLocalProvider(best.provider as LocalProvider);
    await apply({
      side: "local",
      local: best.provider as LocalProvider,
      remote: remoteProvider,
      transport: "api",
      effort:
        side === "local" &&
        best.provider === localProvider &&
        allowedLevels.includes(selectedEffort)
          ? selectedEffort
          : "none",
      ...(best.provider === "custom" && customModel
        ? { model: customModel }
        : {}),
    });
  };
  const openGuide = () => {
    setGuideStep(0);
    setGuideSide(side);
    setGuideTransport(transport);
    setGuideApiProvider(remoteProvider);
    setGuideApiKey("");
    setGuideKeyInvalid(false);
    setGuideKeyError("");
    setGuideLocalState("idle");
    setGuideLocalMessage("");
    setGuideReadyProvider(null);
    setGuideRuntimeAvailable(false);
    setGuideCanDownload(false);
    setGuideModelCandidate("");
    setGuideCustomOpen(false);
    setGuideConfigurationOpen(false);
    setGuideConfigurationDirty(false);
    setError("");
    setGuideOpen(true);
  };
  const scanGuideLocal = async (
    preferredModel?: string,
    preferredProvider?: LocalProvider,
  ) => {
    const run = ++guideScanRunRef.current;
    setGuideLocalState("scanning");
    setGuideLocalMessage("Checking Ollama, Custom, and installed models…");
    setGuideReadyProvider(null);
    try {
      const [found, runtime, ollamaConfig] = await Promise.all([
        discover(),
        api.discoverLocalAgents(profileId).catch(() => null),
        api.getOllamaConfig(profileId).catch(() => null),
      ]);
      if (run !== guideScanRunRef.current) return;
      if (found.failed) {
        setGuideLocalState("error");
        setGuideLocalMessage("Local discovery could not finish. Try again.");
        return;
      }
      setGuideLocalModels(found.models.ollama);
      const configuredModel =
        ollamaConfig?.model || ollamaModel || "qwen3.5:4b";
      const configuredUrl =
        ollamaConfig?.baseUrl || ollamaUrl || "http://127.0.0.1:11434";
      setOllamaModel(configuredModel);
      setOllamaUrl(configuredUrl);
      setGuideModelCandidate(
        preferredModel ?? found.models.ollama[0]?.id ?? "",
      );
      let ready = found.providers.find(
        (item) => item.provider === "custom" && item.ready,
      );
      let verificationMessage = "";
      let verifiedModel = "";
      const runtimeAvailable =
        runtime?.runtimeAvailable ?? found.models.ollama.length > 0;
      setGuideRuntimeAvailable(runtimeAvailable);
      setGuideCanDownload(
        runtimeAvailable &&
          !found.models.ollama.some((item) => item.id === configuredModel),
      );
      if (
        runtimeAvailable &&
        found.models.ollama.length &&
        preferredProvider !== "custom"
      ) {
        const candidate =
          found.models.ollama.find((item) => item.id === preferredModel) ??
          found.models.ollama.find((item) => item.id === configuredModel) ??
          found.models.ollama.find((item) => /qwen/i.test(item.id)) ??
          found.models.ollama[0]!;
        const result = await api.verifyOllamaModel({
          profileId,
          model: candidate.id,
        });
        if (run !== guideScanRunRef.current) return;
        if (result.ok) {
          verifiedModel = candidate.id;
          ready = {
            provider: "ollama",
            detected: true,
            ready: true,
            code: "READY",
            message: result.message,
            recommendedModel: candidate.id,
          };
        } else {
          verificationMessage = result.message;
          ready = found.providers.find(
            (item) => item.provider === "custom" && item.ready,
          );
        }
      }
      let customVerificationFailed = false;
      if (ready?.provider === "custom") {
        setGuideLocalMessage(
          "Checking a test response from your Custom agent…",
        );
        const verified = await api.verifyCustomLocalAgent(profileId);
        if (run !== guideScanRunRef.current) return;
        if (!verified.ok) {
          customVerificationFailed = true;
          ready = undefined;
          verificationMessage =
            "Custom listed the model, but it could not complete a test request. Check its API URL and model.";
        }
      }
      if (ready) {
        const provider = ready.provider as LocalProvider;
        setGuideReadyProvider(provider);
        setGuideModelName(
          provider === "custom"
            ? customModel || ready.recommendedModel || ""
            : verifiedModel || configuredModel || ready.recommendedModel || "",
        );
        setGuideLocalState("ready");
        setGuideLocalMessage(
          provider === "custom"
            ? "Custom local API completed a test response."
            : "Ollama is installed and passed its model checks.",
        );
      } else if (customVerificationFailed) {
        setGuideLocalState("needs-attention");
        setGuideLocalMessage(verificationMessage);
      } else if (runtimeAvailable) {
        setGuideLocalState(
          found.models.ollama.length ? "needs-attention" : "missing-model",
        );
        setGuideLocalMessage(
          found.models.ollama.length
            ? verificationMessage ||
                "Ollama was found, but its model did not pass the connection check."
            : "Ollama is running, but no model is installed yet.",
        );
      } else {
        setGuideLocalState("missing-runtime");
        setGuideLocalMessage("Ollama is not running on this device yet.");
      }
    } catch (cause) {
      if (run !== guideScanRunRef.current) return;
      setGuideLocalState("error");
      setGuideLocalMessage(safeErrorMessage(cause));
    }
  };
  const downloadGuideModel = async () => {
    const run = guideScanRunRef.current;
    setGuideLocalState("downloading");
    setGuideLocalMessage(
      "Downloading the configured Ollama model. This can take a few minutes…",
    );
    try {
      const result = await api.pullLocalAgentModel(profileId);
      if (run !== guideScanRunRef.current) return;
      if (!result.ok)
        throw new Error("Ollama did not finish the model download.");
      setOllamaModel(result.model);
      await scanGuideLocal(result.model);
    } catch (cause) {
      if (run !== guideScanRunRef.current) return;
      setGuideLocalState("error");
      setGuideLocalMessage(safeErrorMessage(cause));
    }
  };
  const verifyGuideCustom = async () => {
    const run = ++guideScanRunRef.current;
    setGuideCustomBusy(true);
    setGuideLocalMessage("");
    try {
      const candidate = {
        profileId,
        baseUrl: customUrl.trim(),
        model: customModel.trim(),
      };
      const result = await api.verifyCustomLocalCandidate(candidate);
      if (run !== guideScanRunRef.current) return;
      if (!result.ok) {
        setGuideLocalState("needs-attention");
        setGuideLocalMessage(
          "Custom could not complete a test request. Check its API URL and model.",
        );
        return;
      }
      setGuideReadyProvider("custom");
      setGuideModelName(candidate.model);
      setGuideLocalState("ready");
      setGuideLocalMessage("Custom local API completed a test response.");
    } catch (cause) {
      if (run !== guideScanRunRef.current) return;
      setGuideLocalState("error");
      setGuideLocalMessage(safeErrorMessage(cause));
    } finally {
      if (run === guideScanRunRef.current) setGuideCustomBusy(false);
    }
  };
  const requireGuideKey = () => {
    setGuideStep(1);
    setGuideKeyInvalid(true);
    setGuideKeyError("Enter an API key for this provider to continue.");
    const field = guideApiKeyFieldRef.current;
    if (field) {
      field.classList.remove("is-shaking");
      void field.offsetWidth;
      field.classList.add("is-shaking");
    }
    guideApiKeyRef.current?.focus();
  };
  const nextGuide = () => {
    if (guideStep === 0) {
      setGuideStep(1);
      if (guideSide === "local") void scanGuideLocal();
      return;
    }
    if (guideSide === "local" && guideLocalState !== "ready") return;
    if (guideSide === "external" && guideTransport === "api") {
      if (!guideApiKey.trim() && !guideSavedKey) {
        requireGuideKey();
        return;
      }
      if (guideApiKey.trim() && guideApiKey.trim().length < 8) {
        setGuideKeyError("The API key must have at least 8 characters.");
        setGuideKeyInvalid(true);
        guideApiKeyRef.current?.focus();
        return;
      }
    }
    setGuideStep(2);
  };
  const applyGuide = async () => {
    const requestedEffort: AgentReasoningEffort =
      guidePriority === "quality"
        ? "high"
        : guidePriority === "balanced"
          ? "medium"
          : "none";
    if (guideSide === "local") {
      if (!guideReadyProvider) return;
      if (guideReadyProvider === "ollama") {
        try {
          const result = await api.connectLocalAgent({
            profileId,
            model: guideModelName,
            baseUrl: ollamaUrl || "http://127.0.0.1:11434",
          });
          if (!result.ok) {
            setError(result.message);
            return;
          }
        } catch (cause) {
          setError(safeErrorMessage(cause));
          return;
        }
      } else {
        try {
          await api.saveCustomLocalAgent({
            profileId,
            baseUrl: customUrl.trim(),
            model: guideModelName,
          });
        } catch (cause) {
          setError(safeErrorMessage(cause));
          return;
        }
      }
      if (
        await apply({
          side: "local",
          local: guideReadyProvider,
          remote: remoteProvider,
          transport: "api",
          effort: guideSelectedEffort,
          ...(guideModelName ? { model: guideModelName } : {}),
        })
      )
        setGuideOpen(false);
    } else if (
      await apply(
        {
          side: "external",
          local: localProvider,
          remote: guideApiProvider,
          transport: guideTransport,
          effort: guideTransport === "mcp" ? "low" : requestedEffort,
        },
        guideApiKey,
        requireGuideKey,
      )
    )
      setGuideOpen(false);
  };

  const localSettingsContent = (inGuide: boolean) => {
    const markGuideConfigurationChanged = () => {
      if (!inGuide) return;
      guideScanRunRef.current += 1;
      setGuideConfigurationDirty(true);
      setGuideReadyProvider(null);
      setGuideLocalState("needs-attention");
      setGuideLocalMessage("Save and verify this configuration to continue.");
    };
    const localCatalog: AgentModelCatalog | null = inGuide
      ? {
          provider: localProvider,
          models: discoveredModels?.[localProvider] ?? [],
          recommendedModel: discoveredModels?.[localProvider]?.[0]?.id ?? null,
          source: "local",
          status: discoveredModels?.[localProvider]?.length
            ? "available"
            : "unavailable",
          message: "No models found. Check the connection and refresh.",
        }
      : side === "local"
        ? activeCatalog
        : null;
    const saveConnection = async () => {
      const saved =
        localProvider === "ollama"
          ? await connectOllama()
          : await connectCustom();
      if (saved && inGuide) {
        setGuideConfigurationDirty(false);
        await scanGuideLocal(
          localProvider === "ollama" ? ollamaModel.trim() : undefined,
          localProvider,
        );
      }
    };
    return (
      <>
        {inGuide && (
          <label className="field">
            <span>Local provider</span>
            <select
              value={localProvider}
              onChange={(event) => {
                setLocalProvider(event.target.value as LocalProvider);
                setLocalModel("");
                markGuideConfigurationChanged();
              }}
            >
              <option value="ollama">Ollama</option>
              <option value="custom">Custom</option>
            </select>
          </label>
        )}
        <ModelSettings
          label="Local"
          model={localModel}
          catalog={localCatalog}
          loading={!inGuide && side === "local" && loadingModels}
          error={!inGuide && side === "local" ? modelError : ""}
          onChange={(value) => {
            setLocalModel(value);
            if (inGuide && value) {
              if (localProvider === "ollama") setOllamaModel(value);
              else setCustomModel(value);
            }
            markGuideConfigurationChanged();
            const option = localCatalog?.models.find(
              (item) => item.id === value,
            );
            if (option && !option.reasoningEfforts.includes(effort))
              setEffort(option.reasoningEfforts[0] ?? "low");
          }}
          onRefresh={() => {
            if (inGuide) void discover();
            else void refreshModels("local");
          }}
        />
        <div className="agent-backend__ollama">
          <p className="integration-block__hint">
            {localProvider === "ollama"
              ? "Ollama runtime connection"
              : "Local OpenAI-compatible server"}
          </p>
          {localProvider === "ollama" ? (
            <>
              <label className="field">
                <span>Ollama URL</span>
                <input
                  value={ollamaUrl}
                  onChange={(event) => {
                    setOllamaUrl(event.target.value);
                    markGuideConfigurationChanged();
                  }}
                  placeholder="http://127.0.0.1:11434"
                />
              </label>
              <label className="field">
                <span>Model to verify for connection</span>
                <input
                  value={ollamaModel}
                  onChange={(event) => {
                    setOllamaModel(event.target.value);
                    markGuideConfigurationChanged();
                  }}
                  placeholder="qwen3.5:4b"
                />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>API URL</span>
                <input
                  value={customUrl}
                  onChange={(event) => {
                    setCustomUrl(event.target.value);
                    markGuideConfigurationChanged();
                  }}
                  placeholder="http://127.0.0.1:1234/v1"
                />
              </label>
              <label className="field">
                <span>Model</span>
                <input
                  value={customModel}
                  onChange={(event) => {
                    setCustomModel(event.target.value);
                    markGuideConfigurationChanged();
                  }}
                  placeholder="local-model"
                />
              </label>
            </>
          )}
          <button
            className="button button--secondary"
            type="button"
            disabled={
              busy ||
              (localProvider === "ollama"
                ? !ollamaModel.trim()
                : !customUrl.trim() || !customModel.trim())
            }
            onClick={() => void saveConnection()}
          >
            {localProvider === "ollama"
              ? "Connect Ollama"
              : "Save Custom connection"}
          </button>
        </div>
      </>
    );
  };

  const guideButton = (
    <button
      className="agent-backend__guide-button"
      type="button"
      aria-expanded={guideOpen}
      onClick={openGuide}
    >
      <span aria-hidden="true">?</span>
      <span>
        A Guide to Choosing an Agent
        <small>
          Answer three quick questions and apply the recommendation.
        </small>
      </span>
      <span aria-hidden="true">{"\u2192"}</span>
    </button>
  );

  return (
    <section className="integration-group agent-backend" aria-label="AI agent">
      {guideAtTop && guideButton}
      <div className="agent-backend__cards">
        <article
          className={`integration-block agent-backend__card ${activeLocal ? "is-active" : ""}`}
        >
          <div className="integration-block__top">
            <div className="integration-block__identity">
              <span className="agent-backend__icon" aria-hidden="true">
                ⌘
              </span>
              <div>
                <h4>Local Agent</h4>
                <span
                  className={`integration-block__status ${activeLocal ? "is-connected" : ""}`}
                >
                  {activeLocal ? "Active" : "On this device"}
                </span>
              </div>
            </div>
            <button
              className={`agent-backend__activate ${draftLocalActive ? "is-active" : ""}`}
              type="button"
              disabled={busy || !loaded}
              onClick={(event) => {
                event.stopPropagation();
                void apply({
                  side: "local",
                  local: localProvider,
                  remote: remoteProvider,
                  transport,
                  effort: selectedEffort,
                  ...(localModel ? { model: localModel } : {}),
                });
              }}
            >
              <Mark active={draftLocalActive} />
              {draftLocalActive ? "Active" : "Activate"}
            </button>
          </div>
          <p>
            Run a private model with Ollama or a local OpenAI-compatible server.
          </p>
          <label className="field agent-backend__local-provider">
            <span>Local provider</span>
            <select
              value={localProvider}
              onChange={(event) => {
                chooseSide("local");
                setLocalProvider(event.target.value as LocalProvider);
                setLocalModel("");
              }}
            >
              <option value="ollama">Ollama</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <div className="agent-backend__card-actions">
            <div className="agent-backend__card-actions-group">
              <button
                className="button button--ghost"
                type="button"
                disabled={discovering}
                onClick={(event) => {
                  event.stopPropagation();
                  void discover();
                }}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                >
                  <circle cx="8.5" cy="8.5" r="5.5" />
                  <path d="m12.5 12.5 4 4" />
                </svg>
                {discovering ? "Discovering…" : "Discover"}
              </button>
            </div>
            <div className="agent-backend__card-actions-group">
              <button
                className="button button--ghost"
                type="button"
                disabled={busy || discovering}
                onClick={(event) => {
                  event.stopPropagation();
                  void autoLocal();
                }}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m10 2 1.45 5.05L16 9l-4.55 1.95L10 16l-1.45-5.05L4 9l4.55-1.95L10 2Z" />
                  <path d="m16 12 .8 2.2L19 15l-2.2.8L16 18l-.8-2.2L13 15l2.2-.8L16 12Z" />
                </svg>
                Auto
              </button>
              <button
                className="button button--ghost agent-backend__settings-button"
                type="button"
                aria-label="Settings"
                aria-expanded={localSettingsOpen}
                onClick={(event) => {
                  event.stopPropagation();
                  chooseSide("local");
                  setLocalSettingsOpen((open) => !open);
                  setExternalSettingsOpen(false);
                }}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="10" cy="10" r="3" />
                  <path d="M10 2.5v2M10 15.5v2M2.5 10h2m11 0h2M4.7 4.7l1.4 1.4m7.8 7.8 1.4 1.4m0-10.6-1.4 1.4m-7.8 7.8-1.4 1.4" />
                </svg>
                Settings
              </button>
            </div>
          </div>
          {capabilities && (
            <ul className="agent-backend__capabilities">
              {capabilities.map((item) => (
                <li key={item.provider}>
                  <strong>
                    {item.provider === "custom" ? "Custom" : "Ollama"}
                  </strong>
                  <span className={item.ready ? "is-ready" : ""}>
                    {item.ready ? "Ready" : item.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {discoveredModels && (
            <div className="agent-backend__discovered-models">
              {localProviders.map((id) => (
                <div key={id}>
                  <strong>
                    {id === "ollama" ? "Ollama" : "Custom"} models (
                    {discoveredModels[id].length})
                  </strong>
                  {discoveredModels[id].length ? (
                    <ul>
                      {discoveredModels[id].map((item) => (
                        <li key={item.id}>{item.label}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>No models found.</p>
                  )}
                </div>
              ))}
            </div>
          )}
          {localSettingsOpen && (
            <div
              className="agent-backend__settings"
              onClick={(event) => event.stopPropagation()}
            >
              {localSettingsContent(false)}
            </div>
          )}
        </article>
        <article
          className={`integration-block agent-backend__card ${activeExternal ? "is-active" : ""}`}
        >
          <div className="integration-block__top">
            <div className="integration-block__identity">
              <span className="agent-backend__icon" aria-hidden="true">
                ↗
              </span>
              <div>
                <h4>External Agent</h4>
                <span
                  className={`integration-block__status ${activeExternal ? "is-connected" : ""}`}
                >
                  {activeExternal ? "Active" : "API or MCP"}
                </span>
              </div>
            </div>
            <button
              className={`agent-backend__activate ${draftExternalActive ? "is-active" : ""}`}
              type="button"
              disabled={busy || !loaded}
              onClick={(event) => {
                event.stopPropagation();
                void apply({
                  side: "external",
                  local: localProvider,
                  remote: remoteProvider,
                  transport,
                  effort: selectedEffort,
                  ...(transport === "api" && externalModel
                    ? { model: externalModel }
                    : {}),
                });
              }}
            >
              <Mark active={draftExternalActive} />
              {draftExternalActive ? "Active" : "Activate"}
            </button>
          </div>
          <p>
            Connect a hosted model with an API key or let your own agent host
            use StreamerAI tools.
          </p>
          {current?.mode === "local" && (
            <p className="integration-block__hint" role="status">
              {current.provider === "codex" ? "Codex" : "Claude Code"} is
              selected through its local CLI. Activate API or MCP here to change
              the connection.
            </p>
          )}
          <p className="agent-backend__transport-label">
            Connection mode{" "}
            <InfoTip label="About AI connection modes">
              <strong>API</strong> lets StreamerAI call the selected model
              provider directly with your API key. <strong>MCP</strong> connects
              your external agent to StreamerAI tools; that agent chooses and
              runs its own model.
            </InfoTip>
          </p>
          <fieldset
            className="agent-backend__transport"
            aria-label="External connection mode"
          >
            {(["api", "mcp"] as const).map((mode) => (
              <label
                className={transport === mode ? "is-selected" : ""}
                key={mode}
              >
                <input
                  checked={transport === mode}
                  name={`external-transport-${profileId}`}
                  onChange={() => {
                    chooseSide("external");
                    setTransport(mode);
                    if (mode === "mcp") setApiKeyInvalid(false);
                    setExternalSettingsOpen(false);
                  }}
                  type="radio"
                  value={mode}
                />
                <span>{mode === "api" ? "API" : "MCP"}</span>
              </label>
            ))}
          </fieldset>
          {transport === "api" ? (
            <div
              className="agent-backend__api"
              onClick={(event) => event.stopPropagation()}
            >
              <label className="field">
                <span>API provider</span>
                <select
                  value={remoteProvider}
                  onFocus={() => chooseSide("external")}
                  onChange={(event) => {
                    chooseSide("external");
                    setRemoteProvider(event.target.value as RemoteProvider);
                    setExternalModel("");
                    setApiKey("");
                    setApiKeyInvalid(false);
                  }}
                >
                  {remoteProviders.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label
                className={`field agent-backend__api-key-field ${apiKeyInvalid ? "is-invalid" : ""}`}
                ref={apiKeyFieldRef}
              >
                <span>API key</span>
                <input
                  ref={apiKeyInputRef}
                  type="password"
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    if (event.target.value.trim()) setApiKeyInvalid(false);
                  }}
                  autoComplete="off"
                  placeholder="Leave blank to keep saved key"
                />
              </label>
              <span className="integration-block__hint" role="status">
                {keyConfigured === null
                  ? "Checking saved key…"
                  : keyConfigured
                    ? "Key saved for this profile."
                    : "No key saved for this profile."}
              </span>
              {keyConfigured && (
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void removeKey()}
                >
                  Remove saved API key
                </button>
              )}
              <button
                className="button button--ghost agent-backend__settings-button"
                type="button"
                aria-label="Settings"
                aria-expanded={externalSettingsOpen}
                onClick={() => {
                  chooseSide("external");
                  setExternalSettingsOpen((open) => !open);
                  setLocalSettingsOpen(false);
                }}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="10" cy="10" r="3" />
                  <path d="M10 2.5v2M10 15.5v2M2.5 10h2m11 0h2M4.7 4.7l1.4 1.4m7.8 7.8 1.4 1.4m0-10.6-1.4 1.4m-7.8 7.8-1.4 1.4" />
                </svg>
                Settings
              </button>
              {externalSettingsOpen && (
                <div className="agent-backend__settings">
                  <ModelSettings
                    label="External"
                    model={externalModel}
                    catalog={side === "external" ? activeCatalog : null}
                    loading={side === "external" && loadingModels}
                    error={side === "external" ? modelError : ""}
                    onChange={(value) => {
                      setExternalModel(value);
                      const option = models.find((item) => item.id === value);
                      if (option && !option.reasoningEfforts.includes(effort))
                        setEffort(option.reasoningEfforts[0] ?? "low");
                    }}
                    onRefresh={() => void refreshModels("external")}
                  />
                </div>
              )}
            </div>
          ) : (
            <div
              className="agent-backend__mcp-info"
              onClick={(event) => event.stopPropagation()}
            >
              <p>
                Run the StreamerAI server, then add this stdio MCP command to
                Codex, Claude Code, Cursor or another host:
              </p>
              <code>
                node &lt;StreamerAI
                installation&gt;/apps/server/dist/mcp/stdio.js
              </code>
              <p>
                Set <code>STREAMERAI_MCP_PROFILE_ID={profileId}</code>. The
                bridge uses <code>http://127.0.0.1:4400</code>; in Docker
                Compose set{" "}
                <code>STREAMERAI_MCP_BASE_URL=http://127.0.0.1:8080</code>.
              </p>
              <p>
                Tools: search_media, inspect_media, get_subtitles,
                start_playback, stop_playback.
              </p>
            </div>
          )}
        </article>
      </div>
      <div className="agent-backend__shared">
        {!mcp && (
          <ContextSettings
            value={contextTokens}
            onChange={setContextTokens}
            maximum={chosenModel?.maxContextTokens}
            effective={current?.effectiveContextTokens}
          />
        )}
        <div className="agent-backend__effort">
          <label htmlFor="agent-effort">
            Thinking level{" "}
            <strong>
              {mcp
                ? "Set in your MCP host"
                : allowedLevels.length
                  ? effortLabels[selectedEffort]
                  : loadingModels
                    ? "Checking model…"
                    : "Model capabilities unavailable"}
            </strong>
          </label>
          <input
            id="agent-effort"
            aria-label="Thinking level"
            type="range"
            min="0"
            max={Math.max(0, allowedLevels.length - 1)}
            step="1"
            value={Math.max(0, allowedLevels.indexOf(selectedEffort))}
            disabled={mcp || allowedLevels.length <= 1}
            onChange={(event) =>
              setEffort(allowedLevels[Number(event.target.value)] ?? "low")
            }
          />
          <div className="agent-backend__range-labels">
            <span>Speed</span>
            <span>Quality</span>
          </div>
          <p>
            {mcp
              ? "The external MCP host chooses its own model and thinking level."
              : !allowedLevels.length
                ? loadingModels
                  ? "Checking the selected model's supported thinking levels."
                  : "Refresh models to check the selected model's supported thinking levels."
                : allowedLevels.length <= 1
                  ? "This model does not offer a thinking setting."
                  : "Speed uses less reasoning. Quality can take longer and cost more."}
          </p>
        </div>
        <div className="agent-backend__shared-actions">
          <button
            className={`button button--danger ${current?.mode === "disabled" ? "is-off" : ""} ${turnOffComplete ? "has-completed" : ""}`}
            type="button"
            disabled={busy || current?.mode === "disabled"}
            onClick={() => void disableAgent()}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3v9" />
              <path d="M18.36 6.64a9 9 0 1 1-12.72 0" />
            </svg>
            Turn off agent
          </button>
          <button
            className="button button--secondary"
            type="button"
            disabled={
              !loaded || busy || (Boolean(model) && !mcp && loadingModels)
            }
            onClick={() => void saveDraft()}
          >
            {busy ? "Saving…" : "Save agent preference"}
          </button>
        </div>
        {notice && (
          <p className="agent-backend__notice" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="agent-backend__error" role="alert">
            {error}
          </p>
        )}
      </div>
      {!guideAtTop && guideButton}
      {guideOpen &&
        createPortal(
          <div
            className="agent-backend__guide-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setGuideOpen(false);
            }}
          >
            <div
              className="agent-backend__guide"
              role="dialog"
              aria-modal="true"
              aria-label="Agent choice guide"
              aria-describedby="agent-guide-intro"
              ref={guideDialogRef}
              tabIndex={-1}
            >
              <header className="agent-backend__guide-header">
                <span
                  className="agent-backend__guide-header-icon"
                  aria-hidden="true"
                >
                  ✦
                </span>
                <div>
                  <p className="eyebrow">YOUR AGENT, YOUR WAY</p>
                  <h3>A Guide to Choosing an Agent</h3>
                  <p id="agent-guide-intro">
                    Three short steps. We will check what is ready and help
                    finish setup.
                  </p>
                </div>
                <button
                  className="agent-backend__guide-close"
                  type="button"
                  aria-label="Close guide"
                  onClick={() => setGuideOpen(false)}
                >
                  ×
                </button>
              </header>
              <div
                className="agent-backend__guide-progress"
                aria-label={`Step ${guideStep + 1} of 3`}
              >
                {[0, 1, 2].map((step) => (
                  <span
                    key={step}
                    className={step <= guideStep ? "is-current" : ""}
                  />
                ))}
              </div>
              <div className="agent-backend__guide-body">
                <p className="eyebrow">STEP {guideStep + 1} OF 3</p>
                {guideStep === 0 && (
                  <>
                    <h4>Where should the agent run?</h4>
                    <p>
                      Choose where your assistant lives. You can change this
                      later.
                    </p>
                    <div className="agent-backend__guide-options">
                      <button
                        className={guideSide === "local" ? "is-selected" : ""}
                        type="button"
                        aria-pressed={guideSide === "local"}
                        onClick={() => {
                          setGuideSide("local");
                          setGuideApiKey("");
                        }}
                      >
                        <span
                          className="agent-backend__guide-option-icon"
                          aria-hidden="true"
                        >
                          ⌂
                        </span>
                        <strong>On this device</strong>
                        <small>Ollama or your own local API</small>
                      </button>
                      <button
                        className={
                          guideSide === "external" ? "is-selected" : ""
                        }
                        type="button"
                        aria-pressed={guideSide === "external"}
                        onClick={() => setGuideSide("external")}
                      >
                        <span
                          className="agent-backend__guide-option-icon"
                          aria-hidden="true"
                        >
                          ↗
                        </span>
                        <strong>Outside StreamerAI</strong>
                        <small>Hosted API or your own MCP host</small>
                      </button>
                    </div>
                  </>
                )}
                {guideStep === 1 && guideSide === "local" && (
                  <>
                    <h4>Let’s find your local agent</h4>
                    <p>
                      We check Ollama, Custom, and available models
                      automatically.
                    </p>
                    <div
                      className={`agent-backend__guide-discovery is-${guideLocalState}`}
                    >
                      <GuideTarget
                        active={
                          guideLocalState === "scanning" ||
                          guideLocalState === "downloading"
                        }
                      />
                      <div>
                        <strong>
                          {guideLocalState === "scanning"
                            ? "Looking for an agent…"
                            : guideLocalState === "downloading"
                              ? "Getting your model…"
                              : guideLocalState === "ready"
                                ? "Agent confirmed"
                                : guideLocalState === "missing-model"
                                  ? "Model needed"
                                  : guideLocalState === "missing-runtime"
                                    ? "Ollama needed"
                                    : "One more step"}
                        </strong>
                        <p role="status" aria-live="polite">
                          {guideLocalMessage}
                        </p>
                        {guideLocalState === "ready" && (
                          <small>
                            {guideReadyProvider === "custom"
                              ? "Custom"
                              : "Ollama"}
                            {guideModelName ? ` · ${guideModelName}` : ""}
                            {guideReadyProvider === "ollama"
                              ? ` · ${guideLocalModels.length} model${guideLocalModels.length === 1 ? "" : "s"} found`
                              : ""}
                          </small>
                        )}
                      </div>
                    </div>
                    {guideLocalState === "missing-runtime" && (
                      <div className="agent-backend__guide-help">
                        <p>
                          Install and start Ollama, then come back and check
                          again.
                        </p>
                        <a
                          className="button button--secondary"
                          href="https://ollama.com/download"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          ↗ Download Ollama
                        </a>
                      </div>
                    )}
                    {(guideLocalState === "missing-model" ||
                      (guideLocalState === "needs-attention" &&
                        guideCanDownload)) && (
                      <div className="agent-backend__guide-help">
                        <p>
                          StreamerAI can ask Ollama to download the configured
                          model ({ollamaModel || "qwen3.5:4b"}). Downloads can
                          take several minutes and use disk space.
                        </p>
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={() => void downloadGuideModel()}
                        >
                          ↓ Download model with Ollama
                        </button>
                      </div>
                    )}
                    {guideLocalState === "needs-attention" &&
                      guideRuntimeAvailable &&
                      guideLocalModels.length > 1 && (
                        <div className="agent-backend__guide-help">
                          <label className="field">
                            <span>Try another installed model</span>
                            <select
                              value={guideModelCandidate}
                              onChange={(event) =>
                                setGuideModelCandidate(event.target.value)
                              }
                            >
                              {guideLocalModels.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            className="button button--secondary"
                            type="button"
                            onClick={() =>
                              void scanGuideLocal(guideModelCandidate)
                            }
                          >
                            Verify model
                          </button>
                        </div>
                      )}
                    {guideLocalState !== "downloading" && (
                      <div className="agent-backend__guide-local-actions">
                        <button
                          className="button button--ghost agent-backend__guide-retry"
                          type="button"
                          disabled={
                            guideLocalState === "scanning" ||
                            guideConfigurationDirty
                          }
                          onClick={() => void scanGuideLocal()}
                        >
                          <GuideTarget active={false} /> Check again
                        </button>
                        <button
                          className="button button--ghost agent-backend__guide-configuration-button"
                          type="button"
                          aria-expanded={guideConfigurationOpen}
                          aria-controls="agent-guide-local-configuration"
                          onClick={() => {
                            setGuideConfigurationOpen((open) => !open);
                            setGuideCustomOpen(false);
                            setLocalSettingsOpen(false);
                          }}
                        >
                          <svg
                            aria-hidden="true"
                            viewBox="0 0 20 20"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <circle cx="10" cy="10" r="3" />
                            <path d="M10 2.5v2M10 15.5v2M2.5 10h2m11 0h2M4.7 4.7l1.4 1.4m7.8 7.8 1.4 1.4m0-10.6-1.4 1.4m-7.8 7.8-1.4 1.4" />
                          </svg>
                          Configuration
                        </button>
                      </div>
                    )}
                    {guideConfigurationOpen && (
                      <div
                        id="agent-guide-local-configuration"
                        className="agent-backend__settings agent-backend__guide-configuration"
                      >
                        <p className="integration-block__hint">
                          Save the connection below to verify your changes.
                        </p>
                        {localSettingsContent(true)}
                      </div>
                    )}
                    {guideLocalState !== "ready" && !guideConfigurationOpen && (
                      <div className="agent-backend__guide-custom">
                        <button
                          className="button button--ghost"
                          type="button"
                          aria-expanded={guideCustomOpen}
                          onClick={() => setGuideCustomOpen((open) => !open)}
                        >
                          {guideCustomOpen ? "▾" : "▸"} Use a Custom local API
                        </button>
                        {guideCustomOpen && (
                          <div className="agent-backend__guide-custom-fields">
                            <label className="field">
                              <span>Local API URL</span>
                              <input
                                type="url"
                                disabled={guideCustomBusy}
                                value={customUrl}
                                onChange={(event) =>
                                  setCustomUrl(event.target.value)
                                }
                                placeholder="http://127.0.0.1:1234/v1"
                              />
                            </label>
                            <label className="field">
                              <span>Model name</span>
                              <input
                                disabled={guideCustomBusy}
                                value={customModel}
                                onChange={(event) =>
                                  setCustomModel(event.target.value)
                                }
                                placeholder="Your installed model"
                              />
                            </label>
                            <button
                              className="button button--secondary"
                              type="button"
                              disabled={
                                guideCustomBusy ||
                                !customUrl.trim() ||
                                !customModel.trim()
                              }
                              onClick={() => void verifyGuideCustom()}
                            >
                              {guideCustomBusy
                                ? "Checking…"
                                : "Verify Custom agent"}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
                {guideStep === 1 && guideSide === "external" && (
                  <>
                    <h4>How will it connect?</h4>
                    <p>
                      API lets StreamerAI call a model. MCP lets an external
                      agent use StreamerAI tools.
                    </p>
                    <div className="agent-backend__guide-options">
                      <button
                        className={
                          guideTransport === "api" ? "is-selected" : ""
                        }
                        type="button"
                        aria-pressed={guideTransport === "api"}
                        onClick={() => setGuideTransport("api")}
                      >
                        <span
                          className="agent-backend__guide-option-icon"
                          aria-hidden="true"
                        >
                          ⚡
                        </span>
                        <strong>API</strong>
                        <small>Connect a hosted model provider</small>
                      </button>
                      <button
                        className={
                          guideTransport === "mcp" ? "is-selected" : ""
                        }
                        type="button"
                        aria-pressed={guideTransport === "mcp"}
                        onClick={() => {
                          setGuideTransport("mcp");
                          setGuideApiKey("");
                        }}
                      >
                        <span
                          className="agent-backend__guide-option-icon"
                          aria-hidden="true"
                        >
                          ◇
                        </span>
                        <strong>MCP</strong>
                        <small>Your external host calls StreamerAI tools</small>
                      </button>
                    </div>
                    {guideTransport === "api" ? (
                      <div className="agent-backend__guide-api-fields">
                        <label className="field">
                          <span>API provider</span>
                          <select
                            value={guideApiProvider}
                            onChange={(event) => {
                              setGuideApiProvider(
                                event.target.value as RemoteProvider,
                              );
                              setGuideApiKey("");
                              setGuideKeyInvalid(false);
                            }}
                          >
                            {remoteProviders.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label
                          className={`field agent-backend__api-key-field ${guideKeyInvalid ? "is-invalid" : ""}`}
                          ref={guideApiKeyFieldRef}
                        >
                          <span>API key</span>
                          <input
                            ref={guideApiKeyRef}
                            type="password"
                            autoComplete="off"
                            value={guideApiKey}
                            aria-invalid={guideKeyInvalid}
                            onChange={(event) => {
                              setGuideApiKey(event.target.value);
                              setGuideKeyInvalid(false);
                              setGuideKeyError("");
                            }}
                            placeholder={
                              guideSavedKey
                                ? "Leave blank to use saved key"
                                : "Paste your API key"
                            }
                          />
                        </label>
                        <p
                          className={`agent-backend__guide-key-status ${guideKeyInvalid ? "is-error" : ""}`}
                          role={guideKeyInvalid ? "alert" : "status"}
                        >
                          {guideKeyError ||
                            (guideSavedKey === null
                              ? "Checking saved key…"
                              : guideSavedKey
                                ? "A key is already saved for this provider. You can keep it or replace it."
                                : "Your key is saved for this profile when you apply the recommendation.")}
                        </p>
                      </div>
                    ) : (
                      <div className="agent-backend__guide-help">
                        <p>
                          Your external host runs the agent. After applying, add
                          StreamerAI’s MCP bridge to Codex, Claude Code, Cursor,
                          or another MCP host. No API key is needed here.
                        </p>
                      </div>
                    )}
                  </>
                )}
                {guideStep === 2 && (
                  <>
                    {(guideSide === "local" || guideTransport === "api") && (
                      <ContextSettings
                        value={contextTokens}
                        onChange={setContextTokens}
                        maximum={
                          guideSide === "local" &&
                          guideReadyProvider === "ollama"
                            ? discoveredModels?.ollama.find(
                                (item) => item.id === guideModelName,
                              )?.maxContextTokens
                            : undefined
                        }
                        effective={current?.effectiveContextTokens}
                      />
                    )}
                    <h4>
                      {guideSide === "external" && guideTransport === "api"
                        ? "What matters most?"
                        : "Your setup is ready"}
                    </h4>
                    {guideSide === "external" && guideTransport === "api" ? (
                      <>
                        <p>
                          We will choose a suitable model automatically. Pick
                          how much time it may spend thinking.
                        </p>
                        <div className="agent-backend__guide-options agent-backend__guide-priorities">
                          {(["speed", "balanced", "quality"] as const).map(
                            (value) => (
                              <button
                                key={value}
                                className={
                                  guidePriority === value ? "is-selected" : ""
                                }
                                type="button"
                                aria-pressed={guidePriority === value}
                                onClick={() => setGuidePriority(value)}
                              >
                                <span
                                  className="agent-backend__guide-option-icon"
                                  aria-hidden="true"
                                >
                                  {value === "speed"
                                    ? "⚡"
                                    : value === "balanced"
                                      ? "◐"
                                      : "✦"}
                                </span>
                                <strong>
                                  {value === "speed"
                                    ? "Speed"
                                    : value === "balanced"
                                      ? "Balance"
                                      : "Quality"}
                                </strong>
                                <small>
                                  {value === "speed"
                                    ? "No reasoning, when supported"
                                    : value === "balanced"
                                      ? "Moderate thinking"
                                      : "More time to reason"}
                                </small>
                              </button>
                            ),
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="agent-backend__guide-summary">
                        <GuideTarget active={false} />
                        <div>
                          <strong>
                            {guideSide === "local"
                              ? `${guideReadyProvider === "custom" ? "Custom" : "Ollama"}${guideModelName ? ` · ${guideModelName}` : ""}`
                              : "External MCP host"}
                          </strong>
                          <p>
                            {guideSide === "local"
                              ? guideAllowedLevels.length > 1
                                ? "Choose from the thinking levels supported by this local model."
                                : "This local model does not offer a thinking setting."
                              : "Your external host chooses its model and thinking level. Connect it using the MCP instructions in External Agent."}
                          </p>
                          {guideSide === "local" &&
                            guideAllowedLevels.length > 1 && (
                              <label className="field">
                                <span>
                                  Thinking level:{" "}
                                  {effortLabels[guideSelectedEffort]}
                                </span>
                                <input
                                  aria-label="Local model thinking level"
                                  type="range"
                                  min="0"
                                  max={guideAllowedLevels.length - 1}
                                  step="1"
                                  value={guideAllowedLevels.indexOf(
                                    guideSelectedEffort,
                                  )}
                                  onChange={(event) =>
                                    setEffort(
                                      guideAllowedLevels[
                                        Number(event.target.value)
                                      ] ?? guideSelectedEffort,
                                    )
                                  }
                                />
                              </label>
                            )}
                        </div>
                      </div>
                    )}
                    {guideSide === "external" && guideTransport === "api" && (
                      <p className="agent-backend__guide-confirmation">
                        {
                          remoteProviders.find(
                            (item) => item.id === guideApiProvider,
                          )?.name
                        }{" "}
                        · {guideApiKey.trim() ? "New API key" : "Saved API key"}{" "}
                        · Automatic model
                      </p>
                    )}
                  </>
                )}
                {error && (
                  <p className="agent-backend__error" role="alert">
                    {error}
                  </p>
                )}
              </div>
              <footer className="agent-backend__guide-actions">
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => setGuideOpen(false)}
                >
                  Cancel
                </button>
                <span />
                {guideStep > 0 && (
                  <button
                    className="button button--ghost"
                    type="button"
                    onClick={() => setGuideStep((step) => step - 1)}
                  >
                    ← Back
                  </button>
                )}
                {guideStep < 2 ? (
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={
                      guideStep === 1 &&
                      ((guideSide === "local" && guideLocalState !== "ready") ||
                        (guideSide === "external" &&
                          guideTransport === "api" &&
                          guideSavedKey === null &&
                          !guideApiKey.trim()))
                    }
                    onClick={nextGuide}
                  >
                    Next →
                  </button>
                ) : (
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={busy || guideLocalState === "downloading"}
                    onClick={() => void applyGuide()}
                  >
                    {busy ? "Applying…" : "Apply recommendation"}
                  </button>
                )}
              </footer>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}
