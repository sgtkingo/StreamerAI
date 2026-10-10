import { createHash } from "node:crypto";
import type { StreamerDatabase } from "@streamer-ai/database";
import type { EpisodeSelection } from "@streamer-ai/contracts";

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
    const value = this.database.settings.get<unknown>(
      this.key(profileId, titleId, episode),
    );
    return typeof value === "string" ? value : null;
  }

  set(
    profileId: string,
    titleId: string,
    sourceId: string,
    episode?: EpisodeSelection,
  ): void {
    this.database.settings.set(this.key(profileId, titleId, episode), sourceId);
  }
}
