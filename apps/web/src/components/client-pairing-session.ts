export interface PairingRequest {
  requestId: string;
  code: string;
  expiresAt: string;
  interval?: number;
  qrCodeDataUrl?: string;
  verificationUriComplete?: string;
}

const key = "streamer.installation.pending-pairing.v1";
type PairingSession = {
  serverId: string | null;
  name: string;
  request: PairingRequest;
};

export function clearPairingSession(): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* Storage may be disabled. */
  }
}

export function savePairingSession(
  serverId: string | undefined,
  name: string,
  request: PairingRequest,
): boolean {
  try {
    // A failed write must not leave an older request to be resumed instead.
    window.sessionStorage.removeItem(key);
    window.sessionStorage.setItem(
      key,
      JSON.stringify({
        serverId: serverId ?? null,
        name,
        request,
      } satisfies PairingSession),
    );
    return true;
  } catch {
    return false;
  }
}

export function readPairingSession(
  serverId: string | undefined,
): PairingSession | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid pairing session");
    const data = value as Partial<PairingSession>,
      request = data.request;
    const expiry =
      typeof request?.expiresAt === "string"
        ? Date.parse(request.expiresAt)
        : NaN;
    if (
      data.serverId !== (serverId ?? null) ||
      typeof data.name !== "string" ||
      !data.name.trim() ||
      data.name.length > 80 ||
      !request ||
      typeof request.requestId !== "string" ||
      !request.requestId ||
      request.requestId.length > 160 ||
      typeof request.code !== "string" ||
      !/^\d{6}$/.test(request.code) ||
      !Number.isFinite(expiry) ||
      expiry > Date.now() + 600_000 ||
      expiry < Date.now() - 300_000 ||
      (request.interval !== undefined &&
        (typeof request.interval !== "number" ||
          !Number.isFinite(request.interval) ||
          request.interval < 1 ||
          request.interval > 60)) ||
      (request.qrCodeDataUrl !== undefined &&
        (typeof request.qrCodeDataUrl !== "string" ||
          !request.qrCodeDataUrl.startsWith("data:image/png;base64,") ||
          request.qrCodeDataUrl.length > 100_000)) ||
      (request.verificationUriComplete !== undefined &&
        (typeof request.verificationUriComplete !== "string" ||
          request.verificationUriComplete.length > 2048))
    )
      throw new Error("Invalid pairing session");
    return { serverId: data.serverId, name: data.name, request };
  } catch {
    clearPairingSession();
    return null;
  }
}
