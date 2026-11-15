import { useCallback, useEffect, useRef, useState } from "react";
import type {
  McpConnectorLaunch,
  McpConnectorStatus,
  McpHostId,
  McpHostStatus,
  McpHostsOverview,
  McpManualSetup,
  StreamerApi,
} from "../api/client";
import { safeErrorMessage } from "../api/client";

export type McpHostsController = ReturnType<typeof useMcpHosts>;

/** Opens the streamerai-agent: link registered by Windows setup. Replaceable in tests. */
export const mcpConnectorLauncher = {
  open(url: string) {
    window.location.assign(url);
  },
};
const CONNECTOR_POLL_MS = 1500;
/** After this, the link probably did not open the connector: offer the command. */
export const CONNECTOR_FALLBACK_MS = 12_000;
const RESTART_POLL_MS = 5000;

/** The server runs as a service: agents are connected by the user-side connector. */
export function usesMcpConnector(overview: McpHostsOverview | null) {
  return !!overview?.serviceAccount;
}
export function canStartMcpConnector(overview: McpHostsOverview | null) {
  return (
    !!overview?.canManage &&
    overview.serviceAccount &&
    overview.bridge.available &&
    !!overview.connector?.available
  );
}
/** A connected host that has not loaded the bridge since it was connected. */
export function awaitsRestart(host: McpHostStatus) {
  return (
    host.state === "installed" && !!host.connection && !host.connection.seenAt
  );
}

