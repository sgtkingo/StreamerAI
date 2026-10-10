import { describe, expect, it } from "vitest";

import {
  CONNECTOR_CONTRACT_VERSION,
  ConnectorFailure,
  PlaybackGrantSchema,
  PlaybackSourceRefreshRequestSchema,
  ProviderDescriptorSchema,
  ProviderFailureSchema,
  assertConnectorAttribution,
  assertConnectorDescriptor,
} from "../src/index.js";

const descriptor = {
  id: "example-media",
  family: "media" as const,
  displayName: "Example media",
  connectorVersion: "2.3.0",
  capabilities: ["movie-search", "direct-play"],
  supportedLocales: ["en" as const],
  setupMode: "none" as const,
  credentialFields: [],
  canAutoDetect: false,
  supportsRecheck: true,
  supportsDisconnect: true,
  documentationUrl: null,
  privacySummary: "This fixture never accesses a network.",
};

const candidate = {
  ref: { providerId: "example-media", candidateId: "movie-1" },
  provenance: {
    providerId: "example-media",
    connectorVersion: "2.3.0",
    retrievedAt: "2026-10-10T10:00:00.000Z",
    confidence: 0.9,
    validationState: "verified" as const,
    expiresAt: null,
  },
};

describe("source connector boundary", () => {
  it("negotiates the contract version separately from an adapter release", () => {
    expect(assertConnectorDescriptor(descriptor, "media")).toMatchObject({
      contractVersion: CONNECTOR_CONTRACT_VERSION,
      connectorVersion: "2.3.0",
    });
    expect(
      assertConnectorDescriptor(
        { ...descriptor, contractVersion: CONNECTOR_CONTRACT_VERSION },
        "media",
      ).contractVersion,
    ).toBe(CONNECTOR_CONTRACT_VERSION);
    expect(() =>
      assertConnectorDescriptor({ ...descriptor, contractVersion: 2 }, "media"),
    ).toThrow();
    expect(() => assertConnectorDescriptor(descriptor, "subtitle")).toThrow(
      /expected 'subtitle'/,
    );
    expect(() =>
      assertConnectorDescriptor({ ...descriptor, id: "Bad ID" }, "media"),
    ).toThrow();
  });

  it("accepts only standardized or own-namespaced source capabilities", () => {
    expect(
      assertConnectorDescriptor(
        {
          ...descriptor,
          capabilities: ["movie-search", "x-example-media:lan-scanning"],
        },
        "media",
      ).capabilities,
    ).toEqual(["movie-search", "x-example-media:lan-scanning"]);
    expect(() =>
      assertConnectorDescriptor(
        { ...descriptor, capabilities: ["episode-serach"] },
        "media",
      ),
    ).toThrow(/unsupported media capability/);
    expect(() =>
      assertConnectorDescriptor(
        { ...descriptor, capabilities: ["x-other:lan-scanning"] },
        "media",
      ),
    ).toThrow(/unsupported media capability/);
    expect(
      ProviderDescriptorSchema.safeParse({
        ...descriptor,
        capabilities: ["movie-search", "movie-search"],
      }).success,
    ).toBe(false);
  });

  it("keeps candidate references, provenance and adapter versions consistent", () => {
    expect(() =>
      assertConnectorAttribution(descriptor, candidate),
    ).not.toThrow();
    expect(() =>
      assertConnectorAttribution(descriptor, {
        ...candidate,
        ref: { ...candidate.ref, providerId: "other" },
      }),
    ).toThrow(/inconsistent attribution/);
    expect(() =>
      assertConnectorAttribution(descriptor, {
        ...candidate,
        provenance: { ...candidate.provenance, providerId: "other" },
      }),
    ).toThrow(/inconsistent attribution/);
    expect(() =>
      assertConnectorAttribution(descriptor, {
        ...candidate,
        provenance: { ...candidate.provenance, connectorVersion: "1.0.0" },
      }),
    ).toThrow(/inconsistent attribution/);
  });

  it("only carries stable, redacted connector failures across the boundary", () => {
    const failure = {
      providerId: "example-media",
      operation: "search",
      category: "RATE_LIMITED" as const,
      retryable: true,
      retryAfterMs: 1_000,
    };
    const error = new ConnectorFailure(failure);
    expect(error.failure).toEqual(failure);
    expect(error.message).not.toContain("https://");
    expect(
      ProviderFailureSchema.safeParse({
        ...failure,
        upstreamResponse: "secret value",
      }).success,
    ).toBe(false);
    expect(
      ProviderFailureSchema.safeParse({
        ...failure,
        providerId: "https://example.invalid/?token=secret",
      }).success,
    ).toBe(false);
  });

  it("refreshes an exact candidate and variant without exposing a source URL in the request", () => {
    const refresh = {
      candidate: { providerId: "example-media", candidateId: "movie-1" },
      variantId: "original-1080p",
    };
    expect(PlaybackSourceRefreshRequestSchema.parse(refresh)).toEqual(refresh);
    expect(
      PlaybackSourceRefreshRequestSchema.safeParse({
        ...refresh,
        directUrl: "https://example.invalid/private",
      }).success,
    ).toBe(false);
    expect(
      PlaybackSourceRefreshRequestSchema.safeParse({
        candidate: { providerId: "example-media" },
        variantId: "original-1080p",
      }).success,
    ).toBe(false);
  });

  it("allows only same-origin playback grants in public adapter results", () => {
    const grant = {
      grantId: "grant-1",
      titleId: "sai:tmdb:movie:42",
      providerId: "example-media",
      variantId: "movie-1",
      url: "/api/v1/playback/grants/grant-1",
      supportsHttpRange: true,
      expiresAt: "2026-10-10T12:00:00.000Z",
      embeddedSubtitles: [],
    };
    expect(PlaybackGrantSchema.parse(grant)).toEqual(grant);
    expect(
      PlaybackGrantSchema.safeParse({
        ...grant,
        url: "https://media.example/private-video",
      }).success,
    ).toBe(false);
  });
});
