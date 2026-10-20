import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { StreamerApi } from "../../api/client";
import { LocalAiStep } from "./LocalAiStep";

describe("onboarding agent step", () => {
  it("shows the shared agent choice and treats disabled as a real off state", async () => {
    const onEnabledChange = vi.fn();
    const api = {
      getAgentSelection: vi.fn().mockResolvedValue({
        mode: "disabled",
        provider: "ollama",
        available: false,
        code: "DISABLED",
        message: "The agent is disabled.",
      }),
      getAgentModels: vi.fn().mockResolvedValue({
        provider: "ollama",
        models: [],
        recommendedModel: null,
        source: "local",
        status: "unavailable",
        message: "No models.",
      }),
      getLocalAgent: vi.fn().mockResolvedValue({ model: "", baseUrl: "" }),
      getOllamaConfig: vi
        .fn()
        .mockResolvedValue({
          model: "qwen3.5:4b",
          baseUrl: "http://127.0.0.1:11434",
        }),
      getCustomLocalAgent: vi
        .fn()
        .mockResolvedValue({ configured: false, baseUrl: "", model: "" }),
    } as unknown as StreamerApi;
    render(
      <LocalAiStep
        api={api}
        profileId="viewer-2"
        enabled={false}
        onEnabledChange={onEnabledChange}
      />,
    );
    await screen.findByRole("heading", { name: "Local Agent" });
    expect(
      screen.getByRole("heading", { name: "Local Agent" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "External Agent" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Search still works without an AI agent/),
    ).toBeInTheDocument();
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(false));
    expect(api.getAgentModels).toHaveBeenCalledWith(
      "ollama",
      "viewer-2",
      "low",
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /A Guide to Choosing an Agent/ }),
    );
    expect(
      screen.getByRole("dialog", { name: "Agent choice guide" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Agent choice guide" }),
    ).not.toBeInTheDocument();
  });

  it("explains API data flow when a remote provider is selected", async () => {
    const onEnabledChange = vi.fn();
    const api = {
      getAgentSelection: vi.fn().mockResolvedValue({
        mode: "api",
        provider: "openai",
        available: true,
        code: "CONFIGURED",
        message: "API key stored.",
      }),
      getLocalAgent: vi.fn().mockResolvedValue({ model: "", baseUrl: "" }),
      getOllamaConfig: vi
        .fn()
        .mockResolvedValue({
          model: "qwen3.5:4b",
          baseUrl: "http://127.0.0.1:11434",
        }),
      getCustomLocalAgent: vi
        .fn()
        .mockResolvedValue({ configured: false, baseUrl: "", model: "" }),
      getAgentModels: vi.fn().mockResolvedValue({
        provider: "openai",
        models: [],
        recommendedModel: null,
        source: "fallback",
        status: "unverified",
        message: "Models unverified.",
      }),
      getAgentApiKeyStatus: vi.fn().mockResolvedValue({ configured: true }),
    } as unknown as StreamerApi;
    render(
      <LocalAiStep
        api={api}
        profileId="default"
        enabled={true}
        onEnabledChange={onEnabledChange}
      />,
    );
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
    expect(
      screen.getByText(/API providers receive the discovery requests/),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "API provider" })).toHaveValue(
      "openai",
    );
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
  });
});
