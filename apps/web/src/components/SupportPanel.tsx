import { useEffect, useState } from "react";
import { AdminIcon, AdminNote, AdminStatus } from "./AdminUI";
import { AdminHelp as InfoTip } from "./AdminUI";
import { makeTextZip } from "./supportZip";

const FIELD_LIMIT = 20000;
const PREFILLED_URL_LIMIT = 7000;
const ISSUES = "https://github.com/sgtkingo/StreamerAI/issues/new";
const diagnosticFields = [
  "format",
  "generatedAt",
  "serverVersion",
  "apiProtocol",
  "platform",
  "architecture",
  "nodeMajor",
  "includesLogs",
  "includesPersonalData",
];

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

export function SupportPanel() {
  const [diagnostics, setDiagnostics] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");
  const [expected, setExpected] = useState("");
  const [includeLogs, setIncludeLogs] = useState(true);
  const [logs, setLogs] = useState("");
  const [logsStatus, setLogsStatus] = useState("");
  const [logsRevision, setLogsRevision] = useState(0);
  const [logsLoading, setLogsLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotData, setScreenshotData] = useState("");
  const [screenshotError, setScreenshotError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    setScreenshotData("");
    if (!screenshot) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setScreenshotData(reader.result);
    };
    reader.onerror = () => {
      setScreenshot(null);
      setScreenshotError(
        "The screenshot could not be read. Try another image.",
      );
    };
    reader.readAsDataURL(screenshot);
    return () => {
      reader.onload = null;
      reader.onerror = null;
      if (reader.readyState === FileReader.LOADING) reader.abort();
    };
  }, [screenshot]);

  useEffect(() => {
    if (!includeLogs) {
      setLogs("");
      setLogsStatus("");
      setLogsLoading(false);
      return;
    }
    const controller = new AbortController();
    setLogs("");
    setLogsStatus("Loading recent logs…");
    void fetch("/api/v1/server/diagnostic-logs", {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "Recent logs are unavailable. Ask the server owner to prepare the report.",
          );
        const data = (await response.json()) as {
          available?: boolean;
          entries?: unknown;
        };
        if (controller.signal.aborted) return;
        if (!data.available || !Array.isArray(data.entries))
          throw new Error(
            "Recent logs are unavailable with this server's logging configuration.",
          );
        const entries = data.entries.slice(-100).flatMap((entry: unknown) => {
          if (!entry || typeof entry !== "object") return [];
          const { time, level, code } = entry as Record<string, unknown>;
          return typeof time === "string" &&
            typeof level === "number" &&
            typeof code === "string"
            ? [{ time, level, code }]
            : [];
        });
        setLogs(JSON.stringify(entries, null, 2));
        setLogsStatus(
          entries.length
            ? `${entries.length} recent ${entries.length === 1 ? "event" : "events"} ready for download.`
            : "No recent diagnostic events are available yet.",
        );
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLogsStatus(
          reason instanceof Error
            ? reason.message
            : "Recent logs are unavailable.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLogsLoading(false);
      });
    return () => controller.abort();
  }, [includeLogs, logsRevision]);

  const report = `### What happened\n${description}\n\n### Steps to reproduce\n${steps}\n\n### Expected result\n${expected}`;
  const baseIssueUrl = `${ISSUES}?labels=bug&title=${encodeURIComponent("Bug report")}`;
  const prefilledUrl = `${baseIssueUrl}&body=${encodeURIComponent(report)}`;
  const needsCopy = prefilledUrl.length > PREFILLED_URL_LIMIT;
  const logFiles = [
    ...(diagnostics
      ? [{ name: "diagnostics.json", content: diagnostics }]
      : []),
    ...(includeLogs && logs
      ? [{ name: "recent-logs.json", content: logs }]
      : []),
  ];
  const downloadLogs = () => {
    if (!logFiles.length) return;
    const url = URL.createObjectURL(makeTextZip(logFiles));
    const link = document.createElement("a");
    link.href = url;
    link.download = "streamerai-diagnostics.zip";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopyStatus("Report copied. Paste it into the GitHub issue.");
    } catch {
      setCopyStatus(
        "Could not copy automatically. Select and copy the report preview.",
      );
    }
  };
  const download = () => {
    const html = screenshotData
      ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>StreamerAI bug report</title><style>body{font:16px system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body><h1>StreamerAI bug report</h1><pre>${escapeHtml(report)}</pre><h2>Screenshot</h2><img alt="Attached screenshot" src="${escapeHtml(screenshotData)}"></body></html>`
      : null;
    const url = URL.createObjectURL(
      new Blob([html ?? report], {
        type: html ? "text/html;charset=utf-8" : "text/plain;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = html
      ? "streamerai-bug-report.html"
      : "streamerai-bug-report.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const prepareDiagnostics = () => {
    setBusy(true);
    setError("");
    void fetch("/api/v1/server/diagnostics", {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            "Diagnostics could not be prepared. The server owner can try again.",
          );
        const data = (await response.json()) as Record<string, unknown>;
        setDiagnostics(
          JSON.stringify(
            Object.fromEntries(
              diagnosticFields
                .filter((key) =>
                  ["string", "number", "boolean"].includes(typeof data[key]),
                )
                .map((key) => [key, data[key]]),
            ),
            null,
            2,
          ),
        );
      })
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error ? reason.message : "Diagnostics unavailable.",
        ),
      )
      .finally(() => setBusy(false));
  };
  return (
    <section className="profile-page__section" id="settings-support">
      <p className="eyebrow">Support</p>
      <h2>Report a problem</h2>
      <p>
        Describe the problem, review your report, then save it or submit it
        through GitHub. Server diagnostics and logs require owner access.
      </p>
      <section
        className="admin-subsection"
        aria-labelledby="support-description-title"
      >
        <h3 id="support-description-title">1. Describe the problem</h3>
        <label className="field">
          <span>What happened?</span>
          <textarea
            rows={4}
            value={description}
            maxLength={FIELD_LIMIT}
            placeholder="Describe the problem you encountered."
            onChange={(event) => setDescription(event.target.value)}
            aria-label="What happened?"
            aria-describedby="description-remaining"
          />
          <small id="description-remaining">
            {FIELD_LIMIT - description.length} characters remaining
          </small>
        </label>
        <label className="field">
          <span>Steps to reproduce</span>
          <textarea
            rows={4}
            value={steps}
            maxLength={FIELD_LIMIT}
            placeholder={"1. Open…\n2. Select…\n3. …"}
            onChange={(event) => setSteps(event.target.value)}
            aria-label="Steps to reproduce"
            aria-describedby="steps-remaining"
          />
          <small id="steps-remaining">
            {FIELD_LIMIT - steps.length} characters remaining
          </small>
        </label>
        <label className="field">
          <span>Expected result</span>
          <textarea
            rows={3}
            value={expected}
            maxLength={FIELD_LIMIT}
            placeholder="What did you expect to happen?"
            onChange={(event) => setExpected(event.target.value)}
            aria-label="Expected result"
            aria-describedby="expected-remaining"
          />
          <small id="expected-remaining">
            {FIELD_LIMIT - expected.length} characters remaining
          </small>
        </label>
        <label className="field">
          <span>Screenshot (optional)</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              setScreenshotError("");
              if (
                !["image/png", "image/jpeg", "image/webp"].includes(
                  file.type,
                ) ||
                file.size > 10 * 1024 * 1024
              ) {
                setScreenshotError(
                  "Choose a PNG, JPEG or WebP image up to 10 MB.",
                );
                return;
              }
              setScreenshotData("");
              setScreenshot(file);
            }}
          />
        </label>
        {screenshotError && <p role="alert">{screenshotError}</p>}
        {screenshotData && (
          <div className="support-screenshot">
            <img src={screenshotData} alt="Screenshot preview" />
            <button
              className="button button--secondary"
              type="button"
              onClick={() => {
                setScreenshot(null);
                setScreenshotData("");
                setScreenshotError("");
              }}
            >
              Remove screenshot
            </button>
          </div>
        )}
      </section>
      <section
        className="admin-subsection"
        aria-labelledby="support-diagnostics-title"
      >
        <div className="admin-card-heading">
          <h3 id="support-diagnostics-title">
            2. Add diagnostics{" "}
            <InfoTip label="What diagnostics contain">
              Server and platform versions can help identify the problem. Recent
              diagnostic logs contain event codes, severity and timestamps.
              Review the report before sharing.
            </InfoTip>
          </h3>
          <AdminStatus tone={diagnostics ? "success" : "neutral"}>
            {diagnostics ? "Ready for ZIP" : "Optional"}
          </AdminStatus>
        </div>
        <button
          className="button button--secondary"
          disabled={busy}
          type="button"
          onClick={prepareDiagnostics}
        >
          {busy ? "Preparing…" : "Prepare diagnostics"}
        </button>
        {error && <p role="alert">{error}</p>}
        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={includeLogs}
            onChange={(event) => setIncludeLogs(event.target.checked)}
          />
          <span>Include logs in ZIP</span>
        </label>
        {includeLogs && (
          <>
            <p className="settings-note" role="status">
              {logsStatus} Recent diagnostic events are kept in memory since the
              server started.
            </p>
            <button
              className="text-button"
              type="button"
              onClick={() => setLogsRevision((current) => current + 1)}
            >
              Refresh logs
            </button>
          </>
        )}
      </section>
      <section
        className="admin-subsection"
        aria-labelledby="support-share-title"
      >
        <h3 id="support-share-title">3. Review and submit</h3>
        <p className="settings-note">
          Review before sharing. Remove passwords, keys, personal details and
          private links from your description.
        </p>
        <pre className="deployment-report" tabIndex={0}>
          {report}
        </pre>
        {needsCopy && (
          <p className="settings-note">
            This report is too long for a prefilled link. Copy the report and
            paste it into the GitHub issue; no text will be cut off.
          </p>
        )}
        {needsCopy && (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => void copyReport()}
          >
            Copy report
          </button>
        )}
        {copyStatus && <p role="status">{copyStatus}</p>}
        {logFiles.length > 0 && (
          <p className="settings-note">
            Diagnostics and logs are downloaded separately as a ZIP. Attach the
            ZIP to the GitHub issue yourself.
          </p>
        )}
        {screenshotData && (
          <p className="settings-note">
            The offline HTML report includes the screenshot. To include it in a
            GitHub issue, attach the original image in the GitHub form.
          </p>
        )}
        <div className="deployment-actions">
          {logFiles.length > 0 && (
            <button
              className="button button--secondary"
              type="button"
              onClick={downloadLogs}
            >
              Download diagnostics ZIP
            </button>
          )}
          <button
            className="button button--secondary"
            type="button"
            disabled={
              (includeLogs && logsLoading) || (!!screenshot && !screenshotData)
            }
            onClick={download}
          >
            <AdminIcon name="download" />
            Save report offline
          </button>
          <a
            className="button button--secondary"
            href={needsCopy ? baseIssueUrl : prefilledUrl}
            target="_blank"
            rel="noreferrer"
            aria-disabled={
              (includeLogs && logsLoading) || (!!screenshot && !screenshotData)
            }
            onClick={(event) => {
              if (
                (includeLogs && logsLoading) ||
                (screenshot && !screenshotData)
              ) {
                event.preventDefault();
                return;
              }
              if (logFiles.length) downloadLogs();
            }}
          >
            Open GitHub issue <AdminIcon name="arrow" />
          </a>
        </div>
        <p className="settings-note">
          GitHub requires an account. Saving the file does not create a ticket.
          Keep sensitive security reports out of public issues.
        </p>
      </section>
      <AdminNote>
        Preparing a report does not send it. You choose whether to save it
        locally or open a GitHub issue.
      </AdminNote>
    </section>
  );
}
