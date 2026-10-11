import type {
  CatalogTitle,
  EpisodeSelection,
  TitleDetail,
  TitleSource,
} from "@streamer-ai/contracts";
import type { PlaybackCheckResult, StreamerApi } from "../api/client";

export type RetryPlaybackResult = {
  ready: boolean;
  check?: PlaybackCheckResult;
  detail?: TitleDetail;
  sources?: TitleSource[];
  searched: boolean;
};

/** An explicit retry checks known files before asking the provider for more. */
export async function retryPlaybackCheck(
  api: StreamerApi,
  profileId: string,
  title: CatalogTitle,
  episode?: EpisodeSelection,
): Promise<RetryPlaybackResult> {
  try {
    const check = await api.checkPlayback(profileId, title.id, episode);
    return { ready: true, check, searched: false };
  } catch {
    // Known files failed; search for replacements only on this explicit action.
  }

  const search =
    title.kind === "series" && episode
      ? await api.forceEpisodeSearch(profileId, title.id, episode)
      : await api.forceTitleSearch(profileId, title.id);
  const hasSources =
    "sources" in search ? search.sources.length > 0 : search.foundSources > 0;
  if (!hasSources) return { ready: false, ...search, searched: true };
  try {
    const check = await api.checkPlayback(profileId, title.id, episode);
    return { ready: true, check, ...search, searched: true };
  } catch {
    return { ready: false, ...search, searched: true };
  }
}
