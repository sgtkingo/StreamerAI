import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "./ToastProvider";
import {
  ServerUpdateReminder,
  ServerUpdatesPanel,
  shouldRemind,
  type ServerUpdateStatus,
} from "./ServerUpdates";

const base: ServerUpdateStatus = {
  supported: true,
  currentVersion: "0.1.0",
  state: "ready",
  latestVersion: "0.2.0",
  releaseNotesUrl: "https://github.com/sgtkingo/StreamerAI/releases/tag/v0.2.0",
  downloadBytes: 150 * 1024 ** 2,
  downloadedBytes: 150 * 1024 ** 2,
  checkedAt: "2026-11-15T10:00:00.000Z",
  error: null,
  settings: { autoDownload: true, nightlyInstall: false },
  remindAfter: null,
  playbackActive: false,
  nightlyWindow: { startHour: 2, endHour: 5 },
  lastResult: null,
};

function mockServer(
  initial: ServerUpdateStatus,
  handlers: Record<string, (body: unknown) => Response> = {},
) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace("/api/v1/server/updates", "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method: init?.method ?? "GET", body });
      return handlers[path]?.(body) ?? Response.json(initial);
    },
  );
  vi.stubGlobal("fetch", fetcher);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("server updates", () => {
  it("reminds only for offered updates after the snooze passes", () => {
    expect(shouldRemind(base)).toBe(true);
    expect(shouldRemind({ ...base, state: "idle" })).toBe(false);
    expect(
      shouldRemind({ ...base, remindAfter: "2999-01-01T00:00:00.000Z" }),
    ).toBe(false);
    expect(
      shouldRemind({ ...base, remindAfter: "2000-01-01T00:00:00.000Z" }),
    ).toBe(true);
    expect(shouldRemind({ ...base, supported: false })).toBe(false);
  });

  it("installs on approval and asks again while someone is watching", async () => {
    const calls = mockServer(base, {
      "/install": (body) =>
        (body as { allowDuringPlayback: boolean }).allowDuringPlayback
          ? Response.json({ ...base, state: "installing" })
          : Response.json(
              {
                error: {
                  code: "PLAYBACK_ACTIVE",
                  message: "Someone is watching.",
                },
              },
              { status: 409 },
            ),
    });
    render(
      <ToastProvider>
        <ServerUpdatesPanel />
      </ToastProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Install 0\.2\.0 now/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Install anyway" }),
    );
    expect(await screen.findByText(/Installing the update\./)).toBeTruthy();
    expect(
      calls.filter((call) => call.path === "/install").map((call) => call.body),
    ).toEqual([
      {
        confirm: "install-server-update",
        version: "0.2.0",
        allowDuringPlayback: false,
      },
      {
        confirm: "install-server-update",
        version: "0.2.0",
        allowDuringPlayback: true,
      },
    ]);
  });

  it("saves the nightly install preference and explains rollbacks", async () => {
    const calls = mockServer(
      {
        ...base,
        state: "idle",
        latestVersion: null,
        lastResult: {
          result: "rolled-back",
          version: "0.2.0",
          from: "0.1.0",
          message: "",
          at: "",
        },
      },
      {
        "/settings": (body) =>
          Response.json({
            ...base,
            state: "idle",
            settings: { ...base.settings, ...(body as object) },
          }),
      },
    );
    render(
      <ToastProvider>
        <ServerUpdatesPanel />
      </ToastProvider>,
    );
    expect(
      await screen.findByText(/0\.2\.0 did not start, so 0\.1\.0 was restored/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /Install updates automatically at night/,
      }),
    );
    await waitFor(() =>
      expect(calls.some((call) => call.path === "/settings")).toBe(true),
    );
    expect(calls.find((call) => call.path === "/settings")?.body).toEqual({
      nightlyInstall: true,
    });
  });

  it("explains manual updates for development or container servers", async () => {
    mockServer({
      ...base,
      supported: false,
      unsupportedReason: "development",
      state: "unsupported",
    });
    render(
      <ToastProvider>
        <ServerUpdatesPanel />
      </ToastProvider>,
    );
    expect(
      await screen.findByText(
        /Automatic updates need the Windows server installer/,
      ),
    ).toBeTruthy();
  });

  it("the reminder can be snoozed until tomorrow", async () => {
    const calls = mockServer(base, {
      "/remind-later": () =>
        Response.json({ ...base, remindAfter: "2999-01-01T00:00:00.000Z" }),
    });
    const review = vi.fn();
    render(<ServerUpdateReminder onReview={review} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Review update" }),
    );
    expect(review).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remind me tomorrow" }));
    await waitFor(() => expect(screen.queryByText(/is available/)).toBeNull());
    expect(
      calls.some(
        (call) => call.path === "/remind-later" && call.method === "POST",
      ),
    ).toBe(true);
  });
});
