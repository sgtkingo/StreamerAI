import { useEffect, useState } from "react";
import { resolveMediaSourceOrder } from "@streamer-ai/contracts";
import type {
  ConnectionState,
  IntegrationCatalogItem,
  StreamerApi,
} from "../api/client";
import { safeErrorMessage } from "../api/client";
import { SourceIcon } from "./SourceIcon";
import { LocalFolderSettings } from "./LocalFolderSettings";
import { AgentBackendSettings } from "./AgentBackendSettings";

type SourceCategory = IntegrationCatalogItem["category"];

const groups: {
  id: SourceCategory;
  title: string;
  emptyLabel: string;
  description: string;
}[] = [
  {
    id: "metadata",
    title: "Movie databases",
    emptyLabel: "Choose a movie database",
    description: "Title details, artwork and ratings.",
  },
  {
    id: "media",
    title: "Stream sources",
    emptyLabel: "Choose a stream source",
    description: "Places where StreamerAI can find playable video.",
  },
  {
    id: "subtitle",
    title: "Subtitle sources",
    emptyLabel: "Choose a subtitle source",
    description: "External subtitles for the selected video.",
  },
  {
    id: "inference",
    title: "Local agents",
    emptyLabel: "Choose a local AI service",
    description: "",
  },
  {
    id: "enrichment",
    title: "Enrichment sources",
    emptyLabel: "Choose an enrichment source",
    description: "Additional context for matching titles.",
  },
  {
    id: "search",
    title: "Search sources",
    emptyLabel: "Choose a search source",
    description: "Additional ways to discover titles.",
  },
  {
    id: "sync",
    title: "Sync services",
    emptyLabel: "Choose a sync service",
    description: "Keep your data in step across devices.",
  },
];

const coreIntegration = (
  id: "tmdb" | "webshare",
  configured: boolean,
): IntegrationCatalogItem => ({
  id,
  name: id === "tmdb" ? "TMDB" : "Webshare",
  description:
    id === "tmdb"
      ? "Movie and series details, artwork and ratings."
      : "Find and play media from your Webshare account.",
  category: id === "tmdb" ? "metadata" : "media",
  planned: false,
  selected: false,
  configured,
  setup: { documentationUrl: null, supportsDisconnect: true },
});

function connectionError(id: string, code: string): string {
  if (id === "tmdb") {
    const messages: Record<string, string> = {
      CREDENTIAL_REQUIRED: "Paste your TMDB Read Access Token first.",
      CREDENTIAL_REJECTED:
        "TMDB did not accept this token. Copy the Read Access Token and try again.",
      RATE_LIMITED: "TMDB is receiving too many requests. Try again shortly.",
      TIMEOUT: "TMDB did not respond in time. Your token was not saved.",
      INVALID_RESPONSE: "TMDB returned an unexpected response.",
      PROVIDER_UNAVAILABLE: "TMDB is unavailable right now.",
      SECURE_STORAGE_UNAVAILABLE:
        "The token was verified but the home server could not store it securely.",
    };
    return (
      messages[code] ?? "TMDB could not be connected. Your token was not saved."
    );
  }
  const name = id === "hellspy" ? "Hellspy" : "Webshare";
  return code === "CREDENTIAL_REJECTED"
    ? `${name} did not accept these credentials. Check them and try again.`
    : code === "TIMEOUT"
      ? `${name} did not respond in time. Nothing was saved.`
      : code === "RATE_LIMITED"
        ? `${name} is receiving too many requests. Try again shortly.`
        : `${name} could not be connected. Nothing was saved.`;
}

interface IntegrationManagerProps {
  api: StreamerApi;
  context: "onboarding" | "settings";
  profileId?: string;
  category?: "services" | "agents";
  showAgentSelector?: boolean;
  initialTmdbState?: ConnectionState;
  initialWebshareState?: ConnectionState;
  onConnectionChange?: (id: string, connected: boolean) => void;
  agentModel?: string;
  agentBaseUrl?: string;
  onAgentConfigured?: (agent: { model: string; baseUrl: string }) => void;
  onCheckAgent?: () => void;
  checkingAgent?: boolean;
  agentCheck?: string;
  discoveryRevision?: number;
  discoveredAgentIds?: string[] | null;
}

function TargetIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function AgentConnectionForm({
  baseUrl,
  model,
  onBaseUrlChange,
  onModelChange,
  onSubmit,
  busy,
  error,
  submitLabel,
}: {
  baseUrl: string;
  model: string;
  onBaseUrlChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string;
  submitLabel: string;
}) {
  return (
    <form
      className="integration-agent-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <p>Connect to an Ollama API on this device or your private network.</p>
      <label className="field">
        <span>Local API address</span>
        <input
          type="text"
          value={baseUrl}
          onChange={(event) => onBaseUrlChange(event.target.value)}
          placeholder="http://192.168.1.10:11434"
          autoComplete="url"
          required
        />
      </label>
      <label className="field">
        <span>Model name</span>
        <input
          type="text"
          value={model}
          onChange={(event) => onModelChange(event.target.value)}
          placeholder="qwen3.5:4b"
          spellCheck={false}
          required
        />
      </label>
      <p className="integration-block__hint">
        Verification checks the model and its capabilities. Choose Ollama above
        to make it the active agent.
      </p>
      {error && (
        <p className="integration-agent-form__error" role="alert">
          {error}
        </p>
      )}
      <button
        className="button button--secondary"
        type="submit"
        disabled={busy}
      >
        <TargetIcon />
        {busy ? "Verifying…" : submitLabel}
      </button>
    </form>
  );
}

function ActionIcon({
  kind,
}: {
  kind: "connect" | "settings" | "disconnect" | "remove";
}) {
  return kind === "connect" ? (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5" />
    </svg>
  ) : kind === "settings" ? (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="m19.4 15 .5 1.5-2 2-1.5-.5-1.4.8-.3 1.7h-2.8l-.3-1.7-1.4-.8-1.5.5-2-2 .5-1.5-.8-1.4-1.7-.3v-2.8l1.7-.3.8-1.4-.5-1.5 2-2 1.5.5 1.4-.8.3-1.7h2.8l.3 1.7 1.4.8 1.5-.5 2 2-.5 1.5.8 1.4 1.7.3v2.8l-1.7.3-.8 1.4Z" />
    </svg>
  ) : kind === "disconnect" ? (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 7v4M15 7v4M7 11h10v2a5 5 0 0 1-10 0v-2ZM12 18v3M4 4l16 16" />
    </svg>
  ) : (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 7h16M10 11v6M14 11v6M5 7l1 14h12l1-14M9 7V4h6v3" />
    </svg>
  );
}

