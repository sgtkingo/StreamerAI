import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InstallationAccess } from "./InstallationAccess";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

it("resumes the same pending request after a refresh and clears it after approval", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        requestId: "request-1",
        code: "123456",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      }),
    )
    .mockResolvedValue(Response.json({ status: "approved" }));
  vi.stubGlobal("fetch", fetcher);
  const connected = vi.fn(),
    status = {
      enabled: true,
      claimed: true,
      paired: false,
      role: null,
      serverId: "server-1",
    } as const;
  const first = render(
    <InstallationAccess status={status} onConnected={connected} />,
  );
  fireEvent.change(screen.getByLabelText("Device name"), {
    target: { value: "Bedroom TV" },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Show pairing code" })),
  );
  first.unmount();
  const second = render(
    <InstallationAccess status={status} onConnected={connected} />,
  );
  expect(screen.getByLabelText("Pairing code 123456")).toBeVisible();
  expect(screen.getByText("Bedroom TV")).toBeVisible();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(fetcher).toHaveBeenLastCalledWith(
    "/api/v1/installation/poll",
    expect.objectContaining({
      body: JSON.stringify({ requestId: "request-1" }),
    }),
  );
  expect(connected).toHaveBeenCalledOnce();
  second.unmount();
  render(<InstallationAccess status={status} onConnected={connected} />);
  expect(
    screen.getByRole("button", { name: "Show pairing code" }),
  ).toBeVisible();
});

it("does not resume a request belonging to another home server", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({
        requestId: "request-1",
        code: "123456",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const base = {
    enabled: true,
    claimed: true,
    paired: false,
    role: null,
  } as const;
  const previous = render(
    <InstallationAccess
      status={{ ...base, serverId: "server-1" }}
      onConnected={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Show pairing code" }));
  await screen.findByLabelText("Pairing code 123456");
  previous.unmount();
  render(
    <InstallationAccess
      status={{ ...base, serverId: "server-2" }}
      onConnected={vi.fn()}
    />,
  );
  expect(
    screen.queryByLabelText("Pairing code 123456"),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Show pairing code" }),
  ).toBeVisible();
});

it("offers a new code if a resumed request can no longer be verified", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        requestId: "request-1",
        code: "123456",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      }),
    )
    .mockResolvedValue(
      Response.json({ error: { code: "PAIRING_REJECTED" } }, { status: 403 }),
    );
  vi.stubGlobal("fetch", fetcher);
  const connected = vi.fn();
  const first = render(
    <InstallationAccess
      status={{ enabled: true, claimed: true, paired: false, role: null }}
      onConnected={connected}
    />,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Show pairing code" })),
  );
  first.unmount();
  render(
    <InstallationAccess
      status={{ enabled: true, claimed: true, paired: false, role: null }}
      onConnected={connected}
    />,
  );
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(
    screen.getByRole("heading", {
      name: "This pairing request is no longer available",
    }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Get a new code" })).toBeVisible();
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(connected).not.toHaveBeenCalled();
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
    screen.getByRole("link", { name: "Open approval page" }),
  ).toHaveAttribute("href", "http://localhost:3000/admin/pair?code=123456");
});

it("shows the named pairing form immediately without creating a request on page load", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(
    <InstallationAccess
      status={{
        enabled: true,
        claimed: true,
        paired: false,
        role: null,
        householdName: "Hnízdo",
      }}
      onConnected={vi.fn()}
    />,
  );
  expect(screen.getByRole("form", { name: "Name this device" })).toBeVisible();
  expect(screen.getByLabelText("Device name")).toHaveValue("Home browser");
  expect(screen.getByText("Hnízdo")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Sign in on this device" }),
  ).toBeVisible();
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Device name"), {
    target: { value: "   " },
  });
  expect(
    screen.getByRole("button", { name: "Show pairing code" }),
  ).toBeDisabled();
});

it("expires a code locally, hides it and prepares a replacement without re-entering the device name", async () => {
  vi.useFakeTimers();
  const grant = {
    requestId: "old",
    code: "123456",
    expiresAt: new Date(Date.now() + 3000).toISOString(),
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(grant))
    .mockResolvedValueOnce(
      Response.json({
        ...grant,
        requestId: "new",
        code: "654321",
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
  fireEvent.change(screen.getByLabelText("Device name"), {
    target: { value: "Living room TV" },
  });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Show pairing code" })),
  );
  expect(screen.getByLabelText("Pairing code 123456")).toBeVisible();
  expect(screen.getByRole("timer")).toHaveTextContent("00:03");
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(
    screen.getByRole("heading", { name: "Your pairing code has expired" }),
  ).toBeVisible();
  expect(
    screen.queryByLabelText("Pairing code 123456"),
  ).not.toBeInTheDocument();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Get a new code" })),
  );
  expect(screen.getByLabelText("Pairing code 654321")).toBeVisible();
  expect(fetcher).toHaveBeenLastCalledWith(
    "/api/v1/installation/pair",
    expect.objectContaining({
      body: JSON.stringify({ name: "Living room TV" }),
    }),
  );
});

it("stops polling after the owner declines a request", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        requestId: "pending",
        code: "123456",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      }),
    )
    .mockResolvedValue(Response.json({ status: "denied" }));
  vi.stubGlobal("fetch", fetcher);
  const connected = vi.fn();
  render(
    <InstallationAccess
      status={{ enabled: true, claimed: true, paired: false, role: null }}
      onConnected={connected}
    />,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Show pairing code" })),
  );
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(
    screen.getByRole("heading", { name: "This connection was declined" }),
  ).toBeVisible();
  expect(
    screen.queryByLabelText("Pairing code 123456"),
  ).not.toBeInTheDocument();
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(connected).not.toHaveBeenCalled();
});

it("recovers a temporary polling failure and opens the household exactly once after approval", async () => {
  vi.useFakeTimers();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        requestId: "pending",
        code: "123456",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      }),
    )
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(Response.json({ status: "pending" }))
    .mockResolvedValueOnce(Response.json({ status: "approved" }));
  vi.stubGlobal("fetch", fetcher);
  const connected = vi.fn();
  render(
    <InstallationAccess
      status={{ enabled: true, claimed: true, paired: false, role: null }}
      onConnected={connected}
    />,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Show pairing code" })),
  );
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Reconnecting to the server",
  );
  expect(screen.getByRole("alert")).toHaveTextContent("keep checking");
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for approval");
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(connected).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(connected).toHaveBeenCalledOnce();
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
