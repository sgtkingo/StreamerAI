import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { browserScript, page } from "../../cloud/src/pages";

afterEach(() => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
  document.body.innerHTML = "";
});

function login() {
  window.history.replaceState({}, "", "/login");
  const parsed = new DOMParser().parseFromString(
    page("login", true),
    "text/html",
  );
  document.body.innerHTML = parsed.body.innerHTML;
  document.body.dataset.page = "login";
  new Function(browserScript)();
  (document.getElementById("login-email") as HTMLInputElement).value =
    "owner@example.test";
}

it("keeps provider sign-in on the hosted page and explains local access in a quiet tip", () => {
  const document = new DOMParser().parseFromString(
    page("login", true),
    "text/html",
  );
  expect(document.querySelector("#google.google-button svg")).not.toBeNull();
  expect(
    document.querySelector("#email-form input[type=email]"),
  ).not.toBeNull();
  expect(document.querySelector(".login-tip h2")?.textContent).toBe(
    "Věděli jste, že?",
  );
  expect(document.querySelector(".login-tip")?.textContent).toContain(
    "bez registrace",
  );
  expect(document.body.textContent).not.toContain(
    "Apple přihlášení připravujeme.",
  );
});

it("reveals the email sign-in form and focuses its input on request", () => {
  login();
  const fields = document.getElementById("email-fields")!;
  const button = document.getElementById("email-open")!;
  expect(fields).toHaveAttribute("hidden");
  expect(button).toHaveAttribute("aria-expanded", "false");
  button.click();
  expect(fields).not.toHaveAttribute("hidden");
  expect(button).toHaveAttribute("hidden");
  expect(document.getElementById("login-email")).toHaveFocus();
});

it("shows sign-in code feedback beside the form and permits a new code only after its countdown", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true }));
  vi.stubGlobal("fetch", fetcher);
  login();
  const form = document.getElementById("email-form")!;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.getElementById("otp-form")).not.toHaveAttribute("hidden");
  expect(form).toHaveAttribute("hidden");
  expect(document.getElementById("verify-email")).toBeDisabled();
  expect(document.getElementById("login-feedback")!.textContent).toContain(
    "owner@example.test",
  );
  expect(document.getElementById("login-feedback")!.textContent).toContain(
    "Spam",
  );
  expect(document.getElementById("resend-email")).toHaveTextContent("60 s");
  document.getElementById("resend-email")!.click();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(document.getElementById("resend-email")).not.toBeDisabled();
  expect(document.getElementById("resend-email")).toHaveTextContent(
    "Poslat nový kód",
  );
  document.getElementById("resend-email")!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("submits an eight-digit code once, allows a failed attempt to be corrected, and changes email", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ success: true }))
    .mockResolvedValueOnce(
      Response.json({ error: "invalid_otp" }, { status: 400 }),
    );
  vi.stubGlobal("fetch", fetcher);
  login();
  document
    .getElementById("email-form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await waitFor(() =>
    expect(document.getElementById("otp-form")).not.toHaveAttribute("hidden"),
  );
  const input = document.getElementById("login-otp") as HTMLInputElement;
  input.value = "1234567";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(document.getElementById("verify-email")).toBeDisabled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  input.value = "12345678";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
    email: "owner@example.test",
    otp: "12345678",
  });
  await waitFor(() =>
    expect(document.getElementById("login-feedback")).toHaveTextContent(
      "Kód není platný",
    ),
  );
  expect(document.getElementById("verify-email")).not.toBeDisabled();
  document.getElementById("change-email")!.click();
  expect(document.getElementById("otp-form")).toHaveAttribute("hidden");
  expect(document.getElementById("email-form")).not.toHaveAttribute("hidden");
  const email = document.getElementById("login-email") as HTMLInputElement;
  expect(email).toHaveFocus();
  expect(email.value).toBe("owner@example.test");
  email.value = "other@example.test";
  expect(email.value).toBe("other@example.test");
});

