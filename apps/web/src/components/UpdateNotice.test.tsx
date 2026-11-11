import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdateNotice } from "./UpdateNotice";
import { useUpdateSave } from "./updateSave";

const shared = vi.hoisted(() => ({
  notify: (() => undefined) as () => void,
  activate: vi.fn(async () => undefined),
}));
vi.mock("virtual:pwa-register", () => ({
  registerSW: (options: { onNeedRefresh(): void }) => {
    shared.notify = options.onNeedRefresh;
    return shared.activate;
  },
}));
beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", undefined);
  shared.activate.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

function PendingSetting({ save }: { save: () => Promise<void> }) {
  useUpdateSave(true, save);
  return <input aria-label="Setting" />;
}

it("saves on one click without a separate saved-work confirmation", async () => {
  let finish!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <>
      <PendingSetting save={save} />
      <UpdateNotice />
    </>,
  );
  act(() => shared.notify());
  fireEvent.input(screen.getByLabelText("Setting"), {
    target: { value: "changed" },
  });
  expect(
    screen.queryByRole("button", { name: "I have saved my changes" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(shared.activate).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
  await act(async () => finish());
  await waitFor(() => expect(shared.activate).toHaveBeenCalledWith(true));
});

it("keeps the page open on save failure and allows a single-click retry", async () => {
  const save = vi
    .fn(async () => undefined)
    .mockRejectedValueOnce(new Error("offline"));
  render(
    <>
      <PendingSetting save={save} />
      <UpdateNotice />
    </>,
  );
  act(() => shared.notify());
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await screen.findByRole("alert");
  expect(shared.activate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await waitFor(() => expect(shared.activate).toHaveBeenCalledOnce());
});

it("does not mistake search or login fields for settings or submit arbitrary forms", async () => {
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(
    <>
      <form onSubmit={submit}>
        <input aria-label="Search" />
        <input aria-label="Login PIN" type="password" />
      </form>
      <UpdateNotice />
    </>,
  );
  act(() => shared.notify());
  fireEvent.input(screen.getByLabelText("Search"), {
    target: { value: "film" },
  });
  fireEvent.input(screen.getByLabelText("Login PIN"), {
    target: { value: "1234" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await waitFor(() => expect(shared.activate).toHaveBeenCalledOnce());
  expect(submit).not.toHaveBeenCalled();
});
