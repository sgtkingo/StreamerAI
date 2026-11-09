import { useState } from "react";

const ISSUES = "https://github.com/sgtkingo/StreamerAI/issues/new";
export function SupportPanel() {
  const [diagnostics, setDiagnostics] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const report = `### What happened\n${description}\n\n### Steps to reproduce\n1. \n\n### Expected result\n${diagnostics ? `\n### Diagnostics\n\`\`\`json\n${diagnostics}\n\`\`\`` : ""}`;
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([report], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "streamerai-bug-report.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="profile-page__section" id="settings-support">
      <p className="eyebrow">Support</p>
      <h2>Report a problem</h2>
      <p>
        Describe the problem, review your report, then save it or submit it
        through GitHub. Server diagnostics are optional and require owner
        access.
      </p>
      <button
        className="button button--secondary"
        disabled={busy}
        type="button"
        onClick={() => {
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
              // Repeat the allowlist on the client before offering public sharing.
              const fields = [
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
              setDiagnostics(
                JSON.stringify(
                  Object.fromEntries(
                    fields
                      .filter((key) =>
                        ["string", "number", "boolean"].includes(
                          typeof data[key],
                        ),
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
                reason instanceof Error
                  ? reason.message
                  : "Diagnostics unavailable.",
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Preparing…" : "Prepare diagnostics"}
      </button>
      {error && <p role="alert">{error}</p>}
      {
        <>
          <label className="field">
            <span>What happened?</span>
            <textarea
              rows={4}
              value={description}
              maxLength={3000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <p className="settings-note">
            Review before sharing. Remove passwords, keys, personal details and
            private links from your own description. The diagnostic summary
            contains versions and platform information only.
          </p>
          <pre className="deployment-report" tabIndex={0}>
            {report}
          </pre>
          <div className="deployment-actions">
            <button
              className="button button--secondary"
              type="button"
              onClick={download}
            >
              Save report offline
            </button>
            <a
              className="button button--secondary"
              href={`${ISSUES}?labels=bug&title=${encodeURIComponent("Bug report")}&body=${encodeURIComponent(report.slice(0, 5000))}`}
              target="_blank"
              rel="noreferrer"
            >
              Open GitHub issue
            </a>
          </div>
          <p className="settings-note">
            GitHub requires an account. Saving the file does not create a
            ticket. Keep sensitive security reports out of public issues.
          </p>
        </>
      }
    </section>
  );
}
