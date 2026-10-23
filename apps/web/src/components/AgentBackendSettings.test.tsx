import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { StreamerApi } from "../api/client";
import { AgentBackendSettings } from "./AgentBackendSettings";

function createApi(mode: "api" | "mcp" | "disabled" = "api") {
  const selection = {
    mode,
    provider: "ollama",
    reasoningEffort: "low",
    available: mode === "api",
    code: mode === "mcp" ? "MCP_HOST_REQUIRED" : "CONFIGURED",
    message: mode === "mcp" ? "Connect an external host." : "Ollama selected.",
  };
  return {
    getAgentSelection: vi.fn().mockResolvedValue(selection),
    getLocalAgent: vi.fn().mockResolvedValue({
      model: "qwen3.5:4b",
      baseUrl: "http://127.0.0.1:11434",
    }),
    getOllamaConfig: vi.fn().mockResolvedValue({
      model: "qwen3.5:4b",
      baseUrl: "http://127.0.0.1:11434",
    }),
    getCustomLocalAgent: vi.fn().mockResolvedValue({
      configured: false,
      baseUrl: "",
      model: "",
    }),
    saveCustomLocalAgent: vi.fn().mockResolvedValue({
      configured: true,
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
    }),
    verifyCustomLocalAgent: vi.fn().mockResolvedValue({ ok: true }),
    verifyCustomLocalCandidate: vi.fn().mockResolvedValue({ ok: true }),
    getLocalAgentCapabilities: vi.fn().mockResolvedValue({
      providers: [
        {
          provider: "ollama",
          detected: true,
          ready: true,
          code: "READY",
          message: "Ready",
          recommendedModel: "qwen3.5:4b",
        },
        {
          provider: "codex",
          detected: false,
          ready: false,
          code: "NOT_INSTALLED",
          message: "Not installed",
          recommendedModel: null,
        },
        {
          provider: "claude",
          detected: false,
          ready: false,
          code: "NOT_INSTALLED",
          message: "Not installed",
          recommendedModel: null,
        },
      ],
    }),
    getAgentModels: vi.fn().mockImplementation(async (provider: string) => ({
      provider,
      models: [
        {
          id: "fast-model",
          label: "Fast model",
          reasoningEfforts: ["none", "low", "medium", "high"],
        },
        { id: "fixed-model", label: "Fixed model", reasoningEfforts: ["low"] },
      ],
      recommendedModel: "fast-model",
      source: "provider",
      status: "available",
      message: "Models available.",
    })),
    getAgentApiKeyStatus: vi.fn().mockResolvedValue({ configured: false }),
    saveAgentApiKey: vi.fn().mockResolvedValue({ configured: true }),
    deleteAgentApiKey: vi.fn().mockResolvedValue({ configured: false }),
    setAgentSelection: vi.fn().mockImplementation(async (input) => ({
      ...input,
      available: input.mode !== "mcp",
      message: "Saved.",
    })),
    connectLocalAgent: vi.fn().mockResolvedValue({ ok: true }),
    verifyOllamaModel: vi.fn().mockResolvedValue({
      ok: true,
      model: "qwen3.5:4b",
      message: "Ready",
    }),
    pullLocalAgentModel: vi.fn().mockResolvedValue({
      ok: true,
      model: "qwen3.5:4b",
    }),
    discoverLocalAgents: vi.fn().mockResolvedValue({
      availableIds: ["ollama"],
      runtimeAvailable: true,
    }),
  } as unknown as StreamerApi;
}

function useBinaryLocalModels(api: StreamerApi) {
  vi.mocked(api.getAgentModels).mockImplementation(async (provider) => ({
    provider,
    models: [
      {
        id: "qwen3.5:4b",
        label: "Qwen",
        reasoningEfforts: ["none", "high"],
      },
      { id: "fixed-model", label: "Fixed model", reasoningEfforts: ["none"] },
    ],
    recommendedModel: "qwen3.5:4b",
    source: "local",
    status: "available",
    message: "Available",
  }));
}

