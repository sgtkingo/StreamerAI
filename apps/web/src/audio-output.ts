export interface AudioOutputDevice {
  deviceId: string;
  label: string;
}

type SelectableMediaDevices = MediaDevices & {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>;
};

type SinkableMediaElement = HTMLMediaElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

export function canSelectAudioOutput(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    typeof (HTMLMediaElement.prototype as SinkableMediaElement).setSinkId ===
      "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.enumerateDevices === "function"
  );
}

export async function listAudioOutputs(): Promise<AudioOutputDevice[]> {
  if (!canSelectAudioOutput()) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  const seen = new Set<string>();
  return devices
    .filter((device) => device.kind === "audiooutput" && device.deviceId)
    .filter((device) => {
      if (seen.has(device.deviceId)) return false;
      seen.add(device.deviceId);
      return true;
    })
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Audio output ${index + 1}`,
    }));
}

export async function requestAudioOutput(): Promise<AudioOutputDevice | null> {
  const mediaDevices = navigator.mediaDevices as
    | SelectableMediaDevices
    | undefined;
  if (!mediaDevices?.selectAudioOutput) return null;
  const device = await mediaDevices.selectAudioOutput();
  return { deviceId: device.deviceId, label: device.label || "Selected output" };
}

export async function applyAudioOutput(
  element: HTMLMediaElement,
  deviceId: string,
): Promise<"applied" | "unsupported"> {
  const sinkable = element as SinkableMediaElement;
  if (typeof sinkable.setSinkId !== "function")
    return deviceId === "default" ? "applied" : "unsupported";
  await sinkable.setSinkId(deviceId);
  return "applied";
}
