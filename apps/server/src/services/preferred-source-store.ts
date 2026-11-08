import { createHash, randomUUID } from "node:crypto";
import type { StreamerDatabase } from "@streamer-ai/database";
import type {
  EpisodeSelection,
  PreferredSourceSelection,
} from "@streamer-ai/contracts";

interface StoredSelection {
  sourceId: string;
  revision: string;
  aiPick?: { sourceId: string; reason: string };
  profileId?: string;
  titleId?: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

/** A viewer's last playable choice for one movie or exact episode. */
export class PreferredSourceStore {
  constructor(private readonly database: StreamerDatabase) {}

  private key(
    profileId: string,
    titleId: string,
    episode?: EpisodeSelection,
  ): string {
    const identity = JSON.stringify([
      profileId,
      titleId,
      episode?.seasonNumber ?? null,
      episode?.episodeNumber ?? null,
    ]);
    return `playback.preferred-source.${createHash("sha256").update(identity).digest("hex")}`;
  }

  get(
    profileId: string,
    titleId: string,
    episode?: EpisodeSelection,
  ): string | null {
    return this.selection(profileId, titleId, episode).sourceId;
  }

  selection(
    profileId: string,
    titleId: string,
    episode?: EpisodeSelection,
  ): PreferredSourceSelection {
    const value = this.database.settings.get<unknown>(
      this.key(profileId, titleId, episode),
    );
    if (typeof value === "string") return { sourceId: value };
    if (value && typeof value === "object" && "sourceId" in value) {
      const stored = value as StoredSelection;
      return {
        sourceId: stored.sourceId,
        ...(stored.aiPick ? { aiPick: stored.aiPick } : {}),
      };
    }
    return { sourceId: null };
  }

  revision(
    profileId: string,
    titleId: string,
    episode?: EpisodeSelection,
  ): string {
    return JSON.stringify(
      this.database.settings.get<unknown>(
        this.key(profileId, titleId, episode),
      ) ?? null,
    );
  }

  setAi(
    profileId: string,
    titleId: string,
    sourceId: string,
    reason: string,
    episode?: EpisodeSelection,
  ): void {
    this.database.settings.set(this.key(profileId, titleId, episode), {
      profileId,
      titleId,
      seasonNumber: episode?.seasonNumber ?? null,
      episodeNumber: episode?.episodeNumber ?? null,
      sourceId,
      revision: randomUUID(),
      aiPick: { sourceId, reason },
    });
  }

  set(
    profileId: string,
    titleId: string,
    sourceId: string,
    episode?: EpisodeSelection,
  ): void {
    const current = this.selection(profileId, titleId, episode);
    this.database.settings.set(this.key(profileId, titleId, episode), {
      profileId,
      titleId,
      seasonNumber: episode?.seasonNumber ?? null,
      episodeNumber: episode?.episodeNumber ?? null,
      sourceId,
      revision: randomUUID(),
      ...(current.aiPick?.sourceId === sourceId
        ? { aiPick: current.aiPick }
        : {}),
    });
  }
  exportProfile(profileId: string) {
    return this.database.settings
      .listByPrefix<StoredSelection>("playback.preferred-source.")
      .flatMap(({ value }) =>
        value && value.profileId === profileId && value.titleId
          ? [
              {
                titleId: value.titleId,
                seasonNumber: value.seasonNumber ?? null,
                episodeNumber: value.episodeNumber ?? null,
                sourceId: value.sourceId,
                aiPick: value.aiPick,
              },
            ]
          : [],
      );
  }
}
