import { describe, expect, it } from "vitest";
import {
  WebshareClient,
  WEBSHARE_WST_SECRET_KEY,
  type WebshareFileInfo,
  type WebshareSimilarSubtitleItem,
} from "../src/integrations/webshare-client.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";
import {
  matchExternalSubtitleFilename,
  MAX_EXTERNAL_SUBTITLE_BYTES,
  WebshareExternalSubtitleService,
} from "../src/services/external-subtitle-service.js";

const movie = "Interstellar.2014.1080p.BluRay.x264.mkv";

function fileInfo(ident: string, name: string, size = 1024): WebshareFileInfo {
  return {
    ident,
    name,
    type: name.split(".").at(-1) ?? null,
    size,
    downloadable: true,
    passwordProtected: false,
    copyrighted: false,
  };
}

describe("external subtitle filename matching", () => {
  it("prioritizes exact release names and language/forced suffixes", () => {
    expect(
      matchExternalSubtitleFilename(movie, movie.replace(/mkv$/, "srt")),
    ).toMatchObject({ matchType: "exact", language: null, forced: false });
    expect(
      matchExternalSubtitleFilename(
        movie,
        "Interstellar.2014.1080p.BluRay.x264.cze.forced.srt",
      ),
    ).toMatchObject({ matchType: "language", language: "cs", forced: true });
    expect(
      matchExternalSubtitleFilename(
        movie,
        "Interstellar.2014.1080p.BluRay.x264.en.default.vtt",
      ),
    ).toMatchObject({ matchType: "language", language: "en", default: true });
    expect(
      matchExternalSubtitleFilename("The.English.mkv", "The.English.srt"),
    ).toMatchObject({ matchType: "exact", language: null });
    expect(
      matchExternalSubtitleFilename("The.English.mkv", "The.English.en.srt"),
    ).toMatchObject({ matchType: "language", language: "en" });
    expect(
      matchExternalSubtitleFilename("Film.mkv", "Film.en.cs.srt"),
    ).toMatchObject({ matchType: "language", language: "cs" });
  });

  it("removes release metadata while preserving the movie title and year", () => {
    expect(
      matchExternalSubtitleFilename(
        movie,
        "Interstellar.2014.WEB-DL.H265.cs.ass",
      ),
    ).toMatchObject({ matchType: "normalized", language: "cs" });
    expect(
      matchExternalSubtitleFilename(movie, "Interstellar.2013.1080p.srt"),
    ).toBeNull();
    expect(matchExternalSubtitleFilename(movie, "Interstellar.srt")).toBeNull();
    expect(
      matchExternalSubtitleFilename(movie, "Interstellar.2014.Final.Cut.srt"),
    ).toBeNull();
    expect(
      matchExternalSubtitleFilename(
        "Film.2020.Part.1.1080p.mkv",
        "Film.2020.Part.2.srt",
      ),
    ).toBeNull();
    expect(
      matchExternalSubtitleFilename(
        "Film.2020.Disc.1.1080p.mkv",
        "Film.2020.Disc.2.srt",
      ),
    ).toBeNull();
    expect(
      matchExternalSubtitleFilename(
        "A.Quiet.Place.1080p.WEB-DL.mkv",
        "A.Quiet.Place.srt",
      ),
    ).toMatchObject({ matchType: "normalized" });
    expect(
      matchExternalSubtitleFilename("Dune.1080p.mkv", "Dune.srt"),
    ).toBeNull();
  });

  it("treats TV episode identity as a hard constraint across naming patterns", () => {
    expect(
      matchExternalSubtitleFilename(
        "The.Expanse.S02E07.1080p.mkv",
        "The.Expanse.2x07.eng.srt",
      ),
    ).toMatchObject({ matchType: "normalized", language: "en" });
    expect(
      matchExternalSubtitleFilename(
        "The.Expanse.S02E07.mkv",
        "The.Expanse.S02E08.srt",
      ),
    ).toBeNull();
    expect(
      matchExternalSubtitleFilename(
        "The.Expanse.S02E07.mkv",
        "The.Expanse.srt",
      ),
    ).toBeNull();
    expect(
      matchExternalSubtitleFilename(
        "The.Expanse.S02E07.mkv",
        "Another.Show.S02E07.srt",
      ),
    ).toBeNull();
    expect(
      matchExternalSubtitleFilename(
        "The.Expanse.S02E07-E08.mkv",
        "The.Expanse.S02E07.srt",
      ),
    ).toBeNull();
    expect(
      matchExternalSubtitleFilename(
        "The.Expanse.S02E07.mkv",
        "The.Expanse.S02E07E08.srt",
      ),
    ).toBeNull();
  });

  it("allows only a small title typo with the same year or episode", () => {
    expect(
      matchExternalSubtitleFilename(
        "The.Martian.2015.1080p.mkv",
        "The.Martain.2015.en.srt",
      ),
    ).toMatchObject({ matchType: "fuzzy", language: "en" });
    expect(
      matchExternalSubtitleFilename(
        "The.Martian.2015.mkv",
        "The.Martain.2014.srt",
      ),
    ).toBeNull();
    expect(
      matchExternalSubtitleFilename(
        "The.Martian.2015.mkv",
        "The.Marian.2015.srt",
      ),
    ).toBeNull();
  });
});

