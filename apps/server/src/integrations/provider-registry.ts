import {
  assertConnectorDescriptor,
  type ProviderDescriptor,
  type ProviderFamily,
  type ProviderRegistry,
} from "@streamer-ai/contracts";

export interface DescribedProvider {
  descriptor(): ProviderDescriptor;
}

/**
 * Immutable, family-scoped provider registry used by coordinators and tests.
 * It rejects duplicate IDs and descriptor-family mismatches at composition time.
 */
export class AdapterRegistry<
  TProvider extends DescribedProvider,
> implements ProviderRegistry<TProvider> {
  readonly #providers: ReadonlyMap<string, TProvider>;

  constructor(family: ProviderFamily, providers: readonly TProvider[]) {
    const registered = new Map<string, TProvider>();
    for (const provider of providers) {
      const descriptor = assertConnectorDescriptor(
        provider.descriptor(),
        family,
      );
      if (registered.has(descriptor.id)) {
        throw new Error(
          `Provider '${descriptor.id}' is registered more than once.`,
        );
      }
      registered.set(descriptor.id, provider);
    }
    this.#providers = registered;
  }

  list(): readonly TProvider[] {
    return [...this.#providers.values()];
  }

  get(id: string): TProvider | null {
    return this.#providers.get(id) ?? null;
  }

  require(id: string): TProvider {
    const provider = this.get(id);
    if (provider === null)
      throw new Error(`Provider '${id}' is not registered.`);
    return provider;
  }
}
