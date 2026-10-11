/**
 * A small, deterministic route for requests that describe a type of title
 * rather than naming a title. Genre names match catalog metadata names.
 */
export interface ThematicDiscoveryIntent {
  kind: "movie" | "series" | null;
  genres: string[];
  completeOnly: boolean;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const GENRES: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "Science fiction",
    /\b(?:sci fi|sci fy|scifi|scify|science fiction|sciencefiction|vedecka fantastika|vedeckofantastick\w*|wissenschaftsfiktion)\b/,
  ],
  [
    "Mystery",
    /\b(?:mystery|mysteries|mysterium|mysterios\w*|zahad\w*|detektiv\w*)\b/,
  ],
  ["Comedy", /\b(?:comedy|comedies|komedi\w*|komod\w*)\b/],
  ["Crime", /\b(?:crime|criminal|krimi\w*|kriminal\w*|zlocin\w*)\b/],
  ["Thriller", /\b(?:thriller\w*|napinav\w*)\b/],
  ["Drama", /\b(?:drama\w*|dram\w*)\b/],
  ["Fantasy", /\b(?:fantasy|fantasie|fantazia|fantastick\w*)\b/],
  ["Horror", /\b(?:horror\w*|horor\w*)\b/],
  ["Romance", /\b(?:romance|romantic\w*|romantik\w*|romantick\w*)\b/],
  ["Animation", /\b(?:animation|animated|animovan\w*|zeichentrick\w*)\b/],
  ["Adventure", /\b(?:adventure|dobrodruz\w*|abenteuer\w*)\b/],
  ["Action", /\b(?:action|akcni|aktionsfilm\w*)\b/],
  ["Documentary", /\b(?:documentar\w*|dokument\w*)\b/],
];

const MOVIE_WORDS =
  /\b(?:movie|movies|film|films|filmy|filmu|filme|spielfilm\w*)\b/;
const SERIES_WORDS =
  /\b(?:series|serial\w*|serie|serien|miniseries|mini series|tv show|tv shows|tv serie\w*)\b/;
const COMPLETE_WORDS =
  /\b(?:complete|completed|finished|concluded|ended|all seasons|all episodes|dokoncen\w*|dokoncov\w*|uzavren\w*|kompletni|komplet\w*|abgeschlossen\w*|beendet\w*|vollstandig\w*|alle staffeln)\b/;

// Explicitly named titles belong in catalog title search, even if their names
// contain a genre word. Quotes and "called" are strong signals across languages.
const TITLE_SIGNALS =
  /\b(?:called|titled|named|entitled|s nazvem|jmenem|ktery se jmenuje|namens|heisst|mit dem titel)\b/;

/** Returns null when the text does not clearly request genre discovery. */
export function parseThematicDiscoveryIntent(
  message: string,
): ThematicDiscoveryIntent | null {
  if (!message.trim()) return null;
  if (/["“”„«»`]/u.test(message)) return null;
  // Genre discovery cannot enforce a person or a comparison title. Preserve
  // those requests for the agent and its title-level catalog validation.
  if (
    /\b(?:with|starring|featuring|mit|s|se)\s+[A-Z][\p{L}'-]+\s+[A-Z][\p{L}'-]+/u.test(
      message,
    ) ||
    /\b(?:like|similar to|jako|podobn\p{L}*|wie)\s+\S+/iu.test(message)
  )
    return null;

  const text = normalize(message);
  if (TITLE_SIGNALS.test(text)) return null;

  const genres = GENRES.filter(([, pattern]) => pattern.test(text))
    .map(([genre]) => genre)
    .slice(0, 3);
  if (genres.length === 0) return null;

  const movie = MOVIE_WORDS.test(text);
  const series = SERIES_WORDS.test(text);
  const kind = movie === series ? null : movie ? "movie" : "series";
  // TMDB does not offer these as TV genres. Let title-level discovery handle
  // the request instead of presenting an empty genre feed as a real result.
  if (
    kind === "series" &&
    genres.some((genre) => ["Horror", "Romance", "Thriller"].includes(genre))
  )
    return null;

  // "Mystery on the Orient Express" and similar phrases are usually names,
  // whereas "a mystery for tonight" describes a category of recommendation.
  const directTitleShape =
    /^(?:find|search|look for|najdi|suche)?\s*(?:the|ten|die|das)?\s*(?:mystery|zahad\w*|sci fi|scifi|scify)\s+(?:of|on|in|at|na|v|im|am)\b/.test(
      text,
    );
  if (directTitleShape && kind === null) return null;

  const titleCaseName =
    /^(?:(?:[Ff]ind|[Ss]earch(?: for)?|[Ll]ook for)\s+)?(?:[Tt]he\s+)?(?:Mystery|Crime|Fantasy|Comedy|Horror|Drama|Thriller|Sci[- ]?Fi)\s+[A-Z][a-z]/.test(
      message.trim(),
    );
  if (
    titleCaseName &&
    kind === null &&
    !/\b(?:for tonight|tonight|something|anything)\b/.test(text)
  ) {
    return null;
  }

  return {
    kind,
    genres,
    completeOnly: kind === "series" && COMPLETE_WORDS.test(text),
  };
}