describe("Webshare external subtitle service", () => {
  it("filters provider suggestions by extension, size, safe ID, title and episode", async () => {
    const items: WebshareSimilarSubtitleItem[] = [
      {
        ident: "exact",
        name: "The.Expanse.S02E07.srt",
        type: "srt",
        size: 1000,
      },
      {
        ident: "language",
        name: "The.Expanse.S02E07.cs.forced.ass",
        type: "ass",
        size: 1000,
      },
      {
        ident: "wrongEpisode",
        name: "The.Expanse.S02E08.srt",
        type: "srt",
        size: 1000,
      },
      {
        ident: "tooLarge",
        name: "The.Expanse.S02E07.vtt",
        type: "vtt",
        size: MAX_EXTERNAL_SUBTITLE_BYTES + 1,
      },
      {
        ident: "archive",
        name: "The.Expanse.S02E07.zip",
        type: "zip",
        size: 1000,
      },
      {
        ident: "disguisedArchive",
        name: "The.Expanse.S02E07.srt",
        type: "zip",
        size: 1000,
      },
      {
        ident: "bad/id",
        name: "The.Expanse.S02E07.ssa",
        type: "ssa",
        size: 1000,
      },
    ];
    const queries: string[] = [];
    const service = new WebshareExternalSubtitleService({
      fileInfo: async (id) => fileInfo(id, "The.Expanse.S02E07.mkv"),
      similarSubtitles: async (name) => {
        queries.push(name);
        return items;
      },
      downloadFile: async () => Buffer.from(""),
    });
    expect(await service.discover("mediaId")).toEqual([
      {
        fileId: "exact",
        filename: "The.Expanse.S02E07.srt",
        extension: "srt",
        language: null,
        forced: false,
        default: false,
        matchScore: 1,
        matchType: "exact",
      },
      {
        fileId: "language",
        filename: "The.Expanse.S02E07.cs.forced.ass",
        extension: "ass",
        language: "cs",
        forced: true,
        default: false,
        matchScore: 0.97,
        matchType: "language",
      },
    ]);
    expect(queries).toEqual(["The.Expanse.S02E07.mkv"]);
  });

  it("rechecks availability and size before downloading, then decodes legacy Czech text", async () => {
    const downloads: string[] = [];
    const service = new WebshareExternalSubtitleService({
      fileInfo: async (id) => fileInfo(id, "Film.2020.cs.srt"),
      similarSubtitles: async () => [],
      downloadFile: async (id) => {
        downloads.push(id);
        return Buffer.from([0x50, 0xf8, 0xed, 0x6c, 0x69, 0x9a]);
      },
    });
    expect(await service.load("subtitleId")).toEqual({
      filename: "Film.2020.cs.srt",
      content: "Příliš",
    });
    expect(downloads).toEqual(["subtitleId"]);

    const oversized = new WebshareExternalSubtitleService({
      fileInfo: async (id) =>
        fileInfo(id, "Film.2020.cs.srt", MAX_EXTERNAL_SUBTITLE_BYTES + 1),
      similarSubtitles: async () => [],
      downloadFile: async () => {
        throw new Error("must not download");
      },
    });
    await expect(oversized.load("subtitleId")).rejects.toMatchObject({
      kind: "forbidden",
    });
    const malformedUtf16 = new WebshareExternalSubtitleService({
      fileInfo: async (id) => fileInfo(id, "Film.2020.cs.srt"),
      similarSubtitles: async () => [],
      downloadFile: async () => Buffer.from([0xff, 0xfe, 0x41]),
    });
    await expect(malformedUtf16.load("subtitleId")).rejects.toMatchObject({
      kind: "invalid-response",
    });
  });
});