/** Detects MCP-capable agent hosts on the server computer and connects them. */
export function useMcpHosts(
  api: StreamerApi,
  profileId: string,
  enabled: boolean,
) {
  const [overview, setOverview] = useState<McpHostsOverview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [working, setWorking] = useState<McpHostId | "all" | null>(null);
  const [error, setError] = useState("");
  const [failures, setFailures] = useState<Partial<Record<McpHostId, string>>>(
    {},
  );
  const [connector, setConnector] = useState<{
    launch: McpConnectorLaunch;
    status: McpConnectorStatus | null;
    startedAt: number;
    /** The browser refused to open the link. */
    blocked: boolean;
  } | null>(null);
  const [connectorLate, setConnectorLate] = useState(false);
  const connectorSlow = !!connector?.blocked || connectorLate;
  const run = useRef(0);

  const scan = useCallback(
    async (quiet = false) => {
      // A background refresh never supersedes a visible scan or a change.
      const id = quiet ? run.current : ++run.current;
      if (!quiet) {
        setScanning(true);
        setError("");
      }
      try {
        const result = await api.getMcpHosts(profileId);
        if (id === run.current) setOverview(result);
        return result;
      } catch (cause) {
        if (id === run.current && !quiet) setError(safeErrorMessage(cause));
        return null;
      } finally {
        if (id === run.current && !quiet) setScanning(false);
      }
    },
    [api, profileId],
  );

  useEffect(() => {
    setOverview(null);
    setFailures({});
    setConnector(null);
    if (enabled) void scan();
  }, [enabled, scan]);

  // Follow the connector until it reports, then show what it connected.
  const connectorTicket = connector?.launch.ticket;
  const connectorState = connector?.status?.state ?? "waiting";
  const connectorStartedAt = connector?.startedAt ?? 0;
  useEffect(() => {
    if (!enabled || !connectorTicket) return;
    if (connectorState === "done" || connectorState === "expired") return;
    setConnectorLate(Date.now() - connectorStartedAt >= CONNECTOR_FALLBACK_MS);
    const timer = window.setInterval(() => {
      setConnectorLate(
        Date.now() - connectorStartedAt >= CONNECTOR_FALLBACK_MS,
      );
      void api
        .getMcpConnector(profileId, connectorTicket)
        .then((status) => {
          setConnector((current) =>
            current?.launch.ticket === connectorTicket
              ? { ...current, status }
              : current,
          );
          if (status.state === "done") void scan(true);
        })
        .catch(() => {});
    }, CONNECTOR_POLL_MS);
    return () => window.clearInterval(timer);
  }, [
    api,
    connectorStartedAt,
    connectorState,
    connectorTicket,
    enabled,
    profileId,
    scan,
  ]);

  // An agent loads StreamerAI only after a restart; notice when it has.
  const waitingForRestart = !!overview?.hosts.some(awaitsRestart);
  useEffect(() => {
    if (!enabled || !waitingForRestart) return;
    const timer = window.setInterval(() => void scan(true), RESTART_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, scan, waitingForRestart]);

  const install = async (hosts?: McpHostId[]) => {
    setWorking(hosts?.length === 1 ? hosts[0]! : "all");
    setError("");
    try {
      const result = await api.connectMcpHosts(profileId, hosts);
      run.current += 1;
      setOverview(result);
      setFailures(
        Object.fromEntries(
          (result.failures ?? []).map((item) => [item.id, item.message]),
        ),
      );
      return result;
    } catch (cause) {
      setError(safeErrorMessage(cause));
      return null;
    } finally {
      setWorking(null);
    }
  };

  const remove = async (host: McpHostId) => {
    setWorking(host);
    setError("");
    try {
      const result = await api.removeMcpHost(profileId, host);
      run.current += 1;
      setOverview(result);
      setFailures((previous) => ({ ...previous, [host]: undefined }));
      return result;
    } catch (cause) {
      setError(safeErrorMessage(cause));
      return null;
    } finally {
      setWorking(null);
    }
  };

  /** Starts the user-side connector through its streamerai-agent: link. */
  const startConnector = async () => {
    setWorking("all");
    setError("");
    try {
      const launch = await api.startMcpConnector(profileId);
      let blocked = false;
      try {
        mcpConnectorLauncher.open(launch.url);
      } catch {
        blocked = true;
      }
      setConnectorLate(false);
      setConnector({ launch, status: null, startedAt: Date.now(), blocked });
      return launch;
    } catch (cause) {
      setError(safeErrorMessage(cause));
      return null;
    } finally {
      setWorking(null);
    }
  };

  return {
    overview,
    scanning,
    working,
    error,
    failures,
    connector,
    connectorSlow,
    scan,
    install,
    remove,
    startConnector,
  };
}

/**
 * Hosts that one-click connect installs into or repairs. A host bound to
 * another profile is left alone; switching it is an explicit per-host action.
 */
export function installableMcpHosts(overview: McpHostsOverview | null) {
  if (!overview?.canManage || !overview.bridge.available) return [];
  if (usesMcpConnector(overview)) return [];
  return overview.hosts.filter(
    (host) => host.state === "available" || host.state === "outdated",
  );
}

const stateLabels: Record<McpHostStatus["state"], string> = {
  installed: "Connected",
  available: "Found",
  outdated: "Needs update",
  "other-profile": "Another profile",
  "not-detected": "Not found",
};
const actionLabels: Partial<Record<McpHostStatus["state"], string>> = {
  available: "Install",
  outdated: "Update",
  "other-profile": "Use this profile",
};
function stateLabel(host: McpHostStatus) {
  if (awaitsRestart(host)) return "Restart needed";
  if (host.state === "installed" && host.connection?.seenAt) return "Active";
  return stateLabels[host.state];
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mcp-hosts__copy">
      <div className="mcp-hosts__copy-head">
        <span>{label}</span>
        <button
          className="button button--ghost"
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(value)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              })
              .catch(() => {});
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <code>{value}</code>
    </div>
  );
}

