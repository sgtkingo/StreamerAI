import { useCallback, useRef, useState } from "react";
import type { CatalogTitle, EpisodeSelection } from "@streamer-ai/contracts";
import type { StreamerApi } from "../api/client";
import { safeErrorMessage } from "../api/client";

export type PlaybackCheckState =
  | { status: "checking" }
  | {
      status: "ready";
      audioLanguages?: string[];
      subtitleLanguages?: string[];
    }
  | { status: "failed"; message: string };

function checkKey(title: CatalogTitle, episode?: EpisodeSelection): string {
  if (title.kind !== "series") return title.id;
  const selected = episode ??
    title.resumeEpisode ?? { seasonNumber: 1, episodeNumber: 1 };
  return `${title.id}:s${selected.seasonNumber}e${selected.episodeNumber}`;
}

/** Checks visible page titles without minting or invalidating playback grants. */
export function usePlaybackChecks(api: StreamerApi, profileId: string) {
  const [states, setStates] = useState<Map<string, PlaybackCheckState>>(
    () => new Map(),
  );
  const statesRef = useRef(states);
  const queue = useRef<
    Array<{ title: CatalogTitle; episode?: EpisodeSelection }>
  >([]);
  const active = useRef(0);
  const pumpRef = useRef<() => void>(() => undefined);

  statesRef.current = states;

  pumpRef.current = () => {
    while (active.current < 3 && queue.current.length > 0) {
      const request = queue.current.shift();
      if (!request) continue;
      const { title, episode } = request;
      const key = checkKey(title, episode);
      active.current += 1;
      void api
        .checkPlayback(profileId, title.id, episode)
        .then((result) => {
          const next = new Map(statesRef.current);
          next.set(key, {
            status: "ready",
            audioLanguages: result.audioLanguages,
            subtitleLanguages: result.subtitleLanguages,
          });
          statesRef.current = next;
          setStates(next);
        })
        .catch((error: unknown) => {
          const next = new Map(statesRef.current);
          next.set(key, {
            status: "failed",
            message: safeErrorMessage(error),
          });
          statesRef.current = next;
          setStates(next);
        })
        .finally(() => {
          active.current -= 1;
          pumpRef.current();
        });
    }
  };

  const check = useCallback(
    (title: CatalogTitle, episode?: EpisodeSelection) => {
      const key = checkKey(title, episode);
      const current = statesRef.current.get(key);
      if (current?.status === "checking" || current?.status === "ready") return;
      const next = new Map(statesRef.current);
      next.set(key, { status: "checking" });
      statesRef.current = next;
      setStates(next);
      queue.current.push({ title, ...(episode ? { episode } : {}) });
      pumpRef.current();
    },
    [],
  );

  const markFailed = useCallback(
    (title: CatalogTitle, message: string, episode?: EpisodeSelection) => {
      const next = new Map(statesRef.current);
      next.set(checkKey(title, episode), { status: "failed", message });
      statesRef.current = next;
      setStates(next);
    },
    [],
  );

  const stateFor = (title: CatalogTitle, episode?: EpisodeSelection) =>
    states.get(checkKey(title, episode));
  return { check, markFailed, stateFor };
}
