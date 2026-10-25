import {
  MediaSourcePreferencesSchema,
  resolveMediaSourceOrder,
  type MediaSourceRankingMode,
} from "@streamer-ai/contracts";
import type { StreamerDatabase } from "@streamer-ai/database";

export class MediaSourcePreferenceStore {
  constructor(private readonly database: StreamerDatabase) {}
  private key(profileId: string) {
    return `media.source-order.${Buffer.from(profileId).toString("base64url")}`;
  }
  order(profileId: string, known: readonly string[]): string[] {
    return resolveMediaSourceOrder(this.get(profileId).providerOrder, known);
  }
  get(profileId: string) {
    const parsed = MediaSourcePreferencesSchema.safeParse(
      this.database.settings.get(this.key(profileId)),
    );
    return parsed.success
      ? parsed.data
      : { mode: "auto" as const, providerOrder: [] };
  }
  mode(profileId: string): MediaSourceRankingMode {
    return this.get(profileId).mode;
  }
  set(
    profileId: string,
    providerOrder: readonly string[],
    mode: MediaSourceRankingMode = "auto",
  ): void {
    this.database.settings.set(
      this.key(profileId),
      MediaSourcePreferencesSchema.parse({ providerOrder, mode }),
    );
  }
  delete(profileId: string): void {
    this.database.settings.delete(this.key(profileId));
  }
}