it.each([503, 429])(
  "shows sign-in send failure %i beside the form instead of offering an unsent code",
  async (status) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: status === 429 ? "rate_limited" : "email_unavailable" },
            { status, headers: { "retry-after": "120" } },
          ),
        ),
    );
    login();
    document
      .getElementById("email-form")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("otp-form")).toHaveAttribute("hidden");
    expect(document.getElementById("login-feedback")!.textContent).toContain(
      status === 429 ? "2 min" : "nepodařilo odeslat",
    );
    if (status === 429) {
      expect(document.getElementById("send-email")).toBeDisabled();
      await vi.advanceTimersByTimeAsync(120_000);
    }
    expect(document.getElementById("send-email")).not.toBeDisabled();
  },
);

function portal() {
  window.history.replaceState({}, "", "/account?account_id=owner-a");
  const parsed = new DOMParser().parseFromString(page("account"), "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  document.body.dataset.page = "account";
  new Function(browserScript)();
}

it("stops linking when the portal is signed in as a different owner", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      id: "owner-b",
      name: "Other owner",
      email: "other@example.test",
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  portal();
  await waitFor(() =>
    expect(document.getElementById("message")!.textContent).toContain(
      "jiný účet",
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(document.getElementById("link-google")).toHaveAttribute("hidden");
  expect(document.getElementById("enable-email")).toHaveAttribute("hidden");
  expect(document.getElementById("login-again")).toHaveAttribute(
    "href",
    "/login",
  );
});

it("shows existing Google enrollment and displays a resend limit next to its e-mail button", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === "/v1/account")
        return Response.json({
          id: "owner-a",
          name: "Owner",
          email: "owner@example.test",
        });
      if (path === "/v1/account/email-login")
        return Response.json({
          available: true,
          enabled: false,
          googleLinked: true,
        });
      if (path === "/v1/account/email-login/code")
        return Response.json(
          { error: "rate_limited" },
          { status: 429, headers: { "retry-after": "1200" } },
        );
      if (path === "/v1/devices") return Response.json({ devices: [] });
      if (path === "/v1/profiles") return Response.json({ profiles: [] });
      if (path === "/v1/transfers") return Response.json({ transfers: [] });
      if (path === "/v1/merges") return Response.json({ merges: [] });
      if (path === "/v1/device/pending") return Response.json({ pairings: [] });
      throw new Error("Unexpected request");
    }),
  );
  portal();
  await waitFor(() =>
    expect(document.getElementById("enable-email")).not.toHaveAttribute(
      "hidden",
    ),
  );
  expect(document.getElementById("link-google")).toHaveAttribute("hidden");
  expect(document.getElementById("google-status")!.textContent).toContain(
    "Účet je propojen",
  );
  document.getElementById("enable-email")!.click();
  await waitFor(() =>
    expect(document.getElementById("email-feedback")!.textContent).toContain(
      "20 min",
    ),
  );
  expect(document.getElementById("enable-email")).not.toBeDisabled();
});

function portalFetcher(failure?: string) {
  let devices = [
    { id: "tv-1", name: "Obývák", expires_at: Date.now() + 60_000 },
  ];
  return vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/v1/account")
      return Response.json({
        id: "owner-a",
        name: "Owner",
        email: "owner@example.test",
      });
    if (path === "/v1/account/email-login" && options?.method !== "DELETE")
      return Response.json({
        available: true,
        enabled: true,
        googleLinked: true,
      });
    if (path === "/v1/account/email-login" && options?.method === "DELETE")
      return Response.json(
        { error: failure },
        { status: failure === "reauth_required" ? 403 : 409 },
      );
    if (path === "/v1/devices/tv-1" && options?.method === "DELETE") {
      devices = [];
      return Response.json({ ok: true });
    }
    if (path === "/v1/devices") return Response.json({ devices });
    if (path === "/v1/device/pending") return Response.json({ pairings: [] });
    if (path === "/v1/profiles") return Response.json({ profiles: [] });
    if (path === "/v1/transfers") return Response.json({ transfers: [] });
    if (path === "/v1/merges") return Response.json({ merges: [] });
    throw new Error("Unexpected request " + path);
  });
}

function enableDialog() {
  const dialog = document.getElementById("confirm-dialog") as HTMLDialogElement;
  dialog.showModal = () => dialog.setAttribute("open", "");
  dialog.close = () => {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  };
  return dialog;
}

