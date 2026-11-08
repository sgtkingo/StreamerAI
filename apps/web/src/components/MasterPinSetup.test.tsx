import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { StreamerApi } from "../api/client";
import { AccountLogin } from "./AccountLogin";
import { MasterPinSetup } from "./MasterPinSetup";

it("requires eight matching digits and allows retry after a rejected save", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue(undefined);
  render(<MasterPinSetup onSave={save} />);
  const pin = screen.getByLabelText("Master PIN (8 digits)");
  const confirmation = screen.getByLabelText("Confirm Master PIN");
  for (const field of [pin, confirmation])
    expect(
      field.closest(".digit-slots")?.querySelectorAll(".digit-slots__cell"),
    ).toHaveLength(8);
  const button = screen.getByRole("button", { name: "Save Master PIN" });
  fireEvent.change(pin, { target: { value: "01234567" } });
  fireEvent.change(confirmation, { target: { value: "01234568" } });
  expect(button).toBeDisabled();
  fireEvent.change(confirmation, { target: { value: "01234567" } });
  fireEvent.click(button);
  await screen.findByRole("alert");
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save).toHaveBeenLastCalledWith("01234567");
});

it("opens the local session before Welcome so backup recovery can use an existing Master PIN", async () => {
  const authenticated = vi.fn();
  const api = {
    getAuthStatus: vi.fn().mockResolvedValue({ localMasterPinRequired: true }),
    startLocalSession: vi.fn().mockResolvedValue({}),
  } as unknown as StreamerApi;
  render(<AccountLogin api={api} allowLocal onAuthenticated={authenticated} />);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Create a household",
    }),
  );
  await waitFor(() => expect(authenticated).toHaveBeenCalledOnce());
  expect(api.startLocalSession).toHaveBeenCalledWith();
  expect(
    screen.queryByRole("heading", { name: "Choose your Master PIN" }),
  ).not.toBeInTheDocument();
});
