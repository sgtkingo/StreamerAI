import type { CatalogTitle, PlaybackPreferences } from "@streamer-ai/contracts";

type Languages = Pick<
  CatalogTitle["formats"][number],
  "audioLanguages" | "subtitleLanguages"
>;

const aliases: Record<string, string> = {
  cs: "cs",
  ces: "cs",
  cze: "cs",
  cz: "cs",
  czech: "cs",
  en: "en",
  eng: "en",
  english: "en",
  sk: "sk",
  slk: "sk",
  slo: "sk",
  slovak: "sk",
  de: "de",
  deu: "de",
  ger: "de",
  german: "de",
  fr: "fr",
  fra: "fr",
  fre: "fr",
  french: "fr",
  es: "es",
  spa: "es",
  spanish: "es",
  it: "it",
  ita: "it",
  italian: "it",
  pl: "pl",
  pol: "pl",
  polish: "pl",
  ja: "ja",
  jpn: "ja",
  jap: "ja",
  japanese: "ja",
  ko: "ko",
  kor: "ko",
  korean: "ko",
  zh: "zh",
  zho: "zh",
  chi: "zh",
  chinese: "zh",
};

const labels: Record<string, string> = {
  cs: "CZ",
  en: "ENG",
  sk: "SK",
  de: "DE",
  fr: "FR",
  es: "ES",
  it: "IT",
  pl: "PL",
  ja: "JAP",
  ko: "KOR",
  zh: "CHI",
};

function normalizeLanguage(value: string): string | null {
  const code = value.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (!code || code === "und" || code === "unknown") return null;
  return aliases[code] ?? (/^[a-z]{2,3}$/.test(code) ? code : null);
}

function uniqueLanguages(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map(normalizeLanguage)
        .filter((value): value is string => value !== null),
    ),
  ];
}

export interface TitleLanguageBadge {
  label: string;
  priority: "primary" | "secondary" | "other";
  warning: boolean;
}

export interface TitleLanguageLabel {
  text: string;
  warning: boolean;
}

interface DetailedTitleLanguageLabel extends TitleLanguageLabel {
  badges: TitleLanguageBadge[];
}

/** Shows verified tracks when present, otherwise the languages attached to catalogue formats. */
function titleLanguageDetails(
  title: CatalogTitle,
  preferences: PlaybackPreferences,
  checked?: Languages,
  showMissingSubtitleWarning = true,
): DetailedTitleLanguageLabel | null {
  const formats = title.formats;
  const audio = uniqueLanguages(
    checked
      ? checked.audioLanguages
      : formats.flatMap((format) => format.audioLanguages),
  );
  if (audio.length === 0) return null;

  const primary = normalizeLanguage(preferences.primaryAudioLanguage);
  const secondary = normalizeLanguage(preferences.secondaryAudioLanguage);
  const preferred = [
    ...new Set(
      [primary, secondary].filter((value): value is string => value !== null),
    ),
  ];
  const matches = preferred.filter((language) => audio.includes(language));
  const shown = matches.length > 0 ? matches : audio.slice(0, 3);
  let warning = false;
  const badges = shown.map((language) => {
    const label = labels[language] ?? language.toUpperCase();
    const hasSubtitles = checked
      ? checked.subtitleLanguages.length > 0
      : formats.some(
          (format) =>
            uniqueLanguages(format.audioLanguages).includes(language) &&
            format.subtitleLanguages.length > 0,
        );
    const missingPreferredSubtitles =
      language !== primary &&
      !preferred.includes(language) &&
      !hasSubtitles &&
      showMissingSubtitleWarning;
    if (missingPreferredSubtitles) warning = true;
    return {
      label: language !== primary && hasSubtitles ? `${label} (sub)` : label,
      priority:
        language === primary
          ? ("primary" as const)
          : language === secondary
            ? ("secondary" as const)
            : ("other" as const),
      warning: missingPreferredSubtitles,
    };
  });
  const text = shown
    .map((language) => {
      const label = labels[language] ?? language.toUpperCase();
      const hasSubtitles = checked
        ? checked.subtitleLanguages.length > 0
        : formats.some(
            (format) =>
              uniqueLanguages(format.audioLanguages).includes(language) &&
              format.subtitleLanguages.length > 0,
          );
      if (language === primary) return label;
      if (hasSubtitles) return `${label} (sub)`;
      if (!preferred.includes(language) && showMissingSubtitleWarning) {
        warning = true;
        return `${label} (!)`;
      }
      return label;
    })
    .join(", ");
  return { text, warning, badges };
}

export function titleLanguageLabel(
  title: CatalogTitle,
  preferences: PlaybackPreferences,
  checked?: Languages,
  showMissingSubtitleWarning = true,
): TitleLanguageLabel | null {
  const details = titleLanguageDetails(
    title,
    preferences,
    checked,
    showMissingSubtitleWarning,
  );
  return details ? { text: details.text, warning: details.warning } : null;
}

export function titleLanguageBadges(
  title: CatalogTitle,
  preferences: PlaybackPreferences,
  checked?: Languages,
  showMissingSubtitleWarning = true,
): TitleLanguageBadge[] | null {
  return (
    titleLanguageDetails(
      title,
      preferences,
      checked,
      showMissingSubtitleWarning,
    )?.badges ?? null
  );
}
