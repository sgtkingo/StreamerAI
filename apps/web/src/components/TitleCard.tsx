import { useEffect, useMemo } from "react";
import type { CatalogTitle, PlaybackPreferences } from "@streamer-ai/contracts";
import type { EpisodeSelection } from "@streamer-ai/contracts";
import {
  titleLanguageBadges,
  titleLanguageLabel,
} from "../title-language-label";
import { SourceOriginStack, titleSourceProviderIds } from "./SourceIcon";
import { DownloadGlyph } from "./DownloadButton";
import type { PlaybackCheckState } from "./usePlaybackChecks";

let cardHoverAudioContext: AudioContext | null = null;
let lastCardHoverTickAt = 0;

export function playCardHoverTick() {
  if (
    typeof window === "undefined" ||
    typeof window.AudioContext !== "function"
  )
    return;
  const now = performance.now();
  if (now - lastCardHoverTickAt < 100) return;
  lastCardHoverTickAt = now;

  try {
    cardHoverAudioContext ??= new window.AudioContext();
    const context = cardHoverAudioContext;
    const play = () => {
      const startAt = context.currentTime;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(1350, startAt);
      oscillator.frequency.exponentialRampToValueAtTime(760, startAt + 0.035);
      gain.gain.setValueAtTime(0.025, startAt);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.045);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + 0.05);
    };
    if (context.state === "suspended") {
      void context
        .resume()
        .then(play)
        .catch(() => undefined);
    } else {
      play();
    }
  } catch {
    // Hover sound is decorative and may be unavailable in restricted browsers.
  }
}

interface TitleCardProps {
  item: CatalogTitle;
  preferences: PlaybackPreferences;
  reason?: string;
  episode?: EpisodeSelection;
  episodeTitle?: string;
  episodeSynopsis?: string;
  hero?: boolean;
  onPlay: (
    item: CatalogTitle,
    episode?: EpisodeSelection,
    sourceId?: string,
  ) => void;
  onOpen?: (item: CatalogTitle, episode?: EpisodeSelection) => void;
  onCheck?: (item: CatalogTitle, episode?: EpisodeSelection) => void;
  onAdd: (item: CatalogTitle) => void;
  onRemove?: (item: CatalogTitle) => void;
  playbackEnabled?: boolean;
  pendingAction?: "play" | "add" | "remove";
  playbackCheck?: PlaybackCheckState;
}

function ratingPercent(item: CatalogTitle): number | null {
  const rating = item.ratings[0];
  return rating ? Math.round((rating.value / rating.scale) * 100) : null;
}

function ratingLabel(item: CatalogTitle): string {
  const rating = item.ratings[0];
  const percent = ratingPercent(item);
  if (!rating || percent === null) return "Rating pending";
  return `${rating.source} ${percent}%`;
}

function availabilityLabel(item: CatalogTitle): string {
  if (item.availability === "available")
    return item.formats[0]?.label ?? "Playable";
  if (item.availability === "partial" && item.seriesCoverage) {
    return `${item.seriesCoverage.episodesAvailable}/${item.seriesCoverage.episodesTotal} episodes`;
  }
  if (item.availability === "unknown") return "Availability needs recheck";
  return `Not found on ${item.availabilityProvider ?? "media source"}`;
}

export function titleHasPlayableVariant(item: CatalogTitle): boolean {
  if (item.formats.length === 0) return false;
  if (item.availability === "available") return true;
  return (
    item.kind === "series" &&
    item.availability === "partial" &&
    item.seriesCoverage !== null &&
    item.seriesCoverage.episodesAvailable > 0 &&
    item.seriesCoverage.nextEpisodeLabel !== null
  );
}

