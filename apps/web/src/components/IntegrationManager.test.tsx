import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationCatalogItem, StreamerApi } from "../api/client";
import { IntegrationManager } from "./IntegrationManager";

const items: IntegrationCatalogItem[] = [
  {
    id: "tmdb",
    name: "TMDB",
    description: "Movie metadata.",
    category: "metadata",
    planned: false,
    selected: false,
    configured: true,
    setup: { documentationUrl: null, supportsDisconnect: true },
  },
  {
    id: "webshare",
    name: "Webshare",
    description: "Playable video.",
    category: "media",
    planned: false,
    selected: false,
    configured: true,
    setup: { documentationUrl: null, supportsDisconnect: true },
  },
  {
    id: "opensubtitles",
    name: "OpenSubtitles",
    description: "External subtitles.",
    category: "subtitle",
    planned: true,
    selected: false,
    configured: false,
    setup: { documentationUrl: null, supportsDisconnect: true },
  },
  {
    id: "local-files",
    name: "Local folder or drive",
    description: "Local media.",
    category: "media",
    planned: false,
    selected: false,
    configured: false,
    setup: { documentationUrl: null, supportsDisconnect: true },
  },
];

function apiWith(integrations: IntegrationCatalogItem[]) {
  return {
    getIntegrations: vi.fn().mockResolvedValue({ items: integrations }),
    setIntegrationSelected: vi
      .fn()
      .mockImplementation(async (id: string, selected: boolean) => ({
        ...integrations.find((item) => item.id === id),
        selected,
      })),
    disconnectIntegration: vi.fn().mockResolvedValue(undefined),
    getLocalFolders: vi.fn().mockResolvedValue({
      roots: [],
      extensions: ["mkv", "avi", "mp4"],
      availableExtensions: ["mkv", "avi", "mp4"],
      scan: { state: "idle", fileCount: 0, error: null, completedAt: null },
    }),
    addLocalFolder: vi.fn(),
    selectLocalFolder: vi.fn(),
    removeLocalFolder: vi.fn(),
    setLocalFormats: vi.fn(),
    scanLocalFolders: vi.fn(),
    connectTmdb: vi.fn().mockResolvedValue({
      ok: true,
      integrationId: "tmdb",
      status: "connected",
      messageCode: "CONNECTED",
      persistence: "secure-local",
    }),
    connectWebshare: vi.fn(),
  } as unknown as StreamerApi;
}

