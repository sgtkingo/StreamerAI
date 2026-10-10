import type {
  IntegrationDescriptor,
  IntegrationId,
  ProviderDescriptor,
} from "@streamer-ai/contracts";
import type { IntegrationConnectionStatus } from "../stores/integration-state-store.js";

export interface IntegrationCatalogItem {
  id: IntegrationId;
  name: string;
  description: string;
  category: IntegrationDescriptor["kind"];
  required: boolean;
  planned: boolean;
  selected: boolean;
  status: IntegrationConnectionStatus;
  configured: boolean;
  setup: {
    mode: IntegrationDescriptor["setupMode"];
    documentationUrl: string | null;
    automatedCheck: boolean;
    canAutoDetect: boolean;
    supportsDisconnect: boolean;
  };
}

/** Public UI model generated from the shared registry, never provider secrets. */
export function integrationCatalogItem(
  descriptor: IntegrationDescriptor,
  status: IntegrationConnectionStatus,
  configured: boolean,
): IntegrationCatalogItem {
  return {
    id: descriptor.id,
    name: descriptor.name.en,
    description: descriptor.description.en,
    category: descriptor.kind,
    required: !descriptor.optional,
    planned: descriptor.planned === true,
    selected: descriptor.planned === true && status === "action_required",
    status,
    configured,
    setup: {
      mode: descriptor.setupMode,
      documentationUrl: descriptor.documentationUrl ?? null,
      automatedCheck: descriptor.automatedChecks,
      canAutoDetect: descriptor.canAutoDetect,
      supportsDisconnect: descriptor.supportsDisconnect,
    },
  };
}

/** Adapt a registered community connector's public descriptor for generic setup UI. */
export function providerIntegrationDescriptor(
  provider: ProviderDescriptor,
): IntegrationDescriptor {
  const kind = provider.family === "agent" ? "inference" : provider.family;
  const description = provider.privacySummary;
  return {
    id: provider.id,
    kind,
    name: {
      en: provider.displayName,
      cs: provider.displayName,
      de: provider.displayName,
    },
    description: { en: description, cs: description, de: description },
    setupMode: provider.setupMode,
    optional: true,
    canAutoDetect: provider.canAutoDetect,
    automatedChecks: provider.supportsRecheck,
    supportsDisconnect: provider.supportsDisconnect,
    ...(provider.documentationUrl
      ? { documentationUrl: provider.documentationUrl }
      : {}),
  };
}
