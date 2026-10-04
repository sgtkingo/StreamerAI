import type {
  PlaybackAudioTrack,
  PlaybackMediaInfo,
  PlaybackPreferences,
} from "@streamer-ai/contracts";

export const DEFAULT_PLAYBACK_PREFERENCES: PlaybackPreferences = {
  primaryAudioLanguage: "cs",
  secondaryAudioLanguage: "en",
  autoFindSubtitles: false,
  primaryAudioSubtitleLanguage: "off",
  secondaryAudioSubtitleLanguage: "cs",
  audioOutputDeviceId: "default",
  subtitleSizePercent: 100,
  subtitleColor: "#ffffff",
  subtitleFont: "sans",
};

const languageAliases: Record<string, string[]> = {
  cs: ["cs", "ces", "cze"],
  en: ["en", "eng"],
  sk: ["sk", "slk", "slo"],
  de: ["de", "deu", "ger"],
  fr: ["fr", "fra", "fre"],
  es: ["es", "spa"],
  it: ["it", "ita"],
  pl: ["pl", "pol"],
  ja: ["ja", "jpn"],
};

function matchesLanguage(actual: string | null, preferred: string): boolean {
  return (
    actual !== null &&
    (languageAliases[preferred] ?? [preferred]).includes(actual.toLowerCase())
  );
}

export function preferredAudioTrack(
  info: PlaybackMediaInfo,
  preferences: PlaybackPreferences,
): PlaybackAudioTrack | undefined {
  return (
    info.audioTracks.find((track) =>
      matchesLanguage(track.language, preferences.primaryAudioLanguage),
    ) ??
    info.audioTracks.find((track) =>
      matchesLanguage(track.language, preferences.secondaryAudioLanguage),
    ) ??
    info.audioTracks[0]
  );
}

export function preferredEmbeddedSubtitle(
  info: PlaybackMediaInfo,
  preferences: PlaybackPreferences,
  audio: PlaybackAudioTrack | undefined,
): string {
  if (!preferences.autoFindSubtitles || !audio) return "off";
  const desired = matchesLanguage(
    audio.language,
    preferences.primaryAudioLanguage,
  )
    ? preferences.primaryAudioSubtitleLanguage
    : matchesLanguage(audio.language, preferences.secondaryAudioLanguage)
      ? preferences.secondaryAudioSubtitleLanguage
      : "off";
  if (desired === "off") return "off";
  const subtitle = info.subtitleTracks.find((track) =>
    matchesLanguage(track.language, desired),
  );
  return subtitle ? `embedded:${subtitle.streamIndex}` : "off";
}
