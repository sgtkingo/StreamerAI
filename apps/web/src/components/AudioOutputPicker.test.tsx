import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAudioOutput } from "../audio-output";
import { AudioOutputPicker } from "./AudioOutputPicker";

const previousMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);

afterEach(() => {
  if (previousMediaDevices)
    Object.defineProperty(navigator, "mediaDevices", previousMediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
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
    const option = await screen.findByRole("option", {
      name: "Living room speakers",
    });
    expect(option).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Duplicate" })).toBeNull();
    await user.selectOptions(
      screen.getByLabelText("Preferred audio output"),
      "speaker-1",
    );
    expect(onChange).toHaveBeenCalledWith("speaker-1");
    expect(
      await applyAudioOutput(document.createElement("video"), "speaker-1"),
    ).toBe("applied");
    expect(setSinkId).toHaveBeenCalledWith("speaker-1");
  });
});
