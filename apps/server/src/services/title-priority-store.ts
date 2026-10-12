import { createHash, randomInt } from "node:crypto";
import type { CatalogTitle, EpisodeSelection } from "@streamer-ai/contracts";
import type { StreamerDatabase } from "@streamer-ai/database";

type Interaction = { at: number; episode?: string };
type State = {
  manualHigh: boolean;
  autoHigh: boolean;
  opens: number[];
  plays: Interaction[];
  nextCheckAt: number | null;
  highChecks?: number;
};

const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export class TitlePriorityStore {
  constructor(
    private readonly database: StreamerDatabase,
    private readonly now: () => Date,
  ) {}

  private key(profileId: string, titleId: string): string {
    const hash = createHash("sha256")
      .update(`${profileId}\u0000${titleId}`)
      .digest("hex");
    return `title-priority:${hash}`;
  }

  private state(profileId: string, titleId: string): State {
    return (
      this.database.settings.get<State>(this.key(profileId, titleId)) ?? {
        manualHigh: false,
        autoHigh: false,
        opens: [],
        plays: [],
        nextCheckAt: null,
        highChecks: 0,
      }
    );
  }

  private save(profileId: string, titleId: string, state: State): void {
    this.database.settings.set(this.key(profileId, titleId), state);
  }

  priority(profileId: string, titleId: string): "low" | "high" {
    const state = this.state(profileId, titleId);
    return state.manualHigh || state.autoHigh ? "high" : "low";
  }

  toggle(profileId: string, titleId: string): "low" | "high" {
    const state = this.state(profileId, titleId);
    if (state.manualHigh || state.autoHigh) {
      state.manualHigh = false;
      state.autoHigh = false;
      state.opens = [];
      state.plays = [];
      state.highChecks = 0;
      this.scheduleNext(profileId, titleId, state);
      return "low";
    } else {
      state.manualHigh = true;
      state.highChecks = 0;
      state.nextCheckAt = this.now().getTime();
    }
    this.save(profileId, titleId, state);
    return this.priority(profileId, titleId);
  }

  opened(profileId: string, titleId: string): void {
    const state = this.state(profileId, titleId);
    const now = this.now().getTime();
    state.opens = [...state.opens.filter((at) => at > now - WEEK), now];
    if (state.opens.length >= 3 && !state.autoHigh) {
      state.autoHigh = true;
      state.highChecks = 0;
      state.nextCheckAt = now;
      this.save(profileId, titleId, state);
      return;
    }
    this.save(profileId, titleId, state);
  }

  played(profileId: string, titleId: string, episode?: EpisodeSelection): void {
    const state = this.state(profileId, titleId);
    const now = this.now().getTime();
    state.plays = [
      ...state.plays.filter((play) => play.at > now - MONTH),
      {
        at: now,
        ...(episode
          ? { episode: `${episode.seasonNumber}:${episode.episodeNumber}` }
          : {}),
      },
    ];
    if (
      !state.autoHigh &&
      (state.plays.length >= 4 ||
        new Set(state.plays.flatMap((play) => play.episode ?? [])).size >= 2)
    ) {
      state.autoHigh = true;
      state.highChecks = 0;
      state.nextCheckAt = now;
      this.save(profileId, titleId, state);
      return;
    }
    this.save(profileId, titleId, state);
  }

  /** Claim before starting work, so concurrent page reads cannot start duplicates. */
  claimDue(profileId: string, title: CatalogTitle): boolean {
    const state = this.state(profileId, title.id);
    const now = this.now().getTime();
    if ((state.manualHigh || state.autoHigh) && state.highChecks === undefined) {
      state.highChecks = 0;
      state.nextCheckAt = now;
    }
    if (state.nextCheckAt === null) {
      const checkedAt = title.availabilityCheckedAt
        ? Date.parse(title.availabilityCheckedAt)
        : now;
      const hash = createHash("sha256")
        .update(`${profileId}\u0000${title.id}\u0000${checkedAt}`)
        .digest();
      const fraction = hash.readUInt32BE(0) / 0xffffffff;
      state.nextCheckAt = checkedAt + (18 + fraction * 12) * 60 * 60_000;
    }
    if (state.nextCheckAt > now) {
      this.save(profileId, title.id, state);
      return false;
    }
    this.scheduleNext(profileId, title.id, state);
    return true;
  }

  noteExplicitCheck(profileId: string, titleId: string): void {
    this.scheduleNext(profileId, titleId, this.state(profileId, titleId));
  }

  private scheduleNext(profileId: string, titleId: string, state: State): void {
    const high = state.manualHigh || state.autoHigh;
    const attempts = state.highChecks ?? 0;
    const minutes = Math.min(240, 2 * 2 ** Math.min(attempts, 7));
    const delay = high
      ? (minutes + randomInt(0, Math.ceil(minutes * 0.25) + 1)) * 60_000
      : 18 * 60 * 60_000 + randomInt(0, 12 * 60 * 60_000);
    if (high) state.highChecks = attempts + 1;
    state.nextCheckAt = this.now().getTime() + delay;
    this.save(profileId, titleId, state);
  }
}
