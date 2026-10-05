import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAudioOutput, revealAudioOutputs } from "../audio-output";
import { AudioOutputPicker } from "./AudioOutputPicker";

const previousMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);
const previousCreateObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const previousRevokeObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);

afterEach(() => {
  if (previousMediaDevices)
    Object.defineProperty(navigator, "mediaDevices", previousMediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
  if (previousCreateObjectURL)
    Object.defineProperty(URL, "createObjectURL", previousCreateObjectURL);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (previousRevokeObjectURL)
    Object.defineProperty(URL, "revokeObjectURL", previousRevokeObjectURL);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("audio output selection", () => {
  it("lists output devices and routes media to the chosen sink", async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true,
      value: setSinkId,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          {
            kind: "audiooutput",
            deviceId: "speaker-1",
            label: "Living room speakers",
          },
          { kind: "audiooutput", deviceId: "speaker-1", label: "Duplicate" },
          { kind: "audioinput", deviceId: "mic-1", label: "Microphone" },
        ]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AudioOutputPicker value="default" onChange={onChange} />);
    await user.click(
      screen.getByRole("button", { name: "Preferred audio output" }),
    );
    const option = await screen.findByRole("option", {
      name: "Living room speakers",
    });
    expect(option).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Duplicate" })).toBeNull();
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith("speaker-1");
    expect(
      await applyAudioOutput(document.createElement("video"), "speaker-1"),
    ).toBe("applied");
    expect(setSinkId).toHaveBeenCalledWith("speaker-1");
    await applyAudioOutput(document.createElement("video"), "default");
    expect(setSinkId).toHaveBeenCalledTimes(1);
    const previouslyRouted = document.createElement("video");
    Object.defineProperty(previouslyRouted, "sinkId", { value: "speaker-1" });
    await applyAudioOutput(previouslyRouted, "default");
    expect(setSinkId).toHaveBeenLastCalledWith("");
  });

  it("can explicitly reveal outputs and immediately stop microphone capture", async () => {
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    let allowed = false;
    const stop = vi.fn();
    const enumerateDevices = vi.fn().mockImplementation(async () =>
      allowed
        ? [
            {
              kind: "audiooutput",
              deviceId: "headphones",
              label: "Headphones",
            },
          ]
        : [],
    );
    const getUserMedia = vi.fn().mockImplementation(async () => {
      allowed = true;
      return { getTracks: () => [{ stop }] };
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices,
        getUserMedia,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AudioOutputPicker value="default" onChange={onChange} />);
    expect(
      await screen.findByText(
        /Open the selector to discover available outputs/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show more audio outputs" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Preferred audio output" }),
    );
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(stop).toHaveBeenCalledOnce();
    const headphones = await screen.findByRole("option", {
      name: "Headphones",
    });
    await user.click(headphones);
    expect(onChange).toHaveBeenCalledWith("headphones");
  });

  it("opens the browser speaker picker when available", async () => {
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    const selectAudioOutput = vi.fn().mockResolvedValue({
      kind: "audiooutput",
      deviceId: "speaker-2",
      label: "Desk speakers",
    });
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([]),
        selectAudioOutput,
        getUserMedia,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<AudioOutputPicker value="default" onChange={onChange} />);
    await user.click(
      screen.getByRole("button", { name: "Preferred audio output" }),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("speaker-2"));
    expect(selectAudioOutput).toHaveBeenCalledOnce();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("routes the softer test cue to the selected output", async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    const pause = vi.fn();
    const removeAttribute = vi.fn();
    const audio = {
      volume: 1,
      onended: null as null | (() => void),
      onerror: null as null | (() => void),
      setSinkId,
      play: vi.fn().mockImplementation(async () => {
        queueMicrotask(() => audio.onended?.());
      }),
      pause,
      removeAttribute,
    };
    vi.stubGlobal(
      "Audio",
      vi.fn(() => audio),
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn().mockReturnValue("blob:test-tone"),
    });
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revoke,
    });

    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: vi
          .fn()
          .mockResolvedValue([
            {
              kind: "audiooutput",
              deviceId: "headphones",
              label: "Headphones",
            },
          ]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const user = userEvent.setup();
    render(<AudioOutputPicker value="headphones" onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Test audio output" }));

    expect(setSinkId).toHaveBeenCalledWith("headphones");
    await waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
    expect(pause).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:test-tone");
  });

  it("stops microphone capture even when device enumeration fails", async () => {
    const stop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop }],
        }),
        enumerateDevices: vi.fn().mockRejectedValue(new Error("blocked")),
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true,
      value: vi.fn(),
    });
    await expect(revealAudioOutputs()).rejects.toThrow("blocked");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops microphone capture if device enumeration never settles", async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop }],
        }),
        enumerateDevices: vi.fn().mockReturnValue(new Promise(() => undefined)),
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true,
      value: vi.fn(),
    });
    const request = revealAudioOutputs();
    const rejection = expect(request).rejects.toThrow(
      "Device discovery timed out.",
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(stop).toHaveBeenCalledOnce();
  });
});
