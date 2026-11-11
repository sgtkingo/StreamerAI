import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { saveBeforeUpdate } from "./updateSave";
import {
  DEFAULT_PLAYBACK_PREFERENCES,
  ViewerProfileSchema,
} from "@streamer-ai/contracts";
import { expect, it, vi } from "vitest";
import type { StreamerApi } from "../api/client";
import { ProfilePages } from "./ProfilePages";

vi.mock("./IntegrationManager", () => ({
  IntegrationManager: ({ category }: { category?: string }) => (
    <div>Services: {category ?? "all"}</div>
  ),
}));
vi.mock("./AccountSettings", () => ({
  AccountSettings: () => <div>Account details</div>,
}));
vi.mock("./AccountSecurity", () => ({
  AccountSecurity: () => <div>Security</div>,
}));
vi.mock("./ProfilePin", () => ({
  ProfilePinSettings: () => <div>Profile privacy</div>,
}));
vi.mock("./SupportPanel", () => ({
  SupportPanel: () => <div>Report a problem</div>,
}));
vi.mock("./InstallationAccess", () => ({ InstallationDevices: () => null }));
vi.mock("../theme/AppearanceSettings", () => ({
  AppearanceSettings: () => null,
}));
vi.mock("./AgentBackendSettings", () => ({ AgentBackendSettings: () => null }));
vi.mock("./AudioOutputPicker", () => ({ AudioOutputPicker: () => null }));

const profile = ViewerProfileSchema.parse({
  id: "viewer",
  name: "Alex",
  onboardingComplete: true,
  locale: "en",
  genres: [],
  prompt: "",
  playback: DEFAULT_PLAYBACK_PREFERENCES,
});
const props = {
  api: {} as StreamerApi,
  profile,
  onProfileUpdated: vi.fn(),
  onRerunOnboarding: vi.fn(),
  onDeleteProfile: vi.fn(),
  onBackHome: vi.fn(),
  onIntegrationsChanged: vi.fn(),
};

it("saves a profile draft before updating without clicking Save profile", async () => {
  const updateProfile = vi.fn(async (_id, patch) => ({ ...profile, ...patch }));
  render(
    <ProfilePages
      {...props}
      api={{ updateProfile } as unknown as StreamerApi}
      page="profile"
    />,
  );
  fireEvent.change(screen.getByLabelText("Profile name"), {
    target: { value: "Updated name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Fox" }));
  await act(async () => saveBeforeUpdate());
  expect(updateProfile).toHaveBeenCalledWith("viewer", {
    name: "Updated name",
    avatar: "fox",
  });
});

it("keeps household administration out of playback profile pages", () => {
  const view = render(<ProfilePages {...props} page="settings" />);
  expect(screen.queryByText("Security")).not.toBeInTheDocument();
  expect(screen.queryByText("Services: all")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Open household administration" }),
  ).not.toBeInTheDocument();
  view.rerender(<ProfilePages {...props} page="account" />);
  expect(screen.queryByText("Security")).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Open household administration" }),
  ).toHaveAttribute("href", "/admin");
  view.rerender(<ProfilePages {...props} page="profile" />);
  expect(
    screen.queryByRole("button", { name: "Choose another profile" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Profile privacy")).toBeVisible();
  expect(screen.getByText("Profile photo")).toBeVisible();
  view.rerender(<ProfilePages {...props} page="support" />);
  expect(screen.getByText("Report a problem")).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Open household administration" }),
  ).not.toBeInTheDocument();
});

it("saves a renamed profile and selected avatar", async () => {
  const updated = { ...profile, name: "Sam", avatar: "fox" as const };
  const updateProfile = vi.fn().mockResolvedValue(updated);
  const onProfileUpdated = vi.fn();
  render(
    <ProfilePages
      {...props}
      api={{ updateProfile } as unknown as StreamerApi}
      onProfileUpdated={onProfileUpdated}
      page="profile"
    />,
  );
  fireEvent.change(screen.getByLabelText("Profile name"), {
    target: { value: " Sam " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Fox" }));
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() =>
    expect(updateProfile).toHaveBeenCalledWith("viewer", {
      name: "Sam",
      avatar: "fox",
    }),
  );
  expect(onProfileUpdated).toHaveBeenCalledWith(updated);
});

it("saves player behaviour with the profile settings", async () => {
  const updateProfile = vi
    .fn()
    .mockImplementation(async (_id, patch) => ({ ...profile, ...patch }));
  render(
    <ProfilePages
      {...props}
      api={{ updateProfile } as unknown as StreamerApi}
      page="settings"
    />,
  );
  fireEvent.change(screen.getByRole("slider", { name: /Starting volume/ }), {
    target: { value: "35" },
  });
  fireEvent.change(screen.getByLabelText("Skip interval"), {
    target: { value: "30" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Automatically play the next episode",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(updateProfile).toHaveBeenCalledWith(
      "viewer",
      expect.objectContaining({
        playback: expect.objectContaining({
          defaultVolume: 35,
          skipSeconds: 30,
          autoPlayNextEpisode: false,
        }),
      }),
    ),
  );
});
