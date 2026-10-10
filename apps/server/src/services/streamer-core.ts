import {
  CatalogTitleSchema,
  DiscoveryRequestSchema,
  DiscoveryResponseSchema,
  HistoryResponseSchema,
  LibraryResponseSchema,
  PlaybackGrantSchema,
  PlaybackPreferencesSchema,
  ViewerProfileSchema,
  TitleDetailSchema,
  type PlaybackPreferences,
  type UpdateViewerProfile,
  type ViewerProfile,
  type CatalogTitle,
  type DiscoveryRequest,
  type DiscoveryResponse,
  type HistoryResponse,
  type HomeFeed,
  type LibraryResponse,
  type PlaybackGrant,
  type PlaybackLanguageAvailability,
  type EpisodeSelection,
  type TitleDetail,
  type TitleSource,
} from "@streamer-ai/contracts";
import {
  ProfileLimitError,
  type Profile,
  type StreamerDatabase,
} from "@streamer-ai/database";
import { createHash, randomUUID } from "node:crypto";
import {
  PreviewContentProvider,
  type StreamerContentProvider,
} from "./content-provider.js";
import { PreferredSourceStore } from "./preferred-source-store.js";
import {
  excludeWatchedTitles,
  normalizeWatchedTitle,
  requestsUnseenTitles,
  watchedTitlesFromReply,
  type UnseenExclusions,
} from "./unseen-discovery.js";

function storageTitle(item: CatalogTitle) {
  const {
    inLibrary: _inLibrary,
    matchPercent: _matchPercent,
    progressPercent: _progressPercent,
    resumePositionSeconds: _resumePositionSeconds,
    resumeEpisode: _resumeEpisode,
    ...stored
  } = item;
  return stored;
}

function sagaStem(value: string): string {
  const stem = value
    .toLowerCase()
    .replace(/\s*[:–—-].*$/, "")
    .replace(/\s+(?:part\s*)?(?:\d+|[ivx]+)$/i, "")
    .trim();
  return stem.length >= 6 ? stem : "";
}

function discoveryRequestHash(request: DiscoveryRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        profileId: request.profileId,
        sessionId: request.sessionId ?? null,
        message: request.message,
      }),
    )
    .digest("hex");
}

/**
 * Application service over provider-neutral records. Provider orchestration is
 * injected, so Library and History do not depend on TMDB, Webshare or any
 * particular agent implementation.
 */
export class StreamerCore {
  private readonly activeDiscoveries = new Map<string, AbortController>();
  private readonly cancelledDiscoveries = new Map<string, number>();
  private readonly preferredSources: PreferredSourceStore;

  constructor(
    private readonly database: StreamerDatabase,
    private readonly now: () => Date,
    private readonly contentProvider: StreamerContentProvider = new PreviewContentProvider(),
  ) {
    this.preferredSources = new PreferredSourceStore(database);
    for (const item of contentProvider.bootstrapTitles()) {
      this.database.titles.upsert(storageTitle(item));
    }
    if (
      this.database.profiles.count() === 0 &&
      this.database.settings.get<boolean>("setup.completed") !== true
    ) {
      this.database.profiles.create({
        id: "default",
        name: "Viewer",
        locale: "en",
        preferences: {},
      });
    }
  }

  requireProfile(profileId: string): void {
    if (this.database.profiles.get(profileId) === null) {
      throw new UnknownProfileError(profileId);
    }
  }

  preferredSourceId(
    profileId: string,
    titleId: string,
    episode?: EpisodeSelection,
  ): string | null {
    this.requireProfile(profileId);
    if (!this.database.titles.get(titleId))
      throw new UnknownTitleError(titleId);
    return this.preferredSources.get(profileId, titleId, episode);
  }

  configureProfile(input: {
    id: string;
    name: string;
    locale: "en" | "cs" | "de";
    preferences: string[];
    playback: PlaybackPreferences;
    localAiEnabled: boolean;
  }): void {
    const existing = this.database.profiles.get(input.id);
    const preferences = {
      ...existing?.preferences,
      genres: input.preferences,
      playback: input.playback,
      onboardingComplete: true,
    };
    if (existing === null) {
      this.database.profiles.create({ ...input, preferences });
    } else {
      this.database.profiles.update(input.id, {
        name: input.name,
        locale: input.locale,
        preferences,
      });
    }
    this.database.settings.set("setup.completed", true);
    this.database.settings.set("setup.localAiEnabled", input.localAiEnabled);
  }

  private publicProfile(profile: Profile): ViewerProfile {
    const playback = PlaybackPreferencesSchema.safeParse(
      profile.preferences.playback,
    );
    return ViewerProfileSchema.parse({
      id: profile.id,
      name: profile.name,
      onboardingComplete:
        profile.preferences.onboardingComplete === true ||
        (profile.id === "default" &&
          profile.preferences.onboardingComplete !== false &&
          this.database.settings.get<boolean>("setup.completed") === true),
      locale: profile.locale,
      genres: Array.isArray(profile.preferences.genres)
        ? profile.preferences.genres.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      prompt:
        typeof profile.preferences.prompt === "string"
          ? profile.preferences.prompt
          : "",
      playback: playback.success
        ? playback.data
        : PlaybackPreferencesSchema.parse({}),
    });
  }