it("requires an explicit profile selection before accepting an account merge", async () => {
  const base = portalFetcher();
  const profiles = Array.from({ length: 6 }, (_, index) => ({
    id: `profile-${index}`,
    name: `Profile ${index}`,
    account_id: index < 3 ? "owner-a" : "owner-b",
  }));
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/v1/merges")
      return Response.json({
        merges: [
          {
            id: "merge-1",
            source_email: "one@example.test",
            target_email: "two@example.test",
            target_account_id: "owner-a",
            incoming: true,
            profiles,
          },
        ],
      });
    if (path === "/v1/merges/merge-1/decision")
      return Response.json({ ok: true, accountId: "owner-a" });
    return base(path, options);
  });
  vi.stubGlobal("fetch", fetcher);
  portal();
  const dialog = document.getElementById(
    "profiles-dialog",
  ) as HTMLDialogElement;
  dialog.showModal = () => dialog.setAttribute("open", "");
  dialog.close = () => {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  };
  await waitFor(() =>
    expect(document.getElementById("transfers")).toHaveTextContent(
      "Sloučení účtů",
    ),
  );
  const review = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Zkontrolovat sloučení",
  )!;
  review.click();
  expect(dialog).toHaveAttribute("open");
  expect(fetcher).not.toHaveBeenCalledWith(
    "/v1/merges/merge-1/decision",
    expect.anything(),
  );
  const boxes = Array.from(
    dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  );
  boxes.slice(0, 5).forEach((box) => box.click());
  document.getElementById("profiles-confirm")!.click();
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/merges/merge-1/decision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          approve: true,
          profileIds: profiles.slice(0, 5).map((p) => p.id),
          expectedProfileIds: profiles.map((p) => p.id),
        }),
      }),
    ),
  );
});

it("requires confirmation before deleting the cloud account and offers reauthentication when needed", async () => {
  const base = portalFetcher();
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/v1/account" && options?.method === "DELETE")
      return Response.json({ error: "reauth_required" }, { status: 403 });
    return base(path, options);
  });
  vi.stubGlobal("fetch", fetcher);
  portal();
  const dialog = enableDialog();
  await waitFor(() =>
    expect(document.getElementById("delete-account")).toBeEnabled(),
  );
  // Wait for the account page to finish installing its action handlers.
  await waitFor(() =>
    expect(
      document.querySelector('[aria-label="Odebrat zařízení Obývák"]'),
    ).not.toBeNull(),
  );
  document.getElementById("delete-account")!.click();
  expect(dialog).toHaveTextContent(
    "Místní data na domácích serverech zůstanou zachována",
  );
  document.getElementById("confirm-cancel")!.click();
  await Promise.resolve();
  expect(fetcher).not.toHaveBeenCalledWith(
    "/v1/account",
    expect.objectContaining({ method: "DELETE" }),
  );
  document.getElementById("delete-account")!.click();
  document.getElementById("confirm-action")!.click();
  await waitFor(() =>
    expect(document.getElementById("delete-reauth-help")).not.toHaveAttribute(
      "hidden",
    ),
  );
  expect(document.getElementById("delete-reauthenticate")).toHaveAttribute(
    "href",
    "/login?account_id=owner-a",
  );
});