export function TitleCard({
  item,
  preferences,
  reason,
  episode,
  episodeTitle,
  episodeSynopsis,
  hero = false,
  onPlay,
  onOpen,
  onCheck,
  onAdd,
  onRemove,
  playbackEnabled = true,
  pendingAction,
  playbackCheck,
}: TitleCardProps) {
  const playable = titleHasPlayableVariant(item);
  const checkStatus = playbackCheck?.status ?? "checking";
  const checkedLanguages =
    playbackCheck?.status === "ready" &&
    playbackCheck.audioLanguages &&
    playbackCheck.subtitleLanguages
      ? {
          audioLanguages: playbackCheck.audioLanguages,
          subtitleLanguages: playbackCheck.subtitleLanguages,
        }
      : undefined;
  const languageLabel =
    !playbackEnabled || checkStatus === "ready"
      ? titleLanguageLabel(
          item,
          preferences,
          checkedLanguages,
          !playbackEnabled || checkedLanguages !== undefined,
        )
      : null;
  const languageBadges =
    !playbackEnabled || checkStatus === "ready"
      ? titleLanguageBadges(
          item,
          preferences,
          checkedLanguages,
          !playbackEnabled || checkedLanguages !== undefined,
        )
      : null;
  const hasSavedProgress =
    item.progressPercent !== null &&
    item.progressPercent >= 2 &&
    item.progressPercent < 95;
  const playAction = (
    <>
      <span className="play-action__icon" aria-hidden="true">
        ▶
      </span>
      <span className="play-action__label">
        {hasSavedProgress ? "Continue" : "Play"}
      </span>
    </>
  );
  const defaultEpisode = useMemo(
    () =>
      item.kind === "series"
        ? (episode ??
          item.resumeEpisode ?? { seasonNumber: 1, episodeNumber: 1 })
        : undefined,
    [episode, item.kind, item.resumeEpisode],
  );
  const episodeCode = episode
    ? `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`
    : null;
  const displayTitle = episodeCode
    ? episodeTitle || `Episode ${episodeCode}`
    : item.title;
  const openDetails = () => {
    if (episode) onOpen?.(item, episode);
    else onOpen?.(item);
  };
  const alternateSources = (item.sources ?? []).filter((source) =>
    defaultEpisode
      ? source.seasonNumber === defaultEpisode.seasonNumber &&
        source.episodeNumber === defaultEpisode.episodeNumber
      : source.seasonNumber === null && source.episodeNumber === null,
  );
  const sourceProviderIds = titleSourceProviderIds(item, episode);
  const downloadable =
    (episode ? alternateSources : (item.sources ?? [])).some(
      (source) =>
        source.providerId === "webshare" &&
        /\.(mkv|avi|mp4|m4v|mov|webm|mpg|mpeg|ts|m2ts)$/i.test(
          source.releaseName,
        ),
    ) ||
    (item.availabilityProvider === "webshare" &&
      (item.availability === "available" || item.availability === "partial") &&
      item.formats.some(
        (format) =>
          format.container !== null &&
          /^(mkv|avi|mp4|m4v|mov|webm|mpg|mpeg|ts|m2ts)$/i.test(
            format.container,
          ),
      ));
  const availableOffline = (
    episode ? alternateSources : (item.sources ?? [])
  ).some((source) => source.providerId === "local-files");
  const canShowPlayback = playbackEnabled || playable;
  const displayAvailability = playbackEnabled
    ? item.kind === "series"
      ? checkStatus === "ready"
        ? "available"
        : item.availability
      : checkStatus === "failed"
        ? "unavailable"
        : checkStatus === "ready"
          ? "available"
          : "unknown"
    : item.availability;
  const availabilityText =
    playbackEnabled && item.kind === "series"
      ? checkStatus === "checking"
        ? `Checking ${episodeCode ?? "first episode"}…`
        : checkStatus === "failed"
          ? `${episodeCode ?? "First episode"} unavailable · see episodes`
          : checkStatus === "ready"
            ? item.availability === "available" ||
              item.availability === "partial"
              ? episodeCode
                ? `${episodeCode} ready${item.formats[0]?.label ? ` · ${item.formats[0].label}` : ""}`
                : `First episode ready · ${availabilityLabel(item)}`
              : `${episodeCode ?? "First episode"} ready on streaming source`
            : availabilityLabel(item)
      : playbackEnabled
        ? checkStatus === "checking"
          ? "Checking streaming availability…"
          : checkStatus === "failed"
            ? "Sorry, currently unavailable"
            : checkStatus === "ready" &&
                item.availability !== "available" &&
                item.availability !== "partial"
              ? "Verified on streaming source"
              : availabilityLabel(item)
        : availabilityLabel(item);

  useEffect(() => {
    if (playbackEnabled && onCheck)
      onCheck(item, item.kind === "series" ? defaultEpisode : undefined);
  }, [item, onCheck, playbackEnabled, defaultEpisode]);

  const score = ratingPercent(item);
  const ratingCardClass =
    score === null
      ? ""
      : score >= 90
        ? "title-card--rating-excellent"
        : score >= 80
          ? "title-card--rating-good"
          : "";
  const ratingBadgeClass =
    score === null
      ? ""
      : score >= 90
        ? "title-card__rating--excellent"
        : score >= 80
          ? "title-card__rating--good"
          : score < 60
            ? "title-card__rating--low"
            : "";

  const classNames = [
    "title-card",
    ratingCardClass,
    onOpen ? "title-card--openable" : "",
    hero ? "title-card--hero" : "",
    displayAvailability === "unavailable" ? "title-card--unavailable" : "",
    displayAvailability === "unknown" ? "title-card--unknown" : "",
    playbackEnabled && item.kind !== "series" && checkStatus === "failed"
      ? "title-card--playback-unavailable"
      : "",
    item.kind === "series" && !episodeCode ? "title-card--series" : "",
    episodeCode ? "title-card--episode" : "",
    item.kind === "series" &&
    item.seriesCoverage &&
    !item.seriesCoverage.complete
      ? "title-card--searching"
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const artwork = item.posterUrl ? (
    <img src={item.posterUrl} alt="" />
  ) : (
    <>
      <span>{item.title.slice(0, 1)}</span>
      <i />
    </>
  );

  return (
    <article
      className={classNames}
      style={{ "--card-accent": item.accentColor } as React.CSSProperties}
      aria-busy={pendingAction ? "true" : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") playCardHoverTick();
      }}
      onClick={(event) => {
        if (
          !onOpen ||
          (event.target as HTMLElement).closest(
            "button, a, input, select, textarea",
          )
        )
          return;
        openDetails();
      }}
    >
      {onOpen ? (
        <button
          className="title-card__art title-card__art--button"
          type="button"
          onClick={openDetails}
          aria-label={`Details for ${item.title}${episodeCode ? ` ${episodeCode}` : ""}`}
        >
          {artwork}
        </button>
      ) : (
        <div className="title-card__art" aria-hidden="true">
          {artwork}
        </div>
      )}
      <div className="title-card__content">
        <div className="title-card__topline">
          <div className="title-card__topline-copy">
            {hero && <p className="eyebrow title-card__label">Best match</p>}
            {episodeCode && (
              <p className="title-card__episode-label">
                {item.title} · {episodeCode}
              </p>
            )}
            <div className="title-card__chips">
              <span>
                {episodeCode
                  ? "Episode"
                  : item.kind === "series"
                    ? "Series"
                    : "Movie"}
                {!episodeCode && item.year ? ` · ${item.year}` : ""}
              </span>
              {!episodeCode && (
                <span
                  className={`title-card__rating ${ratingBadgeClass}`}
                  aria-label={
                    score !== null && score < 60
                      ? `${ratingLabel(item)}, low rating`
                      : undefined
                  }
                >
                  {ratingLabel(item)}
                  {score !== null && score < 60 && (
                    <b
                      className="title-card__rating-warning"
                      aria-hidden="true"
                    >
                      !
                    </b>
                  )}
                </span>
              )}
              {item.matchPercent !== null && (
                <span>Match {item.matchPercent}%</span>
              )}
              {/* Keep source selection in the detail view; tiles only show the source count. */}
              {alternateSources.length > 1 && (
                <span>{alternateSources.length} sources</span>
              )}
            </div>
          </div>
          <div className="title-card__indicators">
            {(downloadable || availableOffline) && (
              <span
                className={`title-card__downloadable${availableOffline ? " is-downloaded" : ""}`}
                role="img"
                aria-label={
                  availableOffline ? "Available offline" : "Downloadable"
                }
                title={
                  availableOffline
                    ? "Available offline"
                    : "Available to save offline"
                }
              >
                <DownloadGlyph checked={availableOffline} />
              </span>
            )}
            <SourceOriginStack providerIds={sourceProviderIds} />
          </div>
        </div>
        <h3>
          {onOpen ? (
            <button
              className="title-card__title-button"
              type="button"
              onClick={openDetails}
              aria-label={`Details for ${item.title}${episodeCode ? ` ${episodeCode}` : ""}`}
            >
              {displayTitle}
            </button>
          ) : (
            displayTitle
          )}
        </h3>
        {reason && !episodeCode && (
          <p className="title-card__reason">{reason}</p>
        )}
        {(episodeCode ? episodeSynopsis : hero ? item.synopsis : null) && (
          <p className="title-card__synopsis">
            {episodeCode ? episodeSynopsis : item.synopsis}
          </p>
        )}
        <p className="title-card__availability">
          <span
            className={`availability-dot availability-dot--${playbackEnabled && item.kind !== "series" && checkStatus === "failed" ? "playback-failed" : playbackEnabled && checkStatus === "ready" ? "available" : displayAvailability}`}
            aria-hidden="true"
          />
          {availabilityText}
        </p>
        {languageLabel && (
          <p
            className="title-card__languages"
            aria-label={`Audio languages: ${languageBadges?.map((badge) => badge.label).join(", ") ?? languageLabel.text}${languageLabel.warning ? "; no preferred audio or subtitles" : ""}`}
          >
            {languageBadges?.map((badge) => (
              <span
                className={`title-card__language-badge title-card__language-badge--${badge.priority}${badge.warning ? " title-card__language-badge--warning" : ""}`}
                key={badge.label}
              >
                {badge.label}
              </span>
            ))}
          </p>
        )}
        {playbackEnabled &&
          item.kind !== "series" &&
          checkStatus === "failed" && (
            <p className="title-card__playback-error" role="status">
              {playbackCheck?.status === "failed"
                ? playbackCheck.message
                : "Sorry, this title is currently unavailable."}
            </p>
          )}
        {item.seriesCoverage && !episodeCode && (
          <p className="series-coverage">
            {item.seriesCoverage.seasonsAvailable}/
            {item.seriesCoverage.seasonsTotal} seasons ·{" "}
            {item.seriesCoverage.episodesAvailable}/
            {item.seriesCoverage.episodesTotal} episodes
            {!item.seriesCoverage.complete && <span> · • searching...</span>}
          </p>
        )}
        {item.progressPercent !== null && (
          <div
            className="progress-track"
            aria-label={`${Math.round(item.progressPercent)}% watched`}
          >
            <span style={{ width: `${item.progressPercent}%` }} />
          </div>
        )}
        <div className="title-card__actions">
          {onOpen && (
            <button
              className="button button--secondary button--compact"
              type="button"
              onClick={openDetails}
            >
              Details
            </button>
          )}
          {episodeCode && onOpen && (
            <button
              className="button button--secondary button--compact"
              type="button"
              onClick={() => onOpen(item)}
            >
              More episodes
            </button>
          )}
          {item.kind === "series" && onOpen ? (
            <button
              className={`button button--${checkStatus === "failed" ? "secondary" : "primary"} button--compact${checkStatus === "ready" ? " button--play-action" : ""}${checkStatus === "checking" || pendingAction === "play" ? " button--checking" : ""}`}
              type="button"
              onFocus={() => {
                if (checkStatus === "ready") playCardHoverTick();
              }}
              disabled={
                pendingAction !== undefined || checkStatus === "checking"
              }
              onClick={() =>
                checkStatus === "ready"
                  ? onPlay(item, defaultEpisode)
                  : openDetails()
              }
            >
              {checkStatus === "checking"
                ? "Checking"
                : pendingAction === "play"
                  ? "Starting…"
                  : checkStatus === "ready"
                    ? playAction
                    : "Episodes"}
            </button>
          ) : (
            canShowPlayback &&
            playbackEnabled && (
              <button
                className={`button button--${checkStatus === "failed" ? "warning" : "primary"} button--compact${checkStatus === "ready" ? " button--play-action" : ""}${
                  checkStatus === "checking" || pendingAction === "play"
                    ? " button--checking"
                    : ""
                }`}
                type="button"
                onFocus={() => {
                  if (checkStatus === "ready") playCardHoverTick();
                }}
                onClick={() =>
                  checkStatus === "failed" ? onCheck?.(item) : onPlay(item)
                }
                disabled={
                  pendingAction !== undefined || checkStatus === "checking"
                }
              >
                {checkStatus === "checking"
                  ? "Checking"
                  : pendingAction === "play"
                    ? "Starting…"
                    : checkStatus === "failed"
                      ? "Retry check"
                      : playAction}
              </button>
            )
          )}
          {playable && !playbackEnabled && item.kind !== "series" && (
            <button
              className="button button--secondary button--compact"
              type="button"
              disabled
              title="Connect a streaming source to enable playback"
            >
              Streaming source required
            </button>
          )}
          {item.inLibrary ? (
            onRemove ? (
              <button
                className="button button--secondary button--compact"
                type="button"
                onClick={() => onRemove(item)}
                disabled={pendingAction !== undefined}
              >
                {pendingAction === "remove" ? "Removing…" : "Remove"}
              </button>
            ) : (
              <span className="in-library">✓ In Library</span>
            )
          ) : (
            <button
              className="button button--secondary button--compact"
              type="button"
              onClick={() => onAdd(item)}
              disabled={pendingAction !== undefined}
            >
              {pendingAction === "add" ? "Adding…" : "+ Add to Library"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
