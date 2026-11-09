import { fireEvent, render, screen } from "@testing-library/react";
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
  onSwitchAccount: vi.fn(),
  onDeleteProfile: vi.fn(),
  onBackHome: vi.fn(),
  onIntegrationsChanged: vi.fn(),
};

it("keeps household administration out of playback profile pages", () => {
  const view = render(<ProfilePages {...props} page="settings" />);
  expect(screen.queryByText("Security")).not.toBeInTheDocument();
  expect(screen.queryByText("Services: all")).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Open household administration" }),
  ).toHaveAttribute("href", "/admin");
  view.rerender(<ProfilePages {...props} page="account" />);
  expect(screen.queryByText("Security")).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Open household administration" }),
  ).toHaveAttribute("href", "/admin");
  view.rerender(<ProfilePages {...props} page="profile" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Choose another profile" }),
  );
  expect(props.onSwitchAccount).toHaveBeenCalledOnce();
  expect(screen.getByText("Profile privacy")).toBeVisible();
  expect(screen.getByText("Profile photo")).toBeVisible();
  view.rerender(<ProfilePages {...props} page="support" />);
  expect(screen.getByText("Report a problem")).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Open household administration" }),
  ).not.toBeInTheDocument();
});
