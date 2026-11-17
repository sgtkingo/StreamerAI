import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StreamerApi } from "../../api/client";
import { AdminOnboarding } from "./AdminOnboarding";

vi.mock("../IntegrationManager", () => ({
  IntegrationManager: () => <p>Service picker</p>,
}));
vi.mock("../AgentBackendSettings", () => ({
  AgentBackendSettings: () => <p>Agent picker</p>,
}));
vi.mock("../ServerAiSetup", () => ({ ServerAiSetup: () => null }));

afterEach(() => sessionStorage.clear());

function api() {
  return {
    getIntegrations: vi.fn().mockResolvedValue({
      items: [
        { name: "Webshare", configured: true, category: "media" },
        { name: "TMDB", configured: true, category: "metadata" },
        { name: "Cloud Sync", configured: true, category: "sync" },
        { name: "Hellspy", configured: false, category: "media" },
      ],
    }),
    getAgentSelection: vi.fn().mockResolvedValue({
      mode: "api",
      provider: "ollama",
      model: "qwen3.5:4b",
      available: true,
    }),
    getBackupSchedule: vi.fn().mockResolvedValue({
      enabled: true,
      intervalMinutes: 1440,
      cloudEnabled: false,
    }),
    setAdminOnboarding: vi
      .fn()
      .mockResolvedValue({ adminOnboardingPending: false }),
  } as unknown as StreamerApi;
}

function renderOnboarding(client = api()) {
  const onComplete = vi.fn();
  render(
    <AdminOnboarding
      api={client}
      profileId="viewer"
      householdName="Home"
      household={<p>Household name editor</p>}
      backups={<p>Backup schedule editor</p>}
      devices={<p>Device pairing</p>}
      onComplete={onComplete}
    />,
  );
  return { client, onComplete };
}

it("walks the owner through the shared household setup and completes it", async () => {
  const { client, onComplete } = renderOnboarding();
  expect(
    screen.getByRole("heading", { name: /Your home server/ }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Start setup/ }));
  expect(screen.getByText("Household name editor")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  expect(screen.getByText("Service picker")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  expect(
    screen.getByRole("heading", { name: /One assistant for/ }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  expect(screen.getByText("Backup schedule editor")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  expect(screen.getByText("Device pairing")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));

  expect(screen.getByRole("heading", { name: "Home is ready." })).toBeVisible();
  expect(await screen.findByText("Webshare, TMDB")).toBeVisible();
  expect(screen.getByText("qwen3.5:4b")).toBeVisible();
  expect(screen.getByText("Encrypted, daily")).toBeVisible();
  expect(client.getIntegrations).toHaveBeenCalledWith("viewer");

  fireEvent.click(screen.getByRole("button", { name: "Go to administration" }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith("admin"));
  expect(client.setAdminOnboarding).toHaveBeenCalledWith("complete");
});

it("jumps to the summary with Finish later and keeps the step across reloads", async () => {
  renderOnboarding();
  fireEvent.click(screen.getByRole("button", { name: "Finish later" }));
  expect(
    await screen.findByRole("heading", { name: "Home is ready." }),
  ).toBeVisible();
  expect(sessionStorage.getItem("streamerai.adminOnboardingStep")).toBe("6");
});

it("stays in setup and explains the problem when completion fails", async () => {
  const client = api();
  client.setAdminOnboarding = vi
    .fn()
    .mockRejectedValue(new Error("Server unavailable"));
  const { onComplete } = renderOnboarding(client);
  fireEvent.click(screen.getByRole("button", { name: "Finish later" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Open the player/ }),
  );
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(onComplete).not.toHaveBeenCalled();
});
