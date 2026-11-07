import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerAiSetup } from "./ServerAiSetup";

const available = {
  runtime: "ready",
  runtimeVersion: "0.15.0",
  model: { name: "qwen3.5:4b", present: false },
  installedModels: [] as string[],
  download: { state: "idle", error: null },
  resources: {
    memoryBytes: 16 * 1024 ** 3,
    freeDiskBytes: null,
    recommendedMemoryBytes: 8 * 1024 ** 3,
    estimatedModelBytes: 3_600_000_000,
    recommendedFreeDiskBytes: 8 * 1024 ** 3,
  },
};
afterEach(() => vi.unstubAllGlobals());
describe("server AI preparation", () => {
  it("reuses the configured existing model and never starts a replacement download automatically", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        ...available,
        installedModels: ["another:small", "existing:q4"],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const onUse = vi.fn(async () => undefined);
    render(
      <ServerAiSetup configuredModel="existing:q4" onUseLocalModel={onUse} />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Installed local model" }),
      ).toHaveValue("existing:q4"),
    );
    expect(
      screen.queryByRole("button", { name: "Download local model" }),
    ).not.toBeInTheDocument();
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
      true,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Use this local model" }),
    );
    expect(onUse).toHaveBeenCalledWith("existing:q4");
  });
  it("requires explicit download consent and sends no model or command from the browser", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
      init?.method === "POST"
        ? Response.json({
            alreadyPresent: false,
            download: { state: "downloading" },
          })
        : Response.json(available),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<ServerAiSetup />);
    const download = await screen.findByRole("button", {
      name: "Download local model",
    });
    expect(download).toBeDisabled();
    expect(
      screen.getByText(
        /Free space in Ollama's model folder could not be verified/,
      ),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("checkbox", {
        name: "Download the recommended model on this server.",
      }),
    );
    await user.click(download);
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([, init]) => init?.method === "POST"),
      ).toBe(true),
    );
    const [input, init] = fetcher.mock.calls.find(
      ([, options]) => options?.method === "POST",
    )!;
    expect(input).toBe("/api/v1/server/ai-setup/model");
    expect(JSON.parse(String(init?.body))).toEqual({
      confirm: "download-recommended-local-model",
    });
  });
  it("hands runtime installation to the local server wizard, without browser OS execution", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ...available, runtime: "installed-not-running" }),
    );
    vi.stubGlobal("fetch", fetcher);
    render(<ServerAiSetup />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "How to start existing Ollama",
      }),
    );
    expect(screen.getByText("Configure local AI")).toBeInTheDocument();
    expect(
      screen.getByText(/No terminal commands are needed/),
    ).toBeInTheDocument();
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
      true,
    );
  });
});
