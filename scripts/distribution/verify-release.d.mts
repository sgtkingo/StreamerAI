export interface ReleaseArtifact {
  platform: "win-x64" | "linux-x64" | "android";
  component?: "server" | "client";
  filename: string;
  bytes: number;
  sha256: string;
  url: string;
}

export interface ReleaseMetadata {
  format: "streamerai-signed-release/v1";
  trustEpoch: number;
  sequence: number;
  version: string;
  channel: "stable" | "beta";
  issuedAt: string;
  expiresAt: string;
  artifacts: ReleaseArtifact[];
}

export interface ReplayState {
  trustEpoch?: number;
  channels?: Record<string, { sequence: number; metadataHash: string }>;
}

export function verifyRelease(input: {
  root: unknown;
  envelope: unknown;
  state?: ReplayState;
  currentVersion: string;
  platform: ReleaseArtifact["platform"];
  component?: "server" | "client";
  channel?: "stable" | "beta";
  now?: number;
}): {
  metadata: ReleaseMetadata;
  metadataHash: string;
  artifact: ReleaseArtifact;
  state: ReplayState;
};

export function verifyArtifact(
  filename: string,
  artifact: ReleaseArtifact,
): void;
