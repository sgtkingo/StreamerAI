import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import {
  Miniflare,
  Response as MockResponse,
  convertV4MiniflareOptions,
} from "miniflare";

let runtime: Miniflare;
let providerStatus = 201;
const destinations: string[] = [];

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import { sendLoginCode } from "./src/mail.ts";
        export default { async fetch(_request, env) {
          try { await sendLoginCode(env, "recipient@example.test", "01234567"); return Response.json({ok:true}); }
          catch { return Response.json({error:"email_unavailable"}, {status:503}); }
        } };`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: "mail-runtime-test",
      modules: true,
      script: bundle.outputFiles[0]!.text,
      // This is the newest date supported by Wrangler's pinned workerd binary.
      compatibilityDate: "2026-10-30",
      bindings: {
        BREVO_API_KEY: "test-api-key",
        MAIL_FROM: "no-reply@example.test",
      },
      outboundService: async (request) => {
        destinations.push(new URL(request.url).origin);
        expect(request.headers.get("api-key")).toBe("test-api-key");
        return new MockResponse(
          providerStatus === 201
            ? JSON.stringify({ messageId: "test-message" })
            : "",
          {
            status: providerStatus,
            headers: {
              "content-type": "application/json",
              ...(providerStatus === 302
                ? { location: "https://other.example.test/collect" }
                : {}),
            },
          },
        );
      },
    }),
  );
  await runtime.ready;
}, 20_000);

afterAll(async () => {
  await runtime?.dispose();
});

it("submits mail inside workerd using its actual fetch implementation", async () => {
  providerStatus = 201;
  destinations.length = 0;
  const response = await runtime.dispatchFetch(
    "https://identity.example.test/send",
  );
  expect(response.status).toBe(200);
  expect(destinations).toEqual(["https://api.brevo.com"]);
});

it("rejects a provider redirect without forwarding the API key to another host", async () => {
  providerStatus = 302;
  destinations.length = 0;
  const response = await runtime.dispatchFetch(
    "https://identity.example.test/send",
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "email_unavailable" });
  expect(destinations).toEqual(["https://api.brevo.com"]);
});