  listProfiles(): ViewerProfile[] {
    return this.database.profiles
      .list()
      .map((profile) => this.publicProfile(profile));
  }

  createViewerProfile(input: {
    name: string;
    locale: "en" | "cs" | "de";
  }): ViewerProfile {
    if (this.database.profiles.count() >= 5) throw new ProfileLimitError();
    const profile = this.database.profiles.create({
      id: `profile-${randomUUID()}`,
      name: input.name,
      locale: input.locale,
      preferences: {
        genres: [],
        prompt: "",
        playback: PlaybackPreferencesSchema.parse({}),
        onboardingComplete: false,
      },
    });
    return this.publicProfile(profile);
  }

  updateViewerProfile(
    profileId: string,
    patch: UpdateViewerProfile,
  ): ViewerProfile {
    const current = this.database.profiles.get(profileId);
    if (!current) throw new UnknownProfileError(profileId);
    const preferences = {
      ...current.preferences,
      ...(patch.genres === undefined ? {} : { genres: patch.genres }),
      ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
      ...(patch.playback === undefined ? {} : { playback: patch.playback }),
    };
    return this.publicProfile(
      this.database.profiles.update(profileId, {
        name: patch.name,
        locale: patch.locale,
        preferences,
      }),
    );
  }

  deleteViewerProfile(profileId: string): void {
    if (!this.database.profiles.delete(profileId)) {
      throw new UnknownProfileError(profileId);
    }
  }

