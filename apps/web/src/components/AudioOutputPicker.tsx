import { useCallback, useEffect, useState } from "react";
import {
  canSelectAudioOutput,
  listAudioOutputs,
  requestAudioOutput,
  type AudioOutputDevice,
} from "../audio-output";

interface AudioOutputPickerProps {
  value: string;
  onChange: (deviceId: string) => void;
}

export function AudioOutputPicker({ value, onChange }: AudioOutputPickerProps) {
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [status, setStatus] = useState("");
  const supported = canSelectAudioOutput();
  const canRequest =
    typeof navigator !== "undefined" &&
    typeof (
      navigator.mediaDevices as
        | (MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> })
        | undefined
    )?.selectAudioOutput === "function";

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      setDevices(await listAudioOutputs());
      setStatus("");
    } catch {
      setStatus("Audio outputs could not be listed. Check browser permissions.");
    }
  }, [supported]);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () =>
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);

  const selectedMissing =
    value !== "default" &&
    !devices.some((device) => device.deviceId === value);

  return (
    <div className="audio-output-picker">
      <label className="field field--compact">
        <span>Preferred audio output</span>
        <select
          value={value}
          disabled={!supported}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="default">System default</option>
          {devices
            .filter((device) => device.deviceId !== "default")
            .map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          {selectedMissing && (
            <option value={value}>Saved output (not currently available)</option>
          )}
        </select>
      </label>
      <div className="audio-output-picker__actions">
        {supported && (
          <button className="button button--secondary" type="button" onClick={() => void refresh()}>
            Refresh outputs
          </button>
        )}
        {supported && canRequest && (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => {
              void requestAudioOutput()
                .then((device) => {
                  if (!device) return;
                  setDevices((current) => [
                    ...current.filter((item) => item.deviceId !== device.deviceId),
                    device,
                  ]);
                  onChange(device.deviceId);
                  setStatus("");
                })
                .catch(() => setStatus("Audio output selection was cancelled or denied."));
            }}
          >
            Choose output device
          </button>
        )}
      </div>
      {!supported && (
        <p className="settings-note">
          This browser cannot select an output device. Audio uses the system default.
        </p>
      )}
      {supported && devices.length === 0 && (
        <p className="settings-note">
          No separate outputs are visible yet. Use the system default or grant device access.
        </p>
      )}
      {status && <p className="settings-note" role="status">{status}</p>}
    </div>
  );
}
