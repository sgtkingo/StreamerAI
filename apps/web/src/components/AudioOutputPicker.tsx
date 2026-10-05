import { useCallback, useEffect, useRef, useState } from "react";
import {
  canSelectAudioOutput,
  listAudioOutputs,
  playAudioOutputTest,
  requestAudioOutput,
  revealAudioOutputs,
  type AudioOutputDevice,
} from "../audio-output";

interface AudioOutputPickerProps {
  value: string;
  onChange: (deviceId: string) => void;
}

export function AudioOutputPicker({ value, onChange }: AudioOutputPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [accessAttempted, setAccessAttempted] = useState(false);
  const supported = canSelectAudioOutput();
  const canRequest =
    typeof navigator !== "undefined" &&
    typeof (
      navigator.mediaDevices as
        | (MediaDevices & {
            selectAudioOutput?: () => Promise<MediaDeviceInfo>;
          })
        | undefined
    )?.selectAudioOutput === "function";
  const canReveal =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      setDevices(await listAudioOutputs());
    } catch {
      setStatus(
        "Audio outputs could not be listed. Check browser permissions.",
      );
    }
  }, [supported]);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () =>
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const discover = (force = false) => {
    if (!supported || busy) return;
    if (
      !force &&
      (accessAttempted ||
        devices.some((device) => device.deviceId !== "default"))
    ) {
      void refresh();
      return;
    }
    setAccessAttempted(true);
    setBusy(true);
    if (canRequest) {
      void requestAudioOutput()
        .then((device) => {
          if (!device) return;
          setDevices((current) => [
            ...current.filter((item) => item.deviceId !== device.deviceId),
            device,
          ]);
          onChange(device.deviceId);
          setOpen(false);
          setStatus(
            "Output selected. Save settings to keep it for this profile.",
          );
        })
        .catch(() => setStatus("Speaker selection was cancelled or denied."))
        .finally(() => setBusy(false));
      return;
    }
    if (canReveal) {
      void revealAudioOutputs()
        .then((outputs) => {
          setDevices(outputs);
          setStatus(
            outputs.some((device) => device.deviceId !== "default")
              ? "Choose an output, then save settings."
              : "The browser still exposes only the system default.",
          );
        })
        .catch(() =>
          setStatus(
            "Device access was denied or unavailable. System default still works.",
          ),
        )
        .finally(() => setBusy(false));
      return;
    }
    void refresh().finally(() => setBusy(false));
  };

  const selectedDevice = devices.find((device) => device.deviceId === value);
  const selectedLabel =
    value === "default"
      ? "System default"
      : (selectedDevice?.label ?? "Saved output (not currently available)");
  const additionalOutputs = devices.filter(
    (device) => device.deviceId !== "default",
  );

  return (
    <div className="audio-output-picker" ref={rootRef}>
      <div className="field field--compact">
        <span>Preferred audio output</span>
        <div className="audio-output-picker__control">
          <div className="audio-output-picker__select-wrap">
            <button
              className="audio-output-picker__select"
              type="button"
              disabled={!supported}
              aria-label="Preferred audio output"
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-controls="audio-output-options"
              onClick={() => {
                setOpen((current) => !current);
                if (!open) discover();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
            >
              <span>{selectedLabel}</span>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                <path
                  d="m6 9 6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {open && (
              <div
                className="audio-output-picker__options"
                id="audio-output-options"
                role="listbox"
                aria-label="Available audio outputs"
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={value === "default"}
                  onClick={() => {
                    onChange("default");
                    setOpen(false);
                  }}
                >
                  System default
                </button>
                {additionalOutputs.map((device) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === device.deviceId}
                    key={device.deviceId}
                    onClick={() => {
                      onChange(device.deviceId);
                      setOpen(false);
                    }}
                  >
                    {device.label}
                  </button>
                ))}
                {value !== "default" && !selectedDevice && (
                  <span className="audio-output-picker__missing">
                    Saved output is not currently available
                  </span>
                )}
                {busy && (
                  <span className="audio-output-picker__loading" role="status">
                    Checking audio outputs…
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            className="audio-output-picker__refresh"
            type="button"
            disabled={!supported || busy}
            onClick={() => discover(true)}
            aria-label="Refresh audio outputs"
            title="Refresh audio outputs"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path
                d="M19 9V6a3 3 0 0 0-3-3H8a5 5 0 0 0-5 5v1m2 6v3a3 3 0 0 0 3 3h8a5 5 0 0 0 5-5v-1"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
              <path
                d="m16 8 3 3 3-3M2 16l3-3 3 3"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <div className="audio-output-picker__actions">
        <button
          className="button button--secondary audio-output-picker__test"
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void playAudioOutputTest(value)
              .then(() =>
                setStatus(
                  `Test cue played on ${selectedLabel}. If you heard nothing, check this device and its volume.`,
                ),
              )
              .catch(() =>
                setStatus(
                  "The selected output could not play the test cue. Try System default or another device.",
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
            <circle
              cx="12"
              cy="12"
              r="8.5"
              stroke="currentColor"
              strokeWidth="1.7"
            />
            <circle cx="12" cy="12" r="2.3" fill="currentColor" />
          </svg>
          Test audio output
        </button>
      </div>
      {!supported && (
        <p className="settings-note">
          This browser cannot select an output device. Audio uses the system
          default.
        </p>
      )}
      {supported && additionalOutputs.length === 0 && !accessAttempted && (
        <p className="settings-note">
          Open the selector to discover available outputs. Your browser may ask
          for brief microphone access; capture stops immediately after the
          device list loads.
        </p>
      )}
      {supported && additionalOutputs.length === 0 && accessAttempted && (
        <p className="settings-note">
          No other output is currently visible. You can still use System
          default, or retry discovery with the refresh icon.
        </p>
      )}
      {status && (
        <p className="settings-note" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
