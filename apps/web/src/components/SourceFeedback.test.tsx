import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { SourceFeedback, TitleSource } from "@streamer-ai/contracts";
import type { StreamerApi } from "../api/client";
import { SourceFeedbackSettings, useSourceFeedback } from "./SourceFeedback";
import { ToastProvider } from "./ToastProvider";

const source: TitleSource = {
  id: "a".repeat(32),
  providerId: "webshare",
  candidateId: "file-42",
  releaseName: "Sample.S01E02.mkv",
  seasonNumber: 1,
  episodeNumber: 2,
  sizeBytes: 100,
  checkedAt: "2026-11-01T12:00:00Z",
  format: {
    label: "1080p",
    container: "mkv",
    resolution: "1080p",
    videoCodec: null,
    audioLanguages: [],
    subtitleLanguages: [],
  },
};
function Harness({
  api,
  profileId = "first",
}: {
  api: StreamerApi;
  profileId?: string;
}) {
  const feedback = useSourceFeedback(api, profileId, "title-42");
  return <div>{feedback(source)}</div>;
}

it("switches and clears thumbs with accessible pressed states", async () => {
  const user = userEvent.setup();
  const api = {
    getSourceFeedback: vi.fn().mockResolvedValue({ enabled: true, items: [] }),
    saveSourceFeedback: vi
      .fn()
      .mockImplementation(
        async (_profile, _title, _source, vote: SourceFeedback["vote"]) => ({
          enabled: true,
          items: [
            {
              titleId: "title-42",
              profileId: "first-sync",
              isOwn: true,
              providerId: source.providerId,
              candidateId: source.candidateId,
              seasonNumber: 1,
              episodeNumber: 2,
              vote,
            },
          ],
        }),
      ),
  } as unknown as StreamerApi;
  render(<Harness api={api} />);
  const up = await screen.findByRole("button", {
    name: "Correct title or episode",
  });
  const down = screen.getByRole("button", { name: "Wrong title or episode" });
  await user.click(up);
  expect(up).toHaveAttribute("aria-pressed", "true");
  expect(up).toHaveClass("is-up");
  await user.click(down);
  expect(up).toHaveAttribute("aria-pressed", "false");
  expect(down).toHaveClass("is-down");
  await user.click(down);
  expect(down).toHaveAttribute("aria-pressed", "false");
  expect(api.saveSourceFeedback).toHaveBeenLastCalledWith(
    "first",
    "title-42",
    source.id,
    null,
  );
});

it("shows shared counts while highlighting only the current profile's vote", async () => {
  const user = userEvent.setup();
  const base = {
    titleId: "title-42",
    providerId: source.providerId,
    candidateId: source.candidateId,
    seasonNumber: 1,
    episodeNumber: 2,
  };
  const api = {
    getSourceFeedback: vi.fn().mockResolvedValue({
      enabled: true,
      items: [
        { ...base, profileId: "other", isOwn: false, vote: "up" },
        { ...base, profileId: "first", isOwn: true, vote: "down" },
      ],
    }),
    saveSourceFeedback: vi.fn().mockResolvedValue({
      enabled: true,
      items: [
        { ...base, profileId: "other", isOwn: false, vote: "up" },
        { ...base, profileId: "first", isOwn: true, vote: "up" },
      ],
    }),
  } as unknown as StreamerApi;
  render(<Harness api={api} />);
  const up = await screen.findByRole("button", {
    name: "Correct title or episode",
  });
  const down = screen.getByRole("button", { name: "Wrong title or episode" });
  expect(up).toHaveTextContent("1");
  expect(up).toHaveAttribute("aria-pressed", "false");
  expect(down).toHaveTextContent("1");
  expect(down).toHaveAttribute("aria-pressed", "true");
  await user.click(up);
  expect(up).toHaveTextContent("2");
  expect(up).toHaveAttribute("aria-pressed", "true");
  expect(down).not.toHaveTextContent("1");
});

it("hides feedback for a disabled profile and keeps its last saved state on write failure", async () => {
  const user = userEvent.setup();
  const api = {
    getSourceFeedback: vi.fn().mockResolvedValue({ enabled: false, items: [] }),
    saveSourceFeedback: vi.fn().mockRejectedValue(new Error("Save failed")),
  } as unknown as StreamerApi;
  const view = render(
    <ToastProvider>
      <Harness api={api} />
    </ToastProvider>,
  );
  await waitFor(() => expect(api.getSourceFeedback).toHaveBeenCalled());
  expect(
    screen.queryByRole("button", { name: "Correct title or episode" }),
  ).not.toBeInTheDocument();
  vi.mocked(api.getSourceFeedback!).mockResolvedValue({
    enabled: true,
    items: [],
  });
  view.rerender(
    <ToastProvider>
      <Harness api={api} profileId="second" />
    </ToastProvider>,
  );
  const up = await screen.findByRole("button", {
    name: "Correct title or episode",
  });
  await user.click(up);
  expect(up).toHaveAttribute("aria-pressed", "false");
  expect(up).toBeEnabled();
  expect(await screen.findByRole("alert")).toBeInTheDocument();
});

it("loads the profile switch and saves it without changing account votes", async () => {
  const user = userEvent.setup();
  const api = {
    getSourceFeedbackSettings: vi.fn().mockResolvedValue({ enabled: true }),
    saveSourceFeedbackSettings: vi.fn().mockResolvedValue({ enabled: false }),
  } as unknown as StreamerApi;
  render(<SourceFeedbackSettings api={api} profileId="second" />);
  const checkbox = screen.getByRole("checkbox", {
    name: "Source correctness feedback",
  });
  await waitFor(() => expect(checkbox).toBeEnabled());
  expect(checkbox).toBeChecked();
  await user.click(checkbox);
  expect(checkbox).not.toBeChecked();
  expect(api.saveSourceFeedbackSettings).toHaveBeenCalledWith("second", false);
  expect(screen.getByText(/shared across all profiles/)).toBeInTheDocument();
});
