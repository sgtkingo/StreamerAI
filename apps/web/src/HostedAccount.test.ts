import { afterEach, expect, it, vi } from "vitest";
import { pbkdf2Sync, webcrypto } from "node:crypto";
import { waitFor } from "@testing-library/react";
import { browserScript, page } from "../../cloud/src/pages";

afterEach(() => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

it("explains how an account owner can approve a profile PIN reset", () => {
  const document = new DOMParser().parseFromString(
    page("account", true),
    "text/html",
  );
  const recovery = document.querySelector("#pin-resets")?.closest("section");
  expect(recovery?.textContent).toContain("Forgot PIN?");
  expect(recovery?.textContent).toContain("nebo zadáním Master PINu");
  expect(recovery?.nextElementSibling?.querySelector("h2")?.textContent).toBe(
    "Účty a profily",
  );
  expect(document.querySelector('a[href="/device"]')).not.toBeNull();
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
      if (path === "/v1/account/master-pin")
        return Response.json({ setupRequired: false });
      if (path === "/v1/account/pin-resets")
        return Response.json({ requests: [] });
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
    if (path === "/v1/account/master-pin")
      return Response.json({ setupRequired: false });
    if (path === "/v1/account/pin-resets")
      return Response.json({ requests: [] });
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

it("approves the named profile reset in the account portal without a pairing code", async () => {
  const base = portalFetcher();
  let pending = true;
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/v1/account/pin-resets")
      return Response.json({
        requests: pending
          ? [
              {
                id: "reset-1",
                profile_name: "Kids",
                device_name: "Home server",
                expires_at: Date.now() + 300_000,
              },
            ]
          : [],
      });
    if (path === "/v1/account/pin-resets/reset-1/decision") {
      pending = false;
      return Response.json({ ok: true });
    }
    return base(path, options);
  });
  vi.stubGlobal("fetch", fetcher);
  portal();
  enableDialog();
  await waitFor(() =>
    expect(document.getElementById("pin-resets")!.textContent).toContain(
      "Kids",
    ),
  );
  const approve = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#pin-resets button"),
  ).find((button) => button.textContent === "Povolit reset")!;
  approve.click();
  expect(document.getElementById("confirm-description")!.textContent).toContain(
    "Kids",
  );
  expect(fetcher.mock.calls.some(([path]) => path.endsWith("/decision"))).toBe(
    false,
  );
  document.getElementById("confirm-action")!.click();
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/account/pin-resets/reset-1/decision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ approve: true }),
      }),
    ),
  );
  expect(
    fetcher.mock.calls.some(([path]) => path.startsWith("/v1/device/verify")),
  ).toBe(false);
});

it("changes the Master PIN only after matching confirmation and clears the form", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const base = portalFetcher();
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/v1/account/master-pin" && options?.method === "PUT")
      return Response.json({ ok: true });
    return base(path, options);
  });
  vi.stubGlobal("fetch", fetcher);
  portal();
  const dialog = document.getElementById(
    "master-pin-dialog",
  ) as HTMLDialogElement;
  dialog.showModal = () => dialog.setAttribute("open", "");
  dialog.close = () => {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  };
  await waitFor(() =>
    expect(document.getElementById("google-status")!.textContent).not.toBe(""),
  );
  document.getElementById("change-master-pin")!.click();
  const pin = document.getElementById("master-pin") as HTMLInputElement;
  const confirmation = document.getElementById(
    "master-pin-confirmation",
  ) as HTMLInputElement;
  for (const field of [pin, confirmation])
    expect(
      field
        .closest(".master-pin-entry")
        ?.querySelectorAll(".master-pin-entry__slot"),
    ).toHaveLength(8);
  pin.value = "01234567";
  confirmation.value = "01234568";
  document
    .getElementById("master-pin-form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(
    fetcher.mock.calls.some(([, options]) => options?.method === "PUT"),
  ).toBe(false);
  confirmation.value = "01234567";
  document
    .getElementById("master-pin-form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([, options]) => options?.method === "PUT"),
    ).toBe(true),
  );
  const saved = fetcher.mock.calls.find(
    ([, options]) => options?.method === "PUT",
  )!;
  const payload = JSON.parse(String(saved[1]?.body)) as {
    verifier: { salt: string; hash: string; version: string };
  };
  expect(Object.keys(payload)).toEqual(["verifier"]);
  expect(payload.verifier.hash).toBe(
    pbkdf2Sync(
      "01234567",
      payload.verifier.salt,
      600_000,
      32,
      "sha256",
    ).toString("hex"),
  );
  await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
  expect(pin.value).toBe("");
  expect(confirmation.value).toBe("");
});

