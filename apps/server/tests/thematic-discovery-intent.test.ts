import { describe, expect, it } from "vitest";
import { parseThematicDiscoveryIntent } from "../src/services/thematic-discovery-intent.js";

describe("thematic discovery intent", () => {
  it("routes the reported open-ended requests to catalog genres", () => {
    expect(
      parseThematicDiscoveryIntent("A clever mystery for tonight"),
    ).toEqual({
      kind: null,
      genres: ["Mystery"],
      completeOnly: false,
    });
    for (const message of [
      "A complete scify series",
      "A complete sci-fi series",
      "A complete scifi series",
    ]) {
      expect(parseThematicDiscoveryIntent(message)).toEqual({
        kind: "series",
        genres: ["Science fiction"],
        completeOnly: true,
      });
    }
  });

  it("understands common Czech and German requests", () => {
    expect(
      parseThematicDiscoveryIntent("Nějakou chytrou detektivku na večer"),
    ).toEqual({
      kind: null,
      genres: ["Mystery"],
      completeOnly: false,
    });
    expect(parseThematicDiscoveryIntent("Dokončený sci-fi seriál")).toEqual({
      kind: "series",
      genres: ["Science fiction"],
      completeOnly: true,
    });
    expect(
      parseThematicDiscoveryIntent(
        "Eine abgeschlossene Sci-Fi-Serie für heute Abend",
      ),
    ).toEqual({
      kind: "series",
      genres: ["Science fiction"],
      completeOnly: true,
    });
    expect(parseThematicDiscoveryIntent("Ein lustiger Comedy-Film")).toEqual({
      kind: "movie",
      genres: ["Comedy"],
      completeOnly: false,
    });
  });

  it("allows multiple genre constraints", () => {
    expect(parseThematicDiscoveryIntent("A sci-fi mystery movie")).toEqual({
      kind: "movie",
      genres: ["Science fiction", "Mystery"],
      completeOnly: false,
    });
    expect(parseThematicDiscoveryIntent("A fantasy series")).toEqual({
      kind: "series",
      genres: ["Fantasy"],
      completeOnly: false,
    });
  });

  it("keeps apparent title searches in the title-search route", () => {
    for (const message of [
      "Find the series called Mystery Road",
      'Find "Mystery Road"',
      "Mystery on the Orient Express",
      "Mystery Road",
      "Find Mystery Road",
      "Search for the film named Sci-Fi High",
      "Dark",
      "A Complete Unknown",
      "An autumn mystery with Sandra Bullock",
      "A mystery like Knives Out",
      "A horror series",
      "A romantic series",
      "A thriller series",
      "A sci-fi movie without horror",
      "Some sci-fi with no horror or romance",
      "Sci-fi without any boring horror",
      "Sci-fi bez hororu",
      "Ein Sci-Fi-Film ohne Horror",
    ]) {
      expect(parseThematicDiscoveryIntent(message)).toBeNull();
    }
  });
});
