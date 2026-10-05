export interface AudioOutputDevice {
  deviceId: string;
  label: string;
}

type SelectableMediaDevices = MediaDevices & {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>;
};

type SinkableMediaElement = HTMLMediaElement & {
  sinkId?: string;
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
    SelectableMediaDevices | undefined;
  if (!mediaDevices?.selectAudioOutput) return null;
  const device = await mediaDevices.selectAudioOutput();
  return {
    deviceId: device.deviceId,
    label: device.label || "Selected output",
  };
}

/** Explicit fallback when the browser has no native speaker picker. */
export async function revealAudioOutputs(): Promise<AudioOutputDevice[]> {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.getUserMedia) return [];
  const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      listAudioOutputs(),
      new Promise<AudioOutputDevice[]>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Device discovery timed out.")),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    stream.getTracks().forEach((track) => track.stop());
  }
}

function tadamWav(): Blob {
  const rate = 22_050;
  const samples = Math.ceil(rate * 1.25);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples * 2, true);

  const chime = (time: number, start: number, frequency: number) => {
    const age = time - start;
    if (age < 0) return 0;
    const envelope = Math.min(1, age * 35) * Math.exp(-age * 5.2);
    return (
      envelope *
      (Math.sin(2 * Math.PI * frequency * age) +
        0.22 * Math.sin(2 * Math.PI * frequency * 2 * age))
    );
  };
  for (let index = 0; index < samples; index += 1) {
    const time = index / rate;
    const sample =
      0.17 * chime(time, 0.12, 392) +
      0.13 * chime(time, 0.12, 493.88) +
      0.19 * chime(time, 0.5, 523.25) +
      0.14 * chime(time, 0.5, 659.25);
    view.setInt16(
      44 + index * 2,
      Math.round(Math.max(-1, Math.min(1, sample)) * 32767),
      true,
    );
  }
  return new Blob([bytes], { type: "audio/wav" });
}

/** Plays a soft two-note cue through the same sink API as the video player. */
export async function playAudioOutputTest(deviceId: string): Promise<void> {
  const url = URL.createObjectURL(tadamWav());
  const audio = new Audio(url);
  audio.volume = 0.7;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if ((await applyAudioOutput(audio, deviceId)) === "unsupported")
      throw new Error("The browser cannot route audio to this output.");
    const ended = new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Audio test playback failed."));
      timeout = setTimeout(
        () => reject(new Error("Audio test timed out.")),
        4_000,
      );
    });
    await Promise.race([ended, audio.play().then(() => ended)]);
  } finally {
    if (timeout) clearTimeout(timeout);
    audio.pause();
    audio.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}

export async function applyAudioOutput(
  element: HTMLMediaElement,
  deviceId: string,
): Promise<"applied" | "unsupported"> {
  const sinkable = element as SinkableMediaElement;
  if (deviceId === "default") {
    if (sinkable.sinkId && typeof sinkable.setSinkId === "function")
      await sinkable.setSinkId("");
    return "applied";
  }
  if (typeof sinkable.setSinkId !== "function") return "unsupported";
  await sinkable.setSinkId(deviceId);
  return "applied";
}
