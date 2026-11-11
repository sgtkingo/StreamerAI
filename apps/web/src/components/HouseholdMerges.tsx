import { useEffect, useState } from "react";
import {
  safeErrorMessage,
  type HouseholdMergePreview,
  type HouseholdMergeRequest,
  type StreamerApi,
} from "../api/client";
import { DigitSlotsInput } from "./DigitSlotsInput";
import { useToasts } from "./ToastProvider";
import { AdminStatus } from "./AdminUI";

export function HouseholdMerges({
  api,
  onCompleted,
}: {
  api: StreamerApi;
  onCompleted: () => void;
}) {
  const [requests, setRequests] = useState<HouseholdMergeRequest[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!api.getHouseholdMerges) return;
    let active = true;
    const refresh = () =>
      void api.getHouseholdMerges!()
        .then((result) => {
          if (active) {
            setRequests(
              result.requests.filter(
                (request) =>
                  request.kind === "merge" &&
                  request.status === "approved" &&
                  request.requiresLocalImport,
              ),
            );
            setError("");
          }
        })
        .catch((reason) => {
          if (active) setError(safeErrorMessage(reason));
        });
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [api]);
  if (!requests.length && !error) return null;
  return (
    <section className="profile-page__section">
      <div className="admin-card-heading">
        <h2>Household merges to finish</h2>
        <AdminStatus tone="warning">
          {requests.length} awaiting import
        </AdminStatus>
      </div>
      <p>
        Finish a cloud merge on this destination server using the source
        household's Master PIN.
      </p>
      {requests.map((request) => (
        <HouseholdMerge
          key={request.id}
          api={api}
          request={request}
          onCompleted={() => {
            setRequests((current) =>
              current.filter((item) => item.id !== request.id),
            );
            onCompleted();
          }}
        />
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function HouseholdMerge({
  api,
  request,
  onCompleted,
}: {
  api: StreamerApi;
  request: HouseholdMergeRequest;
  onCompleted: () => void;
}) {
  const [pin, setPin] = useState("");
  const [preview, setPreview] = useState<HouseholdMergePreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { showToast } = useToasts();
  const review = async () => {
    if (pending || !/^\d{8}$/.test(pin)) return;
    setPending(true);
    setError("");
    try {
      setPreview(await api.previewHouseholdMerge!(request.id, pin));
    } catch (reason) {
      setError(safeErrorMessage(reason));
      setPin("");
    } finally {
      setPending(false);
    }
  };
  const complete = async () => {
    if (pending || !preview || !/^\d{8}$/.test(pin)) return;
    setPending(true);
    setError("");
    try {
      await api.completeHouseholdMerge!(request.id, pin);
      setPin("");
      setPreview(null);
      showToast(
        "Households merged. This household keeps its Master PIN and existing services.",
        "success",
      );
      onCompleted();
    } catch (reason) {
      setError(safeErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <article className="deployment-card household-merge">
      <h3>
        {request.source_name} → {request.target_name}
      </h3>
      {!preview ? (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void review();
          }}
        >
          <DigitSlotsInput
            label={`Master PIN for ${request.source_name}`}
            value={pin}
            onChange={setPin}
            disabled={pending}
          />
          <button
            className="button button--secondary"
            disabled={pending || !/^\d{8}$/.test(pin)}
          >
            {pending ? "Opening backup…" : "Review household merge"}
          </button>
        </form>
      ) : (
        <div className="form-stack">
          <p>
            Import {preview.profiles.length} profiles from {preview.sourceName}.
            This household will contain{" "}
            {preview.targetProfileCount + preview.profiles.length} of 5
            profiles.
          </p>
          <ul>
            {preview.profiles.map((profile, index) => (
              <li key={index}>
                {profile.name}
                {profile.pinEnabled ? " · Profile PIN enabled" : ""}
              </li>
            ))}
          </ul>
          <p>
            This household keeps its current Master PIN and existing shared
            service credentials.
          </p>
          <p>
            The source household's cloud connection is removed after the
            combined cloud backup is confirmed. Its local data stays on the
            source server.
          </p>
          {preview.limitations.length > 0 && (
            <ul>
              {preview.limitations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          <div className="deployment-actions">
            <button
              className="button button--primary"
              disabled={pending}
              onClick={() => void complete()}
            >
              {pending ? "Merging households…" : "Confirm household merge"}
            </button>
            <button
              className="button button--ghost"
              disabled={pending}
              onClick={() => {
                setPreview(null);
                setPin("");
                setError("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
