import { z } from "zod";

import {
  CONNECTOR_CONTRACT_VERSION,
  FieldProvenanceSchema,
  ProviderDescriptorSchema,
  ProviderErrorCategorySchema,
  SOURCE_CONNECTOR_CAPABILITIES,
  type FieldProvenance,
  type ProviderDescriptor,
  type ProviderFamily,
  type SourceConnectorFamily,
} from "./provider-common.js";

export type CompatibleConnectorDescriptor<TFamily extends ProviderFamily> =
  ProviderDescriptor & {
    family: TFamily;
    contractVersion: typeof CONNECTOR_CONTRACT_VERSION;
  };

/** Stable ID shared by registration, result references and public failures. */
export const ConnectorIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);

/**
 * Validate a descriptor before registration. Unknown capabilities are allowed
 * only in the adapter's own namespace, so core code never silently dispatches
 * a misspelled standardized capability.
 */
export function assertConnectorDescriptor<TFamily extends ProviderFamily>(
  value: unknown,
  family: TFamily,
): CompatibleConnectorDescriptor<TFamily> {
  const descriptor = ProviderDescriptorSchema.parse(value);
  ConnectorIdSchema.parse(descriptor.id);
  if (descriptor.family !== family) {
    throw new Error(
      `Provider '${descriptor.id}' belongs to '${descriptor.family}', expected '${family}'.`,
    );
  }

  if (family in SOURCE_CONNECTOR_CAPABILITIES) {
    const known = new Set<string>(
      SOURCE_CONNECTOR_CAPABILITIES[family as SourceConnectorFamily],
    );
    const extensionPrefix = `x-${descriptor.id}:`;
    for (const capability of descriptor.capabilities) {
      if (
        !known.has(capability) &&
        !(
          capability.startsWith(extensionPrefix) &&
          /^[a-z][a-z0-9-]*$/.test(capability.slice(extensionPrefix.length))
        )
      ) {
        throw new Error(
          `Provider '${descriptor.id}' declares unsupported ${family} capability '${capability}'.`,
        );
      }
    }
  }

  // Built-in adapters predating this field are contract v1. New adapters
  // should declare the version explicitly in their descriptor.
  return {
    ...descriptor,
    contractVersion: CONNECTOR_CONTRACT_VERSION,
    family,
  };
}

/** Stable, redacted failure data; never include an upstream URL or response. */
export const ProviderFailureSchema = z
  .object({
    providerId: ConnectorIdSchema,
    operation: z.string().regex(/^[a-z][a-zA-Z0-9]{0,79}$/),
    category: ProviderErrorCategorySchema,
    retryable: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type ProviderFailure = z.infer<typeof ProviderFailureSchema>;

/** Adapter-facing error whose public fields cannot carry provider secrets. */
export class ConnectorFailure extends Error {
  readonly failure: ProviderFailure;

  constructor(value: ProviderFailure) {
    const failure = ProviderFailureSchema.parse(value);
    super(`Provider '${failure.providerId}' failed: ${failure.category}.`);
    this.name = "ConnectorFailure";
    this.failure = failure;
  }
}

export interface ConnectorAttributedCandidate {
  ref: { providerId: string };
  provenance: FieldProvenance;
}

/** Enforce ownership of a normalized candidate before cross-source merging. */
export function assertConnectorAttribution(
  descriptor: ProviderDescriptor,
  candidate: ConnectorAttributedCandidate,
): void {
  const parsedDescriptor = ProviderDescriptorSchema.parse(descriptor);
  const provenance = FieldProvenanceSchema.parse(candidate.provenance);
  if (
    candidate.ref.providerId !== parsedDescriptor.id ||
    provenance.providerId !== parsedDescriptor.id ||
    provenance.connectorVersion !== parsedDescriptor.connectorVersion
  ) {
    throw new Error(
      `Provider '${parsedDescriptor.id}' returned a candidate with inconsistent attribution.`,
    );
  }
}
