import { createHash, randomUUID } from "node:crypto";
import {
  assertConnectorAttribution,
  ExternalSubtitleTrackSchema,
  SubtitleAssetSchema,
  SubtitleCandidateSchema,
  SubtitleSearchRequestSchema,
  type ExternalSubtitleTrack,
  type ProviderContext,
  type ProviderRegistry,
  type SubtitleCandidate,
  type SubtitleProvider,
} from "@streamer-ai/contracts";
import type { ExternalSubtitleSource } from "../routes/playback.js";
import type { PlaybackTicketRecord } from "./playback-ticket-store.js";
import { MAX_EXTERNAL_SUBTITLE_BYTES } from "./external-subtitle-service.js";

const SEARCH_DEADLINE_MS = 8_000;
const FETCH_DEADLINE_MS = 20_000;
const MAX_TRACKS = 20;

type TitleIdentity = {
  kind: "movie" | "series";
  title: string;
  year: number | null;
};

type Selection =
  | { kind: "legacy"; track: ExternalSubtitleTrack }
  | {
      kind: "provider";
      track: ExternalSubtitleTrack;
      candidate: SubtitleCandidate;
      provider: SubtitleProvider;
    };

export interface MultiSourceSubtitleOptions {
  /** Existing Webshare sibling-file discovery remains a first-class source. */
  legacy?: ExternalSubtitleSource;
  providers: ProviderRegistry<SubtitleProvider>;
  titleForTicket: (ticket: PlaybackTicketRecord) => TitleIdentity | null;
  localeForProfile: (profileId: string) => "cs" | "en" | "de";
  isEnabled: (providerId: string) => Promise<boolean>;
  /** Opaque secret-store pointer, never the credential or a browser value. */
  secretRefForProvider?: (
    providerId: string,
    ticket: PlaybackTicketRecord,
  ) => Promise<string | null> | string | null;
  onProviderFailure?: (providerId: string, phase: "search" | "fetch") => void;
  now?: () => Date;
}

function opaqueTrackId(grantId: string, candidate: SubtitleCandidate): string {
  return `sub_${createHash("sha256")
    .update(grantId)
    .update("\0")
    .update(candidate.ref.providerId)
    .update("\0")
    .update(candidate.ref.candidateId)
    .digest("base64url")}`;
}

