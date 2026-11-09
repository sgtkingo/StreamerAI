import { afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
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

it("keeps household PIN and device management on the home server", () => {
  const document = new DOMParser().parseFromString(
    page("account", true),
    "text/html",
  );
  expect(document.querySelector("#households")).not.toBeNull();
  expect(document.querySelector("#household-owner-form")).not.toBeNull();
  expect(document.querySelector("#master-pin-form")).toBeNull();
  expect(document.querySelector("#pin-resets")).toBeNull();
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
      if (path === "/v1/households") return Response.json({ households: [] });
      if (path === "/v1/household-requests")
        return Response.json({ requests: [] });
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
    if (path === "/v1/households")
      return Response.json({
        households: [
          {
            id: "home-1",
            name: "Home",
            hasBackup: true,
            lastBackupAt: Date.now(),
          },
        ],
      });
    if (path === "/v1/household-requests")
      return Response.json({ requests: [] });
    if (path === "/v1/households/home-1/pin-resets")
      return Response.json({ requests: [] });
    if (path === "/v1/households/home-1/profiles")
      return Response.json({ profiles: [] });
    if (
      path === "/v1/households/home-1/connection" &&
      options?.method === "DELETE"
    )
      return Response.json({ ok: true });
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

it("approves a server connection without creating a household Master PIN", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const derive = vi.spyOn(webcrypto.subtle, "deriveBits");
  const fetcher = vi.fn(async (path: string) => {
    if (path === "/v1/account")
      return Response.json({ id: "owner-a", name: "Owner" });
    if (path.startsWith("/v1/device/verify?"))
      return Response.json({
        user_code: "ABCD-2345",
        device_name: "Home server",
        purpose: "login",
      });
    if (path === "/v1/device/claim" || path === "/v1/device/approve")
      return Response.json({ ok: true });
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
  expect(derive).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.some(([path]) => path.includes("master-pin"))).toBe(
    false,
  );
});

it("sends household merge requests to the selected household", async () => {
  const base = portalFetcher();
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === "/v1/households")
      return Response.json({
        households: [
          { id: "home-1", name: "Home" },
          { id: "home-2", name: "Cottage" },
          { id: "home-3", name: "Merged", mergedInto: "home-1" },
        ],
      });
    if (
      path === "/v1/households/home-2/pin-resets" ||
      path === "/v1/households/home-3/pin-resets"
    )
      return Response.json({ requests: [] });
    if (path === "/v1/households/home-1/merge")
      return Response.json({ ok: true });
    return base(path, options);
  });
  vi.stubGlobal("fetch", fetcher);
  portal();
  await waitFor(() =>
    expect(document.querySelector("#merge-household option")).not.toBeNull(),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const target = document.getElementById(
    "merge-target-household",
  ) as HTMLSelectElement;
  expect([...target.options].map((option) => option.value)).toEqual(["home-2"]);
  expect(
    (document.getElementById("profile-target-household") as HTMLSelectElement)
      .value,
  ).toBe("home-2");
  document
    .getElementById("household-merge-form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/households/home-1/merge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ targetHouseholdId: "home-2" }),
      }),
    ),
  );
  const source = document.getElementById(
    "merge-household",
  ) as HTMLSelectElement;
  source.value = "home-2";
  source.dispatchEvent(new Event("change"));
  expect([...target.options].map((option) => option.value)).toEqual(["home-1"]);
});

it("disables transfers and merges when no other owned household is available", async () => {
  vi.stubGlobal("fetch", portalFetcher());
  portal();
  await waitFor(() =>
    expect(
      document.querySelector("#merge-target-household option"),
    ).not.toBeNull(),
  );
  for (const formId of ["household-profile-form", "household-merge-form"]) {
    const form = document.getElementById(formId) as HTMLFormElement;
    const target = form.querySelector<HTMLSelectElement>(
      "select[id$='target-household']",
    )!;
    expect(target).toBeDisabled();
    expect(target).toHaveValue("");
    expect(form.querySelector("button[type=submit]")).toBeDisabled();
  }
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
  await waitFor(() =>
    expect(
      document.querySelector("#households-list .approval-card"),
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

it("asks before disconnecting a household server and keeps its data when cancelled", async () => {
  const fetcher = portalFetcher();
  vi.stubGlobal("fetch", fetcher);
  portal();
  const dialog = enableDialog();
  const findButton = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>("#households-list button"),
    )[0];
  await waitFor(() => expect(findButton()).toBeDefined());
  findButton().click();
  expect(dialog).toHaveAttribute("open");
  document.getElementById("confirm-cancel")!.click();
  await waitFor(() => expect(findButton()).toBeEnabled());
  expect(fetcher).not.toHaveBeenCalledWith(
    "/v1/households/home-1/connection",
    expect.anything(),
  );
  findButton().click();
  document.getElementById("confirm-action")!.click();
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/v1/households/home-1/connection",
      expect.objectContaining({ method: "DELETE" }),
    ),
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
