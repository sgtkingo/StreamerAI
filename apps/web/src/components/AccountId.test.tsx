import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AccountId } from "./AccountId";

afterEach(() => vi.restoreAllMocks());

it("copies the actual account ID and confirms it beside the icon", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText");
  render(<AccountId value="cloud-owner-123" />);
  const button = screen.getByRole("button", { name: "Copy account ID" });
  await user.click(button);
  expect(writeText).toHaveBeenCalledWith("cloud-owner-123");
  await waitFor(() => expect(button).toHaveAttribute("data-copied", "true"));
  expect(screen.getByRole("status")).toHaveTextContent("Account ID copied.");
});

it("offers no copy button when the ID is unavailable", () => {
  render(<AccountId value={null} />);
  expect(screen.getByText("Unavailable")).toBeVisible();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
