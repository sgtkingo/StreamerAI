import { describe, expect, it } from "vitest";
import type { ProviderDescriptor } from "@streamer-ai/contracts";
import { providerIntegrationDescriptor } from "../src/integrations/catalog.js";

describe("community connector catalog", () => {
  it("uses public adapter metadata without requiring a built-in integration ID", () => {
    const provider: ProviderDescriptor = {
      id: "community-subtitles",
      family: "subtitle",
      displayName: "Community Subtitles",
      connectorVersion: "1.0.0",
      capabilities: ["movie-search"],
      supportedLocales: ["en"],
      setupMode: "none",
      credentialFields: [],
      canAutoDetect: false,
      supportsRecheck: true,
      supportsDisconnect: true,
      documentationUrl: "https://example.org/connectors/subtitles",
      privacySummary: "Searches community subtitle records.",
    };

    const descriptor = providerIntegrationDescriptor(provider);
    expect(descriptor).toMatchObject({
      id: "community-subtitles",
      kind: "subtitle",
      name: { en: "Community Subtitles" },
      setupMode: "none",
    });
    expect(descriptor.planned).toBeUndefined();
  });
});
