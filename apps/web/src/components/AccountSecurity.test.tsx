import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { StreamerApi } from "../api/client";
import { AccountSecurity } from "./AccountSecurity";

vi.mock("./EncryptedRecovery", () => ({
  EncryptedRecovery: () => <h3>Household backups</h3>,
}));

it("groups backups and local Master PIN protection in administration", async () => {
  const api = {
    getAccount: vi.fn().mockResolvedValue({
      account: { cloudLinked: true },
      manageUrl: "https://cloud.example/account?account_id=owner",
    }),
    verifyMasterPin: vi.fn().mockResolvedValue(undefined),
    changeMasterPin: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as StreamerApi;
  render(<AccountSecurity api={api} />);
  expect(screen.getByRole("heading", { name: "Security" })).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Household backups" }),
  ).toBeVisible();
  expect(
    await screen.findByRole("link", { name: "Forgot PIN?" }),
  ).toHaveAttribute("href", "/admin/recover");
  expect(
    screen.getByLabelText("How to recover your Master PIN"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Verify Master PIN for backups" }),
  ).not.toBeInTheDocument();
});

it.each([false, true])(
  "changes the Master PIN with the current PIN (online=%s)",
  async (online) => {
    const changeMasterPin = vi.fn().mockResolvedValue({ ok: true });
    const api = {
      getAccount: vi.fn().mockResolvedValue({
        account: { cloudLinked: online },
        manageUrl: online ? "https://cloud.example/account" : null,
      }),
      changeMasterPin,
    } as unknown as StreamerApi;
    render(<AccountSecurity api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Master PIN" }));
    for (const [label, value] of [
      ["Current Master PIN", "12345678"],
      ["New Master PIN", "87654321"],
      ["Confirm new Master PIN", "87654321"],
    ]) {
      const input = screen.getByLabelText(label!);
      expect(
        input.closest(".digit-slots")?.querySelectorAll(".digit-slots__cell"),
      ).toHaveLength(8);
      fireEvent.change(input, { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Save Master PIN" }));
    await waitFor(() =>
      expect(changeMasterPin).toHaveBeenCalledWith(
        "12345678",
        "87654321",
        "87654321",
      ),
    );
    if (!online)
      expect(
        screen.queryByRole("link", { name: "Forgot PIN?" }),
      ).not.toBeInTheDocument();
  },
);