describe("AgentBackendSettings", () => {
  it("loads, saves and resets the context limit in Settings", async () => {
    const api = createApi();
    vi.mocked(api.getAgentSelection).mockResolvedValue({
      mode: "api",
      provider: "ollama",
      reasoningEffort: "low",
      available: true,
      code: "CONFIGURED",
      message: "Ready",
      contextTokens: 8192,
      effectiveContextTokens: 8192,
    });
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="viewer-2" />);
    const context = await screen.findByRole("spinbutton", {
      name: "Context window (tokens)",
    });
    await waitFor(() => expect(context).toHaveValue(8192));
    await user.clear(context);
    await user.type(context, "16384");
    const local = screen
      .getByRole("heading", { name: "Local Agent" })
      .closest("article")!;
    await user.click(within(local).getByRole("button", { name: "Active" }));
    await waitFor(() =>
      expect(api.setAgentSelection).toHaveBeenLastCalledWith(
        expect.objectContaining({ contextTokens: 16384 }),
      ),
    );
    await user.clear(context);
    await user.click(within(local).getByRole("button", { name: "Active" }));
    await waitFor(() => expect(api.setAgentSelection).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(api.setAgentSelection).mock.lastCall?.[0],
    ).not.toHaveProperty("contextTokens");
  });

  it("shows two cards, persists a single API agent and its key", async () => {
    const api = createApi();
    const changed = vi.fn();
    const user = userEvent.setup();
    render(
      <AgentBackendSettings
        api={api}
        profileId="viewer-2"
        onChanged={changed}
      />,
    );
    await screen.findByRole("heading", { name: "External Agent" });
    const external = screen
      .getByRole("heading", { name: "External Agent" })
      .closest("article")!;
    await user.selectOptions(
      within(external).getByLabelText("API provider"),
      "gemini",
    );
    await user.type(
      within(external).getByLabelText("API key"),
      "private-key-123",
    );
    await user.click(
      within(external).getByRole("button", { name: "Activate" }),
    );
    await waitFor(() =>
      expect(api.setAgentSelection).toHaveBeenCalledWith({
        profileId: "viewer-2",
        mode: "api",
        provider: "gemini",
        reasoningEffort: "low",
      }),
    );
    expect(api.saveAgentApiKey).toHaveBeenCalledWith({
      profileId: "viewer-2",
      provider: "gemini",
      apiKey: "private-key-123",
    });
    expect(
      within(external).getByRole("button", { name: "Active" }),
    ).toHaveClass("is-active");
    expect(
      screen.getByRole("heading", { name: "Local Agent" }).closest("article"),
    ).not.toHaveClass("is-active");
    expect(changed).toHaveBeenCalledWith(true);
    expect(within(external).getByLabelText("API key")).toHaveValue("");
  });

  it("does not carry a local model into an external provider", async () => {
    const api = createApi();
    vi.mocked(api.getAgentSelection).mockResolvedValue({
      mode: "api",
      provider: "ollama",
      model: "fast-model",
      reasoningEffort: "low",
      available: true,
      code: "CONFIGURED",
      message: "Ollama selected.",
    });
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="viewer-2" />);
    const external = (
      await screen.findByRole("heading", { name: "External Agent" })
    ).closest("article")!;
    await user.type(
      within(external).getByLabelText("API key"),
      "private-key-123",
    );
    await user.click(
      within(external).getByRole("button", { name: "Activate" }),
    );
    await waitFor(() =>
      expect(api.setAgentSelection).toHaveBeenCalledWith({
        profileId: "viewer-2",
        mode: "api",
        provider: "openai",
        reasoningEffort: "low",
      }),
    );
  });

  it("changes the thinking slider to match a model selected in Local Settings", async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="default" />);
    const local = screen
      .getByRole("heading", { name: "Local Agent" })
      .closest("article")!;
    await user.click(within(local).getByRole("button", { name: "Settings" }));
    await within(local).findByText(/Automatic model: fast-model/);
    await user.selectOptions(
      within(local).getByLabelText("Local model"),
      "fixed-model",
    );
    const slider = screen.getByRole("slider", { name: "Thinking level" });
    expect(slider).toHaveAttribute("max", "0");
    expect(screen.getByText("Supported thinking: low.")).toBeInTheDocument();
    await user.selectOptions(
      within(local).getByLabelText("Local model"),
      "fast-model",
    );
    fireEvent.change(slider, { target: { value: "3" } });
    await user.click(
      screen.getByRole("button", { name: "Save agent preference" }),
    );
    await waitFor(() =>
      expect(api.setAgentSelection).toHaveBeenCalledWith({
        profileId: "default",
        mode: "api",
        provider: "ollama",
        model: "fast-model",
        reasoningEffort: "high",
      }),
    );
  });

  it.each([false, true])(
    "uses the automatic model's actual thinking levels (onboarding: %s)",
    async (guideAtTop) => {
      const api = createApi();
      useBinaryLocalModels(api);
      const user = userEvent.setup();
      render(
        <AgentBackendSettings
          api={api}
          profileId="default"
          guideAtTop={guideAtTop}
        />,
      );
      const slider = screen.getByRole("slider", { name: "Thinking level" });
      await waitFor(() => expect(slider).toHaveAttribute("max", "1"));
      expect(slider).toHaveValue("0");
      const local = screen
        .getByRole("heading", { name: "Local Agent" })
        .closest("article")!;
      await user.click(within(local).getByRole("button", { name: "Settings" }));
      expect(
        within(local).getByText("Supported thinking: none, high."),
      ).toBeInTheDocument();
      await user.selectOptions(
        within(local).getByLabelText("Local model"),
        "fixed-model",
      );
      expect(slider).toHaveAttribute("max", "0");
      expect(slider).toBeDisabled();
      await user.selectOptions(within(local).getByLabelText("Local model"), "");
      expect(slider).toHaveAttribute("max", "1");
      fireEvent.change(slider, { target: { value: "1" } });
      expect(screen.getByText("High reasoning")).toBeInTheDocument();
      await user.click(
        screen.getByRole("button", { name: "Save agent preference" }),
      );
      await waitFor(() =>
        expect(api.setAgentSelection).toHaveBeenCalledWith({
          profileId: "default",
          mode: "api",
          provider: "ollama",
          reasoningEffort: "high",
        }),
      );
      expect(slider).toHaveAttribute("max", "1");
      expect(slider).toHaveValue("1");
    },
  );

  it("displays and saves effective high reasoning for a legacy low setting", async () => {
    const api = createApi();
    useBinaryLocalModels(api);
    vi.mocked(api.getAgentSelection).mockResolvedValue({
      mode: "api",
      provider: "ollama",
      reasoningEffort: "low",
      effectiveReasoningEffort: "high",
      available: true,
      code: "CONFIGURED",
      message: "Ready",
    });
    vi.mocked(api.setAgentSelection).mockImplementation(async (input) => ({
      ...input,
      reasoningEffort: "low",
      effectiveReasoningEffort: "high",
      available: true,
      code: "CONFIGURED",
      message: "Saved",
    }));
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="default" />);
    const slider = screen.getByRole("slider", { name: "Thinking level" });
    await waitFor(() => expect(slider).toHaveAttribute("max", "1"));
    expect(slider).toHaveValue("1");
    expect(screen.getByText("High reasoning")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Save agent preference" }),
    );
    expect(
      await screen.findByText("Agent preference saved."),
    ).toBeInTheDocument();
    expect(api.setAgentSelection).toHaveBeenCalledWith({
      profileId: "default",
      mode: "api",
      provider: "ollama",
      reasoningEffort: "high",
    });
    expect(slider).toHaveValue("1");
    expect(screen.getByText("High reasoning")).toBeInTheDocument();
  });

  it.each(["none", "high"] as const)(
    "preserves the displayed %s thinking level during automatic local activation",
    async (reasoningEffort) => {
      const api = createApi();
      useBinaryLocalModels(api);
      vi.mocked(api.getAgentSelection).mockResolvedValue({
        mode: "api",
        provider: "ollama",
        reasoningEffort,
        effectiveReasoningEffort: reasoningEffort,
        available: true,
        code: "CONFIGURED",
        message: "Ready",
      });
      const user = userEvent.setup();
      render(<AgentBackendSettings api={api} profileId="default" />);
      await waitFor(() =>
        expect(
          screen.getByRole("slider", { name: "Thinking level" }),
        ).toHaveAttribute("max", "1"),
      );
      await user.click(screen.getByRole("button", { name: "Auto" }));
      await waitFor(() =>
        expect(api.setAgentSelection).toHaveBeenCalledWith({
          profileId: "default",
          mode: "api",
          provider: "ollama",
          reasoningEffort,
        }),
      );
    },
  );

  it("does not advertise unsupported thinking levels when model discovery fails", async () => {
    const api = createApi();
    vi.mocked(api.getAgentModels).mockRejectedValue(
      new Error("Ollama unavailable"),
    );
    render(<AgentBackendSettings api={api} profileId="default" />);
    expect(
      await screen.findByText("Model capabilities unavailable"),
    ).toBeInTheDocument();
    const slider = screen.getByRole("slider", { name: "Thinking level" });
    expect(slider).toBeDisabled();
    expect(slider).toHaveAttribute("max", "0");
  });

  it("keeps separate model choices in Local and External Settings", async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="default" />);
    const local = screen
      .getByRole("heading", { name: "Local Agent" })
      .closest("article")!;
    const external = screen
      .getByRole("heading", { name: "External Agent" })
      .closest("article")!;
    await user.click(within(local).getByRole("button", { name: "Settings" }));
    await within(local).findByRole("option", { name: "Fixed model" });
    await user.selectOptions(
      within(local).getByLabelText("Local model"),
      "fixed-model",
    );
    await user.click(
      within(external).getByRole("button", { name: "Settings" }),
    );
    await within(external).findByRole("option", { name: "Fast model" });
    await user.selectOptions(
      within(external).getByLabelText("External model"),
      "fast-model",
    );
    await user.click(within(local).getByRole("button", { name: "Settings" }));
    expect(within(local).getByLabelText("Local model")).toHaveValue(
      "fixed-model",
    );
    expect(
      screen.queryByText("Expert model and mode selection"),
    ).not.toBeInTheDocument();
  });

  it("supports MCP selection with host-owned thinking", async () => {
    const api = createApi();
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="viewer-2" />);
    const mcpOption = await screen.findByRole("radio", { name: "MCP" });
    await user.click(mcpOption);
    expect(
      screen.getByRole("slider", { name: "Thinking level" }),
    ).toBeDisabled();
    const external = screen
      .getByRole("heading", { name: "External Agent" })
      .closest("article")!;
    await user.click(
      within(external).getByRole("button", { name: "Activate" }),
    );
    await waitFor(() =>
      expect(api.setAgentSelection).toHaveBeenCalledWith({
        profileId: "viewer-2",
        mode: "mcp",
        provider: "ollama",
        reasoningEffort: "low",
      }),
    );
    expect(
      screen.getByText(/The external MCP host chooses/),
    ).toBeInTheDocument();
  });

  it("checks a local agent automatically in the dialog and applies it", async () => {
    const api = createApi("disabled");
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="viewer-2" />);
    await user.click(
      screen.getByRole("button", { name: /A Guide to Choosing an Agent/ }),
    );
    expect(
      screen.getByRole("dialog", { name: "Agent choice guide" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("Agent confirmed")).toBeInTheDocument();
    expect(api.getLocalAgentCapabilities).toHaveBeenCalledWith("viewer-2");
    expect(api.discoverLocalAgents).toHaveBeenCalledWith("viewer-2");
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(
      screen.getByText(
        /Choose from the thinking levels supported by this local model/,
      ),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("slider", { name: "Local model thinking level" }),
      {
        target: { value: "3" },
      },
    );
    const guide = screen.getByRole("dialog", { name: "Agent choice guide" });
    await user.type(
      within(guide).getByRole("spinbutton", {
        name: "Context window (tokens)",
      }),
      "8192",
    );
    await user.click(
      screen.getByRole("button", { name: "Apply recommendation" }),
    );
    await waitFor(() =>
      expect(api.setAgentSelection).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "viewer-2",
          mode: "api",
          provider: "ollama",
          reasoningEffort: "high",
          contextTokens: 8192,
        }),
      ),
    );
    expect(
      screen.queryByLabelText("Agent choice guide"),
    ).not.toBeInTheDocument();
  });

  it("opens the shared local configuration beside a static Check again icon", async () => {
    const api = createApi("disabled");
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="viewer-2" />);
    await user.click(
      screen.getByRole("button", { name: /A Guide to Choosing an Agent/ }),
    );
    await user.click(screen.getByRole("button", { name: /Next/ }));
    const dialog = screen.getByRole("dialog", { name: "Agent choice guide" });
    const retry = await within(dialog).findByRole("button", {
      name: "Check again",
    });
    expect(retry.querySelector(".agent-backend__guide-target")).not.toHaveClass(
      "is-scanning",
    );
    const configuration = within(dialog).getByRole("button", {
      name: "Configuration",
    });
    expect(configuration).toHaveAttribute("aria-expanded", "false");
    await user.click(configuration);
    expect(configuration).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByLabelText("Ollama URL")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Connect Ollama" }),
    ).toBeInTheDocument();
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "Local provider" }),
      "custom",
    );
    expect(within(dialog).getByLabelText("API URL")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Save Custom connection" }),
    ).toBeInTheDocument();
    expect(retry).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: /Next/ })).toBeDisabled();
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "Local provider" }),
      "ollama",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Connect Ollama" }),
    );
    expect(
      await within(dialog).findByText("Agent confirmed"),
    ).toBeInTheDocument();
    expect(api.connectLocalAgent).toHaveBeenCalledWith({
      profileId: "viewer-2",
      model: "qwen3.5:4b",
      baseUrl: "http://127.0.0.1:11434",
    });
    expect(retry).toBeEnabled();
    await user.click(configuration);
    expect(configuration).toHaveAttribute("aria-expanded", "false");
  });
  it("shows every discovered local model and configures Custom", async () => {
    const api = createApi("disabled");
    vi.mocked(api.getLocalAgentCapabilities).mockResolvedValue({
      providers: [
        {
          provider: "ollama",
          detected: true,
          ready: true,
          code: "READY",
          message: "Ready",
          recommendedModel: "ollama-one",
        },
        {
          provider: "custom",
          detected: true,
          ready: true,
          code: "READY",
          message: "Ready",
          recommendedModel: "local-fast",
        },
      ],
    });
    vi.mocked(api.getAgentModels).mockImplementation(async (provider) => ({
      provider,
      models: (provider === "ollama"
        ? ["ollama-one", "ollama-two"]
        : ["local-fast", "local-quality"]
      ).map((id) => ({
        id,
        label: id,
        reasoningEfforts: ["none"],
      })),
      recommendedModel: provider === "ollama" ? "ollama-one" : "local-fast",
      source: "local",
      status: "available",
      message: "Models available.",
    }));
    vi.mocked(api.saveCustomLocalAgent).mockResolvedValue({
      configured: true,
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-fast",
    });
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="viewer-2" />);
    const local = screen
      .getByRole("heading", { name: "Local Agent" })
      .closest("article")!;
    await user.click(within(local).getByRole("button", { name: "Discover" }));
    expect(
      await within(local).findByText("Ollama models (2)"),
    ).toBeInTheDocument();
    expect(within(local).getByText("Custom models (2)")).toBeInTheDocument();
    expect(within(local).getByText("ollama-two")).toBeInTheDocument();
    expect(within(local).getByText("local-quality")).toBeInTheDocument();
    await user.selectOptions(
      within(local).getByRole("combobox", { name: "Local provider" }),
      "custom",
    );
    await user.click(within(local).getByRole("button", { name: "Settings" }));
    await user.type(
      within(local).getByLabelText("API URL"),
      "http://127.0.0.1:1234/v1",
    );
    await user.type(
      within(local).getByLabelText("Model", { exact: true }),
      "local-fast",
    );
    await user.click(
      within(local).getByRole("button", { name: "Save Custom connection" }),
    );
    await waitFor(() =>
      expect(api.saveCustomLocalAgent).toHaveBeenCalledWith({
        profileId: "viewer-2",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local-fast",
      }),
    );
    await user.click(within(local).getByRole("button", { name: "Activate" }));
    await waitFor(() =>
      expect(api.setAgentSelection).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "custom",
          mode: "api",
          reasoningEffort: "none",
        }),
      ),
    );
  });
  it("requests the external provider and key inside the guide", async () => {
    const api = createApi("disabled");
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="viewer-2" />);
    await user.click(
      await screen.findByRole("button", {
        name: /A Guide to Choosing an Agent/,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: /Outside StreamerAI/ }),
    );
    await user.click(screen.getByRole("button", { name: /Next/ }));
    const dialog = screen.getByRole("dialog", { name: "Agent choice guide" });
    await user.selectOptions(
      within(dialog).getByLabelText("API provider"),
      "deepseek",
    );
    await waitFor(() =>
      expect(api.getAgentApiKeyStatus).toHaveBeenCalledWith(
        "deepseek",
        "viewer-2",
      ),
    );
    await user.click(within(dialog).getByRole("button", { name: /Next/ }));
    const keyField = within(dialog).getByLabelText("API key");
    await waitFor(() =>
      expect(keyField.closest("label")).toHaveClass("is-invalid"),
    );
    expect(keyField).toHaveFocus();
    expect(api.setAgentSelection).not.toHaveBeenCalled();
    await user.type(keyField, "private-key-123");
    await user.click(within(dialog).getByRole("button", { name: /Next/ }));
    await user.click(within(dialog).getByRole("button", { name: /Quality/ }));
    await user.click(
      within(dialog).getByRole("button", { name: "Apply recommendation" }),
    );
    await waitFor(() =>
      expect(api.saveAgentApiKey).toHaveBeenCalledWith({
        profileId: "viewer-2",
        provider: "deepseek",
        apiKey: "private-key-123",
      }),
    );
    expect(api.setAgentSelection).toHaveBeenCalledWith({
      profileId: "viewer-2",
      mode: "api",
      provider: "deepseek",
      reasoningEffort: "high",
    });
  });
  it("uses a saved key for the provider chosen in the guide", async () => {
    const api = createApi("disabled");
    vi.mocked(api.getAgentApiKeyStatus).mockImplementation(
      async (provider) => ({
        provider,
        configured: provider === "gemini",
      }),
    );
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="viewer-2" />);
    await user.click(
      await screen.findByRole("button", {
        name: /A Guide to Choosing an Agent/,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: /Outside StreamerAI/ }),
    );
    await user.click(screen.getByRole("button", { name: /Next/ }));
    const dialog = screen.getByRole("dialog", { name: "Agent choice guide" });
    await user.selectOptions(
      within(dialog).getByLabelText("API provider"),
      "gemini",
    );
    expect(
      await within(dialog).findByText(/A key is already saved/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Next/ }));
    await user.click(
      screen.getByRole("button", { name: "Apply recommendation" }),
    );
    await waitFor(() =>
      expect(api.setAgentSelection).toHaveBeenCalledWith({
        profileId: "viewer-2",
        mode: "api",
        provider: "gemini",
        reasoningEffort: "none",
      }),
    );
  });

  it("offers the Ollama installer when the local runtime is missing", async () => {
    const api = createApi("disabled");
    vi.mocked(api.getLocalAgentCapabilities).mockResolvedValue({
      providers: [
        {
          provider: "ollama",
          detected: false,
          ready: false,
          code: "NOT_FOUND",
          message: "Ollama not found",
          recommendedModel: null,
        },
      ],
    });
    vi.mocked(api.getAgentModels).mockImplementation(async (provider) => ({
      provider,
      models: [],
      recommendedModel: null,
      source: "local",
      status: "unavailable",
      message: "No models",
    }));
    vi.mocked(api.discoverLocalAgents).mockResolvedValue({
      availableIds: [],
      runtimeAvailable: false,
    });
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="viewer-2" />);
    await user.click(
      screen.getByRole("button", { name: /A Guide to Choosing an Agent/ }),
    );
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("Ollama needed")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Download Ollama/ }),
    ).toHaveAttribute("href", "https://ollama.com/download");
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
  });

  it("downloads a missing Ollama model and verifies it before proceeding", async () => {
    const api = createApi("disabled");
    let installed = false;
    vi.mocked(api.getLocalAgentCapabilities).mockImplementation(async () => ({
      providers: [
        {
          provider: "ollama",
          detected: installed,
          ready: false,
          code: "SETUP_REQUIRED",
          message: "Model required",
          recommendedModel: installed ? "qwen3.5:4b" : null,
        },
      ],
    }));
    vi.mocked(api.getAgentModels).mockImplementation(async (provider) => ({
      provider,
      models:
        installed && provider === "ollama"
          ? [
              {
                id: "qwen3.5:4b",
                label: "qwen3.5:4b",
                reasoningEfforts: ["none"],
              },
            ]
          : [],
      recommendedModel:
        installed && provider === "ollama" ? "qwen3.5:4b" : null,
      source: "local",
      status: installed && provider === "ollama" ? "available" : "unavailable",
      message: installed ? "Available" : "No models",
    }));
    vi.mocked(api.pullLocalAgentModel).mockImplementation(async () => {
      installed = true;
      return { ok: true, model: "qwen3.5:4b" };
    });
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="viewer-2" />);
    await user.click(
      screen.getByRole("button", { name: /A Guide to Choosing an Agent/ }),
    );
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("Model needed")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Download model with Ollama/ }),
    );
    expect(await screen.findByText("Agent confirmed")).toBeInTheDocument();
    expect(api.pullLocalAgentModel).toHaveBeenCalledWith("viewer-2");
    expect(api.verifyOllamaModel).toHaveBeenCalledWith({
      profileId: "viewer-2",
      model: "qwen3.5:4b",
    });
    expect(api.connectLocalAgent).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /Next/ }));
    await user.click(
      screen.getByRole("button", { name: /Apply recommendation/ }),
    );
    expect(api.connectLocalAgent).toHaveBeenCalledWith({
      profileId: "viewer-2",
      model: "qwen3.5:4b",
      baseUrl: "http://127.0.0.1:11434",
    });
  });

  it("waits for a working Custom response before recommending it", async () => {
    const api = createApi("disabled");
    vi.mocked(api.getLocalAgentCapabilities).mockResolvedValue({
      providers: [
        {
          provider: "custom",
          detected: true,
          ready: true,
          code: "READY",
          message: "Model listed",
          recommendedModel: "local-model",
        },
      ],
    });
    vi.mocked(api.getAgentModels).mockImplementation(async (provider) => ({
      provider,
      models:
        provider === "custom"
          ? [
              {
                id: "local-model",
                label: "local-model",
                reasoningEfforts: ["none"],
              },
            ]
          : [],
      recommendedModel: provider === "custom" ? "local-model" : null,
      source: "local",
      status: provider === "custom" ? "available" : "unavailable",
      message: "Checked",
    }));
    vi.mocked(api.discoverLocalAgents).mockResolvedValue({
      availableIds: [],
      runtimeAvailable: false,
    });
    vi.mocked(api.verifyCustomLocalAgent)
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="viewer-2" />);
    await user.click(
      screen.getByRole("button", { name: /A Guide to Choosing an Agent/ }),
    );
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(
      await screen.findByText(/could not complete a test request/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Check again/ }));
    expect(await screen.findByText("Agent confirmed")).toBeInTheDocument();
    expect(api.verifyCustomLocalAgent).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();
  });

  it("verifies a new Custom address without saving it until Apply", async () => {
    const api = createApi("disabled");
    vi.mocked(api.getLocalAgentCapabilities).mockResolvedValue({
      providers: [],
    });
    vi.mocked(api.getAgentModels).mockImplementation(async (provider) => ({
      provider,
      models: [],
      recommendedModel: null,
      source: "local",
      status: "unavailable",
      message: "No models",
    }));
    vi.mocked(api.discoverLocalAgents).mockResolvedValue({
      availableIds: [],
      runtimeAvailable: false,
    });
    const user = userEvent.setup();
    render(<AgentBackendSettings api={api} profileId="viewer-2" />);
    await user.click(
      screen.getByRole("button", { name: /A Guide to Choosing an Agent/ }),
    );
    await user.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Ollama needed");
    await user.click(
      screen.getByRole("button", { name: /Use a Custom local API/ }),
    );
    await user.type(
      screen.getByLabelText("Local API URL"),
      "http://127.0.0.1:1234/v1",
    );
    await user.type(screen.getByLabelText("Model name"), "local-fast");
    await user.click(
      screen.getByRole("button", { name: "Verify Custom agent" }),
    );
    expect(await screen.findByText("Agent confirmed")).toBeInTheDocument();
    expect(api.verifyCustomLocalCandidate).toHaveBeenCalledWith({
      profileId: "viewer-2",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-fast",
    });
    expect(api.saveCustomLocalAgent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Next/ }));
    await user.click(
      screen.getByRole("button", { name: "Apply recommendation" }),
    );
    expect(api.saveCustomLocalAgent).toHaveBeenCalledWith({
      profileId: "viewer-2",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-fast",
    });
  });
});
