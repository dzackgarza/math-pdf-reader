// The real configured assistant reads a stored PDF that has no structured extraction and answers
// with a full sentence present only on page 2. A test proxy observes the real bucket requests.
// This uses a private bucket and assistant server; it does not open or change a chat in the
// provisioned app. The configured provider must be reachable.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AiSessionSchema } from "../src/contract/ai";
import { CONFIG_PATH, loadAppConfig } from "../src/contract/config";
import { closedPortUrl, EXTRACTIONS_MANIFEST, serveBucket } from "./bucket";

const MessagesSchema = z.object({
  data: z.array(
    z.object({
      content: z.array(
        z
          .object({ type: z.string(), text: z.string().optional() })
          .passthrough(),
      ),
    }),
  ),
});

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (port === undefined)
    throw new Error("the temporary listener did not bind a port");
  return port;
}

test("the assistant answers from a non-first raw-PDF page without a structured extraction", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdf-bucket-ai-live-"));
  const config = loadAppConfig(CONFIG_PATH);
  const aiPort = freePort();
  config.ai.port = aiPort;
  const app = await serveBucket({
    root,
    zoteroUrl: closedPortUrl(),
    extractionsManifest: EXTRACTIONS_MANIFEST,
    config,
    // The private assistant links the user's provider logins. Its own data remains under the
    // scratch bucket's index-export directory.
    env: { XDG_DATA_HOME: join(process.env.HOME!, ".local", "share") },
  });
  try {
    const pageRequests: string[] = [];
    const proxy = Bun.serve({
      port: 0,
      async fetch(request) {
        const incoming = new URL(request.url);
        const resource = `${incoming.pathname}${incoming.search}`;
        if (incoming.pathname === "/api/ai/pdf-text/long-notes") {
          pageRequests.push(resource);
        }
        const headers = new Headers(request.headers);
        // The bucket derives the assistant's allowed fetch origin from Host. Keep the proxy host so
        // AGENTS.md and the generated permission configuration use the observed boundary.
        headers.set("Host", incoming.host);
        const method = request.method.toUpperCase();
        return fetch(new URL(resource, app.origin), {
          method: request.method,
          headers,
          body:
            method === "GET" || method === "HEAD"
              ? undefined
              : await request.arrayBuffer(),
        });
      },
    });
    try {
      const bucketRequest = (path: string, init?: RequestInit) =>
        fetch(new URL(path, proxy.url), init);
      const form = new FormData();
      form.set(
        "pdf",
        new File(
          [readFileSync(join(import.meta.dir, "fixtures/long-notes.pdf"))],
          "long-notes.pdf",
          {
            type: "application/pdf",
          },
        ),
      );
      form.set(
        "pdf_url",
        "https://www.math.example.edu/~author/long-notes.pdf",
      );
      form.set("title_hint", "Long Notes");
      expect(
        (await bucketRequest("/capture-bytes", { method: "POST", body: form }))
          .status,
      ).toBe(200);
      const missing = await bucketRequest("/api/ai/text/long-notes");
      expect(missing.status).toBe(400);

      const opened = await bucketRequest("/api/ai/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "long-notes" }),
      });
      expect(opened.status).toBe(200);
      const addresses = AiSessionSchema.parse(await opened.json());
      const assistantOrigin = new URL(addresses.pairUrl).origin;
      const sessionID = addresses.sessionUrl.split("/session/").at(-1)!;
      const password = readFileSync(
        join(dirname(app.indexExport), "ai/password"),
        "utf8",
      ).trim();
      const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
      const assistantRequest = (path: string, init?: RequestInit) =>
        fetch(`${assistantOrigin}${path}`, {
          ...init,
          headers: { ...init?.headers, Authorization: authorization },
        });

      const prompt = await assistantRequest(
        `/api/session/${sessionID}/prompt`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "Read page 2 of the original PDF named in AGENTS.md through its page-text address. Quote exactly the full sentence on that page that begins 'The lattice'. Include every character, including the final period, and add no markup to the quotation.",
          }),
        },
      );
      expect(prompt.status).toBe(200);
      const waited = await assistantRequest(
        `/api/experimental/session/${sessionID}/wait`,
        {
          method: "POST",
          signal: AbortSignal.timeout(180_000),
        },
      );
      expect(waited.status).toBe(204);
      const messages = await assistantRequest(
        `/api/session/${sessionID}/message?type=assistant&order=desc&limit=1`,
      );
      expect(messages.status).toBe(200);
      const answer = MessagesSchema.parse(await messages.json())
        .data.flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      console.info("raw-PDF page-2 assistant answer", answer);
      console.info(
        "raw-PDF requests through the bucket boundary",
        pageRequests,
      );

      expect(answer).not.toMatch(
        /\b(?:can(?:not|'t)|could(?:not|n't)|unable|refuse[sd]?)\b|(?:do not|don't) have access|no access/i,
      );
      expect(answer).toContain(
        "The lattice Z2 has determinant 1 and 2 · 2 vectors of norm 1.",
      );
      expect(pageRequests).toContain("/api/ai/pdf-text/long-notes?page=2");
    } finally {
      proxy.stop(true);
    }
  } finally {
    try {
      await app.stop();
    } finally {
      for (const path of [root, ...app.temporaryPaths]) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  }
});
