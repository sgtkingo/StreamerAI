import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { SupportFaq } from "./SupportFaq";

it("filters questions and answers immediately and handles no results", () => {
  render(<SupportFaq />);
  const search = screen.getByRole("searchbox", {
    name: "Search questions and answers",
  });
  fireEvent.change(search, { target: { value: "VPN" } });
  expect(
    screen.getByText("Why can't my client find the home server?"),
  ).toBeVisible();
  expect(
    screen.queryByText("How do I change a profile PIN?"),
  ).not.toBeInTheDocument();
  fireEvent.change(search, { target: { value: "no such answer" } });
  expect(screen.getByText(/No answers found/)).toBeVisible();
  fireEvent.change(search, { target: { value: "" } });
  expect(screen.getByText("How do I change a profile PIN?")).toBeVisible();
});