function safeFilename(candidate: SubtitleCandidate, title: string): string {
  const stem = (candidate.releaseName ?? title)
    .replace(/[\\/<>:"|?*]/g, "_")
    .split("")
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .slice(0, 450)
    .trim();
  return `${stem || "subtitle"}.${candidate.language}.${candidate.format}`;
}

function trackScore(candidate: SubtitleCandidate): number {
  return Math.min(
    1,
    Math.max(
      0,
      candidate.matchConfidence * 0.85 + candidate.provenance.confidence * 0.15,
    ),
  );
}

function episodeMatches(
  releaseName: string | null,
  ticket: PlaybackTicketRecord,
): boolean {
  if (
    releaseName === null ||
    ticket.seasonNumber === null ||
    ticket.seasonNumber === undefined ||
    ticket.episodeNumber === null ||
    ticket.episodeNumber === undefined
  )
    return true;
  const explicit =
    /\bS(\d{1,2})[ ._-]*E(\d{1,3})\b/i.exec(releaseName) ??
    /\b(\d{1,2})x(\d{1,3})\b/i.exec(releaseName);
  if (!explicit) return true;
  return (
    Number(explicit[1]) === ticket.seasonNumber &&
    Number(explicit[2]) === ticket.episodeNumber
  );
}

/**
 * One active grant owns the discovered candidate-to-provider map. The browser
 * receives opaque track IDs only; fetch is authorized against this map.
 */
export class MultiSourceExternalSubtitleService {
  readonly #options: MultiSourceSubtitleOptions;
  readonly #now: () => Date;
  readonly #selections = new Map<string, Map<string, Selection>>();

  constructor(options: MultiSourceSubtitleOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  forget(grantId: string): void {
    this.#selections.delete(grantId);
  }

  async discover(
    ticket: PlaybackTicketRecord,
    signal?: AbortSignal,
  ): Promise<ExternalSubtitleTrack[]> {
    if (signal?.aborted) throw new Error("Subtitle discovery cancelled.");
    const title = this.#options.titleForTicket(ticket);
    const searches: Promise<Selection[]>[] = [];

    if (
      this.#options.legacy &&
      ticket.providerId === "webshare" &&
      ticket.sourceFilename
    ) {
      searches.push(
        this.#options.legacy
          .discover(ticket.variantId, ticket.sourceFilename, signal)
          .then((tracks) =>
            tracks.flatMap((item) => {
              const parsed = ExternalSubtitleTrackSchema.safeParse(item);
              return parsed.success
                ? [{ kind: "legacy" as const, track: parsed.data }]
                : [];
            }),
          )
          .catch(() => []),
      );
    }

    if (title) {
      for (const provider of this.#options.providers.list()) {
        searches.push(this.#searchProvider(provider, ticket, title, signal));
      }
    }

    const settled = await Promise.all(searches);
    if (signal?.aborted) throw new Error("Subtitle discovery cancelled.");
    const unique = new Map<string, Selection>();
    for (const selection of settled.flat()) {
      const previous = unique.get(selection.track.fileId);
      if (!previous || previous.track.matchScore < selection.track.matchScore)
        unique.set(selection.track.fileId, selection);
    }
    const ranked = [...unique.values()]
      .sort(
        (left, right) =>
          right.track.matchScore - left.track.matchScore ||
          left.track.filename.localeCompare(right.track.filename) ||
          left.track.fileId.localeCompare(right.track.fileId),
      )
      .slice(0, MAX_TRACKS);
    this.#selections.clear();
    this.#selections.set(
      ticket.grantId,
      new Map(ranked.map((selection) => [selection.track.fileId, selection])),
    );
    return ranked.map((selection) => selection.track);
  }

  async load(
    ticket: PlaybackTicketRecord,
    track: ExternalSubtitleTrack,
    signal?: AbortSignal,
  ): Promise<{ filename: string; content: string }> {
    const selection = this.#selections.get(ticket.grantId)?.get(track.fileId);
    if (!selection || selection.track.filename !== track.filename)
      throw new Error("Subtitle track is not part of the playback grant.");
    if (selection.kind === "legacy") {
      if (!this.#options.legacy)
        throw new Error("Subtitle source is unavailable.");
      return this.#options.legacy.load(track.fileId, signal);
    }

    const { candidate, provider } = selection;
    try {
      if (!(await this.#options.isEnabled(candidate.ref.providerId)))
        throw new Error("Subtitle provider is disconnected.");
      const context = await this.#context(
        ticket,
        candidate.ref.providerId,
        signal,
        FETCH_DEADLINE_MS,
      );
      const asset = await this.#bounded(context, FETCH_DEADLINE_MS, (bounded) =>
        provider.fetch(candidate.ref, bounded),
      );
      const parsed = SubtitleAssetSchema.parse(asset);
      assertConnectorAttribution(provider.descriptor(), parsed);
      if (
        parsed.ref.providerId !== candidate.ref.providerId ||
        parsed.ref.candidateId !== candidate.ref.candidateId ||
        parsed.provenance.providerId !== candidate.ref.providerId ||
        parsed.language !== candidate.language ||
        parsed.format !== candidate.format ||
        Buffer.byteLength(parsed.content, "utf8") >
          MAX_EXTERNAL_SUBTITLE_BYTES ||
        createHash("sha256").update(parsed.content, "utf8").digest("hex") !==
          parsed.checksumSha256.toLowerCase()
      ) {
        throw new Error("Subtitle provider returned a mismatched asset.");
      }
      return { filename: track.filename, content: parsed.content };
    } catch (error) {
      this.#options.onProviderFailure?.(candidate.ref.providerId, "fetch");
      throw error;
    }
  }

  async #searchProvider(
    provider: SubtitleProvider,
    ticket: PlaybackTicketRecord,
    title: TitleIdentity,
    signal?: AbortSignal,
  ): Promise<Selection[]> {
    const providerId = provider.descriptor().id;
    try {
      if (!(await this.#options.isEnabled(providerId))) return [];
      const locale = this.#options.localeForProfile(ticket.profileId);
      const request = SubtitleSearchRequestSchema.parse({
        titleId: ticket.titleId,
        kind: title.kind,
        title: title.title,
        year: title.year,
        seasonNumber: ticket.seasonNumber ?? null,
        episodeNumber: ticket.episodeNumber ?? null,
        languages: [...new Set([locale, "en"])],
        mediaHash: null,
        releaseName:
          ticket.sourceFilename && ticket.sourceFilename.length <= 500
            ? ticket.sourceFilename
            : null,
      });
      const context = await this.#context(
        ticket,
        providerId,
        signal,
        SEARCH_DEADLINE_MS,
      );
      const candidates = await this.#bounded(
        context,
        SEARCH_DEADLINE_MS,
        (bounded) => provider.search(request, bounded),
      );
      if (!Array.isArray(candidates))
        throw new Error("Invalid subtitle result.");
      return candidates.slice(0, 100).flatMap((item: unknown) => {
        const parsed = SubtitleCandidateSchema.safeParse(item);
        if (
          !parsed.success ||
          parsed.data.ref.providerId !== providerId ||
          parsed.data.provenance.providerId !== providerId ||
          !episodeMatches(parsed.data.releaseName, ticket)
        )
          return [];
        try {
          assertConnectorAttribution(provider.descriptor(), parsed.data);
        } catch {
          return [];
        }
        const candidate = parsed.data;
        const score = trackScore(candidate);
        const track: ExternalSubtitleTrack = {
          fileId: opaqueTrackId(ticket.grantId, candidate),
          filename: safeFilename(candidate, title.title),
          extension: candidate.format,
          language: candidate.language,
          forced: false,
          default: false,
          matchScore: score,
          matchType:
            score >= 0.95
              ? "exact"
              : score >= 0.85
                ? "normalized"
                : score >= 0.7
                  ? "language"
                  : "fuzzy",
        };
        return [{ kind: "provider" as const, track, candidate, provider }];
      });
    } catch {
      this.#options.onProviderFailure?.(providerId, "search");
      return [];
    }
  }

  async #context(
    ticket: PlaybackTicketRecord,
    providerId: string,
    signal: AbortSignal | undefined,
    deadlineMs: number,
  ): Promise<ProviderContext> {
    const secretRef =
      (await this.#options.secretRefForProvider?.(providerId, ticket)) ?? null;
    if (
      secretRef !== null &&
      (secretRef.length === 0 || secretRef.length > 512)
    )
      throw new Error("Subtitle provider secret reference is invalid.");
    return {
      requestId: randomUUID(),
      profileId: ticket.profileId,
      locale: this.#options.localeForProfile(ticket.profileId),
      deadlineAt: new Date(this.#now().getTime() + deadlineMs).toISOString(),
      secretRef,
      ...(signal ? { signal } : {}),
    };
  }

  async #bounded<T>(
    context: ProviderContext,
    timeoutMs: number,
    invoke: (context: ProviderContext) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    if (context.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      return await Promise.race([
        invoke({ ...context, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          if (controller.signal.aborted) {
            reject(new Error("Subtitle provider operation cancelled."));
            return;
          }
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("Subtitle provider operation cancelled.")),
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
    }
  }
}