function ConnectorProgress({ controller }: { controller: McpHostsController }) {
  const { connector, connectorSlow, overview } = controller;
  if (!connector) return null;
  const { launch, status } = connector;
  const name = (id: McpHostId) =>
    overview?.hosts.find((host) => host.id === id)?.name ?? id;
  if (status?.state === "done") {
    const connected = status.results.filter((result) => result.ok);
    return (
      <div className="mcp-hosts__connector" role="status">
        {status.detected.length === 0 ? (
          <p>
            The connector found no supported agent in your account. Install
            Claude Code, Codex, Claude Desktop or Cursor, then connect again.
          </p>
        ) : (
          <ul className="mcp-hosts__results">
            {status.results.map((result) => (
              <li key={result.id} className={result.ok ? "is-ok" : "is-failed"}>
                {result.ok ? "✓" : "✗"} {name(result.id)}
                {result.ok ? " connected" : `: ${result.message ?? "failed"}`}
              </li>
            ))}
          </ul>
        )}
        {connected.length > 0 && (
          <p>
            Restart {connected.map((result) => name(result.id)).join(", ")} to
            load StreamerAI. This list switches to Active once it has.
          </p>
        )}
      </div>
    );
  }
  if (status?.state === "expired")
    return (
      <p className="mcp-hosts__connector" role="status">
        The connect link expired. Connect again to create a new one.
      </p>
    );
  if (status?.state === "connecting")
    return (
      <p className="mcp-hosts__connector" role="status">
        Connecting agents in your account…
      </p>
    );
  return (
    <div className="mcp-hosts__connector" role="status">
      <p>
        Allow your browser to open <strong>StreamerAI Agent Connector</strong>.
        It adds StreamerAI to the agents in your account on this computer.{" "}
        <a href={launch.url}>Open it again</a>
      </p>
      {connectorSlow && (
        <>
          <p>
            Nothing opened? Run this command on the server computer, signed in
            as the person who uses the agents:
          </p>
          <CopyField label="Connector command" value={launch.command} />
        </>
      )}
    </div>
  );
}

