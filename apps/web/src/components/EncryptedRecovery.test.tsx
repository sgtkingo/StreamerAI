import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EncryptedRecovery } from "./EncryptedRecovery";

afterEach(() => vi.unstubAllGlobals());
const base = "/api/v1/account/encrypted-household";
function ownerFetch(
  operation: (path: string, options?: RequestInit) => Response,
) {
  return vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/api/v1/installation/status")
      return Response.json({ role: "owner" });
    if (path === base)
      return Response.json({
        enabled: true,
        cloudConfigured: false,
        mode: "encrypted-checkpoints",
      });
    return operation(path, options);
  });
}
it("explains that incomplete household setup prevents a local download", async () => {
  const fetcher = ownerFetch(() =>
    Response.json({ error: { code: "MASTER_PIN_REQUIRED" } }, { status: 400 }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<EncryptedRecovery />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Create",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Complete household setup",
  );
  expect(fetcher).toHaveBeenCalledWith(
    base + "/export",
    expect.objectContaining({ method: "POST", body: "{}" }),
  );
});
it.each([false, true])(
  "reviews a Master PIN-protected local file with eight slots (restoreOnly=%s)",
  async (restoreOnly) => {
    const fetcher = ownerFetch((path) => {
      if (path === base + "/preview")
        return Response.json({
          profiles: [{ name: "Restored viewer" }],
          credentials: [],
          limitations: [],
        });
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetcher);
    render(<EncryptedRecovery restoreOnly={restoreOnly} />);
    if (!restoreOnly)
      fireEvent.click(await screen.findByRole("button", { name: /^Restore$/ }));
    const key = await screen.findByLabelText("Master PIN for this backup");
    expect(
      key.closest(".digit-slots")?.querySelectorAll(".digit-slots__cell"),
    ).toHaveLength(8);
    const contents = { format: "streamerai-master-pin-household", version: 1 };
    const file = new File([JSON.stringify(contents)], "household.json", {
      type: "application/json",
    });
    Object.defineProperty(file, "text", {
      value: async () => JSON.stringify(contents),
    });
    fireEvent.change(screen.getByLabelText("Encrypted household file"), {
      target: { files: [file] },
    });
    fireEvent.change(key, { target: { value: "01234567" } });
    expect(key).toHaveAttribute("type", "password");
    const review = screen.getByRole("button", { name: "Review contents" });
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);
    expect(await screen.findByText(/Restored viewer/)).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(
      base + "/preview",
      expect.objectContaining({
        body: JSON.stringify({ envelope: contents, recoveryKey: "01234567" }),
      }),
    );
    expect(screen.queryByText("01234567")).not.toBeInTheDocument();
  },
);

it("shows automatic cloud backup status without recovery-key actions", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/api/v1/installation/status")
        return Response.json({ role: "owner" });
      if (path === base)
        return Response.json({
          enabled: true,
          cloudConfigured: true,
          cloudBackup: {
            status: "current",
            lastSavedAt: "2026-11-07T10:00:00.000Z",
            error: null,
          },
        });
      throw new Error("Unexpected request");
    }),
  );
  render(<EncryptedRecovery />);
  expect(await screen.findByText(/Encrypted backup is current/)).toBeVisible();
  expect(screen.queryByText(/recovery key/i)).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Upload current household" }),
  ).not.toBeInTheDocument();
});

it("loads a cloud backup and reviews it with eight Master PIN slots", async () => {
  const backup = { format: "streamerai-master-pin-household", version: 1 };
  const fetcher = vi.fn(async (path: string) => {
    if (path === "/api/v1/installation/status")
      return Response.json({ role: "owner" });
    if (path === base) return Response.json({ cloudConfigured: true });
    if (path === base + "/cloud")
      return Response.json({ revision: 3, envelope: backup });
    if (path === base + "/preview")
      return Response.json({
        profiles: [{ name: "Cloud viewer" }],
        credentials: [],
        limitations: [],
      });
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetcher);
  render(<EncryptedRecovery restoreOnly />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Restore from cloud backup" }),
  );
  const input = await screen.findByLabelText("Master PIN for this backup");
  expect(
    input.closest(".digit-slots")?.querySelectorAll(".digit-slots__cell"),
  ).toHaveLength(8);
  fireEvent.change(input, { target: { value: "01234567" } });
  fireEvent.click(screen.getByRole("button", { name: "Review contents" }));
  expect(await screen.findByText(/Cloud viewer/)).toBeVisible();
});