  home(profileId: string): HomeFeed {
    this.requireProfile(profileId);
    const titles = this.database.titles.list().map((stored) => {
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...data } = stored;
      return this.decorateTitle(
        profileId,
        CatalogTitleSchema.parse({
          ...data,
          inLibrary: false,
          matchPercent: null,
          progressPercent: null,
        }),
      );
    });
    return this.contentProvider.buildHome({
      profileId,
      generatedAt: this.now().toISOString(),
      titles,
    });
  }

  cancelDiscovery(profileId: string, idempotencyKey: string): boolean {
    this.requireProfile(profileId);
    const claim = this.database.idempotency.get(
      `discovery:${profileId}`,
      idempotencyKey,
    );
    if (claim?.state === "completed" || claim?.state === "failed") return false;
    const key = `${profileId}\u0000${idempotencyKey}`;
    const now = Date.now();
    for (const [entry, expiresAt] of this.cancelledDiscoveries) {
      if (expiresAt <= now) this.cancelledDiscoveries.delete(entry);
    }
    this.cancelledDiscoveries.set(key, now + 60_000);
    if (this.cancelledDiscoveries.size > 500) {
      this.cancelledDiscoveries.delete(
        this.cancelledDiscoveries.keys().next().value!,
      );
    }
    const controller = this.activeDiscoveries.get(key);
    controller?.abort();
    return controller !== undefined;
  }

  private ensureDiscoverySession(
    request: DiscoveryRequest,
    createIfMissing: boolean,
  ): string {
    const sessionId = request.sessionId ?? randomUUID();
    const existing = this.database.discoverySessions.get(sessionId);
    if (existing === null) {
      if (request.sessionId !== undefined && !createIfMissing)
        throw new DiscoverySessionNotFoundError(sessionId);
      this.database.discoverySessions.create({
        id: sessionId,
        profileId: request.profileId,
        mode: this.contentProvider.mode,
        context: {},
      });
    } else if (
      existing.profileId !== request.profileId ||
      existing.state !== "active" ||
      existing.mode !== this.contentProvider.mode
    ) {
      throw new DiscoverySessionClosedError(sessionId);
    }
    const prior = this.database.discoverySessions
      .listMessages<{ message?: string }>(sessionId)
      .find(
        (item) =>
          item.role === "user" && item.requestId === request.idempotencyKey,
      );
    if (prior && prior.content.message !== request.message)
      throw new IdempotencyConflictError(request.idempotencyKey);
    if (!prior) {
      this.database.discoverySessions.appendMessage({
        id: randomUUID(),
        sessionId,
        role: "user",
        content: { message: request.message },
        requestId: request.idempotencyKey,
      });
    }
    return sessionId;
  }

  private unseenDiscovery(
    sessionId: string,
    profileId: string,
    completedAt: string,
  ): { question: DiscoveryResponse | null; exclusions?: UnseenExclusions } {
    if (this.contentProvider.mode !== "live") return { question: null };
    const messages = this.database.discoverySessions.listMessages<{
      message?: string;
      stage?: string;
    }>(sessionId);
    const firstUnseen = messages.findIndex(
      (item) =>
        item.role === "user" &&
        typeof item.content.message === "string" &&
        requestsUnseenTitles(item.content.message),
    );
    if (firstUnseen < 0) return { question: null };
    const questionIndex = messages.findIndex(
      (item, index) =>
        index > firstUnseen &&
        item.role === "assistant" &&
        item.content.stage === "needs-input",
    );
    const replies = messages
      .slice(questionIndex + 1)
      .filter(
        (item) =>
          item.role === "user" && typeof item.content.message === "string",
      );
    if (questionIndex < 0 || replies.length === 0) {
      const firstMessage = messages[firstUnseen]?.content.message ?? "";
      const locale =
        /\b(nevidel|nevidela|nevideli|nevidene|nevideny|nezhlednute)\b/.test(
          normalizeWatchedTitle(firstMessage),
        )
          ? "cs"
          : (this.database.profiles.get(profileId)?.locale ?? "en");
      const reply =
        locale === "cs"
          ? "Pošli mi prosím seznam filmů a seriálů, které už jsi viděl(a). Můžeš je oddělit čárkami nebo napsat každý na nový řádek. Pak je z doporučení vyřadím."
          : locale === "de"
            ? "Welche Filme und Serien hast du schon gesehen? Schick mir eine Liste, durch Kommas oder Zeilenumbrüche getrennt, damit ich sie ausschließen kann."
            : "Which films and series have you already seen? Send me a list separated by commas or new lines so I can exclude them.";
      return {
        question: DiscoveryResponseSchema.parse({
          sessionId,
          mode: this.contentProvider.mode,
          stage: "needs-input",
          reply,
          bestMatch: null,
          available: [],
          unavailable: [],
          unverified: [],
          warnings: [],
          completedAt,
        }),
      };
    }
    const titleIds = new Set(this.database.history.titleIds(profileId));
    for (const entry of this.database.library.list(profileId)) {
      if (entry.state === "completed" || entry.membershipReason === "playback")
        titleIds.add(entry.titleId);
    }
    const titles = watchedTitlesFromReply(replies[0]?.content.message ?? "");
    for (const id of titleIds) {
      const title = this.database.titles.get(id);
      if (title)
        titles.push(
          title.title,
          ...(title.originalTitle ? [title.originalTitle] : []),
        );
    }
    return {
      question: null,
      exclusions: { titleIds: [...titleIds], titles: [...new Set(titles)] },
    };
  }

  async discoverFast(
    rawRequest: DiscoveryRequest,
    externalSignal?: AbortSignal,
  ): Promise<DiscoveryResponse> {
    const request = DiscoveryRequestSchema.parse(rawRequest);
    this.requireProfile(request.profileId);
    if (this.contentProvider.discoverFast === undefined)
      throw new PlaybackNotConfiguredError();
    externalSignal?.throwIfAborted();
    const sessionId = this.ensureDiscoverySession(request, true);
    const unseen = this.unseenDiscovery(
      sessionId,
      request.profileId,
      this.now().toISOString(),
    );
    const response = DiscoveryResponseSchema.parse(
      unseen.question ??
        excludeWatchedTitles(
          await this.contentProvider.discoverFast(
            { ...request, sessionId },
            this.now().toISOString(),
            {
              sessionId,
              signal: externalSignal,
              messages: this.database.discoverySessions.listMessages(sessionId),
              unseen: unseen.exclusions,
            },
          ),
          unseen.exclusions ?? { titleIds: [], titles: [] },
        ),
    );
    externalSignal?.throwIfAborted();
    if (
      response.sessionId !== sessionId ||
      response.mode !== this.contentProvider.mode
    )
      throw new Error(
        "Fast content provider returned a mismatched session or mode.",
      );
    const ranked = [
      ...(response.bestMatch ? [response.bestMatch] : []),
      ...response.available,
      ...response.unavailable,
      ...response.unverified,
    ];
    for (const item of ranked) {
      externalSignal?.throwIfAborted();
      this.database.titles.upsert(storageTitle(item.title));
    }
    const quickRequestId = `quick-${createHash("sha256").update(request.idempotencyKey).digest("hex")}`;
    const existingReplies = this.database.discoverySessions
      .listMessages<{ stage?: string }>(sessionId)
      .filter(
        (item) =>
          item.role === "assistant" &&
          (item.requestId === request.idempotencyKey ||
            item.requestId === quickRequestId),
      );
    if (existingReplies.length === 0) {
      this.database.discoverySessions.appendMessage({
        id: randomUUID(),
        sessionId,
        role: "assistant",
        content: {
          reply: response.reply,
          titles: ranked.map((item) => item.title.title),
          stage: response.stage === "needs-input" ? "needs-input" : "quick",
        },
        requestId: quickRequestId,
      });
    }
    const decorate = (item: (typeof ranked)[number]) => ({
      ...item,
      title: this.decorateTitle(request.profileId, item.title),
    });
    return DiscoveryResponseSchema.parse({
      ...response,
      bestMatch: response.bestMatch ? decorate(response.bestMatch) : null,
      available: response.available.map(decorate),
      unavailable: response.unavailable.map(decorate),
      unverified: response.unverified.map(decorate),
    });
  }

  async discover(
    rawRequest: DiscoveryRequest,
    externalSignal?: AbortSignal,
  ): Promise<DiscoveryResponse> {
    const request = DiscoveryRequestSchema.parse(rawRequest);
    this.requireProfile(request.profileId);
    const cancellationKey = `${request.profileId}\u0000${request.idempotencyKey}`;
    if (this.cancelledDiscoveries.has(cancellationKey)) {
      throw new DiscoveryCancelledError();
    }
    const scope = `discovery:${request.profileId}`;
    const requestHash = discoveryRequestHash(request);
    const claim = this.database.idempotency.claim<DiscoveryResponse>({
      scope,
      key: request.idempotencyKey,
      requestHash,
    });
    if (claim.status === "conflict") {
      throw new IdempotencyConflictError(request.idempotencyKey);
    }
    if (claim.status === "in-progress") {
      throw new RequestInProgressError(request.idempotencyKey);
    }
    if (claim.status === "replay") {
      if (
        claim.record.state === "completed" &&
        claim.record.response !== null
      ) {
        return DiscoveryResponseSchema.parse(claim.record.response);
      }
      throw new PreviousRequestFailedError(request.idempotencyKey);
    }

    const controller = new AbortController();
    const abortFromExternal = () => controller.abort();
    externalSignal?.addEventListener("abort", abortFromExternal, {
      once: true,
    });
    if (
      externalSignal?.aborted ||
      this.cancelledDiscoveries.has(cancellationKey)
    ) {
      controller.abort();
    }
    this.activeDiscoveries.set(cancellationKey, controller);
    try {
      controller.signal.throwIfAborted();
      const sessionId = this.ensureDiscoverySession(
        request,
        request.createSession === true,
      );

      // The fast branch may finish first. Its validated metadata is useful
      // evidence for the agent, but neither branch waits for the other.
      const messages = this.database.discoverySessions.listMessages(sessionId);
      const unseen = this.unseenDiscovery(
        sessionId,
        request.profileId,
        this.now().toISOString(),
      );
      const providerResult = DiscoveryResponseSchema.parse(
        unseen.question ??
          excludeWatchedTitles(
            await this.contentProvider.discover(
              { ...request, sessionId },
              this.now().toISOString(),
              {
                sessionId,
                signal: controller.signal,
                unseen: unseen.exclusions,
                messages: messages.map((message) => ({
                  role: message.role,
                  content: message.content,
                  createdAt: message.createdAt,
                })),
              },
            ),
            unseen.exclusions ?? { titleIds: [], titles: [] },
          ),
      );
      controller.signal.throwIfAborted();
      if (
        providerResult.sessionId !== sessionId ||
        providerResult.mode !== this.contentProvider.mode
      ) {
        throw new Error(
          "Content provider returned a mismatched session or mode.",
        );
      }
      const ranked = [
        ...(providerResult.bestMatch === null
          ? []
          : [providerResult.bestMatch]),
        ...providerResult.available,
        ...providerResult.unavailable,
        ...providerResult.unverified,
      ];
      for (const item of ranked) {
        controller.signal.throwIfAborted();
        this.database.titles.upsert(storageTitle(item.title));
      }

      const decorateRanked = (item: (typeof ranked)[number]) => ({
        ...item,
        title: this.decorateTitle(request.profileId, item.title),
      });
      const response = DiscoveryResponseSchema.parse({
        ...providerResult,
        bestMatch:
          providerResult.bestMatch === null
            ? null
            : decorateRanked(providerResult.bestMatch),
        available: providerResult.available.map(decorateRanked),
        unavailable: providerResult.unavailable.map(decorateRanked),
        unverified: providerResult.unverified.map(decorateRanked),
      });
      controller.signal.throwIfAborted();
      this.database.transaction(() => {
        controller.signal.throwIfAborted();
        this.database.discoverySessions.appendMessage({
          id: randomUUID(),
          sessionId,
          role: "assistant",
          content: {
            reply: response.reply,
            titleIds: ranked.map((item) => item.title.id),
            titles: ranked.map((item) => item.title.title),
            stage: response.stage,
          },
          requestId: request.idempotencyKey,
        });
        this.database.idempotency.complete({
          scope,
          key: request.idempotencyKey,
          requestHash,
          response,
          statusCode: 200,
        });
      });
      return response;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      this.failDiscoveryClaimIfPending(
        scope,
        request,
        requestHash,
        cancelled
          ? "DISCOVERY_CANCELLED"
          : error instanceof DiscoverySessionNotFoundError
            ? "SESSION_NOT_FOUND"
            : error instanceof DiscoverySessionClosedError
              ? "SESSION_CLOSED"
              : "DISCOVERY_FAILED",
      );
      throw cancelled ? new DiscoveryCancelledError() : error;
    } finally {
      externalSignal?.removeEventListener("abort", abortFromExternal);
      this.activeDiscoveries.delete(cancellationKey);
    }
  }

  library(profileId: string): LibraryResponse {
    this.requireProfile(profileId);
    const items = this.database.library.list(profileId).flatMap((entry) => {
      const stored = this.database.titles.get(entry.titleId);
      if (stored === null) return [];
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...data } = stored;
      const title = this.decorateTitle(
        profileId,
        CatalogTitleSchema.parse({
          ...data,
          inLibrary: true,
          matchPercent: null,
          progressPercent: entry.progressPercent,
        }),
      );
      return [
        {
          title,
          state: entry.state,
          membershipReason: entry.membershipReason,
          addedAt: entry.addedAt,
          updatedAt: entry.updatedAt,
          lastPlayedAt: entry.lastPlayedAt,
        },
      ];
    });
    return LibraryResponseSchema.parse({ profileId, items });
  }

  async titleDetail(
    profileId: string,
    titleId: string,
    retry = false,
  ): Promise<TitleDetail> {
    this.requireProfile(profileId);
    const stored = this.database.titles.get(titleId);
    if (stored === null) throw new UnknownTitleError(titleId);
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...data } = stored;
    let title = this.decorateTitle(
      profileId,
      CatalogTitleSchema.parse({
        ...data,
        inLibrary: false,
        matchPercent: null,
        progressPercent: null,
      }),
    );
    const related = this.database.titles
      .list()
      .filter((other) => other.id !== title.id && other.kind === title.kind)
      .map((other) => ({
        other,
        score:
          other.genres.filter((genre) => title.genres.includes(genre)).length +
          (sagaStem(title.title) !== "" &&
          sagaStem(other.title) === sagaStem(title.title)
            ? 3
            : 0),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ other }) => {
        const {
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          ...record
        } = other;
        return this.decorateTitle(
          profileId,
          CatalogTitleSchema.parse({
            ...record,
            inLibrary: false,
            matchPercent: null,
            progressPercent: null,
          }),
        );
      });
    const series =
      title.kind === "series" && this.contentProvider.getSeriesDetail
        ? await this.contentProvider.getSeriesDetail(profileId, title, retry)
        : null;
    if (series && series.seasons.length > 0 && title.formats.length > 0) {
      const episodes = series.seasons.flatMap((season) => season.episodes);
      const available = episodes.filter(
        (episode) => episode.availability === "available",
      );
      if (
        available.length > 0 &&
        (available.length < episodes.length || series.status === "complete")
      ) {
        const coverage = {
          seasonsAvailable: new Set(
            available.map((episode) => episode.seasonNumber),
          ).size,
          seasonsTotal: series.seasons.filter(
            (season) => season.episodes.length > 0,
          ).length,
          episodesAvailable: available.length,
          episodesTotal: episodes.length,
          complete: series.status === "complete",
          nextEpisodeLabel: `S${String(available[0]!.seasonNumber).padStart(2, "0")} E${String(available[0]!.episodeNumber).padStart(2, "0")}`,
        };
        if (JSON.stringify(coverage) !== JSON.stringify(title.seriesCoverage)) {
          title = CatalogTitleSchema.parse({
            ...title,
            seriesCoverage: coverage,
            availability: coverage.complete ? "available" : "partial",
            availabilityCheckedAt: this.now().toISOString(),
          });
          this.database.titles.upsert(storageTitle(title));
        }
      }
    }
    return TitleDetailSchema.parse({ title, series, related });
  }

  async forceTitleSearch(
    profileId: string,
    titleId: string,
  ): Promise<{ detail: TitleDetail; foundSources: number }> {
    this.requireProfile(profileId);
    const stored = this.database.titles.get(titleId);
    if (stored === null) throw new UnknownTitleError(titleId);
    if (
      this.contentProvider.mode !== "live" ||
      this.contentProvider.forceSearchTitle === undefined
    )
      throw new PlaybackNotConfiguredError();
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...data } = stored;
    const title = this.decorateTitle(
      profileId,
      CatalogTitleSchema.parse({
        ...data,
        inLibrary: false,
        matchPercent: null,
        progressPercent: null,
      }),
    );
    const searched = await this.contentProvider.forceSearchTitle(
      profileId,
      title,
    );
    const foundSources = searched.sources?.length ?? 0;
    if (foundSources > 0) this.database.titles.upsert(storageTitle(searched));
    return {
      detail: await this.titleDetail(
        profileId,
        titleId,
        title.kind === "series",
      ),
      foundSources,
    };
  }

  async forceEpisodeSearch(
    profileId: string,
    titleId: string,
    episode: EpisodeSelection,
  ): Promise<{ detail: TitleDetail; sources: TitleSource[] }> {
    this.requireProfile(profileId);
    const stored = this.database.titles.get(titleId);
    if (stored === null) throw new UnknownTitleError(titleId);
    if (
      this.contentProvider.mode !== "live" ||
      this.contentProvider.forceSearchEpisode === undefined
    )
      throw new PlaybackNotConfiguredError();
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...data } = stored;
    const title = this.decorateTitle(
      profileId,
      CatalogTitleSchema.parse({
        ...data,
        inLibrary: false,
        matchPercent: null,
        progressPercent: null,
      }),
    );
    if (title.kind !== "series") throw new UnplayableTitleError(titleId);
    const sources = await this.contentProvider.forceSearchEpisode(
      profileId,
      title,
      episode,
    );
    let detail = await this.titleDetail(profileId, titleId);
    if (sources.length > 0) {
      const episodes =
        detail.series?.seasons.flatMap((season) => season.episodes) ?? [];
      const available = episodes.filter(
        (item) => item.availability === "available",
      );
      if (available.length > 0 && episodes.length > 0) {
        const complete = available.length === episodes.length;
        const mergedSources = [...sources, ...(detail.title.sources ?? [])]
          .filter(
            (source, index, items) =>
              items.findIndex((other) => other.id === source.id) === index,
          )
          .slice(0, 24);
        const updated = CatalogTitleSchema.parse({
          ...detail.title,
          availability: complete ? "available" : "partial",
          availabilityProvider: sources[0]!.providerId,
          availabilityCheckedAt: this.now().toISOString(),
          availabilityProvenance:
            detail.title.availabilityProvenance?.providerId ===
            sources[0]!.providerId
              ? detail.title.availabilityProvenance
              : undefined,
          formats:
            detail.title.formats.length > 0
              ? detail.title.formats
              : [sources[0]!.format],
          sources: mergedSources,
          seriesCoverage: {
            seasonsAvailable: new Set(
              available.map((item) => item.seasonNumber),
            ).size,
            seasonsTotal: detail.series!.seasons.filter(
              (season) => season.episodes.length > 0,
            ).length,
            episodesAvailable: available.length,
            episodesTotal: episodes.length,
            complete,
            nextEpisodeLabel: `S${String(available[0]!.seasonNumber).padStart(2, "0")} E${String(available[0]!.episodeNumber).padStart(2, "0")}`,
          },
        });
        this.database.titles.upsert(storageTitle(updated));
        detail = await this.titleDetail(profileId, titleId);
      }
    }
    return { detail, sources };
  }

  addToLibrary(profileId: string, titleId: string): LibraryResponse {
    this.requireProfile(profileId);
    if (this.database.titles.get(titleId) === null) {
      throw new UnknownTitleError(titleId);
    }
    this.database.library.upsert({
      profileId,
      titleId,
      membershipReason: "explicit",
      state: "saved",
    });
    return this.library(profileId);
  }

  removeFromLibrary(profileId: string, titleId: string): boolean {
    this.requireProfile(profileId);
    return this.database.library.remove(profileId, titleId);
  }

  async startPlayback(
    profileId: string,
    titleId: string,
  ): Promise<{
    eventId: string;
    library: LibraryResponse;
    playback: PlaybackGrant;
  }> {
    const playback = await this.preparePlayback(profileId, titleId);
    return {
      ...this.recordPlaybackStart(profileId, titleId),
      playback,
    };
  }

  async checkPlayback(
    profileId: string,
    titleId: string,
    episode?: EpisodeSelection,
    sourceId?: string,
  ): Promise<PlaybackLanguageAvailability | void> {
    this.requireProfile(profileId);
    const item = this.database.titles.get(titleId);
    if (item === null) throw new UnknownTitleError(titleId);
    if (
      this.contentProvider.mode !== "live" ||
      this.contentProvider.checkPlayback === undefined
    ) {
      throw new PlaybackNotConfiguredError();
    }
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...stored } = item;
    const title = CatalogTitleSchema.parse({
      ...stored,
      inLibrary: this.database.library.get(profileId, titleId) !== null,
      matchPercent: null,
      progressPercent:
        this.database.library.get(profileId, titleId)?.progressPercent ?? null,
    });
    if (episode && title.kind !== "series")
      throw new UnplayableTitleError(titleId);
    try {
      return await this.contentProvider.checkPlayback(
        profileId,
        title,
        episode,
        sourceId,
      );
    } catch {
      throw new PlaybackRecheckError(titleId);
    }
  }

  async preparePlayback(
    profileId: string,
    titleId: string,
    episode?: EpisodeSelection,
    sourceId?: string,
  ): Promise<PlaybackGrant> {
    this.requireProfile(profileId);
    const item = this.database.titles.get(titleId);
    if (item === null) throw new UnknownTitleError(titleId);
    if (
      this.contentProvider.mode !== "live" ||
      this.contentProvider.preparePlayback === undefined
    ) {
      throw new PlaybackNotConfiguredError();
    }
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...stored } = item;
    const title = CatalogTitleSchema.parse({
      ...stored,
      inLibrary: this.database.library.get(profileId, titleId) !== null,
      matchPercent: null,
      progressPercent:
        this.database.library.get(profileId, titleId)?.progressPercent ?? null,
    });
    if (episode && title.kind !== "series")
      throw new UnplayableTitleError(titleId);
    let playback: PlaybackGrant;
    const remembered =
      sourceId === undefined
        ? this.preferredSources.get(profileId, titleId, episode)
        : null;
    const rememberedAvailable =
      remembered !== null &&
      title.sources?.some(
        (source) =>
          source.id === remembered &&
          (episode
            ? source.seasonNumber === episode.seasonNumber &&
              source.episodeNumber === episode.episodeNumber
            : source.seasonNumber === null && source.episodeNumber === null),
      );
    try {
      let result;
      try {
        result = await this.contentProvider.preparePlayback(
          profileId,
          title,
          episode,
          sourceId ?? (rememberedAvailable ? remembered : undefined),
        );
      } catch (error) {
        if (sourceId !== undefined || !rememberedAvailable) throw error;
        result = await this.contentProvider.preparePlayback(
          profileId,
          title,
          episode,
        );
      }
      playback = PlaybackGrantSchema.parse(result);
    } catch {
      throw new PlaybackRecheckError(titleId);
    }
    const nowDate = this.now();
    if (
      playback.titleId !== titleId ||
      Date.parse(playback.expiresAt) <= nowDate.getTime()
    ) {
      throw new PlaybackRecheckError(titleId);
    }
    if (!playback.url.startsWith("/api/v1/playback/grants/")) {
      const playbackUrl = new URL(playback.url);
      const loopback = ["127.0.0.1", "localhost", "::1"].includes(
        playbackUrl.hostname,
      );
      if (playbackUrl.protocol !== "https:" && !loopback) {
        throw new PlaybackRecheckError(titleId);
      }
    }
    return playback;
  }

  recordPlaybackStart(
    profileId: string,
    titleId: string,
    episode?: EpisodeSelection,
    source?: { providerId: string; candidateId: string },
  ): { eventId: string; library: LibraryResponse } {
    this.requireProfile(profileId);
    const item = this.database.titles.get(titleId);
    if (item === null) throw new UnknownTitleError(titleId);
    const now = this.now().toISOString();
    if (source) {
      const selected = item.sources?.find(
        (entry) =>
          entry.providerId === source.providerId &&
          entry.candidateId === source.candidateId &&
          (episode
            ? entry.seasonNumber === episode.seasonNumber &&
              entry.episodeNumber === episode.episodeNumber
            : entry.seasonNumber === null && entry.episodeNumber === null),
      );
      if (selected)
        this.preferredSources.set(profileId, titleId, selected.id, episode);
    }
    const eventId = randomUUID();
    const previousEntry = this.database.library.get(profileId, titleId);
    const episodePosition = this.database.playbackPositions.get(
      profileId,
      titleId,
      episode?.seasonNumber ?? null,
      episode?.episodeNumber ?? null,
    );
    const previousProgress =
      episodePosition?.progressPercent ??
      (previousEntry?.state === "completed"
        ? 0
        : (previousEntry?.progressPercent ?? 0));
    this.database.transaction(() => {
      this.database.library.upsert({
        profileId,
        titleId,
        membershipReason: "playback",
        state: "in-progress",
        progressPercent: previousProgress,
        lastPlayedAt: now,
      });
      this.database.history.append({
        id: eventId,
        profileId,
        titleId,
        eventType: "start",
        episodeLabel: episode
          ? `S${String(episode.seasonNumber).padStart(2, "0")} E${String(episode.episodeNumber).padStart(2, "0")}`
          : null,
        progressPercent: previousProgress,
        occurredAt: now,
      });
    });
    return { eventId, library: this.library(profileId) };
  }

  recordPlaybackProgress(
    profileId: string,
    titleId: string,
    progressPercent: number,
    positionSeconds = 0,
    durationSeconds = 0,
    episode?: EpisodeSelection,
  ): void {
    this.requireProfile(profileId);
    if (this.database.titles.get(titleId) === null) {
      throw new UnknownTitleError(titleId);
    }
    const bounded = Math.max(0, Math.min(100, progressPercent));
    this.database.playbackPositions.upsert({
      profileId,
      titleId,
      seasonNumber: episode?.seasonNumber ?? null,
      episodeNumber: episode?.episodeNumber ?? null,
      positionSeconds: Math.max(0, positionSeconds),
      durationSeconds: Math.max(0, durationSeconds),
      progressPercent: bounded,
    });
    this.database.library.upsert({
      profileId,
      titleId,
      membershipReason: "playback",
      state: bounded >= 95 ? "completed" : "in-progress",
      progressPercent: bounded,
      lastPlayedAt: this.now().toISOString(),
    });
  }

  history(profileId: string): HistoryResponse {
    this.requireProfile(profileId);
    const items = this.database.history.list(profileId).flatMap((event) => {
      const stored = this.database.titles.get(event.titleId);
      if (stored === null) return [];
      const { createdAt: _createdAt, updatedAt: _updatedAt, ...data } = stored;
      const title = CatalogTitleSchema.parse({
        ...data,
        inLibrary: true,
        matchPercent: null,
        progressPercent: event.progressPercent,
      });
      return [
        {
          id: event.id,
          title,
          episodeLabel: event.episodeLabel,
          occurredAt: event.occurredAt,
          progressPercent: event.progressPercent,
          completed: event.eventType === "complete",
        },
      ];
    });
    return HistoryResponseSchema.parse({ profileId, items });
  }

  removeHistoryEvent(profileId: string, eventId: string): boolean {
    this.requireProfile(profileId);
    return this.database.history.remove(profileId, eventId);
  }

  clearHistory(profileId: string): number {
    this.requireProfile(profileId);
    return this.database.history.clear(profileId);
  }

  private decorateTitle(profileId: string, item: CatalogTitle): CatalogTitle {
    const entry = this.database.library.get(profileId, item.id);
    const latestPosition = this.database.playbackPositions.latestResumable(
      profileId,
      item.id,
    );
    return CatalogTitleSchema.parse({
      ...item,
      inLibrary: entry !== null,
      progressPercent:
        latestPosition?.progressPercent ?? entry?.progressPercent ?? null,
      resumePositionSeconds: latestPosition?.positionSeconds ?? null,
      resumeEpisode:
        latestPosition &&
        latestPosition.seasonNumber !== null &&
        latestPosition.episodeNumber !== null
          ? {
              seasonNumber: latestPosition.seasonNumber,
              episodeNumber: latestPosition.episodeNumber,
            }
          : null,
    });
  }

  private failDiscoveryClaim(
    scope: string,
    request: DiscoveryRequest,
    requestHash: string,
    errorCode: string,
  ): void {
    this.database.idempotency.fail({
      scope,
      key: request.idempotencyKey,
      requestHash,
      response: { errorCode },
      statusCode: 409,
      errorCode,
    });
  }

  private failDiscoveryClaimIfPending(
    scope: string,
    request: DiscoveryRequest,
    requestHash: string,
    errorCode: string,
  ): void {
    const record = this.database.idempotency.get(scope, request.idempotencyKey);
    if (record?.state === "in-progress") {
      this.failDiscoveryClaim(scope, request, requestHash, errorCode);
    }
  }
}