it("asks before removing a device and keeps it when cancelled", async () => {
  const fetcher = portalFetcher();
  vi.stubGlobal("fetch", fetcher);
  portal();
  const dialog = enableDialog();
  expect(document.getElementById("reauth-help")).toHaveAttribute("hidden");
  const addDevice = Array.from(document.querySelectorAll("a")).find(
    (link) => link.textContent === "Připojit další zařízení",
  )!;
  expect(addDevice.getAttribute("href")).toBe("/device");
  expect(addDevice.closest("section")).toContainElement(
    document.getElementById("devices"),
  );
  await waitFor(() =>
    expect(
      document.querySelector('[aria-label="Odebrat zařízení Obývák"]'),
    ).not.toBeNull(),
  );
  (
    document.querySelector(
      '[aria-label="Odebrat zařízení Obývák"]',
    ) as HTMLElement
  ).click();
  expect(dialog).toHaveAttribute("open");
  expect(dialog).toHaveTextContent("Obývák");
  document.getElementById("confirm-cancel")!.click();
  expect(fetcher).not.toHaveBeenCalledWith(
    "/v1/devices/tv-1",
    expect.anything(),
  );
  await waitFor(() =>
    expect(
      document.querySelector('[aria-label="Odebrat zařízení Obývák"]'),
    ).not.toBeDisabled(),
  );
  (
    document.querySelector(
      '[aria-label="Odebrat zařízení Obývák"]',
    ) as HTMLElement
  ).click();
  document.getElementById("confirm-action")!.click();
  await waitFor(() =>
    expect(document.getElementById("devices")).toHaveTextContent(
      "Zatím nemáte připojená zařízení",
    ),
  );
  expect(fetcher).toHaveBeenCalledWith(
    "/v1/devices/tv-1",
    expect.objectContaining({ method: "DELETE" }),
  );
});

it.each([["last_sign_in_method", "Poslední způsob přihlášení nelze odebrat"]])(
  "shows %s when disabling a sign-in method",
  async (failure, expected) => {
    const fetcher = portalFetcher(failure);
    vi.stubGlobal("fetch", fetcher);
    portal();
    enableDialog();
    await waitFor(() =>
      expect(document.getElementById("disable-email")).not.toHaveAttribute(
        "hidden",
      ),
    );
    document.getElementById("disable-email")!.click();
    expect(fetcher).not.toHaveBeenCalledWith(
      "/v1/account/email-login",
      expect.objectContaining({ method: "DELETE" }),
    );
    document.getElementById("confirm-action")!.click();
    await waitFor(() =>
      expect(document.getElementById("email-feedback")).toHaveTextContent(
        expected,
      ),
    );
    expect(document.getElementById("disable-email")).not.toHaveAttribute(
      "hidden",
    );
    expect(document.getElementById("reauth-help")).toHaveAttribute("hidden");
  },
);

it("shows the account-specific reauthentication link only when a method change requires it", async () => {
  vi.stubGlobal("fetch", portalFetcher("reauth_required"));
  portal();
  enableDialog();
  await waitFor(() =>
    expect(document.getElementById("disable-email")).not.toHaveAttribute(
      "hidden",
    ),
  );
  const help = document.getElementById("reauth-help")!;
  expect(help).toHaveAttribute("hidden");
  document.getElementById("disable-email")!.click();
  document.getElementById("confirm-action")!.click();
  await waitFor(() => expect(help).not.toHaveAttribute("hidden"));
  expect(document.getElementById("reauthenticate")).toHaveAttribute(
    "href",
    "/login?account_id=owner-a",
  );
  expect(help).toHaveTextContent("Přihlaste se znovu");
});

it.each(["enable-email", "confirm-email", "link-google"])(
  "offers reauthentication when %s needs a fresh session",
  async (action) => {
    const base = portalFetcher();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options?: RequestInit) => {
        if (
          path === "/v1/account/email-login" &&
          options?.method !== "DELETE"
        ) {
          return Response.json({
            available: true,
            enabled: false,
            googleLinked: action !== "link-google",
          });
        }
        if (
          [
            "/v1/account/email-login/code",
            "/v1/account/email-login/confirm",
            "/api/auth/link-social",
          ].includes(path)
        ) {
          return Response.json({ error: "reauth_required" }, { status: 403 });
        }
        return base(path, options);
      }),
    );
    portal();
    const target = action === "link-google" ? "link-google" : "enable-email";
    await waitFor(() =>
      expect(document.getElementById(target)).not.toHaveAttribute("hidden"),
    );
    if (action === "confirm-email") {
      document
        .getElementById("enable-email-form")!
        .dispatchEvent(new Event("submit", { cancelable: true }));
    } else {
      document.getElementById(target)!.click();
    }
    await waitFor(() =>
      expect(document.getElementById("reauth-help")).not.toHaveAttribute(
        "hidden",
      ),
    );
    expect(document.getElementById("reauthenticate")).toHaveAttribute(
      "href",
      "/login?account_id=owner-a",
    );
  },
);
