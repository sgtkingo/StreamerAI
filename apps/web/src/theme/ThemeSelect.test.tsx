import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeSelect } from "./ThemeSelect";

describe("theme selectors", () => {
  it("limits the primary selector to Seasonal and Cinematic and represents fixed seasons as Seasonal", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ThemeSelect value="christmas" selection="primary" onChange={onChange} />,
    );
    const select = screen.getByLabelText("Theme");
    expect(select).toHaveValue("auto");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Seasonal", "Cinematic"]);
    fireEvent.change(select, { target: { value: "cinematic" } });
    expect(onChange).toHaveBeenCalledWith("cinematic");
    rerender(
      <ThemeSelect value="cinematic" selection="primary" onChange={onChange} />,
    );
    expect(select).toHaveValue("cinematic");
    fireEvent.change(select, { target: { value: "auto" } });
    expect(onChange).toHaveBeenLastCalledWith("auto");
  });

  it("exposes calendar selection and each fixed season in detailed settings", () => {
    render(
      <ThemeSelect
        value="new-year"
        selection="season"
        label="Season"
        onChange={vi.fn()}
      />,
    );
    const select = screen.getByLabelText("Season");
    expect(select).toHaveValue("new-year");
    expect(within(select).getAllByRole("option")).toHaveLength(7);
    expect(
      within(select).getByRole("option", { name: "Follow the calendar" }),
    ).toHaveValue("auto");
    expect(
      within(select).queryByRole("option", { name: "Cinematic" }),
    ).not.toBeInTheDocument();
  });

  it("keeps all appearance choices available to onboarding and localizes the primary selector", () => {
    const { rerender } = render(
      <ThemeSelect value="auto" onChange={vi.fn()} />,
    );
    expect(screen.getAllByRole("option")).toHaveLength(8);
    rerender(
      <ThemeSelect
        value="auto"
        locale="cs"
        selection="primary"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: "Sezónní" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
});
