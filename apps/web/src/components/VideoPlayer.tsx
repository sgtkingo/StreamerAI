import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CatalogTitle,
  PlaybackGrant,
  PlaybackMediaInfo,
  PlaybackPreferences,
  EpisodeSelection,
  SeriesEpisodeDetail,
} from "@streamer-ai/contracts";
import type { StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";
import { applyAudioOutput } from "../audio-output";
import {
  preferredAudioTrack,
  preferredEmbeddedSubtitle,
} from "../playback-preferences";
import { Brand } from "./Brand";
import { adjacentEpisode, playableEpisodes } from "./episode-sequence";
import { subtitleFileToVtt } from "./subtitle-file";
import { parseWebVtt, subtitleTextAt, type SubtitleCue } from "./webvtt";

interface LocalSubtitle {
  id: string;
  name: string;
  url: string;
}

interface VideoPlayerProps {
  api: StreamerApi;
  profileId: string;
  title: CatalogTitle;
  grant: PlaybackGrant;
  episode?: EpisodeSelection;
  episodeTitle?: string;
  preferences: PlaybackPreferences;
  onPlayEpisode: (
    episode: EpisodeSelection,
    episodeTitle: string,
  ) => Promise<void>;
  onClose: () => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

function channelLabel(channels: number, layout: string | null): string {
  const known = /\b(?:2\.0|2\.1|5\.1|7\.1)\b/.exec(layout ?? "")?.[0];
  if (known) return known;
  if (channels === 1) return "Mono";
  if (channels === 2) return "2.0";
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  return `${channels} channels`;
}

function PauseIcon({ size }: { size: "overlay" | "control" }) {
  return (
    <span
      className={`video-player__pause-icon video-player__pause-icon--${size}`}
      aria-hidden="true"
    >
      <span />
      <span />
    </span>
  );
}

export function VideoPlayer({
  api,
  profileId,
  title,
  grant,
  episode,
  episodeTitle,
  preferences,
  onPlayEpisode,
  onClose,
}: VideoPlayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playToggleRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const localUrlsRef = useRef(new Set<string>());
  const resumeAfterLoadRef = useRef(true);
  const lastThumbnailAtRef = useRef(0);
  const progressRef = useRef(0);
  const positionSecondsRef = useRef(0);
  const durationSecondsRef = useRef(0);
  const lastProgressAtRef = useRef(0);
  const startedRef = useRef(false);
  const pauseResumePendingRef = useRef(false);
  const closingRef = useRef(false);
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseBurstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextEpisodeRef = useRef(false);
  const [info, setInfo] = useState<PlaybackMediaInfo | null>(null);
  const [loadingError, setLoadingError] = useState("");
  const [subtitleError, setSubtitleError] = useState("");
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [subtitleLoading, setSubtitleLoading] = useState(false);
  const [audioOutputError, setAudioOutputError] = useState("");
  const [playbackError, setPlaybackError] = useState("");
  const [selectedAudio, setSelectedAudio] = useState<number | null>(null);
  const [selectedSubtitle, setSelectedSubtitle] = useState("off");
  const [localSubtitles, setLocalSubtitles] = useState<LocalSubtitle[]>([]);
  const [menu, setMenu] = useState<"audio" | "subtitles" | null>(null);
  const [sourceStart, setSourceStart] = useState(0);
  const [sourceVersion, setSourceVersion] = useState(0);
  const [position, setPosition] = useState(0);
  const [scrubPosition, setScrubPosition] = useState<number | null>(null);
  const [preview, setPreview] = useState<{
    time: number;
    percent: number;
  } | null>(null);
  const [thumbnailAt, setThumbnailAt] = useState(0);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [hasEnded, setHasEnded] = useState(false);
  const [showPauseBurst, setShowPauseBurst] = useState(false);
  const [needsClick, setNeedsClick] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [resumePrompt, setResumePrompt] = useState(false);
  const [resumeCountdown, setResumeCountdown] = useState(5);
  const [resumeChosen, setResumeChosen] = useState(false);
  const [loadedEpisodeTitle, setLoadedEpisodeTitle] = useState<string | null>(
    null,
  );
  const [availableEpisodes, setAvailableEpisodes] = useState<
    SeriesEpisodeDetail[]
  >([]);
  const [nextEpisodeCountdown, setNextEpisodeCountdown] = useState<
    number | null
  >(null);
  const [findingNextEpisode, setFindingNextEpisode] = useState(false);
  const [episodeSwitching, setEpisodeSwitching] = useState(false);
  const [episodeError, setEpisodeError] = useState("");

  useEffect(() => {
    if (title.kind !== "series") return;
    let active = true;
    void api
      .getTitleDetail(profileId, title.id)
      .then((detail) => {
        if (!active) return;
        const episodes = playableEpisodes(
          detail.series?.seasons.flatMap((season) => season.episodes) ?? [],
        );
        setAvailableEpisodes(episodes);
        if (!episode || episodeTitle) return;
        const name = episodes.find(
          (item) =>
            item.seasonNumber === episode.seasonNumber &&
            item.episodeNumber === episode.episodeNumber,
        )?.title;
        if (name) setLoadedEpisodeTitle(name);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, profileId, title.id, title.kind, episode, episodeTitle]);

  const previousEpisode = adjacentEpisode(
    availableEpisodes,
    episode,
    "previous",
  );
  const nextEpisode = adjacentEpisode(availableEpisodes, episode, "next");

  const playEpisode = useCallback(
    async (item: SeriesEpisodeDetail) => {
      if (episodeSwitching) return;
      setEpisodeSwitching(true);
      setEpisodeError("");
      setFindingNextEpisode(false);
      setNextEpisodeCountdown(null);
      videoRef.current?.pause();
      try {
        await onPlayEpisode(
          {
            seasonNumber: item.seasonNumber,
            episodeNumber: item.episodeNumber,
          },
          item.title,
        );
      } catch (error) {
        setEpisodeSwitching(false);
        setEpisodeError(safeErrorMessage(error));
        if (!hasEnded)
          void videoRef.current?.play().catch(() => setNeedsClick(true));
      }
    },
    [episodeSwitching, hasEnded, onPlayEpisode],
  );

  useEffect(() => {
    if (cleanupTimerRef.current !== null) {
      clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
    let active = true;
    api
      .getPlaybackManifest(grant.grantId)
      .then((manifest) => {
        if (!active) return;
        const sameResumeEpisode =
          title.kind !== "series" ||
          (episode !== undefined &&
            title.resumeEpisode?.seasonNumber === episode.seasonNumber &&
            title.resumeEpisode?.episodeNumber === episode.episodeNumber);
        const savedPercent = sameResumeEpisode
          ? (title.progressPercent ?? 0)
          : 0;
        const resumeAt = sameResumeEpisode
          ? (title.resumePositionSeconds ??
            (title.kind === "movie" && manifest.durationSeconds !== null
              ? (manifest.durationSeconds * savedPercent) / 100
              : 0))
          : 0;
        const canResume =
          savedPercent >= 2 && savedPercent < 95 && resumeAt > 0;
        const audio = preferredAudioTrack(manifest, preferences);
        setInfo(manifest);
        setSelectedAudio(audio?.streamIndex ?? null);
        setSelectedSubtitle(
          preferredEmbeddedSubtitle(manifest, preferences, audio),
        );
        setSourceStart(resumeAt);
        setPosition(resumeAt);
        positionSecondsRef.current = resumeAt;
        durationSecondsRef.current = manifest.durationSeconds ?? 0;
        progressRef.current = resumeAt > 0 ? savedPercent : 0;
        setResumePrompt(canResume);
        setResumeChosen(!canResume);
      })
      .catch((error: unknown) => {
        if (active) setLoadingError(safeErrorMessage(error));
      });
    return () => {
      active = false;
      // StrictMode replays effects in development; do not revoke that live grant.
      cleanupTimerRef.current = setTimeout(() => {
        cleanupTimerRef.current = null;
        if (closingRef.current) return;
        const save = startedRef.current
          ? api.savePlaybackProgress(
              grant.grantId,
              progressRef.current,
              positionSecondsRef.current,
              durationSecondsRef.current,
            )
          : Promise.resolve();
        void save
          .catch(() => undefined)
          .finally(() =>
            api.closePlayback(grant.grantId).catch(() => undefined),
          );
      }, 0);
    };
  }, [
    api,
    grant.grantId,
    preferences,
    title.progressPercent,
    title.resumePositionSeconds,
    title.kind,
    title.resumeEpisode,
    episode,
  ]);

  useEffect(() => {
    if (!resumePrompt || resumeChosen || resumeCountdown <= 0) return;
    const timer = window.setTimeout(
      () => setResumeCountdown((seconds) => seconds - 1),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [resumePrompt, resumeChosen, resumeCountdown]);

  useEffect(() => {
    if (!resumePrompt || resumeCountdown > 0) return;
    setResumePrompt(false);
    setResumeChosen(true);
    const video = videoRef.current;
    if (video)
      void video
        .play()
        .then(() => setNeedsClick(false))
        .catch(() => setNeedsClick(true));
  }, [resumePrompt, resumeCountdown]);

  useEffect(() => {
    if (nextEpisodeCountdown === null || !nextEpisode) return;
    const timer = window.setTimeout(() => {
      if (nextEpisodeCountdown <= 1) void playEpisode(nextEpisode);
      else setNextEpisodeCountdown(nextEpisodeCountdown - 1);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [nextEpisodeCountdown, nextEpisode, playEpisode]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    const localUrls = localUrlsRef.current;
    document.body.style.overflow = "hidden";
    rootRef.current?.focus();
    return () => {
      document.body.style.overflow = oldOverflow;
      previous?.focus();
      for (const url of localUrls) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(
    () => () => {
      if (pauseBurstTimerRef.current !== null)
        clearTimeout(pauseBurstTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.altKey) return;
      event.preventDefault();
      setMuted(false);
      setVolume((current) =>
        Math.min(1, Math.max(0, current + (event.deltaY < 0 ? 0.05 : -0.05))),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = muted;
    }
  }, [volume, muted, sourceVersion]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video
        .play()
        .then(() => setNeedsClick(false))
        .catch(() => {
          setNeedsClick(true);
        });
    } else {
      pauseResumePendingRef.current = true;
      video.pause();
    }
  };

  const closePlayer = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    const save = startedRef.current
      ? api.savePlaybackProgress(
          grant.grantId,
          progressRef.current,
          positionSecondsRef.current,
          durationSecondsRef.current,
        )
      : Promise.resolve();
    void save
      .catch(() => undefined)
      .then(() => api.closePlayback(grant.grantId).catch(() => undefined))
      .finally(onClose);
  };

  const chooseResume = (continueWatching: boolean) => {
    setResumePrompt(false);
    setResumeChosen(true);
    setResumeCountdown(5);
    if (!continueWatching) {
      progressRef.current = 0;
      positionSecondsRef.current = 0;
      setPosition(0);
      setSourceStart(0);
      setSourceVersion((value) => value + 1);
      void api
        .savePlaybackProgress(grant.grantId, 0, 0, durationSecondsRef.current)
        .catch(() => undefined);
    }
    const video = videoRef.current;
    if (continueWatching && video) {
      void video
        .play()
        .then(() => setNeedsClick(false))
        .catch(() => setNeedsClick(true));
    } else {
      resumeAfterLoadRef.current = true;
    }
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          togglePlayback();
          const playToggle = playToggleRef.current;
          if (playToggle && document.activeElement === playToggle) {
            playToggle.blur();
          }
        }
        return;
      }
      if (event.key === "Escape") {
        if (document.fullscreenElement) return;
        closePlayer();
        return;
      }
      if (event.key === "Tab" && rootRef.current) {
        const focusable = Array.from(
          rootRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => element.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  });

  const duration = info?.durationSeconds ?? 0;
  const shownPosition = scrubPosition ?? position;
  const progress =
    duration > 0 ? Math.min(100, (shownPosition / duration) * 100) : 0;
  const isPaused =
    startedRef.current &&
    !playing &&
    !hasEnded &&
    !resumePrompt &&
    !episodeSwitching &&
    !playbackError;
  const mediaUrl = useMemo(() => {
    if (!info) return "";
    const parameters = new URLSearchParams({ start: sourceStart.toFixed(3) });
    if (selectedAudio !== null) parameters.set("audio", String(selectedAudio));
    return `${grant.url}/media?${parameters}`;
  }, [grant.url, info, selectedAudio, sourceStart]);

  const selectedLocal = localSubtitles.find(
    (track) => selectedSubtitle === `local:${track.id}`,
  );
  const selectedEmbedded = info?.subtitleTracks.find(
    (track) => selectedSubtitle === `embedded:${track.streamIndex}`,
  );
  const subtitleUrl =
    selectedLocal?.url ??
    (selectedEmbedded
      ? `${grant.url}/subtitles/${selectedEmbedded.streamIndex}`
      : null);
  const captionText = subtitleTextAt(subtitleCues, position);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !info) return;
    let active = true;
    const output = preferences.audioOutputDeviceId;
    void applyAudioOutput(video, output)
      .then((result) => {
        if (!active) return;
        setAudioOutputError(
          result === "unsupported"
            ? "This browser cannot select the saved audio output. Using the system default."
            : "",
        );
      })
      .catch(() => {
        if (!active) return;
        setAudioOutputError(
          "The selected audio output is unavailable. Using the system default.",
        );
        void applyAudioOutput(video, "default").catch(() => undefined);
      });
    return () => {
      active = false;
    };
  }, [info, preferences.audioOutputDeviceId, selectedAudio, sourceVersion]);

  useEffect(() => {
    setSubtitleCues([]);
    setSubtitleError("");
    setSubtitleLoading(subtitleUrl !== null);
    if (!subtitleUrl) return;
    const controller = new AbortController();
    void fetch(subtitleUrl, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Subtitle download failed.");
        const cues = parseWebVtt(await response.text());
        if (cues.length === 0)
          throw new Error("No readable subtitle cues found.");
        return cues;
      })
      .then((cues) => {
        if (controller.signal.aborted) return;
        setSubtitleCues(cues);
        setSubtitleLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setSubtitleLoading(false);
        setSubtitleError(
          "These subtitles could not be loaded. Choose another track or a local file.",
        );
      });
    return () => controller.abort();
  }, [subtitleUrl]);

  const restartAt = (seconds: number, audio = selectedAudio) => {
    const at = Math.min(Math.max(0, seconds), Math.max(0, duration - 0.2));
    if (duration > 0) progressRef.current = (at / duration) * 100;
    positionSecondsRef.current = at;
    resumeAfterLoadRef.current = videoRef.current
      ? !videoRef.current.paused
      : true;
    videoRef.current?.pause();
    setSelectedAudio(audio);
    setPosition(at);
    setSourceStart(at);
    setSourceVersion((value) => value + 1);
    setScrubPosition(null);
    setPreview(null);
    setPlaybackError("");
  };

  const commitSeek = (seconds: number) => {
    if (duration <= 0) return;
    restartAt(seconds);
  };

  const previewAtPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const percent = Math.max(
      0,
      Math.min(1, (event.clientX - bounds.left) / bounds.width),
    );
    const time = percent * duration;
    setPreview({ time, percent: percent * 100 });
    const now = Date.now();
    if (now - lastThumbnailAtRef.current >= 200) {
      lastThumbnailAtRef.current = now;
      setThumbnailAt(Math.floor(time / 5) * 5);
      setThumbnailFailed(false);
    }
  };

  const addSubtitleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) {
        throw new Error("Subtitle files must be smaller than 5 MB.");
      }
      const vtt = subtitleFileToVtt(file.name, await file.text());
      const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
      const track = { id: crypto.randomUUID(), name: file.name, url };
      localUrlsRef.current.add(url);
      setLocalSubtitles((current) => [...current, track]);
      setSelectedSubtitle(`local:${track.id}`);
      setSubtitleError("");
      setMenu(null);
    } catch (error) {
      setSubtitleError(
        error instanceof Error
          ? error.message
          : "The subtitle file could not be read.",
      );
    }
  };

  return (
    <div
      className="video-player"
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Playing ${title.title}`}
      tabIndex={-1}
    >
      <div
        className="video-player__stage"
        style={{
          backgroundImage:
            title.backdropUrl || title.posterUrl
              ? `linear-gradient(#0009, #000), url("${title.backdropUrl ?? title.posterUrl}")`
              : undefined,
        }}
      >
        {info && (
          <video
            key={`${sourceVersion}:${selectedAudio ?? "silent"}`}
            ref={videoRef}
            className={`video-player__video${isPaused ? " is-paused" : ""}`}
            src={mediaUrl}
            poster={title.backdropUrl ?? title.posterUrl ?? undefined}
            playsInline
            preload="auto"
            onCanPlay={() => {
              if (!resumeAfterLoadRef.current || resumePrompt) return;
              resumeAfterLoadRef.current = false;
              void videoRef.current
                ?.play()
                .then(() => setNeedsClick(false))
                .catch(() => setNeedsClick(true));
            }}
            onPlay={() => {
              startedRef.current = true;
              setHasEnded(false);
              setPlaying(true);
              if (pauseResumePendingRef.current) {
                pauseResumePendingRef.current = false;
                setShowPauseBurst(true);
                if (pauseBurstTimerRef.current !== null)
                  clearTimeout(pauseBurstTimerRef.current);
                pauseBurstTimerRef.current = setTimeout(
                  () => setShowPauseBurst(false),
                  650,
                );
              }
            }}
            onPause={() => {
              setPlaying(false);
              if (startedRef.current && duration > 0) {
                void api
                  .savePlaybackProgress(
                    grant.grantId,
                    progressRef.current,
                    positionSecondsRef.current,
                    durationSecondsRef.current,
                  )
                  .catch(() => undefined);
              }
            }}
            onTimeUpdate={(event) => {
              const at = sourceStart + event.currentTarget.currentTime;
              setPosition(at);
              positionSecondsRef.current = at;
              if (duration > 0) {
                progressRef.current = Math.min(100, (at / duration) * 100);
                if (
                  startedRef.current &&
                  Date.now() - lastProgressAtRef.current > 15_000
                ) {
                  lastProgressAtRef.current = Date.now();
                  void api
                    .savePlaybackProgress(
                      grant.grantId,
                      progressRef.current,
                      positionSecondsRef.current,
                      durationSecondsRef.current,
                    )
                    .catch(() => undefined);
                }
              }
            }}
            onEnded={() => {
              setPlaying(false);
              setHasEnded(true);
              if (duration > 0) setPosition(duration);
              progressRef.current = 100;
              skipNextEpisodeRef.current = false;
              if (nextEpisode) {
                setNextEpisodeCountdown(5);
              } else if (title.kind === "series" && episode) {
                setFindingNextEpisode(true);
                void api
                  .getTitleDetail(profileId, title.id)
                  .then((detail) => {
                    const refreshed = playableEpisodes(
                      detail.series?.seasons.flatMap(
                        (season) => season.episodes,
                      ) ?? [],
                    );
                    setAvailableEpisodes(refreshed);
                    if (
                      !skipNextEpisodeRef.current &&
                      adjacentEpisode(refreshed, episode, "next")
                    )
                      setNextEpisodeCountdown(5);
                  })
                  .catch(() => undefined)
                  .finally(() => setFindingNextEpisode(false));
              }
              void api
                .savePlaybackProgress(grant.grantId, 100, duration, duration)
                .catch(() => undefined);
            }}
            onLoadedData={() => setPlaybackError("")}
            onError={() => {
              setPlaying(false);
              setPlaybackError(
                "This video could not be played. Close the player and try again.",
              );
            }}
            onClick={togglePlayback}
          />
        )}
        {captionText && (
          <div
            className="video-player__captions"
            aria-live="off"
            style={{
              color: preferences.subtitleColor,
              fontFamily:
                preferences.subtitleFont === "serif"
                  ? "Georgia, serif"
                  : preferences.subtitleFont === "mono"
                    ? "Consolas, monospace"
                    : "Arial, sans-serif",
              fontSize: `clamp(${Math.round((16 * preferences.subtitleSizePercent) / 100)}px, ${(2.4 * preferences.subtitleSizePercent) / 100}vw, ${Math.round((30 * preferences.subtitleSizePercent) / 100)}px)`,
            }}
          >
            <span>{captionText}</span>
          </div>
        )}
        <div className="video-player__top">
          <div>
            <Brand className="brand--player" />
            <p className="video-player__eyebrow">Now playing</p>
            <h2>
              {title.title}
              {title.kind === "series" && episode && (
                <>
                  {" "}
                  <span aria-hidden="true">•</span> S
                  {String(episode.seasonNumber).padStart(2, "0")}E
                  {String(episode.episodeNumber).padStart(2, "0")}
                  {(episodeTitle || loadedEpisodeTitle) &&
                    ` · ${episodeTitle || loadedEpisodeTitle}`}
                </>
              )}
            </h2>
            {title.year && <small>{title.year}</small>}
          </div>
          <button
            type="button"
            className="video-player__icon-button video-player__close-button close-icon-button"
            onClick={closePlayer}
            aria-label="Close player"
          >
            ×
          </button>
        </div>

        {!info && !loadingError && (
          <div className="video-player__center-message" role="status">
            <span className="video-player__spinner" />
            Preparing your video…
          </div>
        )}
        {(loadingError || playbackError) && (
          <div
            className="video-player__center-message video-player__center-message--error"
            role="alert"
          >
            <strong>Playback unavailable</strong>
            <span>{loadingError || playbackError}</span>
            <button
              type="button"
              className="button button--secondary"
              onClick={closePlayer}
            >
              Back to StreamerAI
            </button>
          </div>
        )}
        {resumePrompt && info && (
          <div className="video-player__resume-backdrop">
            <section
              className="video-player__resume-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="resume-title"
            >
              <p className="video-player__eyebrow">Playback progress saved</p>
              <h3 id="resume-title">Continue watching?</h3>
              <p>
                Pick up at {formatTime(sourceStart)}, or start from the
                beginning.
              </p>
              <div className="video-player__resume-actions">
                <button
                  type="button"
                  className="button button--primary video-player__continue"
                  onClick={() => chooseResume(true)}
                >
                  <span style={{ animationDuration: "5s" }} />
                  <span className="video-player__continue-label">
                    Continue watching <small>{resumeCountdown}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="button button--secondary button--play-action"
                  onClick={() => chooseResume(false)}
                >
                  Play from the beginning
                </button>
              </div>
            </section>
          </div>
        )}
        {nextEpisodeCountdown !== null && nextEpisode && (
          <div className="video-player__next-episode-backdrop">
            <section
              className="video-player__next-episode"
              role="group"
              aria-label="Next episode"
              aria-live="polite"
            >
              <p className="video-player__eyebrow">Up next</p>
              <h3>
                S{String(nextEpisode.seasonNumber).padStart(2, "0")}E
                {String(nextEpisode.episodeNumber).padStart(2, "0")} ·{" "}
                {nextEpisode.title}
              </h3>
              <p>Starting in {nextEpisodeCountdown} seconds</p>
              <div className="video-player__next-episode-actions">
                <button
                  className="button button--primary button--play-action"
                  type="button"
                  disabled={episodeSwitching}
                  onClick={() => void playEpisode(nextEpisode)}
                >
                  Play now
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => {
                    skipNextEpisodeRef.current = true;
                    setNextEpisodeCountdown(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </section>
          </div>
        )}
        {findingNextEpisode && !nextEpisodeCountdown && (
          <div className="video-player__next-episode-backdrop">
            <section
              className="video-player__next-episode"
              role="status"
              aria-label="Finding next episode"
            >
              <p className="video-player__eyebrow">Up next</p>
              <h3>Checking for the next available episode…</h3>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => {
                  skipNextEpisodeRef.current = true;
                  setFindingNextEpisode(false);
                }}
              >
                Cancel autoplay
              </button>
            </section>
          </div>
        )}
        {(isPaused || showPauseBurst) && (
          <div
            className={`video-player__paused-indicator${showPauseBurst ? " is-resuming" : ""}`}
            aria-hidden="true"
          >
            <PauseIcon size="overlay" />
          </div>
        )}

        {info && (
          <div className="video-player__controls">
            {needsClick && !playing && !resumePrompt && (
              <p className="video-player__audio-notice" role="status">
                Press Play to start playback with sound.
              </p>
            )}
            {info.audioTracks.length === 0 && (
              <p className="video-player__audio-notice" role="status">
                No audio track was found in this file. Try another source.
              </p>
            )}
            {audioOutputError && (
              <p className="video-player__audio-notice" role="status">
                {audioOutputError}
              </p>
            )}
            {episodeError && (
              <p className="video-player__subtitle-error" role="alert">
                Could not start that episode: {episodeError}
              </p>
            )}
            {subtitleError && (
              <p className="video-player__subtitle-error" role="alert">
                {subtitleError}
              </p>
            )}
            {subtitleLoading && (
              <p className="video-player__audio-notice" role="status">
                Loading subtitles…
              </p>
            )}
            {duration > 0 && (
              <div
                className="video-player__timeline"
                onPointerMove={previewAtPointer}
                onPointerLeave={() => setPreview(null)}
              >
                {preview && (
                  <div
                    className="video-player__preview"
                    style={{ left: `${preview.percent}%` }}
                  >
                    {!thumbnailFailed && (
                      <img
                        src={`${grant.url}/thumbnail?at=${thumbnailAt}`}
                        alt=""
                        onError={() => setThumbnailFailed(true)}
                      />
                    )}
                    <span>{formatTime(preview.time)}</span>
                  </div>
                )}
                <input
                  className="video-player__seek"
                  type="range"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={Math.min(shownPosition, duration)}
                  style={
                    { "--seek-progress": `${progress}%` } as React.CSSProperties
                  }
                  aria-label="Seek through video"
                  aria-valuetext={`${formatTime(shownPosition)} of ${formatTime(duration)}`}
                  onChange={(event) =>
                    setScrubPosition(Number(event.target.value))
                  }
                  onPointerUp={(event) =>
                    commitSeek(Number(event.currentTarget.value))
                  }
                  onKeyUp={(event) => {
                    if (
                      [
                        "ArrowLeft",
                        "ArrowRight",
                        "Home",
                        "End",
                        "PageUp",
                        "PageDown",
                      ].includes(event.key)
                    ) {
                      commitSeek(Number(event.currentTarget.value));
                    }
                  }}
                />
              </div>
            )}
            <div className="video-player__control-row">
              {title.kind === "series" && episode && (
                <>
                  <button
                    type="button"
                    className="video-player__episode-button"
                    disabled={!previousEpisode || episodeSwitching}
                    onClick={() =>
                      previousEpisode && void playEpisode(previousEpisode)
                    }
                    aria-label={
                      previousEpisode
                        ? `Play previous episode, season ${previousEpisode.seasonNumber}, episode ${previousEpisode.episodeNumber}`
                        : "No previous episode available"
                    }
                  >
                    ‹ Previous
                  </button>
                  <button
                    type="button"
                    className="video-player__episode-button"
                    disabled={!nextEpisode || episodeSwitching}
                    onClick={() => nextEpisode && void playEpisode(nextEpisode)}
                    aria-label={
                      nextEpisode
                        ? `Play next episode, season ${nextEpisode.seasonNumber}, episode ${nextEpisode.episodeNumber}`
                        : "No next episode available"
                    }
                  >
                    Next ›
                  </button>
                </>
              )}
              <span className="video-player__time">
                {formatTime(shownPosition)}{" "}
                <span>/ {duration > 0 ? formatTime(duration) : "—"}</span>
              </span>
              <div className="video-player__spacer" />
              <button
                type="button"
                className="video-player__icon-button video-player__play-toggle"
                ref={playToggleRef}
                onClick={togglePlayback}
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? <PauseIcon size="control" /> : "▶"}
              </button>
              <button
                type="button"
                className="video-player__icon-button"
                onClick={() => {
                  if (muted || volume === 0) {
                    setMuted(false);
                    if (volume === 0) setVolume(0.5);
                  } else {
                    setMuted(true);
                  }
                }}
                aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="video-player__volume-icon"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3.5 9v6H8l5 4V5L8 9H3.5Z" />
                  {!muted && volume > 0 && (
                    <path d="M16 9.2a4.2 4.2 0 0 1 0 5.6" />
                  )}
                  {!muted && volume >= 0.5 && (
                    <path d="M18.7 6.6a8 8 0 0 1 0 10.8" />
                  )}
                  {(muted || volume === 0) && (
                    <path
                      className="video-player__volume-mute-mark"
                      d="m16.2 9.2 5.1 5.6m0-5.6-5.1 5.6"
                    />
                  )}
                </svg>
              </button>
              <input
                className="video-player__volume"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(event) => {
                  setVolume(Number(event.target.value));
                  setMuted(false);
                }}
                aria-label="Volume"
              />
              <div className="video-player__menu-anchor">
                <button
                  type="button"
                  className="video-player__text-button"
                  onClick={() => setMenu(menu === "audio" ? null : "audio")}
                  aria-expanded={menu === "audio"}
                >
                  Audio
                </button>
                {menu === "audio" && (
                  <div
                    className="video-player__menu"
                    role="group"
                    aria-label="Audio tracks"
                  >
                    <strong>Audio tracks</strong>
                    {info.audioTracks.length === 0 && (
                      <span>No audio tracks</span>
                    )}
                    {info.audioTracks.map((track, index) => (
                      <button
                        type="button"
                        key={track.streamIndex}
                        className={
                          selectedAudio === track.streamIndex
                            ? "is-selected"
                            : ""
                        }
                        onClick={() => {
                          restartAt(position, track.streamIndex);
                          if (preferences.autoFindSubtitles)
                            setSelectedSubtitle(
                              preferredEmbeddedSubtitle(
                                info,
                                preferences,
                                track,
                              ),
                            );
                          setMenu(null);
                        }}
                      >
                        <span>
                          {track.title ??
                            track.language?.toUpperCase() ??
                            `Track ${index + 1}`}
                        </span>
                        <small>
                          {channelLabel(track.channels, track.channelLayout)} ·{" "}
                          {track.codec.toUpperCase()}
                        </small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="video-player__menu-anchor">
                <button
                  type="button"
                  className="video-player__text-button"
                  onClick={() =>
                    setMenu(menu === "subtitles" ? null : "subtitles")
                  }
                  aria-expanded={menu === "subtitles"}
                >
                  Subtitles
                </button>
                {menu === "subtitles" && (
                  <div
                    className="video-player__menu"
                    role="group"
                    aria-label="Subtitle tracks"
                  >
                    <strong>Subtitles</strong>
                    <button
                      type="button"
                      className={
                        selectedSubtitle === "off" ? "is-selected" : ""
                      }
                      onClick={() => {
                        setSelectedSubtitle("off");
                        setMenu(null);
                      }}
                    >
                      Off
                    </button>
                    {info.subtitleTracks.map((track, index) => (
                      <button
                        type="button"
                        key={track.streamIndex}
                        className={
                          selectedSubtitle === `embedded:${track.streamIndex}`
                            ? "is-selected"
                            : ""
                        }
                        onClick={() => {
                          setSelectedSubtitle(`embedded:${track.streamIndex}`);
                          setMenu(null);
                        }}
                      >
                        {track.title ??
                          track.language?.toUpperCase() ??
                          `Embedded ${index + 1}`}
                      </button>
                    ))}
                    {localSubtitles.map((track) => (
                      <button
                        type="button"
                        key={track.id}
                        className={
                          selectedSubtitle === `local:${track.id}`
                            ? "is-selected"
                            : ""
                        }
                        onClick={() => {
                          setSelectedSubtitle(`local:${track.id}`);
                          setMenu(null);
                        }}
                      >
                        {track.name}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="video-player__add-subtitle"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      + Load subtitle file
                    </button>
                  </div>
                )}
              </div>
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                accept=".srt,.vtt,.ass,.ssa,text/vtt"
                aria-label="Choose subtitle file"
                onChange={(event) => {
                  void addSubtitleFile(event.currentTarget.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
              <button
                type="button"
                className="video-player__icon-button"
                onClick={() => {
                  if (document.fullscreenElement)
                    void document.exitFullscreen();
                  else void rootRef.current?.requestFullscreen();
                }}
                aria-label="Toggle full screen"
              >
                ⛶
              </button>
            </div>
            <p className="video-player__hint">
              Space / Alt+Space: play or pause · Alt+wheel: volume
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
