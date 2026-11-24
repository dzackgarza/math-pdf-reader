// The real configured assistant reads a raw PDF page, then discovers an unknown artifact added
// after its chat opened. A test proxy observes the real bucket requests.
// This uses a private bucket and assistant server; it does not open or change a chat in the
// provisioned app. The configured provider must be reachable.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
          .object({
            type: z.string(),
            text: z.string().optional(),
            name: z.string().optional(),
            state: z
              .object({
                status: z.string(),
                input: z.record(z.string(), z.unknown()),
              })
              .passthrough()
              .optional(),
          })
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

test("the assistant reads a raw page and discovers a new artifact in the same chat", async () => {
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
        // reader-view and the generated permission configuration use the observed boundary.
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
      expect((await bucketRequest("/api/ai/text/long-notes")).status).toBe(404);

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

      async function ask(text: string) {
        const prompt = await assistantRequest(
          `/api/session/${sessionID}/prompt`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
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
        return MessagesSchema.parse(await messages.json()).data.flatMap(
          (message) => message.content,
        );
      }

      const rawAnswerParts = await ask(
        "Read page 2 of the original PDF through the page-text address in your reader-view instruction. Quote exactly the full sentence on that page that begins 'The lattice'. Include every character, including the final period, and add no markup to the quotation.",
      );
      const answer = rawAnswerParts
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

      const pageRequestsBeforeDiscovery = [...pageRequests];
      const marker = `pdf-bucket-live-discovery-${randomUUID()}`;
      const artifact = join(
        root,
        "long-notes",
        "research-notes",
        `${marker}.txt`,
      );
      mkdirSync(dirname(artifact), { recursive: true });
      writeFileSync(artifact, `Discovery marker: ${marker}\n`);
      const discoveryParts = await ask(
        "A new artifact has just appeared somewhere in this paper's document directory. Inspect the directory, read the new artifact itself, and report its exact discovery marker. Do not use the PDF page-text endpoint for this question.",
      );
      const discoveryAnswer = discoveryParts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      const transcript = await assistantRequest(
        `/api/session/${sessionID}/message?type=assistant&order=desc&limit=50`,
      );
      expect(transcript.status).toBe(200);
      const toolCalls = MessagesSchema.parse(await transcript.json())
        .data.flatMap((message) => message.content)
        .filter((part) => part.type === "tool");
      console.info(
        "same-chat read calls",
        JSON.stringify(
          toolCalls.filter((part) => part.name === "read"),
          null,
          2,
        ),
      );
      const artifactReads = toolCalls.filter(
        (part) =>
          part.type === "tool" &&
          part.name === "read" &&
          part.state?.status === "completed" &&
          JSON.stringify(part.state.input).includes(artifact),
      );
      console.info(
        "same-chat unknown-artifact assistant answer",
        discoveryAnswer,
      );
      console.info(
        "same-chat unknown-artifact direct reads",
        artifactReads.map((part) => part.state?.input),
      );

      expect(discoveryAnswer).toContain(marker);
      expect(
        artifactReads.map((part) => JSON.stringify(part.state?.input)),
      ).toContainEqual(expect.stringContaining(artifact));
      expect(pageRequests).toEqual(pageRequestsBeforeDiscovery);
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
