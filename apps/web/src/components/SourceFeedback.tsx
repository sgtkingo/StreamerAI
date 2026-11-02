import { useEffect, useRef, useState } from "react";
import type {
  SourceFeedback,
  SourceFeedbackResponse,
  TitleSource,
} from "@streamer-ai/contracts";
import { safeErrorMessage, type StreamerApi } from "../api/client";
import { useToasts } from "./ToastProvider";
import { InfoTip } from "./InfoTip";

function Thumb({ down = false }: { down?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={down ? { transform: "rotate(180deg)" } : undefined}
    >
      <path d="M7 10v11H3V10h4Zm0 0 5-7c1-1 3 0 2.5 2L13 10h6a2 2 0 0 1 2 2l-1.5 7a2 2 0 0 1-2 2H7" />
    </svg>
  );
}

export function useSourceFeedback(
  api: StreamerApi,
  profileId: string,
  titleId: string,
) {
  const [state, setState] = useState<SourceFeedbackResponse>({
    enabled: false,
    items: [],
  });
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const loadRevision = useRef(0);
  const saving = useRef(false);
  const { showToast } = useToasts();
  useEffect(() => {
    const current = ++revision.current;
    saving.current = false;
    setBusy(false);
    setState({ enabled: false, items: [] });
    const load = (initial = false) => {
      if (saving.current || !api.getSourceFeedback) return;
      const request = ++loadRevision.current;
      void api
        .getSourceFeedback(profileId, titleId)
        .then((value) => {
          if (
            revision.current === current &&
            loadRevision.current === request &&
            !saving.current
          )
            setState(value);
        })
        .catch(() => {
          if (initial && revision.current === current)
            showToast(
              "Could not load source feedback. Reopen the title to try again.",
              "error",
            );
        });
    };
    load(true);
    const refresh = () => {
      if (document.visibilityState === "visible") load();
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      revision.current = current + 1;
    };
  }, [api, profileId, titleId, showToast]);
  const votesFor = (source: TitleSource) =>
    state.items.filter(
      (item) =>
        item.providerId === source.providerId &&
        item.candidateId === source.candidateId &&
        item.seasonNumber === source.seasonNumber &&
        item.episodeNumber === source.episodeNumber,
    );
  const vote = async (source: TitleSource, value: SourceFeedback["vote"]) => {
    if (!state.enabled || saving.current || !api.saveSourceFeedback) return;
    const current = revision.current;
    loadRevision.current++;
    saving.current = true;
    setBusy(true);
    try {
      const result = await api.saveSourceFeedback(
        profileId,
        titleId,
        source.id,
        value,
      );
      if (revision.current === current) setState(result);
    } catch (error) {
      if (revision.current === current)
        showToast(safeErrorMessage(error), "error");
    } finally {
      if (revision.current === current) {
        saving.current = false;
        setBusy(false);
      }
    }
  };
  return (source: TitleSource) =>
    state.enabled ? (
      <span
        className="source-feedback"
        role="group"
        aria-label={`Correctness of ${source.releaseName}`}
      >
        {(["up", "down"] as const).map((value) => {
          const votes = votesFor(source);
          const active = votes.some(
            (item) => item.isOwn && item.vote === value,
          );
          const count = votes.filter((item) => item.vote === value).length;
          const label =
            value === "up"
              ? "Correct title or episode"
              : "Wrong title or episode";
          return (
            <button
              key={value}
              type="button"
              className={`source-feedback__vote${active ? ` is-${value}` : ""}`}
              aria-label={label}
              aria-description={`${count} ${count === 1 ? "vote" : "votes"} across this account`}
              aria-pressed={active}
              title={`${label}. Shared across your account's profiles. Click again to clear.`}
              disabled={busy}
              onClick={() => void vote(source, active ? null : value)}
            >
              <Thumb down={value === "down"} />
              {count > 0 && (
                <span className="source-feedback__count" aria-hidden="true">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </span>
    ) : null;
}

export function SourceFeedbackSettings({
  api,
  profileId,
}: {
  api: StreamerApi;
  profileId: string;
}) {
  const [enabled, setEnabled] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  useEffect(() => {
    const current = ++revision.current;
    setReady(false);
    setBusy(false);
    setError("");
    void api
      .getSourceFeedbackSettings?.(profileId)
      .then((value) => {
        if (revision.current === current) {
          setEnabled(value.enabled);
          setReady(true);
        }
      })
      .catch(() => {
        if (revision.current === current)
          setError(
            "Could not load source feedback settings. Reopen Settings to try again.",
          );
      });
    return () => {
      revision.current = current + 1;
    };
  }, [api, profileId]);
  if (!api.getSourceFeedbackSettings) return null;
  const save = async (value: boolean) => {
    if (!api.saveSourceFeedbackSettings || busy || !ready) return;
    const current = revision.current;
    setBusy(true);
    setError("");
    try {
      const result = await api.saveSourceFeedbackSettings(profileId, value);
      if (revision.current === current) setEnabled(result.enabled);
    } catch (reason) {
      if (revision.current === current) setError(safeErrorMessage(reason));
    } finally {
      if (revision.current === current) setBusy(false);
    }
  };
  return (
    <div className="source-feedback-settings">
      <label>
        <input
          type="checkbox"
          aria-label="Source correctness feedback"
          checked={enabled}
          disabled={!ready || busy}
          onChange={(event) => void save(event.target.checked)}
        />{" "}
        <span>
          Source correctness feedback{" "}
          <InfoTip label="About source correctness feedback">
            Use small thumbs beside each file to confirm the correct title or
            episode, or flag a wrong match. Each profile can vote once; counts
            are shared across all profiles in your account and sync to your
            cloud copy when account sync is enabled. They help prioritize
            sources and build a record for future matching improvements. Turning
            this off hides the thumbs and ignores these ratings for this
            profile; saved account ratings are kept.
          </InfoTip>
        </span>
      </label>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
