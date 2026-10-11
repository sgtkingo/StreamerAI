import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DownloadButton } from "./DownloadButton";

describe("DownloadButton", () => {
  it("shows an active preparation spinner around the download icon and allows cancellation", () => {
    const cancel = vi.fn();
    render(
      <DownloadButton
        state="downloading"
        progress={null}
        preparing
        multiFile
        label="all episodes of Sample Show"
        onClick={cancel}
      />,
    );
    const button = screen.getByRole("button", {
      name: /Checking episode availability for all episodes of Sample Show/,
    });
    expect(button).toHaveClass("download-button--preparing");
    expect(button).toHaveClass("download-button--indeterminate");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector(".download-button__ring")).toBeInTheDocument();
    fireEvent.click(button);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
