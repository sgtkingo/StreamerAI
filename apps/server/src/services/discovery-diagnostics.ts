import type { ProviderContext } from "@streamer-ai/contracts";
import { ProviderRequestError } from "../integrations/provider-http.js";

export type DiscoveryDiagnosticSink = (
  event: { code: string } & Record<string, unknown>,
) => void;

export type DiscoveryProviderContext = ProviderContext & {
  discoverySessionId?: string;
};

/** Log classifications, never provider response bodies, messages or credentials. */
export function discoveryFailure(error: unknown) {
  if (error instanceof ProviderRequestError)
    return {
      type: "ProviderRequestError",
      providerId: error.providerId,
      kind: error.kind,
      retryable: error.retryable,
      status: error.status ?? null,
    };
  return {
    type:
      error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.name)
        ? error.name
        : "UnknownError",
  };
}

export function traceDiscovery(
  sink: DiscoveryDiagnosticSink | undefined,
  context: ProviderContext,
  code: string,
  details: Record<string, unknown> = {},
): void {
  sink?.({
    ...details,
    code,
    discoveryRequestId: context.requestId,
    sessionId: (context as DiscoveryProviderContext).discoverySessionId,
    profileId: context.profileId ?? null,
  });
}
