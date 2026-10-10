import { useEffect, useState } from "react";
import type {
  ConnectionState,
  IntegrationCatalogItem,
  StreamerApi,
} from "../api/client";
import { safeErrorMessage } from "../api/client";
import { SourceIcon } from "./SourceIcon";

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
    title: "Local AI",
    emptyLabel: "Choose a local AI service",
    description: "On-device recommendations and interpretation.",
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
  return code === "CREDENTIAL_REJECTED"
    ? "Webshare did not accept these credentials. Check them and try again."
    : code === "TIMEOUT"
      ? "Webshare did not respond in time. Nothing was saved."
      : "Webshare could not be connected. Nothing was saved.";
}

interface IntegrationManagerProps {
  api: StreamerApi;
  context: "onboarding" | "settings";
  initialTmdbState?: ConnectionState;
  initialWebshareState?: ConnectionState;
  onConnectionChange?: (id: string, connected: boolean) => void;
}

function ActionIcon({
  kind,
}: {
  kind: "settings" | "disconnect" | "remove";
}) {
  return kind === "settings" ? (
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
  initialTmdbState,
  initialWebshareState,
  onConnectionChange,
}: IntegrationManagerProps) {
  const [items, setItems] = useState<IntegrationCatalogItem[]>([
    coreIntegration("tmdb", initialTmdbState === "connected"),
    coreIntegration("webshare", initialWebshareState === "connected"),
  ]);
  const [addedIds, setAddedIds] = useState<string[]>([]);
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

  useEffect(() => {
    let active = true;
    api
      .getIntegrations()
      .then((response) => {
        if (!active) return;
        setItems((current) => {
          const byId = new Map(current.map((item) => [item.id, item]));
          for (const item of response.items) byId.set(item.id, item);
          return [...byId.values()];
        });
        setCatalogError("");
      })
      .catch((error: unknown) => {
        if (active) setCatalogError(safeErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [api]);

  const visible = (item: IntegrationCatalogItem) =>
    item.configured || item.selected || addedIds.includes(item.id);
  const visibleIds = new Set(items.filter(visible).map((item) => item.id));
  const pickerItems = items.filter(
    (item) => !visibleIds.has(item.id) && item.category === picker,
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

  const choose = async (item: IntegrationCatalogItem) => {
    setCatalogError("");
    if (item.planned) {
      setWorkingId(item.id);
      try {
        const updated = await api.setIntegrationSelected(item.id, true);
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

  const connect = async (id: "tmdb" | "webshare") => {
    const cleanToken = token.trim().replace(/^Bearer\s+/i, "");
    if (id === "tmdb" && !cleanToken) {
      setMessage({
        id,
        text: "Paste your TMDB Read Access Token first.",
        error: true,
      });
      return;
    }
    if (id === "webshare" && (!username.trim() || !password)) {
      setMessage({
        id,
        text: "Enter your Webshare username and password first.",
        error: true,
      });
      return;
    }
    setWorkingId(id);
    setMessage(null);
    try {
      const result =
        id === "tmdb"
          ? await api.connectTmdb(cleanToken)
          : await api.connectWebshare(username.trim(), password);
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
            : id === "webshare"
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
        await api.setIntegrationSelected(item.id, false);
      } else if (item.configured) {
        await api.disconnectIntegration(item.id);
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
      {groups.map((group) => {
        const groupItems = items.filter(
          (item) => item.category === group.id && visible(item),
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
            <div className="integration-group__heading">
              <h3>{group.title}</h3>
              <p>{group.description}</p>
            </div>
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
              {groupItems.map((item) => {
                const supported = item.id === "tmdb" || item.id === "webshare";
                const busy = workingId === item.id;
                return (
                  <article className="integration-block" key={item.id}>
                    <div className="integration-block__top">
                      <div className="integration-block__identity">
                        <SourceIcon providerId={item.id} />
                        <div>
                          <h4>{item.name}</h4>
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
                        {!item.planned && supported && (
                          <button
                            type="button"
                            onClick={() => openSetup(item.id)}
                            disabled={busy}
                          >
                            {item.configured && <ActionIcon kind="settings" />}
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
                    {item.planned && (
                      <p className="integration-block__hint">
                        Saved for later. This adapter cannot connect yet.
                      </p>
                    )}
                    {!item.planned && !supported && (
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
                    {expandedId === item.id && supported && (
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
                              <span>Username or email</span>
                              <input
                                type="text"
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
                                      ? "Hide Webshare password"
                                      : "Show Webshare password"
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
                              onClick={() => void connect("webshare")}
                            >
                              {busy ? "Connecting…" : "Connect Webshare"}
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
                setPicker((current) => (current === group.id ? null : group.id))
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
                  <p>All listed services in this group are already added.</p>
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
