import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InstallationAccess } from "./InstallationAccess";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

it("links initial administration to household setup without asking for an installation key", () => {
  render(
    <InstallationAccess
      administration
      status={{
        enabled: true,
        claimed: false,
        paired: false,
        role: null,
        householdReady: false,
      }}
      onConnected={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("link", { name: "Set up your household" }),
  ).toHaveAttribute("href", "/admin");
  expect(screen.queryByLabelText("One-time setup key")).not.toBeInTheDocument();
});

it("shows a local QR address and a six-digit pairing code without cloud sign-in", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path.endsWith("/pair"))
        return Response.json({
          requestId: "pending",
          code: "123456",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          qrCodeDataUrl: "data:image/png;base64,AA==",
          verificationUriComplete:
            "http://localhost:3000/admin/pair?code=123456",
        });
      return Response.json({ status: "pending" });
    }),
  );
  render(
    <InstallationAccess
      status={{ enabled: true, claimed: true, paired: false, role: null }}
      onConnected={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Show pairing code" }));
  expect(await screen.findByLabelText("Pairing code 123456")).toHaveTextContent(
    "123 456",
  );
  expect(screen.getByRole("img", { name: /Scan to approve/ })).toBeVisible();
  expect(
    screen.getByRole("link", { name: /admin\/pair\?code=123456/ }),
  ).toHaveAttribute("href", "http://localhost:3000/admin/pair?code=123456");
});

it("authorizes a playback client using the household PIN without granting administration", async () => {
  const fetcher = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  const connected = vi.fn();
  render(
    <InstallationAccess
      status={{ enabled: true, claimed: true, paired: false, role: null }}
      onConnected={connected}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in on this device" }),
  );
  fireEvent.change(screen.getByLabelText("Master PIN"), {
    target: { value: "01234567" },
  });
  await waitFor(() => expect(connected).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/installation/authorize",
    expect.objectContaining({
      body: JSON.stringify({
        masterPin: "01234567",
        deviceName: "Home browser",
        admin: false,
      }),
    }),
  );
});

it("starts device pairing when the client asks the owner for direct approval", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      requestId: "pending",
      code: "123456",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(
    <InstallationAccess
      status={{ enabled: true, claimed: true, paired: false, role: null }}
      onConnected={vi.fn()}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in on this device" }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Ask household owner to approve this device",
    }),
  );
  expect(await screen.findByLabelText("Pairing code 123456")).toBeVisible();
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/installation/pair",
    expect.objectContaining({ method: "POST" }),
  );
});

it("directs an unpaired client to administration until household setup finishes", () => {
  render(
    <InstallationAccess
      status={{
        enabled: true,
        claimed: true,
        paired: false,
        role: null,
        householdReady: false,
      }}
      onConnected={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Your household is not ready yet" }),
  ).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open household administration" }),
  ).toHaveAttribute("href", "/admin");
  expect(
    screen.queryByRole("button", { name: "Show pairing code" }),
  ).not.toBeInTheDocument();
});
