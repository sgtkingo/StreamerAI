import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_PLAYBACK_PREFERENCES,
} from "@streamer-ai/contracts";
import { openStreamerDatabase } from "@streamer-ai/database";
import { createApp } from "../src/index.js";

describe("viewer profiles", () => {
  const apps: ReturnType<typeof createApp>[] = [];
  const databases: ReturnType<typeof openStreamerDatabase>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const database of databases.splice(0)) database.close();
  });

  it("creates at most five profiles and keeps playback preferences per viewer", async () => {
    const app = createApp({ environment: "test", logger: false });
    apps.push(app);
    const first = await app.inject({ method: "GET", url: "/api/v1/profiles" });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(1);
    expect(first.json().items[0].id).toBe("default");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/profiles",
      payload: { name: "Alex", locale: "cs" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().onboardingComplete).toBe(false);
    const id = created.json().id as string;
    const playback = {
      ...DEFAULT_PLAYBACK_PREFERENCES,
      autoFindSubtitles: true,
      primaryAudioLanguage: "en",
      secondaryAudioSubtitleLanguage: "en",
    };
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/profiles/${id}`,
      payload: {
        genres: ["Drama"],
        prompt: "Quiet autumn films with rich dialogue.",
        playback,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      name: "Alex",
      genres: ["Drama"],
      prompt: "Quiet autumn films with rich dialogue.",
      playback,
    });

    const defaultProfile = (
      await app.inject({ method: "GET", url: "/api/v1/profiles" })
    )
      .json()
      .items.find((item: { id: string }) => item.id === "default");
    expect(defaultProfile.playback.autoFindSubtitles).toBe(false);
    const home = await app.inject({
      method: "GET",
      url: `/api/v1/home?profileId=${id}`,
    });
    expect(home.statusCode).toBe(200);
    const titleId = home
      .json()
      .sections.flatMap(
        (section: { items: Array<{ id: string }> }) => section.items,
      )[0].id as string;
    const saved = await app.inject({
      method: "PUT",
      url: `/api/v1/profiles/${id}/library/${encodeURIComponent(titleId)}`,
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/profiles/default/library",
        })
      ).json().items,
    ).toHaveLength(0);

    for (const name of ["B", "C", "D"]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/profiles",
            payload: { name },
          })
        ).statusCode,
      ).toBe(201);
    }
    const sixth = await app.inject({
      method: "POST",
      url: "/api/v1/profiles",
      payload: { name: "Too many" },
    });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().error.code).toBe("PROFILE_LIMIT_REACHED");
  });

  it("defaults old and new profiles safely, including corrupt stored appearance", async () => {
    const database = openStreamerDatabase({ filename: ":memory:" });
    databases.push(database);
    database.profiles.create({
      id: "legacy",
      name: "Legacy",
      locale: "cs",
      preferences: { prompt: "An older profile." },
    });
    database.profiles.create({
      id: "corrupt",
      name: "Corrupt appearance",
      locale: "en",
      preferences: { appearance: { mode: "unknown", ambientMotion: "yes" } },
    });
    const app = createApp({ environment: "test", logger: false, database });
    apps.push(app);
    const listed = await app.inject({ method: "GET", url: "/api/v1/profiles" });
    expect(listed.statusCode).toBe(200);
    for (const profile of listed.json().items) {
      expect(profile.appearance).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    }
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/profiles",
      payload: { name: "New viewer" },
    });
    expect(created.json().appearance).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    const status = await app.inject({
      method: "GET",
      url: "/api/v1/setup/status?profileId=corrupt",
    });
    expect(status.json().profile.appearance).toEqual(
      DEFAULT_APPEARANCE_PREFERENCES,
    );
  });

  it("merges theme patches without enabling motion or changing another viewer", async () => {
    const app = createApp({ environment: "test", logger: false });
    apps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/profiles",
      payload: { name: "Alex" },
    });
    const id = created.json().id as string;
    const preferences = {
      genres: ["Drama"],
      prompt: "Slow cinema.",
      playback: { ...DEFAULT_PLAYBACK_PREFERENCES, autoFindSubtitles: true },
    };
    await app.inject({
      method: "PATCH",
      url: `/api/v1/profiles/${id}`,
      payload: {
        ...preferences,
        appearance: { mode: "autumn", ambientMotion: false },
      },
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/profiles/${id}`,
      payload: { appearance: { mode: "cinematic" } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      ...preferences,
      appearance: { mode: "cinematic", ambientMotion: false },
    });
    const listed = await app.inject({ method: "GET", url: "/api/v1/profiles" });
    expect(
      listed
        .json()
        .items.find((profile: { id: string }) => profile.id === "default")
        .appearance,
    ).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/v1/profiles/${id}`,
      payload: { appearance: { mode: "not-a-theme" } },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("remembers seasonal mode across Cinematic and preserves independent appearance pins", async () => {
    const app = createApp({ environment: "test", logger: false });
    apps.push(app);
    const initial = {
      mode: "autumn",
      seasonalMode: "autumn",
      ambientMotion: false,
      weatherOverride: "rain",
      daylightOverride: "night",
    };
    const patch = (appearance: object) =>
      app.inject({
        method: "PATCH",
        url: "/api/v1/profiles/default",
        payload: { appearance },
      });
    await patch(initial);
    const cinematic = await patch({ mode: "cinematic" });
    expect(cinematic.statusCode).toBe(200);
    expect(cinematic.json().appearance).toEqual({
      ...initial,
      mode: "cinematic",
    });
    const winter = await patch({ mode: "winter" });
    expect(winter.json().appearance).toEqual({
      ...initial,
      mode: "winter",
      seasonalMode: "winter",
    });
    const snow = await patch({ weatherOverride: "snow" });
    expect(snow.json().appearance).toEqual({
      ...winter.json().appearance,
      weatherOverride: "snow",
    });
    const explicitSeason = await patch({
      mode: "cinematic",
      seasonalMode: "christmas",
    });
    expect(explicitSeason.json().appearance).toEqual({
      ...snow.json().appearance,
      mode: "cinematic",
      seasonalMode: "christmas",
    });
    const explicitAutomatic = await patch({
      mode: "auto",
      seasonalMode: "winter",
    });
    expect(explicitAutomatic.json().appearance).toEqual({
      ...snow.json().appearance,
      mode: "auto",
      seasonalMode: "winter",
    });
    for (const invalid of [
      { seasonalMode: "cinematic" },
      { weatherOverride: "hail" },
      { daylightOverride: "dusk" },
    ]) {
      expect((await patch(invalid)).statusCode).toBe(400);
    }
    const unchanged = await patch({});
    expect(unchanged.json().appearance).toEqual(
      explicitAutomatic.json().appearance,
    );
  });

  it("normalizes stored legacy seasons before applying a partial weather override", async () => {
    const database = openStreamerDatabase({ filename: ":memory:" });
    databases.push(database);
    database.profiles.create({
      id: "legacy-autumn",
      name: "Autumn viewer",
      locale: "cs",
      preferences: { appearance: { mode: "autumn", ambientMotion: false } },
    });
    const app = createApp({ environment: "test", logger: false, database });
    apps.push(app);
    const normalized = {
      ...DEFAULT_APPEARANCE_PREFERENCES,
      mode: "autumn",
      seasonalMode: "autumn",
      ambientMotion: false,
    };
    const profiles = await app.inject({
      method: "GET",
      url: "/api/v1/profiles",
    });
    expect(profiles.json().items[0].appearance).toEqual(normalized);
    const setup = await app.inject({
      method: "GET",
      url: "/api/v1/setup/status?profileId=legacy-autumn",
    });
    expect(setup.json().profile.appearance).toEqual(normalized);
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/profiles/legacy-autumn",
      payload: { appearance: { weatherOverride: "fog" } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().appearance).toEqual({
      ...normalized,
      weatherOverride: "fog",
    });
    expect(
      database.profiles.get("legacy-autumn")?.preferences.appearance,
    ).toEqual({
      ...normalized,
      weatherOverride: "fog",
    });
  });

  it("persists the theme chosen during onboarding and exposes it on setup status", async () => {
    const app = createApp({ environment: "test", logger: false });
    apps.push(app);
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: {
        localAiEnabled: false,
        profile: {
          name: "Christmas viewer",
          locale: "cs",
          appearance: {
            mode: "christmas",
            ambientMotion: false,
            weatherOverride: "snow",
            daylightOverride: "night",
          },
        },
      },
    });
    expect(setup.statusCode).toBe(204);
    const listed = await app.inject({ method: "GET", url: "/api/v1/profiles" });
    expect(listed.json().items[0]).toMatchObject({
      onboardingComplete: true,
      appearance: { mode: "christmas", ambientMotion: false },
    });
    const status = await app.inject({
      method: "GET",
      url: "/api/v1/setup/status",
    });
    expect(status.json().profile.appearance).toEqual({
      ...DEFAULT_APPEARANCE_PREFERENCES,
      mode: "christmas",
      seasonalMode: "christmas",
      ambientMotion: false,
      weatherOverride: "snow",
      daylightOverride: "night",
    });
  });

  it("revisits onboarding without erasing its taste prompt or omitted appearance", async () => {
    const app = createApp({ environment: "test", logger: false });
    apps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/profiles",
      payload: { name: "Alex" },
    });
    const id = created.json().id as string;
    await app.inject({
      method: "PATCH",
      url: `/api/v1/profiles/${id}`,
      payload: {
        prompt: "Slow cinema.",
        appearance: {
          mode: "summer",
          ambientMotion: false,
          weatherOverride: "fog",
          daylightOverride: "day",
        },
      },
    });
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/setup/complete",
      payload: {
        profileId: id,
        localAiEnabled: false,
        profile: {
          name: "Alex 2",
          locale: "cs",
          preferences: ["Drama"],
          playback: DEFAULT_PLAYBACK_PREFERENCES,
        },
      },
    });
    expect(setup.statusCode).toBe(204);
    const profiles = (
      await app.inject({ method: "GET", url: "/api/v1/profiles" })
    ).json().items;
    expect(
      profiles.find((item: { id: string }) => item.id === id),
    ).toMatchObject({
      name: "Alex 2",
      onboardingComplete: true,
      prompt: "Slow cinema.",
      genres: ["Drama"],
      appearance: {
        mode: "summer",
        seasonalMode: "summer",
        ambientMotion: false,
        weatherOverride: "fog",
        daylightOverride: "day",
      },
    });
  });
});
