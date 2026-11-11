import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SupportPanel } from "./SupportPanel";

afterEach(() => vi.unstubAllGlobals());

it("keeps logs out of the GitHub report and offers a separate ZIP", async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      available: true,
      entries: [
        {
          time: "2026-11-10T10:00:00.000Z",
          level: 50,
          code: "PLAYBACK_MANIFEST_FAILED",
          token: "private",
        },
      ],
    }),
  });
  vi.stubGlobal("fetch", fetcher);
  render(<SupportPanel />);
  fireEvent.change(screen.getByLabelText("What happened?"), {
    target: { value: "Playback stopped" },
  });
  fireEvent.change(screen.getByLabelText("Steps to reproduce"), {
    target: { value: "1. Press play" },
  });
  fireEvent.change(screen.getByLabelText("Expected result"), {
    target: { value: "Video starts" },
  });
  const checkbox = screen.getByRole("checkbox", {
    name: "Include logs in ZIP",
  });
  expect(checkbox).toBeChecked();
  expect(
    await screen.findByText("1 recent event ready for download.", {
      exact: false,
    }),
  ).toBeVisible();
  const issue = screen.getByRole("link", { name: "Open GitHub issue" });
  const body = () =>
    new URL(issue.getAttribute("href")!).searchParams.get("body")!;
  expect(body()).toContain("Playback stopped");
  expect(body()).toContain("1. Press play");
  expect(body()).toContain("Video starts");
  expect(body()).not.toContain("PLAYBACK_MANIFEST_FAILED");
  expect(
    screen.getByRole("button", { name: "Download diagnostics ZIP" }),
  ).toBeVisible();
  expect(
    screen.getByText(/Attach the ZIP to the GitHub issue yourself/),
  ).toBeVisible();
  expect(body()).not.toContain("private");
  fireEvent.click(checkbox);
  expect(body()).not.toContain("PLAYBACK_MANIFEST_FAILED");
  expect(
    screen.getByRole("button", { name: "Save report offline" }),
  ).toBeEnabled();
});

it("allows reporting without owner access and explains that logs could not be loaded", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  render(<SupportPanel />);
  await waitFor(() =>
    expect(screen.getByText(/Recent logs are unavailable/)).toBeVisible(),
  );
  expect(screen.getByRole("link", { name: "Open GitHub issue" })).toBeVisible();
});

it("previews and includes a screenshot in the saved report, with GitHub instructions", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const createUrl = vi.fn().mockReturnValue("blob:report");
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: createUrl,
      revokeObjectURL: vi.fn(),
    }),
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
  render(<SupportPanel />);
  const file = new File(["image contents"], "screen.png", {
    type: "image/png",
  });
  fireEvent.change(screen.getByLabelText("Screenshot (optional)"), {
    target: { files: [file] },
  });
  const preview = await screen.findByRole("img", {
    name: "Screenshot preview",
  });
  expect(preview.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  expect(
    screen.getByText(/attach the original image in the GitHub form/),
  ).toBeVisible();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Save report offline" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save report offline" }));
  expect(createUrl).toHaveBeenCalledOnce();
  const blob = createUrl.mock.calls[0]![0] as Blob;
  expect(blob.type).toMatch(/^text\/html/);
  const content = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
  expect(content).toContain(preview.getAttribute("src"));
  expect(
    new URL(
      screen
        .getByRole("link", { name: "Open GitHub issue" })
        .getAttribute("href")!,
    ).searchParams.get("body"),
  ).not.toContain("Attach the screenshot");
  fireEvent.click(screen.getByRole("button", { name: "Remove screenshot" }));
  expect(
    screen.queryByRole("img", { name: "Screenshot preview" }),
  ).not.toBeInTheDocument();
  click.mockRestore();
});

it("rejects unsupported screenshots", () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  render(<SupportPanel />);
  fireEvent.change(screen.getByLabelText("Screenshot (optional)"), {
    target: {
      files: [new File(["bad"], "file.svg", { type: "image/svg+xml" })],
    },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("PNG, JPEG or WebP");
});

it("shows remaining characters and preserves long reports without truncation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<SupportPanel />);
  const field = screen.getByLabelText("What happened?");
  expect(field).toHaveAttribute("maxlength", "20000");
  expect(screen.getAllByText("20000 characters remaining")).toHaveLength(3);
  const text = "x".repeat(8000);
  fireEvent.change(field, { target: { value: text } });
  expect(screen.getByText("12000 characters remaining")).toBeVisible();
  const issue = screen.getByRole("link", { name: "Open GitHub issue" });
  expect(new URL(issue.getAttribute("href")!).searchParams.has("body")).toBe(
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(text)),
  );
});

it("downloads a separate ZIP of logs when opening GitHub", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          available: true,
          entries: [
            {
              time: "2026-11-10T10:00:00.000Z",
              level: 50,
              code: "PLAYBACK_MANIFEST_FAILED",
            },
          ],
        }),
      }),
  );
  const createUrl = vi.fn().mockReturnValue("blob:archive");
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: createUrl,
      revokeObjectURL: vi.fn(),
    }),
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
  render(<SupportPanel />);
  await screen.findByText(/1 recent event ready for download/);
  await waitFor(() =>
    expect(
      screen.getByRole("link", { name: "Open GitHub issue" }),
    ).toHaveAttribute("aria-disabled", "false"),
  );
  fireEvent.click(screen.getByRole("link", { name: "Open GitHub issue" }));
  expect(createUrl).toHaveBeenCalledOnce();
  expect((createUrl.mock.calls[0]![0] as Blob).type).toBe("application/zip");
  expect(click).toHaveBeenCalledOnce();
  click.mockRestore();
});
