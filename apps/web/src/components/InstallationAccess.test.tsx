import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InstallationAccess } from "./InstallationAccess";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

it("consumes the installer handoff once and removes the key from the address before claiming", async () => {
  const secret = "a".repeat(64);
  window.history.replaceState({}, "", `/#setup=${secret}`);
  let addressAtRequest = "";
  const fetcher = vi.fn(async () => {
    addressAtRequest = window.location.href;
    return Response.json({ role: "owner" });
  });
  vi.stubGlobal("fetch", fetcher);
  const connected = vi.fn();
  render(
    <StrictMode>
      <InstallationAccess
        status={{ enabled: true, claimed: false, paired: false, role: null }}
        onConnected={connected}
      />
    </StrictMode>,
  );
  await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(addressAtRequest).not.toContain(secret);
  expect(window.location.hash).toBe("");
  const options = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(options[1].body))).toEqual({ token: secret });
});

it("clears malformed setup fragments and offers retry without sending a claim", async () => {
  window.history.replaceState({}, "", "/#setup=invalid");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await act(async () => {
    render(
      <InstallationAccess
        status={{ enabled: true, claimed: false, paired: false, role: null }}
        onConnected={vi.fn()}
      />,
    );
  });
  expect(screen.getByRole("alert")).toHaveTextContent("setup link is invalid");
  expect(fetcher).not.toHaveBeenCalled();
  expect(window.location.hash).toBe("");
});
