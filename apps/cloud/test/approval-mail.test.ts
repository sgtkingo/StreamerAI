import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { approvalSignature, sendApprovalMail } from "../src/approval-mail.js";
import { fixture, origin } from "./helpers.js";

describe("approval email", () => {
  const f = fixture();
  const approval = {
    targetAccountId: "account-b",
    kind: "transfer" as const,
    requestId: "12345678-1234-4123-a123-123456789abc",
  };
  f.env.BREVO_API_KEY = "test";
  f.env.MAIL_FROM = "notify@example.test";
  afterAll(() => f.close());
  afterEach(() => {
    f.sqlite
      .prepare('UPDATE "user" SET "emailVerified" = 0 WHERE id = ?')
      .run("account-b");
    f.sqlite.prepare("DELETE FROM cloud_rate_limit").run();
  });

  it("sends review links only to the verified target address", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 201 }));
    expect(await sendApprovalMail(f.env, approval, f.now(), fetcher)).toBe(
      "unavailable",
    );
    expect(fetcher).not.toHaveBeenCalled();

    f.sqlite
      .prepare('UPDATE "user" SET "emailVerified" = 1 WHERE id = ?')
      .run("account-b");
    expect(await sendApprovalMail(f.env, approval, f.now(), fetcher)).toBe(
      "sent",
    );
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const mail = JSON.parse(String(init.body)) as {
      to: { email: string }[];
      textContent: string;
    };
    expect(mail.to).toEqual([{ email: "bob@example.test" }]);
    for (const intent of ["accept", "decline"]) {
      const url = new URL(`${origin}/email-approval`);
      url.searchParams.set("kind", "transfer");
      url.searchParams.set("id", approval.requestId);
      url.searchParams.set("intent", intent);
      url.searchParams.set(
        "token",
        await approvalSignature(f.env, {
          ...approval,
          intent: intent as "accept" | "decline",
          email: "bob@example.test",
        }),
      );
      expect(mail.textContent).toContain(url.toString());
    }
  });

  it("limits notices for one recipient and handles delivery failure", async () => {
    f.sqlite
      .prepare('UPDATE "user" SET "emailVerified" = 1 WHERE id = ?')
      .run("account-b");
    const fetcher = vi.fn(async () => new Response(null, { status: 500 }));
    for (let attempt = 0; attempt < 10; attempt++)
      expect(await sendApprovalMail(f.env, approval, f.now(), fetcher)).toBe(
        "unavailable",
      );
    expect(fetcher).toHaveBeenCalledTimes(10);
    await sendApprovalMail(f.env, approval, f.now(), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
});
