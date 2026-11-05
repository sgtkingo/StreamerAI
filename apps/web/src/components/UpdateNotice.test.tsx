import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateNotice } from "./UpdateNotice";

const shared = vi.hoisted(() => ({
  notify: (() => undefined) as () => void,
  activate: vi.fn(async () => undefined),
}));
vi.mock("virtual:pwa-register", () => ({
  registerSW: (options: { onNeedRefresh(): void }) => {
    shared.notify = options.onNeedRefresh;
    return shared.activate;
  },
}));
afterEach(() => vi.unstubAllGlobals());

it("waits for playback, unsaved edits and a busy sibling tab before activation", async () => {
  let peerBusy = true;
  class Channel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    postMessage(message: { kind: string }) {
      if (message.kind === "query")
        queueMicrotask(() =>
          this.onmessage?.({
            data: { kind: "status", id: "other-tab", busy: peerBusy },
          }),
        );
    }
    close() {
      /* test channel */
    }
  }
  vi.stubGlobal("BroadcastChannel", Channel);
  render(
    <>
      <input aria-label="Draft title" />
      <UpdateNotice />
    </>,
  );
  act(() => shared.notify());
  const video = document.createElement("video");
  Object.defineProperty(video, "paused", { value: false });
  document.body.append(video);
  fireEvent.click(screen.getByRole("button", { name: "Update when ready" }));
  await screen.findByText(/Finish playback and save changes/);
  expect(shared.activate).not.toHaveBeenCalled();
  video.remove();
  fireEvent.input(screen.getByLabelText("Draft title"), {
    target: { value: "unsaved" },
  });
  expect(
    screen.getByRole("button", { name: "I have saved my changes" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Update when ready" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Update when ready" }),
    ).not.toBeDisabled(),
  );
  expect(shared.activate).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "I have saved my changes" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Update when ready" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Update when ready" }),
    ).not.toBeDisabled(),
  );
  expect(shared.activate).not.toHaveBeenCalled();
  peerBusy = false;
  fireEvent.click(screen.getByRole("button", { name: "Update when ready" }));
  await waitFor(() => expect(shared.activate).toHaveBeenCalledWith(true));
});