/** The same source catalogue and connection controls serve setup and Settings. */
export function IntegrationManager({
  api,
  context,
  profileId = "default",
  category = "services",
  showAgentSelector = true,
  initialTmdbState,
  initialWebshareState,
  onConnectionChange,
  agentModel,
  agentBaseUrl,
  onAgentConfigured,
  onCheckAgent,
  checkingAgent = false,
  agentCheck,
  discoveryRevision = 0,
  discoveredAgentIds = null,
}: IntegrationManagerProps) {
  const [items, setItems] = useState<IntegrationCatalogItem[]>([
    coreIntegration("tmdb", initialTmdbState === "connected"),
    coreIntegration("webshare", initialWebshareState === "connected"),
  ]);
  const [addedIds, setAddedIds] = useState<string[]>([]);
  const [sourceOrder, setSourceOrder] = useState<string[]>([]);
  const [orderReady, setOrderReady] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);
  const [orderMessage, setOrderMessage] = useState("");
  const [orderError, setOrderError] = useState(false);
  const [draggedSource, setDraggedSource] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [picker, setPicker] = useState<SourceCategory | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    id: string;
    text: string;
    error: boolean;
  } | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [memoryOnly, setMemoryOnly] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [agentFormBaseUrl, setAgentFormBaseUrl] = useState("");
  const [agentFormModel, setAgentFormModel] = useState("");
  const [agentFormError, setAgentFormError] = useState("");

  useEffect(() => {
    let active = true;
    setOrderReady(false);
    setOrderMessage("");
    if (!api.getMediaSourcePreferences) {
      setOrderReady(true);
      return;
    }
    void api
      .getMediaSourcePreferences(profileId)
      .then((result) => {
        if (active) {
          setSourceOrder(result.providerOrder);
          setOrderReady(true);
        }
      })
      .catch(() => {
        if (active) {
          setOrderMessage(
            "Could not load source priority. Reopen Settings to try again.",
          );
          setOrderError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [api, profileId]);

  useEffect(() => {
    let active = true;
    api
      .getIntegrations(profileId)
      .then((response) => {
        if (!active) return;
        setItems((current) => {
          const byId = new Map(current.map((item) => [item.id, item]));
          for (const item of response.items) byId.set(item.id, item);
          return [...byId.values()];
        });
        setCatalogError("");
        if (discoveryRevision > 0) setPicker("inference");
      })
      .catch((error: unknown) => {
        if (active) setCatalogError(safeErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [api, discoveryRevision, profileId]);

  const visible = (item: IntegrationCatalogItem) =>
    item.configured || item.selected || addedIds.includes(item.id);
  const visibleIds = new Set(items.filter(visible).map((item) => item.id));
  const orderedIds = resolveMediaSourceOrder(
    sourceOrder,
    items
      .filter((item) => item.category === "media" && !item.planned)
      .map((item) => item.id),
  );
  const sourceRank = (id: string) => {
    const index = orderedIds.indexOf(id);
    return index < 0 ? orderedIds.length : index;
  };
  const moveSource = async (id: string, target: string) => {
    if (
      id === target ||
      savingOrder ||
      !orderReady ||
      !api.saveMediaSourcePreferences
    )
      return;
    const previous = [...orderedIds];
    const next = previous.filter((entry) => entry !== id);
    const targetIndex = previous.indexOf(target);
    if (!previous.includes(id) || targetIndex < 0) return;
    next.splice(targetIndex, 0, id);
    setSourceOrder(next);
    setSavingOrder(true);
    setOrderError(false);
    setOrderMessage("Saving source priority…");
    try {
      const result = await api.saveMediaSourcePreferences(next, profileId);
      setSourceOrder(result.providerOrder);
      setOrderMessage("Source priority saved.");
      onConnectionChange?.("source-priority", true);
    } catch {
      setSourceOrder(previous);
      setOrderError(true);
      setOrderMessage(
        "Could not save source priority. Your previous order is still active.",
      );
    } finally {
      setSavingOrder(false);
    }
  };
  const pickerItems = items.filter(
    (item) =>
      !visibleIds.has(item.id) &&
      item.category === picker &&
      (picker !== "inference" ||
        discoveredAgentIds === null ||
        discoveredAgentIds.includes(item.id)),
  );

  const openSetup = (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
    setConfirmId(null);
    setMessage(null);
    setToken("");
    setUsername("");
    setPassword("");
    setShowToken(false);
    setShowPassword(false);
  };

  const openAgentSettings = () => {
    const opening = expandedId !== "ollama";
    setExpandedId(opening ? "ollama" : null);
    setPicker(null);
    setManualOpen(false);
    setAgentFormBaseUrl(agentBaseUrl ?? "");
    setAgentFormModel(agentModel ?? "");
    setAgentFormError("");
  };

  const configureAgent = async () => {
    setWorkingId("ollama");
    setAgentFormError("");
    try {
      const result = await api.connectLocalAgent({
        baseUrl: agentFormBaseUrl,
        model: agentFormModel,
        profileId,
      });
      if (!result.ok) {
        setAgentFormError(
          result.message || "The local agent could not be verified.",
        );
        return;
      }
      const model = result.model || agentFormModel.trim();
      const baseUrl = result.baseUrl || agentFormBaseUrl.trim();
      setItems((current) =>
        current.map((item) =>
          item.id === "ollama"
            ? { ...item, configured: true, status: "connected" }
            : item,
        ),
      );
      onAgentConfigured?.({ model, baseUrl });
      onConnectionChange?.("ollama", true);
      setExpandedId(null);
      setManualOpen(false);
      setPicker(null);
      setMessage({
        id: "ollama",
        text: "Local agent verified and connected.",
        error: false,
      });
    } catch (reason) {
      setAgentFormError(safeErrorMessage(reason));
    } finally {
      setWorkingId(null);
    }
  };

  const choose = async (item: IntegrationCatalogItem) => {
    setCatalogError("");
    if (item.planned) {
      setWorkingId(item.id);
      try {
        const updated = await api.setIntegrationSelected(
          item.id,
          true,
          profileId,
        );
        setItems((current) =>
          current.map((entry) =>
            entry.id === item.id
              ? { ...entry, ...updated, selected: true }
              : entry,
          ),
        );
        setPicker(null);
      } catch (error) {
        setCatalogError(safeErrorMessage(error));
      } finally {
        setWorkingId(null);
      }
      return;
    }
    setAddedIds((current) => [...new Set([...current, item.id])]);
    setPicker(null);
    openSetup(item.id);
  };

  const connect = async (id: "tmdb" | "webshare" | "hellspy") => {
    const cleanToken = token.trim().replace(/^Bearer\s+/i, "");
    if (id === "tmdb" && !cleanToken) {
      setMessage({
        id,
        text: "Paste your TMDB Read Access Token first.",
        error: true,
      });
      return;
    }
    if (id !== "tmdb" && (!username.trim() || !password)) {
      setMessage({
        id,
        text:
          id === "hellspy"
            ? "Enter your Hellspy email and password first."
            : "Enter your Webshare username and password first.",
        error: true,
      });
      return;
    }
    setWorkingId(id);
    setMessage(null);
    try {
      const result =
        id === "tmdb"
          ? await api.connectTmdb(cleanToken, profileId)
          : id === "hellspy"
            ? await api.connectHellspy(username.trim(), password, profileId)
            : await api.connectWebshare(username.trim(), password, profileId);
      setPassword("");
      setShowPassword(false);
      if (!result.ok) {
        setMessage({
          id,
          text: connectionError(id, result.messageCode),
          error: true,
        });
        return;
      }
      setToken("");
      setShowToken(false);
      setMemoryOnly(result.persistence === "memory");
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? { ...item, configured: true, status: "connected" }
            : item,
        ),
      );
      setExpandedId(null);
      setMessage({
        id,
        text:
          result.persistence === "memory"
            ? "Connection verified for this development session."
            : id !== "tmdb"
              ? "Connected. The session token is stored in the encrypted local vault."
              : "Connection verified. Your token is stored securely by the home server.",
        error: false,
      });
      onConnectionChange?.(id, true);
    } catch (error) {
      setPassword("");
      setShowPassword(false);
      setMessage({ id, text: safeErrorMessage(error), error: true });
    } finally {
      setWorkingId(null);
    }
  };

  const remove = async (item: IntegrationCatalogItem) => {
    setWorkingId(item.id);
    setMessage(null);
    try {
      if (item.planned) {
        await api.setIntegrationSelected(item.id, false, profileId);
      } else if (item.configured) {
        await api.disconnectIntegration(item.id, profileId);
        onConnectionChange?.(item.id, false);
      }
      setItems((current) =>
        current.map((entry) =>
          entry.id === item.id
            ? {
                ...entry,
                configured: false,
                selected: false,
                status: "not_configured",
              }
            : entry,
        ),
      );
      setAddedIds((current) => current.filter((id) => id !== item.id));
      setExpandedId(null);
      setConfirmId(null);
    } catch (error) {
      setMessage({ id: item.id, text: safeErrorMessage(error), error: true });
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <div className={"integration-manager integration-manager--" + context}>
      {category === "agents" && showAgentSelector && (
        <AgentBackendSettings
          api={api}
          profileId={profileId}
          onChanged={(available) => onConnectionChange?.("agent", available)}
        />
      )}
      {groups
        .filter((group) =>
          category === "agents"
            ? group.id === "inference"
            : group.id !== "inference",
        )
        .map((group) => {
          const groupItems = items
            .filter((item) => item.category === group.id && visible(item))
            .sort((a, b) =>
              group.id === "media" ? sourceRank(a.id) - sourceRank(b.id) : 0,
            );
          if (
            groupItems.length === 0 &&
            !["metadata", "media", "subtitle"].includes(group.id) &&
            !items.some((item) => item.category === group.id)
          ) {
            return null;
          }
          return (
            <section
              className="integration-group"
              key={group.id}
              aria-label={group.title}
            >
              {category !== "agents" && (
                <div className="integration-group__heading">
                  <h3>{group.title}</h3>
                  <p>
                    {group.id === "media" && context === "settings"
                      ? "Drag sources to set your preference. Higher sources lead Recommended; all connected sources search in parallel. Local storage comes first by default."
                      : group.description}
                  </p>
                  {group.id === "media" && orderMessage && (
                    <p
                      className={
                        orderError
                          ? "source-priority-message is-error"
                          : "source-priority-message"
                      }
                      role={orderError ? "alert" : "status"}
                    >
                      {orderMessage}
                    </p>
                  )}
                </div>
              )}
              <div className="integration-group__cards">
                {groupItems.length === 0 && (
                  <button
                    className="integration-empty"
                    type="button"
                    onClick={() => setPicker(group.id)}
                  >
                    <span aria-hidden="true">+</span>
                    <strong>{group.emptyLabel}</strong>
                    <small>View available services</small>
                  </button>
                )}
                {groupItems.map((item, itemIndex) => {
                  const supported =
                    item.id === "tmdb" ||
                    item.id === "webshare" ||
                    item.id === "hellspy" ||
                    item.id === "local-files";
                  const busy = workingId === item.id;
                  return (
                    <article
                      className={`integration-block${dropTarget === item.id ? " integration-block--drop-target" : ""}${draggedSource === item.id ? " integration-block--dragging" : ""}`}
                      key={item.id}
                      data-source-id={item.id}
                      onDragOver={(event) => {
                        if (
                          draggedSource &&
                          item.category === "media" &&
                          !item.planned
                        ) {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          setDropTarget(item.id);
                        }
                      }}
                      onDrop={(event) => {
                        if (!draggedSource) return;
                        event.preventDefault();
                        const source = draggedSource;
                        setDraggedSource(null);
                        setDropTarget(null);
                        void moveSource(source, item.id);
                      }}
                    >
                      <div className="integration-block__top">
                        <div className="integration-block__identity">
                          {group.id === "media" &&
                            !item.planned &&
                            context === "settings" && (
                              <div className="source-priority-controls">
                                <button
                                  type="button"
                                  className="source-priority-grip"
                                  aria-label={`Drag ${item.name} to reorder`}
                                  title="Drag to reorder, or use the arrow keys"
                                  disabled={!orderReady || savingOrder}
                                  draggable={orderReady && !savingOrder}
                                  onDragStart={(event) => {
                                    setDraggedSource(item.id);
                                    event.dataTransfer.effectAllowed = "move";
                                    event.dataTransfer.setData(
                                      "text/plain",
                                      item.id,
                                    );
                                  }}
                                  onDragEnd={() => {
                                    setDraggedSource(null);
                                    setDropTarget(null);
                                  }}
                                  onKeyDown={(event) => {
                                    if (
                                      event.key !== "ArrowUp" &&
                                      event.key !== "ArrowDown"
                                    )
                                      return;
                                    event.preventDefault();
                                    const target =
                                      groupItems[
                                        itemIndex +
                                          (event.key === "ArrowUp" ? -1 : 1)
                                      ];
                                    if (target && !target.planned)
                                      void moveSource(item.id, target.id);
                                  }}
                                >
                                  <svg
                                    viewBox="0 0 16 24"
                                    aria-hidden="true"
                                    fill="currentColor"
                                  >
                                    {[6, 12, 18].flatMap((y) =>
                                      [5, 11].map((x) => (
                                        <circle
                                          key={`${x}:${y}`}
                                          cx={x}
                                          cy={y}
                                          r="1.5"
                                        />
                                      )),
                                    )}
                                  </svg>
                                </button>
                                <span
                                  className="source-priority-number"
                                  aria-label={`Priority ${itemIndex + 1}`}
                                >
                                  {itemIndex + 1}
                                </span>
                                <div className="source-priority-arrows">
                                  <button
                                    type="button"
                                    aria-label={`Move ${item.name} up`}
                                    disabled={
                                      !orderReady ||
                                      savingOrder ||
                                      itemIndex === 0
                                    }
                                    onClick={() =>
                                      void moveSource(
                                        item.id,
                                        groupItems[itemIndex - 1]!.id,
                                      )
                                    }
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Move ${item.name} down`}
                                    disabled={
                                      !orderReady ||
                                      savingOrder ||
                                      !groupItems[itemIndex + 1] ||
                                      groupItems[itemIndex + 1]!.planned
                                    }
                                    onClick={() =>
                                      void moveSource(
                                        item.id,
                                        groupItems[itemIndex + 1]!.id,
                                      )
                                    }
                                  >
                                    ↓
                                  </button>
                                </div>
                              </div>
                            )}
                          <SourceIcon providerId={item.id} />
                          <div>
                            <h4>
                              {item.id === "ollama"
                                ? agentModel || "Loading model…"
                                : item.name}
                            </h4>
                            <span
                              className={
                                "integration-block__status " +
                                (item.configured
                                  ? "is-connected"
                                  : item.planned
                                    ? "is-planned"
                                    : "")
                              }
                            >
                              {item.configured
                                ? "Connected"
                                : item.planned
                                  ? "Planned"
                                  : "Ready to connect"}
                            </span>
                          </div>
                        </div>
                        <div className="integration-block__actions">
                          {item.id === "ollama" && (
                            <button
                              type="button"
                              className="integration-block__settings"
                              aria-label="Agent settings"
                              aria-expanded={expandedId === "ollama"}
                              onClick={openAgentSettings}
                              disabled={busy}
                            >
                              <ActionIcon kind="settings" />
                            </button>
                          )}
                          {item.id === "ollama" && onCheckAgent && (
                            <button
                              type="button"
                              onClick={onCheckAgent}
                              disabled={checkingAgent}
                            >
                              <TargetIcon />
                              {checkingAgent ? "Checking…" : "Check agent"}
                            </button>
                          )}
                          {!item.planned && supported && (
                            <button
                              type="button"
                              onClick={() => openSetup(item.id)}
                              disabled={busy}
                            >
                              <ActionIcon
                                kind={item.configured ? "settings" : "connect"}
                              />
                              {item.configured ? "Settings" : "Connect"}
                            </button>
                          )}
                          {(!item.configured || supported) && (
                            <button
                              type="button"
                              className="integration-block__remove"
                              onClick={() =>
                                item.configured
                                  ? setConfirmId(item.id)
                                  : void remove(item)
                              }
                              disabled={busy}
                            >
                              <ActionIcon
                                kind={item.configured ? "disconnect" : "remove"}
                              />
                              {item.configured ? "Disconnect" : "Remove"}
                            </button>
                          )}
                        </div>
                      </div>
                      <p>{item.description}</p>
                      {item.id === "ollama" && agentCheck && (
                        <p className="integration-block__hint" role="status">
                          {agentCheck}
                        </p>
                      )}
                      {item.planned && (
                        <p className="integration-block__hint">
                          Saved for later. This adapter cannot connect yet.
                        </p>
                      )}
                      {!item.planned && !supported && item.id !== "ollama" && (
                        <p className="integration-block__hint">
                          {item.configured
                            ? "This connection is managed in its own setup flow."
                            : "This connector needs its own setup flow before it can be configured here."}
                        </p>
                      )}
                      {item.setup.documentationUrl && (
                        <a
                          href={item.setup.documentationUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Provider information <span aria-hidden="true">↗</span>
                        </a>
                      )}
                      {confirmId === item.id && (
                        <div className="integration-block__confirm">
                          <p>
                            Disconnect {item.name}? It will stop supplying new
                            results.
                          </p>
                          <button
                            type="button"
                            onClick={() => setConfirmId(null)}
                            disabled={busy}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => void remove(item)}
                            disabled={busy}
                          >
                            {busy ? "Disconnecting…" : "Disconnect now"}
                          </button>
                        </div>
                      )}
                      {expandedId === item.id && item.id === "local-files" && (
                        <div className="integration-block__form">
                          <LocalFolderSettings
                            api={api}
                            onConfigured={(configured) => {
                              setItems((current) =>
                                current.map((entry) =>
                                  entry.id === item.id
                                    ? {
                                        ...entry,
                                        configured,
                                        status: configured
                                          ? "connected"
                                          : "not_configured",
                                      }
                                    : entry,
                                ),
                              );
                              onConnectionChange?.(item.id, configured);
                            }}
                          />
                        </div>
                      )}
                      {expandedId === "ollama" && item.id === "ollama" && (
                        <div className="integration-block__form">
                          <AgentConnectionForm
                            baseUrl={agentFormBaseUrl}
                            model={agentFormModel}
                            onBaseUrlChange={setAgentFormBaseUrl}
                            onModelChange={setAgentFormModel}
                            onSubmit={() => void configureAgent()}
                            busy={busy}
                            error={agentFormError}
                            submitLabel="Verify and save"
                          />
                        </div>
                      )}
                      {expandedId === item.id &&
                        supported &&
                        item.id !== "local-files" && (
                          <div className="integration-block__form">
                            {item.id === "tmdb" ? (
                              <>
                                <label className="field token-field">
                                  <span>TMDB Read Access Token</span>
                                  <span className="input-with-action">
                                    <input
                                      type={showToken ? "text" : "password"}
                                      autoComplete="off"
                                      spellCheck={false}
                                      value={token}
                                      onChange={(event) =>
                                        setToken(event.target.value)
                                      }
                                      placeholder="Paste token"
                                    />
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setShowToken((value) => !value)
                                      }
                                    >
                                      {showToken ? "Hide" : "Show"}
                                    </button>
                                  </span>
                                </label>
                                <p className="integration-block__hint">
                                  Get the API Read Access Token from your TMDB
                                  account settings.
                                </p>
                                <button
                                  className="button button--secondary"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void connect("tmdb")}
                                >
                                  <ActionIcon kind="connect" />
                                  {busy ? "Verifying…" : "Verify and connect"}
                                </button>
                              </>
                            ) : (
                              <>
                                <p className="integration-block__hint">
                                  Your password is used only to obtain a session
                                  token.
                                </p>
                                <label className="field">
                                  <span>
                                    {item.id === "hellspy"
                                      ? "Email"
                                      : "Username or email"}
                                  </span>
                                  <input
                                    type={
                                      item.id === "hellspy" ? "email" : "text"
                                    }
                                    autoComplete="username"
                                    value={username}
                                    onChange={(event) =>
                                      setUsername(event.target.value)
                                    }
                                  />
                                </label>
                                <label className="field">
                                  <span>Password</span>
                                  <span className="input-with-action">
                                    <input
                                      type={showPassword ? "text" : "password"}
                                      autoComplete="current-password"
                                      value={password}
                                      onChange={(event) =>
                                        setPassword(event.target.value)
                                      }
                                    />
                                    <button
                                      type="button"
                                      aria-label={
                                        showPassword
                                          ? `Hide ${item.name} password`
                                          : `Show ${item.name} password`
                                      }
                                      onClick={() =>
                                        setShowPassword((value) => !value)
                                      }
                                    >
                                      {showPassword ? "Hide" : "Show"}
                                    </button>
                                  </span>
                                </label>
                                <button
                                  className="button button--secondary"
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    void connect(
                                      item.id === "hellspy"
                                        ? "hellspy"
                                        : "webshare",
                                    )
                                  }
                                >
                                  <ActionIcon kind="connect" />
                                  {busy
                                    ? "Connecting…"
                                    : `Connect ${item.name}`}
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      {message?.id === item.id && (
                        <p
                          className={
                            "integration-block__message " +
                            (message.error ? "is-error" : "is-success")
                          }
                          role={message.error ? "alert" : "status"}
                        >
                          {message.text}
                        </p>
                      )}
                      {message?.id === item.id &&
                        !message.error &&
                        memoryOnly && (
                          <p className="integration-block__hint" role="status">
                            Development mode: this credential is held in memory
                            only.
                          </p>
                        )}
                    </article>
                  );
                })}
              </div>
              <button
                className="integration-add-more"
                type="button"
                aria-expanded={picker === group.id}
                aria-controls={"integration-picker-" + group.id}
                onClick={() =>
                  setPicker((current) =>
                    current === group.id ? null : group.id,
                  )
                }
              >
                + Add more
              </button>
              {picker === group.id && (
                <section
                  className="integration-picker"
                  id={"integration-picker-" + group.id}
                  aria-label={group.title + " available integrations"}
                >
                  <div className="integration-picker__heading">
                    <h3>Available {group.title.toLowerCase()}</h3>
                    <button type="button" onClick={() => setPicker(null)}>
                      Close
                    </button>
                  </div>
                  {pickerItems.length === 0 ? (
                    <p
                      className={
                        category === "agents"
                          ? "integration-picker__empty"
                          : undefined
                      }
                    >
                      {category === "agents"
                        ? "Sorry, no more agents found."
                        : "All listed services in this group are already added."}
                    </p>
                  ) : (
                    <div className="integration-picker__options">
                      {pickerItems.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          onClick={() => void choose(item)}
                          disabled={workingId !== null}
                        >
                          <SourceIcon providerId={item.id} />
                          <span>
                            <strong>{item.name}</strong>
                            <small>
                              {item.planned ? "Planned · " : ""}
                              {item.description}
                            </small>
                          </span>
                          <span aria-hidden="true">+</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {category === "agents" && (
                    <>
                      <button
                        className="integration-picker__manual-link"
                        type="button"
                        aria-expanded={manualOpen}
                        onClick={() => {
                          setManualOpen((current) => !current);
                          setExpandedId(null);
                          setAgentFormBaseUrl("");
                          setAgentFormModel("");
                          setAgentFormError("");
                        }}
                      >
                        You can try to add your local agent manually
                      </button>
                      {manualOpen && (
                        <AgentConnectionForm
                          baseUrl={agentFormBaseUrl}
                          model={agentFormModel}
                          onBaseUrlChange={setAgentFormBaseUrl}
                          onModelChange={setAgentFormModel}
                          onSubmit={() => void configureAgent()}
                          busy={workingId === "ollama"}
                          error={agentFormError}
                          submitLabel="Verify and add agent"
                        />
                      )}
                    </>
                  )}
                </section>
              )}
            </section>
          );
        })}
      {catalogError && (
        <p className="integration-manager__error" role="alert">
          {catalogError}
        </p>
      )}
    </div>
  );
}
