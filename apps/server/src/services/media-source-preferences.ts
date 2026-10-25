import {
  MediaSourcePreferencesSchema,
  resolveMediaSourceOrder,
} from "@streamer-ai/contracts";
import type { StreamerDatabase } from "@streamer-ai/database";

export class MediaSourcePreferenceStore {
  constructor(private readonly database: StreamerDatabase) {}
  private key(profileId: string) {
    return `media.source-order.${Buffer.from(profileId).toString("base64url")}`;
  }
  order(profileId: string, known: readonly string[]): string[] {
    const parsed = MediaSourcePreferencesSchema.safeParse(
      this.database.settings.get(this.key(profileId)),
    );
    return resolveMediaSourceOrder(
      parsed.success ? parsed.data.providerOrder : [],
      known,
    );
  }
  set(profileId: string, providerOrder: readonly string[]): void {
    this.database.settings.set(
      this.key(profileId),
      MediaSourcePreferencesSchema.parse({ providerOrder }),
    );
  }
  delete(profileId: string): void {
    this.database.settings.delete(this.key(profileId));
  }
}
