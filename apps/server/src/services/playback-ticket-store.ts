/** Server-only source details shared by all media adapters behind a grant. */
export interface PlaybackTicketInput {
  grantId: string;
  profileId: string;
  providerId: string;
  titleId: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  /** Stable provider candidate, which may differ from the playable variant. */
  candidateId?: string;
  variantId: string;
  directUrl: string;
  expiresAt: string;
  supportsHttpRange?: boolean;
  sourceSizeBytes?: number | null;
  sourceFilename?: string | null;
}

export interface PlaybackTicketRecord extends PlaybackTicketInput {
  readonly createdAt: string;
  readonly started: boolean;
}

export interface PlaybackTicketStore {
  issue(input: PlaybackTicketInput): string;
  get(grantId: string): PlaybackTicketRecord | null;
  markStarted(grantId: string): boolean;
  revoke(grantId: string): boolean;
  revokeActive(): void;
}

/** Validate server-only source URLs when issued and after every refresh. */
export function validatePlaybackSourceUrl(value: string): string {
  const directUrl = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(
    directUrl.hostname,
  );
  if (
    (directUrl.protocol !== "https:" &&
      !(directUrl.protocol === "http:" && loopback)) ||
    directUrl.username !== "" ||
    directUrl.password !== ""
  ) {
    throw new Error("Playback direct URL must be secure and credential-free.");
  }
  return value;
}

/**
 * Ephemeral single-playback ticket store. Direct provider URLs never reach
 * SQLite, logs, sync, discovery responses or Library records.
 */
export class InMemoryPlaybackTicketStore implements PlaybackTicketStore {
  #active: PlaybackTicketRecord | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  issue(input: PlaybackTicketInput): string {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(input.grantId)) {
      throw new Error("Playback grant id is invalid.");
    }
    validatePlaybackSourceUrl(input.directUrl);
    if (Date.parse(input.expiresAt) <= this.now().getTime()) {
      throw new Error("Playback ticket must expire in the future.");
    }
    this.#active = {
      ...input,
      seasonNumber: input.seasonNumber ?? null,
      episodeNumber: input.episodeNumber ?? null,
      createdAt: this.now().toISOString(),
      started: false,
    };
    return `/api/v1/playback/grants/${encodeURIComponent(input.grantId)}`;
  }

  get(grantId: string): PlaybackTicketRecord | null {
    if (this.#active === null || this.#active.grantId !== grantId) return null;
    if (Date.parse(this.#active.expiresAt) <= this.now().getTime()) {
      this.#active = null;
      return null;
    }
    return { ...this.#active };
  }

  markStarted(grantId: string): boolean {
    const active = this.get(grantId);
    if (active === null || active.started) return false;
    // The initial grant is short lived; a started playback must survive a film.
    this.#active = {
      ...active,
      started: true,
      expiresAt: new Date(
        this.now().getTime() + 8 * 60 * 60 * 1000,
      ).toISOString(),
    };
    return true;
  }

  revoke(grantId: string): boolean {
    if (this.#active?.grantId !== grantId) return false;
    this.#active = null;
    return true;
  }

  revokeActive(): void {
    this.#active = null;
  }
}