it("enables home server PIN changes for an existing account without resetting its PIN", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const base = portalFetcher();
  const salt = "a".repeat(32);
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/v1/account/master-pin/enroll")
      return options?.method === "POST"
        ? Response.json({ ok: true })
        : Response.json({ required: true, salt, version: "old-version" });
    return base(path, options);
  });
  vi.stubGlobal("fetch", fetcher);
  portal();
  const dialog = document.getElementById(
    "enroll-pin-dialog",
  ) as HTMLDialogElement;
  dialog.showModal = () => dialog.setAttribute("open", "");
  dialog.close = () => {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  };
  await waitFor(() =>
    expect(document.getElementById("google-status")!.textContent).not.toBe(""),
  );
  document.getElementById("enroll-master-pin")!.click();
  await waitFor(() => expect(dialog).toHaveAttribute("open"));
  const input = document.getElementById("enroll-pin") as HTMLInputElement;
  expect(
    input
      .closest(".master-pin-entry")
      ?.querySelectorAll(".master-pin-entry__slot"),
  ).toHaveLength(8);
  input.value = "01234567";
  document
    .getElementById("enroll-pin-form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(
    () =>
      expect(
        fetcher.mock.calls.some(
          ([path, init]) =>
            path === "/v1/account/master-pin/enroll" && init?.method === "POST",
        ),
      ).toBe(true),
    { timeout: 5000 },
  );
  const sent = fetcher.mock.calls.find(
    ([path, init]) =>
      path === "/v1/account/master-pin/enroll" && init?.method === "POST",
  )!;
  const payload = JSON.parse(String(sent[1]?.body));
  expect(payload.proof).toBe(
    pbkdf2Sync("01234567", salt, 600_000, 32, "sha256").toString("hex"),
  );
  expect(payload.changeHash).toBe(
    pbkdf2Sync("01234567", payload.changeSalt, 600_000, 32, "sha256").toString(
      "hex",
    ),
  );
  expect(JSON.stringify(payload)).not.toContain("01234567");
  await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
});

it("initializes a legacy account in the browser before approving its first device", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const derive = vi.spyOn(webcrypto.subtle, "deriveBits");
  let initialized = false;
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/v1/account")
      return Response.json({
        id: "owner-a",
        name: "Owner",
        email: "owner@example.test",
      });
    if (path === "/v1/account/master-pin" && options?.method === "PUT") {
      const payload = JSON.parse(String(options.body));
      expect(Object.keys(payload).sort()).toEqual(["initialize", "verifier"]);
      expect(payload.initialize).toBe(true);
      expect(payload.verifier).toMatchObject({
        salt: expect.stringMatching(/^[a-f0-9]{32}$/),
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      initialized = true;
      return Response.json({ ok: true });
    }
    if (path === "/v1/account/master-pin")
      return Response.json({
        setupRequired: false,
        initializationRequired: true,
      });
    if (path.startsWith("/v1/device/verify?")) {
      expect(initialized).toBe(true);
      return Response.json({
        user_code: "ABCD-2345",
        device_name: "Home server",
        purpose: "login",
      });
    }
    if (path === "/v1/device/claim" || path === "/v1/device/approve") {
      expect(initialized).toBe(true);
      return Response.json({ ok: true });
    }
    throw new Error("Unexpected request " + path);
  });
  vi.stubGlobal("fetch", fetcher);
  window.history.replaceState({}, "", "/device?user_code=ABCD-2345");
  const parsed = new DOMParser().parseFromString(page("device"), "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  document.body.dataset.page = "device";
  new Function(browserScript)();
  await waitFor(() =>
    expect(document.getElementById("approval")).not.toHaveAttribute("hidden"),
  );
  expect(derive).toHaveBeenCalledWith(
    expect.objectContaining({ name: "PBKDF2", iterations: 600_000 }),
    expect.anything(),
    256,
  );
  document.getElementById("approve")!.click();
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/device/approve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ user_code: "ABCD-2345", approve: true }),
      }),
    ),
  );
  await waitFor(() =>
    expect(document.getElementById("approval")).toHaveAttribute("hidden"),
  );
});

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