export function McpHostSetup({
  api,
  profileId,
  controller,
}: {
  api: StreamerApi;
  profileId: string;
  controller: McpHostsController;
}) {
  const {
    overview,
    scanning,
    working,
    error,
    failures,
    scan,
    install,
    remove,
    startConnector,
  } = controller;
  const [manual, setManual] = useState<McpManualSetup | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState("");
  const viaConnector = usesMcpConnector(overview);
  const detected =
    overview?.hosts.filter((host) => host.state !== "not-detected") ?? [];
  const missing =
    overview?.hosts.filter((host) => host.state === "not-detected") ?? [];
  const installable = installableMcpHosts(overview);
  const connected = detected.filter((host) => host.state === "installed");
  const connectorReady = canStartMcpConnector(overview);

  useEffect(() => {
    setManual(null);
    setManualError("");
  }, [profileId]);

  let notice = "";
  if (overview && !overview.canManage)
    notice =
      "Open StreamerAI on the server computer as the household owner to connect agents automatically.";
  else if (overview && !overview.bridge.available)
    notice = overview.bridge.message ?? "The MCP bridge is unavailable.";
  else if (viaConnector && !overview?.connector?.available)
    notice =
      "StreamerAI runs as a background service and this build has no agent connector. Use Manual setup below.";
  else if (overview && !viaConnector && detected.length === 0)
    notice =
      "No supported agent was found on the server computer. Install Claude Code or Codex, then scan again.";

  return (
    <div
      className="agent-backend__mcp-info mcp-hosts"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="mcp-hosts__head">
        <p>
          {viaConnector
            ? "Your agent runs StreamerAI tools on this server computer. StreamerAI runs as a background service, so Activate opens a small connector in your account that finds Claude Code, Codex and other agents and installs StreamerAI into them."
            : "Your agent runs StreamerAI tools on this server computer. Activate finds supported agents, installs the StreamerAI MCP server into them and switches StreamerAI to MCP."}
        </p>
        <button
          className="button button--ghost"
          type="button"
          disabled={scanning || working !== null}
          onClick={() => void scan()}
        >
          {scanning ? "Scanning…" : viaConnector ? "Refresh" : "Scan again"}
        </button>
      </div>
      {!overview && scanning && (
        <p role="status">Looking for agents on the server computer…</p>
      )}
      {overview?.canManage && detected.length > 0 && (
        <ul className="mcp-hosts__list" aria-label="Agents on this server">
          {detected.map((host) => {
            const action = viaConnector ? undefined : actionLabels[host.state];
            const failure = failures[host.id] ?? host.message;
            const restart = awaitsRestart(host);
            return (
              <li
                key={host.id}
                className={`is-${host.state}${restart ? " is-restart" : ""}`}
              >
                <div className="mcp-hosts__name">
                  <strong>{host.name}</strong>
                  <span className="mcp-hosts__state">{stateLabel(host)}</span>
                </div>
                <div className="mcp-hosts__actions">
                  {action && (
                    <button
                      className="button button--secondary"
                      type="button"
                      disabled={working !== null || !overview.bridge.available}
                      aria-label={`${action} ${host.name}`}
                      onClick={() => void install([host.id])}
                    >
                      {working === host.id ? "Installing…" : action}
                    </button>
                  )}
                  {host.state === "installed" && (
                    <button
                      className="button button--ghost"
                      type="button"
                      disabled={working !== null}
                      aria-label={`Remove from ${host.name}`}
                      onClick={() => void remove(host.id)}
                    >
                      {working === host.id
                        ? "Removing…"
                        : viaConnector
                          ? "Disconnect"
                          : "Remove"}
                    </button>
                  )}
                </div>
                {failure && (
                  <small className="mcp-hosts__failure" role="alert">
                    {failure}
                  </small>
                )}
                {restart && !failure && <small>{host.restartHint}</small>}
                {host.state === "installed" &&
                  !restart &&
                  !failure &&
                  host.connection?.seenAt && (
                    <small>StreamerAI tools are loaded in {host.name}.</small>
                  )}
                {host.state === "installed" && !host.connection && !failure && (
                  <small>{host.restartHint}</small>
                )}
                {host.state === "other-profile" && (
                  <small>
                    This agent is connected to another StreamerAI profile.
                  </small>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {overview?.canManage && installable.length > 1 && (
        <button
          className="button button--secondary mcp-hosts__all"
          type="button"
          disabled={working !== null}
          onClick={() => void install(installable.map((host) => host.id))}
        >
          {working === "all"
            ? "Installing…"
            : `Install into all ${installable.length} agents`}
        </button>
      )}
      {connectorReady && (
        <button
          className="button button--secondary mcp-hosts__all"
          type="button"
          disabled={working !== null}
          onClick={() => void startConnector()}
        >
          {working === "all"
            ? "Starting…"
            : connected.length
              ? "Connect more agents"
              : "Connect agents on this computer"}
        </button>
      )}
      <ConnectorProgress controller={controller} />
      {notice && (
        <p className="mcp-hosts__notice" role="status">
          {notice}
        </p>
      )}
      {overview?.canManage && connected.length > 0 && (
        <p className="mcp-hosts__hint">
          Ask your agent, for example: “Use StreamerAI to find a light sci-fi
          film for tonight.”
        </p>
      )}
      {overview?.canManage && !viaConnector && missing.length > 0 && (
        <p className="mcp-hosts__missing">
          Also supported: {missing.map((host) => host.name).join(", ")}.
        </p>
      )}
      {error && (
        <p className="mcp-hosts__failure" role="alert">
          {error}
        </p>
      )}
      {overview?.canManage && overview.bridge.available && (
        <details className="mcp-hosts__manual">
          <summary>Manual setup</summary>
          <p>
            For another MCP host or another user account on this computer.
            Creating commands issues a new manual credential and replaces the
            previous one.
          </p>
          {manual ? (
            <>
              <CopyField label="Claude Code" value={manual.claudeCommand} />
              <CopyField label="Codex" value={manual.codexCommand} />
              <CopyField
                label="JSON (Cursor, Claude Desktop…)"
                value={manual.json}
              />
            </>
          ) : (
            <button
              className="button button--ghost"
              type="button"
              disabled={manualBusy}
              onClick={() => {
                setManualBusy(true);
                setManualError("");
                void api
                  .createMcpManualSetup(profileId)
                  .then(setManual)
                  .catch((cause: unknown) =>
                    setManualError(safeErrorMessage(cause)),
                  )
                  .finally(() => setManualBusy(false));
              }}
            >
              {manualBusy ? "Creating…" : "Create setup commands"}
            </button>
          )}
          {manualError && (
            <p className="mcp-hosts__failure" role="alert">
              {manualError}
            </p>
          )}
        </details>
      )}
    </div>
  );
}