export class DiscoveryCancelledError extends Error {
  constructor() {
    super("Discovery was cancelled.");
    this.name = "DiscoveryCancelledError";
  }
}

export class UnknownProfileError extends Error {
  constructor(readonly profileId: string) {
    super(`Unknown profile '${profileId}'.`);
    this.name = "UnknownProfileError";
  }
}

export class UnknownTitleError extends Error {
  constructor(readonly titleId: string) {
    super(`Unknown canonical title '${titleId}'.`);
    this.name = "UnknownTitleError";
  }
}

export class UnplayableTitleError extends Error {
  constructor(readonly titleId: string) {
    super(`Title '${titleId}' has no verified playable variant.`);
    this.name = "UnplayableTitleError";
  }
}

export class PlaybackNotConfiguredError extends Error {
  constructor() {
    super("A live media provider is required before playback can start.");
    this.name = "PlaybackNotConfiguredError";
  }
}

export class PlaybackRecheckError extends Error {
  constructor(readonly titleId: string) {
    super(`Playback revalidation failed for '${titleId}'.`);
    this.name = "PlaybackRecheckError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(readonly key: string) {
    super(`Idempotency key '${key}' was already used for another request.`);
    this.name = "IdempotencyConflictError";
  }
}

export class RequestInProgressError extends Error {
  constructor(readonly key: string) {
    super(`Request '${key}' is already in progress.`);
    this.name = "RequestInProgressError";
  }
}

export class PreviousRequestFailedError extends Error {
  constructor(readonly key: string) {
    super(`Request '${key}' previously failed; retry with a new key.`);
    this.name = "PreviousRequestFailedError";
  }
}

export class DiscoverySessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Discovery session '${sessionId}' was not found.`);
    this.name = "DiscoverySessionNotFoundError";
  }
}

export class DiscoverySessionClosedError extends Error {
  constructor(readonly sessionId: string) {
    super(`Discovery session '${sessionId}' is no longer active.`);
    this.name = "DiscoverySessionClosedError";
  }
}
