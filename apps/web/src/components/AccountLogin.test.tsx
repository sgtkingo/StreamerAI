import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceAuthorization, StreamerApi } from "../api/client";
import { AccountLogin } from "./AccountLogin";
import { ApiError } from "../api/client";

afterEach(() => vi.useRealTimers());

const grant: DeviceAuthorization = {
  deviceCode: "private-grant",
  userCode: "ABCD-1234",
  verificationUri: "https://example.com/device",
  verificationUriComplete: "https://example.com/device?code=ABCD-1234",
  expiresAt: new Date(Date.now() + 300000).toISOString(),
  interval: 5,
  qrCodeDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
};

describe("device sign-in", () => {
  it("stops polling after a terminal cloud error and offers a new code", async () => {
    vi.useFakeTimers();
    const api = {
      startDeviceAuthorization: vi.fn().mockResolvedValue(grant),
      pollDeviceAuthorization: vi
        .fn()
        .mockRejectedValue(
          new ApiError(
            "Cloud services are unavailable.",
            503,
            "HOUSEHOLD_CLOUD_UNAVAILABLE",
          ),
        ),
    } as unknown as StreamerApi;
    const approved = vi.fn();
    render(<AccountLogin api={api} onAuthenticated={approved} />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Cloud services are unavailable.",
    );
    expect(
      screen.getByRole("button", { name: "Get a new code" }),
    ).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(api.pollDeviceAuthorization).toHaveBeenCalledOnce();
    expect(approved).not.toHaveBeenCalled();
  });
  it("offers one household creation flow without a local account selector", async () => {
    const api = {
      startLocalSession: vi.fn().mockResolvedValue({}),
      startDeviceAuthorization: vi.fn(),
    } as unknown as StreamerApi;
    const onAuthenticated = vi.fn();
    render(
      <AccountLogin
        api={api}
        allowLocal
        recoveredLocalAccounts={[{ id: "old" }]}
        onAuthenticated={onAuthenticated}
      />,
    );
    expect(screen.queryByLabelText("Local account")).not.toBeInTheDocument();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Create a household" }),
      ),
    );
    expect(api.startLocalSession).toHaveBeenCalledWith();
    expect(api.startDeviceAuthorization).not.toHaveBeenCalled();
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });
  it("opens backup import without creating a PIN", async () => {
    const api = {
      startLocalSession: vi.fn().mockResolvedValue({}),
      startDeviceAuthorization: vi.fn(),
    } as unknown as StreamerApi;
    const onRestoreBackup = vi.fn();
    render(
      <AccountLogin
        api={api}
        allowLocal
        onRestoreBackup={onRestoreBackup}
        onAuthenticated={vi.fn()}
      />,
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Import a backup" })),
    );
    expect(onRestoreBackup).toHaveBeenCalledOnce();
    expect(
      screen.queryByLabelText("Confirm Master PIN"),
    ).not.toBeInTheDocument();
  });
  it("clears a cloud error when creating a household", async () => {
    const api = {
      startDeviceAuthorization: vi
        .fn()
        .mockRejectedValue(new Error("Cloud unavailable")),
      startLocalSession: vi.fn().mockResolvedValue({}),
    } as unknown as StreamerApi;
    render(<AccountLogin api={api} allowLocal onAuthenticated={vi.fn()} />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Sign in to cloud" })),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to complete sign-in",
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Create a household" }),
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("hides cloud sign-in when the server has no cloud service", () => {
    const api = { startLocalSession: vi.fn() } as unknown as StreamerApi;
    render(
      <AccountLogin
        api={api}
        allowLocal
        allowCloud={false}
        onAuthenticated={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Sign in to cloud" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create a household" }),
    ).toBeVisible();
  });
  it("labels a failed local session as a local account error", async () => {
    const api = {
      startDeviceAuthorization: vi.fn().mockResolvedValue(grant),
      startLocalSession: vi
        .fn()
        .mockRejectedValue(new Error("Local unavailable")),
    } as unknown as StreamerApi;
    render(<AccountLogin api={api} allowLocal onAuthenticated={vi.fn()} />);
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Create a household" }),
      ),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to open household",
    );
  });
  it("opens a local account without starting online pairing", async () => {
    const onAuthenticated = vi.fn();
    const api = {
      startLocalSession: vi.fn().mockResolvedValue({
        account: { id: "household", cloudLinked: false },
      }),
      startDeviceAuthorization: vi.fn().mockResolvedValue(grant),
    } as unknown as StreamerApi;
    render(
      <AccountLogin api={api} allowLocal onAuthenticated={onAuthenticated} />,
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: "Create a household",
        }),
      ),
    );
    expect(api.startLocalSession).toHaveBeenCalledOnce();
    expect(api.startDeviceAuthorization).not.toHaveBeenCalled();
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("uses cloud synchronization by default when signing in", async () => {
    const api = {
      startDeviceAuthorization: vi.fn().mockResolvedValue(grant),
    } as unknown as StreamerApi;
    render(<AccountLogin api={api} onAuthenticated={vi.fn()} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await act(async () => {});
    expect(api.startDeviceAuthorization).toHaveBeenCalledWith(undefined);
    expect(
      screen.queryByRole("button", { name: "Continue with Google" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Continue with email" }),
    ).not.toBeInTheDocument();
  });
  it("renders a QR and code, then waits for explicit approval before completing", async () => {
    vi.useFakeTimers();
    const onAuthenticated = vi.fn();
    const api = {
      startDeviceAuthorization: vi.fn().mockResolvedValue(grant),
      pollDeviceAuthorization: vi
        .fn()
        .mockResolvedValueOnce({ status: "pending" })
        .mockResolvedValue({ status: "approved" }),
    } as unknown as StreamerApi;
    render(<AccountLogin api={api} onAuthenticated={onAuthenticated} />);
    await act(async () => {});
    expect(
      screen.getByRole("img", { name: /Scan to sign in/ }),
    ).toHaveAttribute("src", grant.qrCodeDataUrl);
    expect(screen.getByLabelText("Pairing code ABCD-1234")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Sign in on this device" }),
    ).toHaveAttribute("href", grant.verificationUriComplete);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(onAuthenticated).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(onAuthenticated).toHaveBeenCalledOnce();
    expect(api.pollDeviceAuthorization).toHaveBeenCalledWith("private-grant");
    expect(localStorage.getItem("deviceCode")).toBeNull();
  });

  it("stops polling when a user cancels", async () => {
    vi.useFakeTimers();
    const api = {
      startDeviceAuthorization: vi.fn().mockResolvedValue(grant),
      pollDeviceAuthorization: vi.fn().mockResolvedValue({ status: "pending" }),
    } as unknown as StreamerApi;
    render(<AccountLogin api={api} onAuthenticated={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(api.pollDeviceAuthorization).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Sign in to cloud" }),
    ).toBeVisible();
  });

  it("replaces expired grants instead of polling them again", async () => {
    vi.useFakeTimers();
    const api = {
      startDeviceAuthorization: vi.fn().mockResolvedValue({
        ...grant,
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      }),
      pollDeviceAuthorization: vi.fn(),
    } as unknown as StreamerApi;
    render(<AccountLogin api={api} onAuthenticated={vi.fn()} />);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(
      screen.getByRole("button", { name: "Get a new code" }),
    ).toBeVisible();
    expect(api.pollDeviceAuthorization).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your pairing code has expired",
    );
  });

  it("shows denial separately from expiry, stops polling, and permits a new request", async () => {
    vi.useFakeTimers();
    const api = {
      startDeviceAuthorization: vi.fn().mockResolvedValue(grant),
      pollDeviceAuthorization: vi.fn().mockResolvedValue({ status: "denied" }),
    } as unknown as StreamerApi;
    render(<AccountLogin api={api} onAuthenticated={vi.fn()} />);
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in was declined");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/expired/i);
    expect(
      screen.queryByLabelText("Pairing code ABCD-1234"),
    ).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(api.pollDeviceAuthorization).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in was declined");
    vi.mocked(api.startDeviceAuthorization!).mockResolvedValueOnce({
      ...grant,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Get a new code" })),
    );
    expect(api.startDeviceAuthorization).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("starts only one request in StrictMode and shows recoverable start errors", async () => {
    const api = {
      startDeviceAuthorization: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue(grant),
    } as unknown as StreamerApi;
    render(
      <StrictMode>
        <AccountLogin api={api} onAuthenticated={vi.fn()} />
      </StrictMode>,
    );
    await act(async () => {});
    expect(api.startDeviceAuthorization).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to complete sign-in",
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Sign in to cloud" })),
    );
    expect(screen.getByLabelText("Pairing code ABCD-1234")).toBeVisible();
  });

  it("ignores a pending cloud grant after switching to a local session", async () => {
    let resolve!: (value: DeviceAuthorization) => void;
    const onAuthenticated = vi.fn();
    const api = {
      startDeviceAuthorization: vi.fn().mockImplementation(
        () =>
          new Promise<DeviceAuthorization>((done) => {
            resolve = done;
          }),
      ),
      startLocalSession: vi.fn().mockResolvedValue({}),
      pollDeviceAuthorization: vi.fn(),
    } as unknown as StreamerApi;
    render(
      <AccountLogin api={api} allowLocal onAuthenticated={onAuthenticated} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in to cloud" }));
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Create a household" }),
      ),
    );
    await act(async () => resolve(grant));
    expect(onAuthenticated).toHaveBeenCalledOnce();
    expect(
      screen.queryByLabelText("Pairing code ABCD-1234"),
    ).not.toBeInTheDocument();
    expect(api.pollDeviceAuthorization).not.toHaveBeenCalled();
  });
});
