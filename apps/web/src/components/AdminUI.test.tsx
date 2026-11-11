import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { AdminHelp } from "./AdminUI";

it("opens contextual help from the keyboard and dismisses it with Escape", async () => {
  const user = userEvent.setup();
  render(
    <AdminHelp label="Backup help">Keep the original backup PIN.</AdminHelp>,
  );
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.tab();
  const trigger = screen.getByRole("button", { name: "Backup help" });
  expect(trigger).toHaveFocus();
  expect(screen.getByRole("tooltip")).toHaveTextContent(
    "Keep the original backup PIN.",
  );
  expect(trigger).toHaveAttribute(
    "aria-describedby",
    screen.getByRole("tooltip").id,
  );
  fireEvent.scroll(window);
  fireEvent.resize(window);
  expect(screen.getByRole("tooltip")).toBeVisible();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("supports hover and touch activation and closes when the page scrolls", () => {
  render(
    <AdminHelp label="Device help">
      Approve only devices you recognize.
    </AdminHelp>,
  );
  const trigger = screen.getByRole("button", { name: "Device help" });
  fireEvent.mouseEnter(trigger);
  expect(screen.getByRole("tooltip")).toBeVisible();
  fireEvent.mouseLeave(trigger);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.click(trigger);
  expect(screen.getByRole("tooltip")).toBeVisible();
  fireEvent.scroll(window);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});
