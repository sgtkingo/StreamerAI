import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { StreamerApi } from "../api/client";
import { HouseholdMerges } from "./HouseholdMerges";

function mergeApi() {
  return {
    getHouseholdMerges: vi.fn().mockResolvedValue({
      requests: [
        {
          id: "merge-1",
          kind: "merge",
          source_name: "Weekend home",
          target_name: "City home",
          status: "approved",
          requiresLocalImport: true,
        },
      ],
    }),
    previewHouseholdMerge: vi.fn().mockResolvedValue({
      profiles: [{ name: "Guest", pinEnabled: true }],
      credentials: [],
      limitations: [],
      sourceName: "Weekend home",
      targetProfileCount: 2,
      keepsDestinationPin: true,
      keepsDestinationServices: true,
    }),
    completeHouseholdMerge: vi
      .fn()
      .mockResolvedValue({ ok: true, profileIds: ["imported-guest"] }),
  } as unknown as StreamerApi;
}

it("reviews an approved source using eight PIN slots before completing the merge", async () => {
  const api = mergeApi(),
    completed = vi.fn();
  render(<HouseholdMerges api={api} onCompleted={completed} />);
  const pin = await screen.findByLabelText("Master PIN for Weekend home");
  expect(
    pin.closest(".digit-slots")?.querySelectorAll(".digit-slots__cell"),
  ).toHaveLength(8);
  fireEvent.change(pin, { target: { value: "01234567" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Review household merge" }),
  );
  expect(await screen.findByText(/contain 3 of 5 profiles/)).toBeVisible();
  expect(
    screen.getByText(
      /keeps its current Master PIN and existing shared service/,
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      /cloud connection is removed after the combined cloud backup is confirmed/,
    ),
  ).toBeVisible();
  expect(api.previewHouseholdMerge).toHaveBeenCalledWith("merge-1", "01234567");
  expect(api.completeHouseholdMerge).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm household merge" }),
  );
  await waitFor(() => expect(completed).toHaveBeenCalledOnce());
  expect(api.completeHouseholdMerge).toHaveBeenCalledWith(
    "merge-1",
    "01234567",
  );
  expect(
    screen.queryByLabelText("Master PIN for Weekend home"),
  ).not.toBeInTheDocument();
});

it("clears the source PIN when review fails and keeps the request available", async () => {
  const api = mergeApi();
  api.previewHouseholdMerge = vi
    .fn()
    .mockRejectedValue(new Error("Check the source Master PIN."));
  render(<HouseholdMerges api={api} onCompleted={vi.fn()} />);
  const pin = await screen.findByLabelText("Master PIN for Weekend home");
  fireEvent.change(pin, { target: { value: "99999999" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Review household merge" }),
  );
  await screen.findByRole("alert");
  expect(pin).toHaveValue("");
  expect(api.completeHouseholdMerge).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Review household merge" }),
  ).toBeDisabled();
});

it("cancels a reviewed merge without keeping the source PIN or submitting changes", async () => {
  const api = mergeApi();
  render(<HouseholdMerges api={api} onCompleted={vi.fn()} />);
  fireEvent.change(
    await screen.findByLabelText("Master PIN for Weekend home"),
    { target: { value: "01234567" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Review household merge" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(screen.getByLabelText("Master PIN for Weekend home")).toHaveValue("");
  expect(api.completeHouseholdMerge).not.toHaveBeenCalled();
});