describe("integration manager", () => {
  it("shows the default local integration and connects a folder through Select folder", async () => {
    const user = userEvent.setup();
    const configured = items.map((item) =>
      item.id === "local-files" ? { ...item, configured: true } : item,
    );
    const api = apiWith(configured);
    const selected = {
      roots: [{ id: "picked", path: "D:\\Media" }],
      extensions: ["mkv"],
      availableExtensions: ["mkv"],
      scan: {
        state: "scanning" as const,
        fileCount: 0,
        error: null,
        completedAt: null,
      },
    };
    vi.mocked(api.getLocalFolders).mockResolvedValue(selected);
    vi.mocked(api.selectLocalFolder).mockResolvedValue(selected);
    render(<IntegrationManager api={api} context="settings" />);
    const card = (await screen.findByText("Local folder or drive")).closest(
      "article",
    )!;
    await user.click(within(card).getByRole("button", { name: "Settings" }));
    await user.click(
      await screen.findByRole("button", { name: "Select folder" }),
    );
    await waitFor(() => expect(api.selectLocalFolder).toHaveBeenCalledOnce());
    expect(screen.getByText("D:\\Media")).toBeInTheDocument();
  });

  it("shows existing connections in their groups and disconnects one service", async () => {
    const user = userEvent.setup();
    const api = apiWith(items);
    const onConnectionChange = vi.fn();
    render(
      <IntegrationManager
        api={api}
        context="settings"
        onConnectionChange={onConnectionChange}
      />,
    );

    const tmdb = (await screen.findByRole("heading", { name: "TMDB" })).closest(
      "article",
    )!;
    const webshare = screen
      .getByRole("heading", { name: "Webshare" })
      .closest("article")!;
    expect(within(tmdb).getByText("Connected")).toBeInTheDocument();
    expect(within(webshare).getByText("Connected")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Movie databases" }),
    ).toContainElement(tmdb);
    expect(
      screen.getByRole("region", { name: "Stream sources" }),
    ).toContainElement(webshare);
    expect(
      within(tmdb)
        .getByRole("button", { name: "Settings" })
        .querySelector("svg"),
    ).toHaveAttribute("aria-hidden", "true");
    expect(
      within(webshare)
        .getByRole("button", { name: "Disconnect" })
        .querySelector("svg"),
    ).toHaveAttribute("aria-hidden", "true");

    await user.click(within(tmdb).getByRole("button", { name: "Settings" }));
    await user.type(
      screen.getByLabelText("TMDB Read Access Token"),
      "new-token",
    );
    await user.click(
      screen.getByRole("button", { name: "Verify and connect" }),
    );
    expect(api.connectTmdb).toHaveBeenCalledWith("new-token");
    expect(screen.queryByDisplayValue("new-token")).not.toBeInTheDocument();

    await user.click(
      within(webshare).getByRole("button", { name: "Disconnect" }),
    );
    expect(api.disconnectIntegration).not.toHaveBeenCalled();
    await user.click(
      within(webshare).getByRole("button", { name: "Disconnect now" }),
    );
    await waitFor(() =>
      expect(api.disconnectIntegration).toHaveBeenCalledWith("webshare"),
    );
    expect(
      screen.queryByRole("heading", { name: "Webshare" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /choose a stream source/i }),
    ).toBeInTheDocument();
    expect(onConnectionChange).toHaveBeenCalledWith("webshare", false);
  });

  it("starts with empty onboarding blocks and adds or removes a planned source", async () => {
    const user = userEvent.setup();
    const api = apiWith(items.map((item) => ({ ...item, configured: false })));
    render(<IntegrationManager api={api} context="onboarding" />);

    expect(
      screen.getByRole("button", { name: /choose a movie database/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /choose a stream source/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /choose a subtitle source/i }),
    ).toBeInTheDocument();
    const streams = screen.getByRole("region", { name: "Stream sources" });
    await user.click(
      within(streams).getByRole("button", { name: /add more/i }),
    );
    const streamPicker = within(streams).getByRole("region", {
      name: "Stream sources available integrations",
    });
    expect(
      within(streamPicker).getByRole("button", { name: /Webshare/i }),
    ).toBeInTheDocument();
    expect(
      within(streamPicker).queryByRole("button", { name: /OpenSubtitles/i }),
    ).not.toBeInTheDocument();
    const subtitles = screen.getByRole("region", { name: "Subtitle sources" });
    const addSubtitles = within(subtitles).getByRole("button", {
      name: /add more/i,
    });
    await user.click(addSubtitles);
    expect(
      within(streams).queryByRole("region", {
        name: "Stream sources available integrations",
      }),
    ).not.toBeInTheDocument();
    const picker = within(subtitles).getByRole("region", {
      name: "Subtitle sources available integrations",
    });
    expect(picker.previousElementSibling).toBe(addSubtitles);
    expect(
      within(picker).getByRole("button", { name: /OpenSubtitles/i }),
    ).toBeInTheDocument();
    expect(
      within(picker).queryByRole("button", { name: /TMDB|Webshare/i }),
    ).not.toBeInTheDocument();
    await user.click(
      within(picker).getByRole("button", { name: /OpenSubtitles/i }),
    );
    await waitFor(() =>
      expect(api.setIntegrationSelected).toHaveBeenCalledWith(
        "opensubtitles",
        true,
      ),
    );
    const card = (
      await screen.findByRole("heading", {
        name: "OpenSubtitles",
      })
    ).closest("article")!;
    expect(within(card).getByText("Planned")).toBeInTheDocument();
    expect(within(card).getByText(/cannot connect yet/i)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(api.setIntegrationSelected).toHaveBeenCalledWith(
        "opensubtitles",
        false,
      ),
    );
    expect(
      screen.getByRole("button", { name: /choose a subtitle source/i }),
    ).toBeInTheDocument();
  });

  it("connects a local folder and saves a video format filter", async () => {
    const user = userEvent.setup();
    const api = apiWith(items.map((item) => ({ ...item, configured: false })));
    const config = {
      roots: [{ id: "root-1", path: "D:\\Movies" }],
      extensions: ["mkv", "avi", "mp4"],
      availableExtensions: ["mkv", "avi", "mp4"],
      scan: {
        state: "scanning" as const,
        fileCount: 0,
        error: null,
        completedAt: null,
      },
    };
    vi.mocked(api.addLocalFolder).mockResolvedValue(config);
    vi.mocked(api.setLocalFormats).mockResolvedValue({
      ...config,
      extensions: ["mkv", "mp4"],
    });
    const onConnectionChange = vi.fn();
    render(
      <IntegrationManager
        api={api}
        context="onboarding"
        onConnectionChange={onConnectionChange}
      />,
    );
    const streams = screen.getByRole("region", { name: "Stream sources" });
    await user.click(
      within(streams).getByRole("button", { name: /add more/i }),
    );
    await user.click(
      within(streams).getByRole("button", { name: /Local folder or drive/i }),
    );
    await user.type(
      await screen.findByLabelText("Folder or mounted drive path"),
      "D:\\Movies",
    );
    await user.click(screen.getByRole("button", { name: "Add folder" }));
    await waitFor(() =>
      expect(api.addLocalFolder).toHaveBeenCalledWith("D:\\Movies"),
    );
    expect(onConnectionChange).toHaveBeenCalledWith("local-files", true);
    await user.click(screen.getByRole("checkbox", { name: ".avi" }));
    await waitFor(() =>
      expect(api.setLocalFormats).toHaveBeenCalledWith(["mkv", "mp4"]),
    );
  });
});
