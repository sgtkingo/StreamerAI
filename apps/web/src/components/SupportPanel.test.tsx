import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { SupportPanel } from "./SupportPanel";

it("lets a viewer prepare a bug report without server-owner diagnostics", () => {
  render(<SupportPanel />);
  fireEvent.change(screen.getByLabelText("What happened?"), {
    target: { value: "Playback stopped" },
  });
  const issue = screen.getByRole("link", { name: "Open GitHub issue" });
  expect(decodeURIComponent(issue.getAttribute("href")!)).toContain(
    "Playback stopped",
  );
  expect(screen.getByText(/Server diagnostics are optional/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Save report offline" }),
  ).toBeEnabled();
});