describe("Webshare subtitle transport", () => {
  it("rejects incomplete file restriction metadata", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(WEBSHARE_WST_SECRET_KEY, "session-token");
    const client = new WebshareClient({
      secretStore: secrets,
      fetch: async () =>
        new Response(
          "<response><status>OK</status><name>Film.2020.srt</name><size>42</size><available>1</available><password>0</password></response>",
        ),
    });
    await expect(client.fileInfo("subtitleId")).rejects.toMatchObject({
      kind: "invalid-response",
    });
  });

  it("reads only the provider subtitles group and requests file_download", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(WEBSHARE_WST_SECRET_KEY, "session-token");
    const calls: Array<{ path: string; body: string }> = [];
    const client = new WebshareClient({
      secretStore: secrets,
      fetch: async (url, init) => {
        calls.push({ path: url, body: init.body ?? "" });
        if (url.endsWith("/similar_files/")) {
          return new Response(
            `<response><status>OK</status><subtitles><file><ident>sub1</ident><name>Film.2020.&#x63;s.srt</name><type>srt</type><size>500</size></file></subtitles><similar><file><ident>movie2</ident><name>Film.2020.mp4</name></file></similar></response>`,
          );
        }
        if (url.endsWith("/file_link/")) {
          return new Response(
            "<response><status>OK</status><link>https://dl.wsfiles.cz/sub1</link></response>",
          );
        }
        return new Response("hello", { status: 200 });
      },
    });
    expect(await client.similarSubtitles("Film.2020.mkv")).toEqual([
      { ident: "sub1", name: "Film.2020.cs.srt", type: "srt", size: 500 },
    ]);
    expect(await client.downloadFile("sub1", 100)).toEqual(
      Buffer.from("hello"),
    );
    expect(new URLSearchParams(calls[0]?.body).get("what")).toBe(
      "Film.2020.mkv",
    );
    expect(new URLSearchParams(calls[1]?.body).get("download_type")).toBe(
      "file_download",
    );
    expect(calls[2]?.path).toBe("https://dl.wsfiles.cz/sub1");
  });

  it("blocks redirects, untrusted download hosts, and bodies beyond the byte limit", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(WEBSHARE_WST_SECRET_KEY, "session-token");
    const untrusted = new WebshareClient({
      secretStore: secrets,
      fetch: async () =>
        new Response(
          "<response><status>OK</status><link>https://evil.example/sub</link></response>",
        ),
    });
    await expect(untrusted.createDownloadLink("sub1")).rejects.toMatchObject({
      kind: "invalid-response",
    });
    const alternatePort = new WebshareClient({
      secretStore: secrets,
      fetch: async () =>
        new Response(
          "<response><status>OK</status><link>https://dl.wsfiles.cz:8443/sub</link></response>",
        ),
    });
    await expect(
      alternatePort.createDownloadLink("sub1"),
    ).rejects.toMatchObject({
      kind: "invalid-response",
    });
    const oversized = new WebshareClient({
      secretStore: secrets,
      fetch: async (url) =>
        url.endsWith("/file_link/")
          ? new Response(
              "<response><status>OK</status><link>https://dl.wsfiles.cz/sub1</link></response>",
            )
          : new Response("123456", { status: 200 }),
    });
    await expect(oversized.downloadFile("sub1", 5)).rejects.toMatchObject({
      kind: "invalid-response",
    });
    const redirect = new WebshareClient({
      secretStore: secrets,
      fetch: async (url) =>
        url.endsWith("/file_link/")
          ? new Response(
              "<response><status>OK</status><link>https://dl.wsfiles.cz/sub1</link></response>",
            )
          : new Response(null, {
              status: 302,
              headers: { location: "https://evil.example/sub" },
            }),
    });
    await expect(redirect.downloadFile("sub1", 5)).rejects.toMatchObject({
      kind: "upstream",
      status: 302,
    });
  });

  it("caps streaming XML before accepting a provider result", async () => {
    const client = new WebshareClient({
      secretStore: new NonPersistentMemorySecretStore(),
      fetch: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    });
    await expect(
      client.similarSubtitles("Film.2020.mkv"),
    ).rejects.toMatchObject({
      kind: "invalid-response",
    });
  });
});
