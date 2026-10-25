import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
    getMediaSourcePreferences: vi
      .fn()
      .mockResolvedValue({
        mode: "auto",
        providerOrder: ["local-files", "webshare"],
      }),
    saveMediaSourcePreferences: vi
      .fn()
      .mockImplementation(async (preferences) => preferences),
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
    connectHellspy: vi.fn().mockResolvedValue({
      ok: true,
      integrationId: "hellspy",
      status: "connected",
      messageCode: "CONNECTED",
      persistence: "secure-local",
    }),
  } as unknown as StreamerApi;
}

describe("integration manager", () => {
  it("defaults to Auto and saves By Order for the active profile", async () => {
    const user = userEvent.setup();
    const api = apiWith(items);
    render(
      <IntegrationManager api={api} context="settings" profileId="viewer" />,
    );
    const auto = await screen.findByRole("radio", { name: "Auto" });
    const byOrder = screen.getByRole("radio", { name: "By Order" });
    await waitFor(() => expect(auto).toBeChecked());
    await user.click(byOrder);
    await waitFor(() =>
      expect(api.saveMediaSourcePreferences).toHaveBeenCalledWith(
        { mode: "by-order", providerOrder: ["local-files", "webshare"] },
        "viewer",
      ),
    );
    expect(byOrder).toBeChecked();
  });
  it("defaults local storage first and saves a drag-and-drop source order for this profile", async () => {
    const configured = items.map((item) =>
      item.id === "local-files" ? { ...item, configured: true } : item,
    );
    const api = apiWith(configured);
    render(
      <IntegrationManager api={api} context="settings" profileId="viewer" />,
    );
    const region = await screen.findByRole("region", {
      name: "Stream sources",
    });
    const local = await screen.findByRole("heading", {
      name: "Local folder or drive",
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Drag Webshare to reorder" }),
      ).toBeEnabled(),
    );
    expect(
      within(region)
        .getAllByRole("heading", { level: 4 })
        .map((heading) => heading.textContent),
    ).toEqual(["Local folder or drive", "Webshare"]);
    const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(
      screen.getByRole("button", { name: "Drag Webshare to reorder" }),
      { dataTransfer: transfer },
    );
    fireEvent.dragOver(local.closest("article")!, { dataTransfer: transfer });
    fireEvent.drop(local.closest("article")!, { dataTransfer: transfer });
    await waitFor(() =>
      expect(api.saveMediaSourcePreferences).toHaveBeenCalledWith(
        { mode: "auto", providerOrder: ["webshare", "local-files"] },
        "viewer",
      ),
    );
    expect(
      within(region)
        .getAllByRole("heading", { level: 4 })
        .map((heading) => heading.textContent),
    ).toEqual(["Webshare", "Local folder or drive"]);
    expect(
      await screen.findByText("Source preference saved."),
    ).toBeInTheDocument();
  });

  it("supports keyboard reordering and restores the previous order when saving fails", async () => {
    const user = userEvent.setup();
    const api = apiWith(
      items.map((item) =>
        item.id === "local-files" ? { ...item, configured: true } : item,
      ),
    );
    vi.mocked(api.saveMediaSourcePreferences).mockRejectedValueOnce(
      new Error("offline"),
    );
    render(<IntegrationManager api={api} context="settings" />);
    const grip = await screen.findByRole("button", {
      name: "Drag Webshare to reorder",
    });
    await waitFor(() => expect(grip).toBeEnabled());
    grip.focus();
    await user.keyboard("{ArrowUp}");
    expect(
      await screen.findByText(/Your previous selection is still active/),
    ).toBeInTheDocument();
    const region = screen.getByRole("region", { name: "Stream sources" });
    expect(
      within(region)
        .getAllByRole("heading", { level: 4 })
        .map((heading) => heading.textContent),
    ).toEqual(["Local folder or drive", "Webshare"]);
    await user.click(screen.getByRole("button", { name: "Move Webshare up" }));
    expect(
      await screen.findByText("Source preference saved."),
    ).toBeInTheDocument();
    expect(
      within(region).getAllByRole("heading", { level: 4 })[0],
    ).toHaveTextContent("Webshare");
  });
  it("connects Hellspy with an email and clears the password after verification", async () => {
    const user = userEvent.setup();
    const api = apiWith([
      ...items,
      {
        id: "hellspy",
        name: "Hellspy",
        description: "Authenticated video.",
        category: "media",
        planned: false,
        selected: false,
        configured: false,
        setup: {
          documentationUrl: "https://www.hellspy.to/",
          supportsDisconnect: true,
        },
      },
    ]);
    render(
      <IntegrationManager api={api} context="settings" profileId="viewer" />,
    );
    await screen.findByRole("heading", { name: "Webshare" });
    await user.click(
      within(screen.getByRole("region", { name: "Stream sources" })).getByRole(
        "button",
        { name: /add more/i },
      ),
    );
    await user.click(await screen.findByRole("button", { name: /Hellspy/ }));
    await user.type(screen.getByLabelText("Email"), "viewer@example.test");
    await user.type(
      screen.getByLabelText("Password", { exact: true }),
      "private-password",
    );
    await user.click(screen.getByRole("button", { name: "Connect Hellspy" }));
    await waitFor(() =>
      expect(api.connectHellspy).toHaveBeenCalledWith(
        "viewer@example.test",
        "private-password",
        "viewer",
      ),
    );
    expect(
      screen.queryByDisplayValue("private-password"),
    ).not.toBeInTheDocument();
    const card = screen
      .getByRole("heading", { name: "Hellspy" })
      .closest("article")!;
    expect(within(card).getByText("Connected")).toBeInTheDocument();
  });
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
    expect(api.connectTmdb).toHaveBeenCalledWith("new-token", "default");
    expect(screen.queryByDisplayValue("new-token")).not.toBeInTheDocument();

    await user.click(
      within(webshare).getByRole("button", { name: "Disconnect" }),
    );
    expect(api.disconnectIntegration).not.toHaveBeenCalled();
    await user.click(
      within(webshare).getByRole("button", { name: "Disconnect now" }),
    );
    await waitFor(() =>
      expect(api.disconnectIntegration).toHaveBeenCalledWith(
        "webshare",
        "default",
      ),
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
        "default",
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
        "default",
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
