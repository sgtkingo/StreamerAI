import { useEffect, useState } from "react";
import type { LocalFolderConfig, StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";

export function LocalFolderSettings({
  api,
  onConfigured,
}: {
  api: StreamerApi;
  onConfigured: (configured: boolean) => void;
}) {
  const [config, setConfig] = useState<LocalFolderConfig | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void api
      .getLocalFolders()
      .then((value) => {
        if (active) setConfig(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(safeErrorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (config?.scan.state !== "scanning") return;
    const timer = window.setTimeout(() => {
      void api
        .getLocalFolders()
        .then(setConfig)
        .catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [api, config]);

  const run = async (operation: () => Promise<LocalFolderConfig | null>) => {
    setBusy(true);
    setError("");
    try {
      const next = await operation();
      if (next === null) return;
      setConfig(next);
      onConfigured(next.roots.length > 0);
    } catch (reason) {
      setError(safeErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="local-folder-settings">
      <p className="integration-block__hint">
        Select a folder on the home server, or enter its path below. Subfolders
        are scanned automatically; symbolic links are skipped.
      </p>
      <div className="local-folder-settings__add">
        <button
          className="button button--secondary local-folder-settings__select"
          type="button"
          disabled={busy}
          onClick={() => void run(() => api.selectLocalFolder())}
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
            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3V7Z" />
            <path d="M8 13h8m-4-4v8" />
          </svg>
          Select folder
        </button>
        <label className="field">
          <span>Folder or mounted drive path</span>
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/media/movies or D:\\Movies"
          />
        </label>
        <button
          className="button button--secondary"
          type="button"
          disabled={busy || !path.trim()}
          onClick={() =>
            void run(async () => {
              const next = await api.addLocalFolder(path);
              setPath("");
              return next;
            })
          }
        >
          Add folder
        </button>
      </div>
      {config?.roots.length ? (
        <ul className="local-folder-settings__roots">
          {config.roots.map((root) => (
            <li key={root.id}>
              <span title={root.path}>{root.path}</span>
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove ${root.path}`}
                onClick={() => void run(() => api.removeLocalFolder(root.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="integration-block__hint">No folders connected yet.</p>
      )}
      {config && (
        <fieldset className="local-folder-settings__formats" disabled={busy}>
          <legend>Video formats</legend>
          {config.availableExtensions.map((extension) => (
            <label key={extension}>
              <input
                type="checkbox"
                checked={config.extensions.includes(extension)}
                onChange={() =>
                  void run(() =>
                    api.setLocalFormats(
                      config.extensions.includes(extension)
                        ? config.extensions.filter(
                            (value) => value !== extension,
                          )
                        : [...config.extensions, extension],
                    ),
                  )
                }
              />
              .{extension}
            </label>
          ))}
        </fieldset>
      )}
      <div className="local-folder-settings__scan">
        <span role="status">
          {config?.scan.state === "scanning"
            ? "Scanning folders…"
            : `${config?.scan.fileCount ?? 0} local files indexed`}
        </span>
        <button
          type="button"
          disabled={
            busy || !config?.roots.length || config.scan.state === "scanning"
          }
          onClick={() => void run(() => api.scanLocalFolders())}
        >
          Scan now
        </button>
      </div>
      {config?.scan.error && <p role="alert">{config.scan.error}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
